import { constants, realpathSync } from "node:fs";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
	obviouslyInvokesVerifier,
	parseWorldModelOutput,
	type VerificationActual,
	type WorldModelRegistration,
} from "./mechanisms";

const WORLD_MODEL_TIMEOUT_MS = 60_000;
const SANDBOX_PROBE_TIMEOUT_MS = 5_000;
const MACOS_PATH = "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const LINUX_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin";
const MACOS_RUNTIME_ROOTS = [
	"/Library/Frameworks",
	"/Library/Java",
	"/System",
	"/bin",
	"/opt/homebrew/Cellar",
	"/opt/homebrew/bin",
	"/opt/homebrew/lib",
	"/opt/homebrew/opt",
	"/opt/homebrew/sbin",
	"/opt/homebrew/share",
	"/private/var/select",
	"/sbin",
	"/usr/bin",
	"/usr/lib",
	"/usr/libexec",
	"/usr/local/bin",
	"/usr/local/lib",
	"/usr/local/share",
	"/usr/sbin",
	"/usr/share",
];
const MACOS_RUNTIME_FILES = ["/dev/null", "/dev/urandom"];
const LINUX_RUNTIME_ROOTS = ["/usr", "/bin", "/sbin", "/lib", "/lib64"];
const LINUX_RUNTIME_FILES = [
	"/etc/ld.so.cache",
	"/etc/ld.so.conf",
	"/etc/ld.so.conf.d",
	"/etc/alternatives",
	"/etc/localtime",
];

export type WorldModelInvocation = {
	command: string;
	args: string[];
};

function schemeLiteral(value: string): string {
	return JSON.stringify(value);
}

function canonicalPath(value: string): string {
	try {
		return realpathSync(value);
	} catch {
		return path.resolve(value);
	}
}

function parentPaths(value: string): string[] {
	const parents: string[] = [];
	let current = path.dirname(value);
	while (true) {
		parents.push(current);
		const parent = path.dirname(current);
		if (parent === current) return parents;
		current = parent;
	}
}

export function macosWorldModelProfile(executable: string, candidate: string): string {
	const metadataPaths = [
		...new Set([...MACOS_RUNTIME_ROOTS, ...MACOS_RUNTIME_FILES, executable, candidate].flatMap(parentPaths)),
	];
	return [
		"(version 1)",
		"(deny default)",
		"(deny network*)",
		"(deny file-write*)",
		"(allow process*)",
		`(allow file-read-data (literal ${schemeLiteral(path.parse(executable).root)}))`,
		`(allow file-read-metadata ${metadataPaths.map(value => `(literal ${schemeLiteral(value)})`).join(" ")})`,
		`(allow file-read* ${MACOS_RUNTIME_ROOTS.map(root => `(subpath ${schemeLiteral(root)})`).join(" ")} ${MACOS_RUNTIME_FILES.map(file => `(literal ${schemeLiteral(file)})`).join(" ")})`,
		`(allow file-read* (literal ${schemeLiteral(executable)}) (subpath ${schemeLiteral(candidate)}))`,
	].join("\n");
}

export function offlineWorldModelInvocation(
	executable: string,
	candidate: string,
	worktree: string,
	platform: NodeJS.Platform = process.platform,
): WorldModelInvocation {
	const resolvedWorktree = canonicalPath(worktree);
	if (resolvedWorktree === path.parse(resolvedWorktree).root) {
		throw new Error("World-model worktree cannot be the filesystem root.");
	}

	if (platform === "darwin") {
		return {
			command: "/usr/bin/sandbox-exec",
			args: [
				"-p",
				macosWorldModelProfile(executable, candidate),
				"/usr/bin/env",
				"-i",
				`PATH=${MACOS_PATH}`,
				"HOME=/nonexistent",
				"TMPDIR=/tmp",
				"PYTHONDONTWRITEBYTECODE=1",
				"PYTHONHASHSEED=0",
				"LANG=C",
				executable,
				candidate,
			],
		};
	}
	if (platform === "linux") {
		return {
			command: "/usr/bin/bwrap",
			args: [
				"--die-with-parent",
				"--new-session",
				"--unshare-all",
				...LINUX_RUNTIME_ROOTS.flatMap(root => ["--ro-bind-try", root, root]),
				...LINUX_RUNTIME_FILES.flatMap(file => ["--ro-bind-try", file, file]),
				"--ro-bind",
				executable,
				"/world-model",
				"--ro-bind",
				candidate,
				"/candidate",
				"--dir",
				"/run",
				"--proc",
				"/proc",
				"--dev",
				"/dev",
				"--tmpfs",
				"/tmp",
				"--clearenv",
				"--setenv",
				"PATH",
				LINUX_PATH,
				"--setenv",
				"HOME",
				"/nonexistent",
				"--setenv",
				"TMPDIR",
				"/tmp",
				"--setenv",
				"PYTHONDONTWRITEBYTECODE",
				"1",
				"--setenv",
				"PYTHONHASHSEED",
				"0",
				"--setenv",
				"LANG",
				"C",
				"--chdir",
				"/candidate",
				"--",
				"/world-model",
				"/candidate",
			],
		};
	}
	throw new Error(`World models require an offline read-only sandbox; unsupported platform: ${platform}.`);
}

