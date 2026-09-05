import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import * as zod from "zod/v4";
import schemaHarnessExtension, { ASSERTION_REQUIRED_MESSAGE } from "../index";
import type { Prediction, TaskRegistration } from "../mechanisms";
import {
	appendLedger,
	captureCandidateSnapshot,
	readLedger,
	readWorldModel,
	writeRegistration,
	writeWorldModel,
} from "../state";

type CapturedTool = {
	name: string;
	loadMode?: string;
	parameters: zod.ZodType;
	execute: (...args: any[]) => Promise<{ details: any }>;
};

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(path.join(os.tmpdir(), "omp-schema-extension-test-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function captureTools(
	exec: ExtensionAPI["exec"] = async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
): Map<string, CapturedTool> {
	const tools = new Map<string, CapturedTool>();
	const pi = {
		zod,
		registerTool(tool: CapturedTool) {
			tools.set(tool.name, tool);
		},
		on() {},
		exec,
	} as unknown as ExtensionAPI;
	schemaHarnessExtension(pi);
	return tools;
}

function context(worktree: string, sessionId: string) {
	return {
		sessionManager: {
			getCwd: () => worktree,
			getSessionId: () => sessionId,
		},
	};
}

async function executable(worktree: string, name: string, source: string): Promise<void> {
	const filename = path.join(worktree, name);
	await writeFile(filename, source);
	await chmod(filename, 0o755);
}

describe("OMP tool boundary", () => {
	test("all harness tools stay essential while the write gate is closed", () => {
		const tools = captureTools();
		expect([...tools.keys()]).toEqual(["register_task", "set_world_model", "run_verify", "replay_verify", "predict"]);
		for (const tool of tools.values()) expect(tool.loadMode).toBe("essential");
	});

	test("predict rejects an empty assertion list with the mechanism rationale", () => {
		const predict = captureTools().get("predict");
		expect(predict).toBeDefined();
		const parsed = predict!.parameters.safeParse({
			hypothesis: "prose only",
			assertions: [],
		});
		expect(parsed.success).toBeFalse();
		if (!parsed.success) expect(parsed.error.issues[0]?.message).toBe(ASSERTION_REQUIRED_MESSAGE);
	});

	test("predict rejects metric/value type mismatches", () => {
		const predict = captureTools().get("predict");
		expect(predict).toBeDefined();
		expect(
			predict!.parameters.safeParse({
				hypothesis: "boolean disguised as a score threshold",
				assertions: [{ metric: "score", op: ">=", value: true }],
			}).success,
		).toBeFalse();
		expect(
			predict!.parameters.safeParse({
				hypothesis: "numeric pass claim",
				assertions: [{ metric: "pass", op: "==", value: 1 }],
			}).success,
		).toBeFalse();
	});
});

describe("world-model tools", () => {
	test("late opt-in is rejected without persisting a deadlocking declaration", async () => {
		const worktree = await temporaryDirectory();
		const sessionId = "late-opt-in";
		await writeRegistration(worktree, sessionId, {
			version: 1,
			verify_cmd: "true",
			budget: 2,
		});
		await appendLedger(worktree, sessionId, {
			ts: 1,
			scope: "baseline",
			actual: { pass: true, failing: [] },
			cost: 1,
		});

		const setWorldModel = captureTools().get("set_world_model")!;
		await expect(
			setWorldModel.execute(
				"call",
				{ path: "world-model.py" },
				new AbortController().signal,
				() => {},
				context(worktree, sessionId),
			),
		).rejects.toThrow("Continue this session without a world model");
		expect(await readWorldModel(worktree, sessionId)).toBeNull();
	});

	test("set_world_model rejects a predictor that invokes the real verifier", async () => {
		const worktree = await temporaryDirectory();
		const sessionId = "delegation";
		await writeRegistration(worktree, sessionId, {
			version: 1,
			verify_cmd: "./verify.sh",
			budget: 2,
		});
		await executable(worktree, "world-model.sh", "#!/bin/sh\nexec ./verify.sh\n");

		const setWorldModel = captureTools().get("set_world_model")!;
		await expect(
			setWorldModel.execute(
				"call",
				{ path: "world-model.sh" },
				new AbortController().signal,
				() => {},
				context(worktree, sessionId),
			),
		).rejects.toThrow("directly references a registered verification command");
	});

	test("set_world_model also rejects delegation to the registered score command", async () => {
		const worktree = await temporaryDirectory();
		const sessionId = "score-delegation";
		await writeRegistration(worktree, sessionId, {
			version: 1,
			verify_cmd: "./verify.sh",
			score_cmd: "bun test",
			budget: 2,
		});
		await executable(
			worktree,
			"world-model.py",
			'#!/usr/bin/env python3\nimport subprocess\nsubprocess.run(["bun", "test"])\n',
		);

		const setWorldModel = captureTools().get("set_world_model")!;
		await expect(
			setWorldModel.execute(
				"call",
				{ path: "world-model.py" },
				new AbortController().signal,
				() => {},
				context(worktree, sessionId),
			),
		).rejects.toThrow("directly references a registered verification command");
	});

	test("replay is free and leaves the verification budget and ledger unchanged", async () => {
		const worktree = await temporaryDirectory();
		const sessionId = "free-replay";
		const task: TaskRegistration = { version: 1, verify_cmd: "./verify.sh", budget: 3 };
		await writeRegistration(worktree, sessionId, task);
		await executable(worktree, "world-model.sh", "#!/bin/sh\nexit 0\n");
		const candidate = await captureCandidateSnapshot(worktree, sessionId);
		await appendLedger(worktree, sessionId, {
			ts: 1,
			scope: "baseline",
			candidate,
			actual: { pass: true, failing: [] },
			cost: 1,
		});
		await writeWorldModel(worktree, sessionId, { version: 1, path: "world-model.sh" });

		const tools = captureTools(async () => ({
			stdout: '{"pass":true,"failing":[]}\n',
			stderr: "",
			code: 0,
			killed: false,
		}));
		const before = await readLedger(worktree, sessionId);
		const result = await tools
			.get("replay_verify")!
			.execute("call", {}, new AbortController().signal, () => {}, context(worktree, sessionId));

		expect(result.details).toMatchObject({
			reproduced: "1/1",
			green: true,
			cost: 0,
			budget: { used: 1, total: 3, remaining: 2 },
		});
		expect(await readLedger(worktree, sessionId)).toEqual(before);
	});

	test("run_verify records a full predicted observation mismatch as a surprise", async () => {
		const worktree = await temporaryDirectory();
		const sessionId = "observation-surprise";
		const task: TaskRegistration = { version: 1, verify_cmd: "./verify.sh", budget: 2 };
		const openPrediction: Prediction = {
			hypothesis: "the verifier passes",
			assertions: [{ metric: "pass", op: "==", value: true }],
			ts: 2,
		};
		await writeRegistration(worktree, sessionId, task);
		await executable(worktree, "world-model.sh", "#!/bin/sh\nexit 0\n");
		const baselineCandidate = await captureCandidateSnapshot(worktree, sessionId);
		await appendLedger(worktree, sessionId, {
			ts: 1,
			scope: "baseline",
			candidate: baselineCandidate,
			actual: { pass: true, failing: [] },
			cost: 1,
		});
		await appendLedger(worktree, sessionId, {
			ts: 2,
			scope: "predict",
			prediction: openPrediction,
		});
		await writeWorldModel(worktree, sessionId, { version: 1, path: "world-model.sh" });

		let worldModelCalls = 0;
		const tools = captureTools(async command => {
			if (command === "bash") return { stdout: "ok\n", stderr: "", code: 0, killed: false };
			worldModelCalls += 1;
			return {
				stdout:
					worldModelCalls === 1 ? '{"pass":true,"failing":[]}\n' : '{"pass":false,"failing":["FAIL predicted"]}\n',
				stderr: "",
				code: 0,
				killed: false,
			};
		});
		const result = await tools
			.get("run_verify")!
			.execute("call", { scope: "full" }, new AbortController().signal, () => {}, context(worktree, sessionId));

		expect(result.details.surprise).toMatchObject({
			kind: "assertion_failed",
		});
		expect(result.details.surprise.detail).toContain("World model predicted pass false, observed true");
		const row = (await readLedger(worktree, sessionId)).at(-1);
		expect(row).toMatchObject({
			scope: "full",
			predicted: { pass: false, failing: ["FAIL predicted"] },
			actual: { pass: true, failing: [] },
			surprise: { kind: "assertion_failed" },
			cost: 1,
		});
	});

	test("verification does not inspect or snapshot candidates before world-model opt-in", async () => {
		const worktree = await temporaryDirectory();
		const sessionId = "no-model-fifo";
		await writeRegistration(worktree, sessionId, {
			version: 1,
			verify_cmd: "true",
			budget: 1,
		});
		const fifo = path.join(worktree, "candidate.fifo");
		const mkfifo = Bun.spawn(["mkfifo", fifo]);
		expect(await mkfifo.exited).toBe(0);

		const tools = captureTools(async command => {
			expect(command).toBe("bash");
			return { stdout: "", stderr: "", code: 0, killed: false };
		});
		const result = await tools
			.get("run_verify")!
			.execute("call", { scope: "baseline" }, new AbortController().signal, () => {}, context(worktree, sessionId));

		expect(result.details).toMatchObject({
			scope: "baseline",
			actual: { pass: true, failing: [] },
			budget: { used: 1, total: 1, remaining: 0 },
		});
		expect((await readLedger(worktree, sessionId))[0]).not.toHaveProperty("candidate");
		expect(await lstat(path.join(worktree, ".schema", sessionId, "candidates")).catch(() => null)).toBeNull();
	});
});
