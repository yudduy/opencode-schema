import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, chmod, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { TaskRegistration } from "../mechanisms";
import {
	appendLedger,
	captureCandidateSnapshot,
	readLedger,
	readRegistration,
	readWorldModel,
	resolveCandidateSnapshot,
	sessionStateDirectory,
	withSessionLock,
	writeRegistration,
	writeWorldModel,
} from "../state";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(path.join(os.tmpdir(), "omp-schema-test-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("state IO", () => {
	test("registration and ledger use the per-session reference layout", async () => {
		const worktree = await temporaryDirectory();
		const task: TaskRegistration = { version: 1, verify_cmd: "./verify.sh", budget: 2 };
		await writeRegistration(worktree, "session-1", task);
		const row = await appendLedger(worktree, "session-1", {
			ts: 1,
			scope: "baseline",
			actual: { pass: true, failing: [] },
			cost: 1,
		});

		expect(await readRegistration(worktree, "session-1")).toEqual(task);
		expect(await readLedger(worktree, "session-1")).toEqual([{ ...row, step: 1 }]);
		expect(await readFile(path.join(sessionStateDirectory(worktree, "session-1"), "ledger.jsonl"), "utf8")).toBe(
			`${JSON.stringify(row)}\n`,
		);
	});

	test("session ids cannot escape the working tree", async () => {
		const worktree = await temporaryDirectory();
		expect(() => sessionStateDirectory(worktree, "../escape")).toThrow("Unsafe OMP session id");
	});

	test("world-model declaration and recorded candidate snapshots round-trip", async () => {
		const worktree = await temporaryDirectory();
		await writeFile(path.join(worktree, "candidate.txt"), "before\n");
		await mkdir(path.join(worktree, ".git"));
		await writeFile(path.join(worktree, ".git", "control"), "not candidate data\n");

		await writeWorldModel(worktree, "session-model", { version: 1, path: "model.py" });
		expect(await readWorldModel(worktree, "session-model")).toEqual({ version: 1, path: "model.py" });

		const reference = await captureCandidateSnapshot(worktree, "session-model");
		const snapshot = await resolveCandidateSnapshot(worktree, "session-model", reference);
		await writeFile(path.join(worktree, "candidate.txt"), "after\n");

		expect(await readFile(path.join(snapshot, "candidate.txt"), "utf8")).toBe("before\n");
		expect(await readFile(path.join(snapshot, ".git", "control"), "utf8").catch(() => null)).toBeNull();
		await expect(resolveCandidateSnapshot(worktree, "session-model", "../../escape")).rejects.toThrow(
			"Unsafe candidate snapshot reference",
		);
	});

	test("snapshotting populates read-only directories before restoring their mode", async () => {
		const worktree = await temporaryDirectory();
		const readonly = path.join(worktree, "readonly");
		await mkdir(readonly);
		await writeFile(path.join(readonly, "candidate.txt"), "captured\n");
		await chmod(readonly, 0o555);

		const reference = await captureCandidateSnapshot(worktree, "readonly-source");
		const snapshot = await resolveCandidateSnapshot(worktree, "readonly-source", reference);
		expect(await readFile(path.join(snapshot, "readonly", "candidate.txt"), "utf8")).toBe("captured\n");

		// Keep test cleanup portable; the assertion above exercises the restored mode.
		await chmod(readonly, 0o755);
		await chmod(path.join(snapshot, "readonly"), 0o755);
	});

	test("in-tree absolute symlinks are pinned inside the snapshot", async () => {
		const worktree = await temporaryDirectory();
		const target = path.join(worktree, "target.txt");
		await writeFile(target, "before\n");
		await symlink(target, path.join(worktree, "alias.txt"));

		const reference = await captureCandidateSnapshot(worktree, "internal-link");
		const snapshot = await resolveCandidateSnapshot(worktree, "internal-link", reference);
		await writeFile(target, "after\n");

		expect(path.isAbsolute(await readlink(path.join(snapshot, "alias.txt")))).toBeFalse();
		expect(await readFile(path.join(snapshot, "alias.txt"), "utf8")).toBe("before\n");
	});

	test("snapshotting rejects symlinks outside the working tree", async () => {
		const worktree = await temporaryDirectory();
		const outside = await temporaryDirectory();
		await writeFile(path.join(outside, "secret.txt"), "outside\n");
		await symlink(path.join(outside, "secret.txt"), path.join(worktree, "escape.txt"));

		await expect(captureCandidateSnapshot(worktree, "external-link")).rejects.toThrow(
			"symlink outside the working tree",
		);
	});

	test("candidate resolution rejects a replaced symlink parent", async () => {
		const worktree = await temporaryDirectory();
		await writeFile(path.join(worktree, "candidate.txt"), "captured\n");
		const sessionId = "symlink-parent";
		const reference = await captureCandidateSnapshot(worktree, sessionId);
		const candidates = path.join(sessionStateDirectory(worktree, sessionId), "candidates");
		const outside = await temporaryDirectory();
		await rm(candidates, { recursive: true });
		await symlink(outside, candidates);

		await expect(resolveCandidateSnapshot(worktree, sessionId, reference)).rejects.toThrow(
			"unsafe candidates directory",
		);
	});

	test("the per-session mutex serializes concurrent operations", async () => {
		const events: string[] = [];
		const first = withSessionLock("same", async () => {
			events.push("first:start");
			await Bun.sleep(20);
			events.push("first:end");
		});
		const second = withSessionLock("same", async () => {
			events.push("second:start");
			events.push("second:end");
		});
		await Promise.all([first, second]);
		expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"]);
	});
});

describe("ledger durability", () => {
	// The gate reads this file before every mutating tool call, including in
	// sessions that never opted into the harness. A torn or truncated write must
	// degrade to "skip that line", never to an exception in the host.
	test("a malformed line is skipped, surrounding rows survive", async () => {
		const worktree = await temporaryDirectory();
		const sid = "torn-write";
		const task: TaskRegistration = { version: 1, verify_cmd: "true", budget: 4 };
		await writeRegistration(worktree, sid, task);
		await appendLedger(worktree, sid, {
			ts: 1,
			scope: "baseline",
			actual: { pass: true, failing: [], score: 0.5 },
			cost: 1,
		});

		const ledgerPath = path.join(sessionStateDirectory(worktree, sid), "ledger.jsonl");
		await appendFile(ledgerPath, '{"ts":2,"scope":"pred\n', "utf8");
		await appendLedger(worktree, sid, {
			ts: 3,
			scope: "full",
			actual: { pass: true, failing: [] },
			cost: 1,
		});

		const rows = await readLedger(worktree, sid);
		expect(rows.map(row => row.scope)).toEqual(["baseline", "full"]);
	});

	test("an absent ledger is empty, not an error", async () => {
		const worktree = await temporaryDirectory();
		expect(await readLedger(worktree, "never-written")).toEqual([]);
	});
});