export async function assertWorldModelSandboxAvailable(
	pi: Pick<ExtensionAPI, "exec">,
	worktree: string,
	platform: NodeJS.Platform = process.platform,
): Promise<void> {
	const invocation = offlineWorldModelInvocation("/usr/bin/true", worktree, worktree, platform);
	try {
		await access(invocation.command, constants.X_OK);
	} catch {
		throw new Error(`World-model sandbox is unavailable: expected executable ${invocation.command}.`);
	}
	const result = await pi.exec(invocation.command, invocation.args, {
		cwd: worktree,
		timeout: SANDBOX_PROBE_TIMEOUT_MS,
	});
	if (result.killed || result.code !== 0) {
		const detail = result.stderr.trim().slice(0, 300);
		throw new Error(`World-model sandbox probe failed${detail ? `: ${detail}` : ` with exit code ${result.code}`}.`);
	}
}

export async function validateWorldModelExecutable(
	worktree: string,
	worldModelPath: string,
	registeredCommands: readonly string[],
): Promise<{ absolutePath: string; registration: WorldModelRegistration }> {
	if (path.isAbsolute(worldModelPath)) {
		throw new Error("World-model path must be relative to the working tree.");
	}

	const canonicalWorktree = await realpath(worktree);
	const requested = path.resolve(canonicalWorktree, worldModelPath);
	const info = await lstat(requested);
	if (info.isSymbolicLink() || !info.isFile()) {
		throw new Error("World-model path must name a regular, non-symlink executable file.");
	}
	const absolutePath = await realpath(requested);
	if (!absolutePath.startsWith(`${canonicalWorktree}${path.sep}`)) {
		throw new Error("World-model path must stay inside the working tree.");
	}
	try {
		await access(absolutePath, constants.X_OK);
	} catch {
		throw new Error("World-model file must be executable.");
	}

	const source = (await readFile(absolutePath)).toString("utf8");
	if (registeredCommands.some(command => obviouslyInvokesVerifier(source, command))) {
		throw new Error("World model rejected: it directly references a registered verification command.");
	}

	return {
		absolutePath,
		registration: {
			version: 1,
			path: path.relative(canonicalWorktree, absolutePath),
		},
	};
}

export async function executeWorldModel(
	pi: Pick<ExtensionAPI, "exec">,
	worktree: string,
	worldModel: WorldModelRegistration,
	registeredCommands: readonly string[],
	candidate: string,
	signal?: AbortSignal,
): Promise<VerificationActual> {
	const validated = await validateWorldModelExecutable(worktree, worldModel.path, registeredCommands);
	const invocation = offlineWorldModelInvocation(validated.absolutePath, candidate, worktree);
	const result = await pi.exec(invocation.command, invocation.args, {
		cwd: candidate,
		signal,
		timeout: WORLD_MODEL_TIMEOUT_MS,
	});
	if (result.killed) throw new Error("World model timed out.");
	if (result.code !== 0) {
		const detail = result.stderr.trim().slice(0, 300);
		throw new Error(`World model exited ${result.code}${detail ? `: ${detail}` : ""}.`);
	}
	return parseWorldModelOutput(result.stdout);
}
