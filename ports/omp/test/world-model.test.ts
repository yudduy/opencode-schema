import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { captureCandidateSnapshot, resolveCandidateSnapshot } from "../state";
import { executeWorldModel, macosWorldModelProfile, offlineWorldModelInvocation } from "../world-model";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(path.join(os.tmpdir(), "omp-schema-world-model-test-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("offline world-model invocation", () => {
	test("macOS exposes system runtimes plus only the model and candidate from task state", () => {
		const profile = macosWorldModelProfile("/work/model", "/work/.schema/session/candidate");
		const invocation = offlineWorldModelInvocation(
			"/work/model",
			"/work/.schema/session/candidate",
			"/work",
			"darwin",
		);

		expect(invocation.command).toBe("/usr/bin/sandbox-exec");
		expect(profile).toContain("(deny network*)");
		expect(profile).toContain("(deny file-write*)");
		expect(profile).toContain('(subpath "/usr/bin")');
		expect(profile).toContain('(literal "/work/model")');
		expect(profile).toContain('(subpath "/work/.schema/session/candidate")');
		expect(invocation.args).toContain(profile);
		expect(invocation.args.slice(-2)).toEqual(["/work/model", "/work/.schema/session/candidate"]);
	});

	test("Linux builds an allowlisted root from runtimes, model, and candidate", () => {
		const invocation = offlineWorldModelInvocation("/work/model", "/work/history/candidate", "/work", "linux");
		expect(invocation.command).toBe("/usr/bin/bwrap");
		expect(invocation.args).toContain("--unshare-all");
		expect(invocation.args).toContain("--tmpfs");
		expect(invocation.args).toContain("--ro-bind-try");
		expect(invocation.args).toContain("/run");
		expect(invocation.args).toContain("/world-model");
		expect(invocation.args).toContain("/candidate");
		expect(invocation.args.join("\0")).not.toContain("--ro-bind\0/\0/");
		expect(invocation.args.slice(-2)).toEqual(["/world-model", "/candidate"]);
	});

	test("unsupported platforms fail closed", () => {
		expect(() => offlineWorldModelInvocation("/work/model", "/history/candidate", "/work", "win32")).toThrow(
			"unsupported platform",
		);
	});

	test.skipIf(process.platform !== "darwin")(
		"the macOS sandbox exposes the snapshot but hides live and unrelated host data",
		async () => {
			const worktree = await temporaryDirectory();
			const liveAnswer = path.join(worktree, "live-answer.txt");
			const outside = await temporaryDirectory();
			const hostSecret = path.join(outside, "host-secret.txt");
			await writeFile(liveAnswer, "secret actual result\n");
			await writeFile(hostSecret, "unrelated host data\n");
			const model = path.join(worktree, "world-model.py");
			await writeFile(
				model,
				[
					"#!/usr/bin/env python3",
					"import json",
					"import pathlib",
					"import sys",
					"candidate = pathlib.Path(sys.argv[1])",
					"try:",
					`    pathlib.Path(${JSON.stringify(liveAnswer)}).read_text()`,
					"    live_hidden = False",
					"except OSError:",
					"    live_hidden = True",
					"try:",
					`    pathlib.Path(${JSON.stringify(hostSecret)}).read_text()`,
					"    host_hidden = False",
					"except OSError:",
					"    host_hidden = True",
					"snapshot_visible = (candidate / 'live-answer.txt').read_text().strip() == 'secret actual result'",
					"ok = live_hidden and host_hidden and snapshot_visible",
					"failing = []",
					"if not live_hidden:",
					"    failing.append('FAIL live worktree visible')",
					"if not host_hidden:",
					"    failing.append('FAIL unrelated host data visible')",
					"if not snapshot_visible:",
					"    failing.append('FAIL snapshot hidden')",
					"print(json.dumps({'pass': ok, 'failing': failing}))",
					"",
				].join("\n"),
			);
			await chmod(model, 0o755);
			const reference = await captureCandidateSnapshot(worktree, "sandbox");
			const candidate = await resolveCandidateSnapshot(worktree, "sandbox", reference);

			const pi = {
				async exec(command: string, args: string[], options: { cwd?: string }) {
					const child = Bun.spawn([command, ...args], {
						cwd: options.cwd,
						stdout: "pipe",
						stderr: "pipe",
					});
					const [stdout, stderr, code] = await Promise.all([
						new Response(child.stdout).text(),
						new Response(child.stderr).text(),
						child.exited,
					]);
					return { stdout, stderr, code, killed: false };
				},
			} as Pick<ExtensionAPI, "exec">;

			expect(
				await executeWorldModel(pi, worktree, { version: 1, path: "world-model.py" }, ["./verify.sh"], candidate),
			).toEqual({ pass: true, failing: [] });
		},
	);
});
