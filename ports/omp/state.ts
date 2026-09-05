import { constants } from "node:fs";
import {
	chmod,
	copyFile,
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	readlink,
	realpath,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { LedgerRow, LedgerRowInput, TaskRegistration, WorldModelRegistration } from "./mechanisms";

const locks = new Map<string, Promise<void>>();

// The user-required worktree ledger is an auditable coordination record, not a
// security boundary against a task that deliberately rewrites its own .schema
// files. Moving the authority elsewhere would violate the reference layout.

function isMissing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function validateSessionId(sessionId: string): void {
	if (
		!sessionId ||
		sessionId === "." ||
		sessionId === ".." ||
		sessionId.includes("/") ||
		sessionId.includes("\\") ||
		sessionId.includes("\0")
	) {
		throw new Error(`Unsafe OMP session id: ${JSON.stringify(sessionId)}`);
	}
}

export function sessionStateDirectory(worktree: string, sessionId: string): string {
	validateSessionId(sessionId);
	return path.join(path.resolve(worktree), ".schema", sessionId);
}

async function ensureDirectory(directory: string): Promise<void> {
	try {
		const info = await lstat(directory);
		if (info.isSymbolicLink() || !info.isDirectory()) {
			throw new Error(`Refusing unsafe schema directory: ${directory}`);
		}
	} catch (error) {
		if (!isMissing(error)) throw error;
		try {
			await mkdir(directory, { mode: 0o700 });
		} catch (mkdirError) {
			if (!(mkdirError instanceof Error && "code" in mkdirError && mkdirError.code === "EEXIST")) {
				throw mkdirError;
			}
		}
		const info = await lstat(directory);
		if (info.isSymbolicLink() || !info.isDirectory()) {
			throw new Error(`Refusing unsafe schema directory: ${directory}`);
		}
	}
}

async function ensureSessionDirectory(worktree: string, sessionId: string): Promise<string> {
	await ensureDirectory(path.join(path.resolve(worktree), ".schema"));
	const directory = sessionStateDirectory(worktree, sessionId);
	await ensureDirectory(directory);
	return directory;
}

export async function readRegistration(worktree: string, sessionId: string): Promise<TaskRegistration | null> {
	const filename = path.join(sessionStateDirectory(worktree, sessionId), "run.json");
	try {
		return JSON.parse(await readFile(filename, "utf8")) as TaskRegistration;
	} catch (error) {
		if (isMissing(error)) return null;
		throw error;
	}
}

export async function writeRegistration(
	worktree: string,
	sessionId: string,
	registration: TaskRegistration,
): Promise<void> {
	const directory = await ensureSessionDirectory(worktree, sessionId);
	const destination = path.join(directory, "run.json");
	const temporary = path.join(directory, `run.${process.pid}.${crypto.randomUUID()}.tmp`);
	await writeFile(temporary, `${JSON.stringify(registration, null, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
		flag: "wx",
	});
	await rename(temporary, destination);
}

export async function readWorldModel(worktree: string, sessionId: string): Promise<WorldModelRegistration | null> {
	const filename = path.join(sessionStateDirectory(worktree, sessionId), "world-model.json");
	try {
		return JSON.parse(await readFile(filename, "utf8")) as WorldModelRegistration;
	} catch (error) {
		if (isMissing(error)) return null;
		throw error;
	}
}

export async function writeWorldModel(
	worktree: string,
	sessionId: string,
	worldModel: WorldModelRegistration,
): Promise<void> {
	const directory = await ensureSessionDirectory(worktree, sessionId);
	const destination = path.join(directory, "world-model.json");
	const temporary = path.join(directory, `world-model.${process.pid}.${crypto.randomUUID()}.tmp`);
	await writeFile(temporary, `${JSON.stringify(worldModel, null, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
		flag: "wx",
	});
	await rename(temporary, destination);
}

function containsPath(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function cloneCandidateTree(
	source: string,
	destination: string,
	sourceRoot: string,
	destinationRoot: string,
): Promise<void> {
	const info = await lstat(source);
	if (info.isDirectory()) {
		// Keep the destination writable while populating it. Restoring a source
		// mode such as 0555 before recursion would make the copy fail.
		await mkdir(destination, { mode: 0o700 });
		for (const name of await readdir(source)) {
			await cloneCandidateTree(path.join(source, name), path.join(destination, name), sourceRoot, destinationRoot);
		}
		await chmod(destination, info.mode & 0o777);
		return;
	}
	if (info.isFile()) {
		await copyFile(source, destination, constants.COPYFILE_FICLONE);
		await chmod(destination, info.mode & 0o777);
		return;
	}
	if (info.isSymbolicLink()) {
		const originalTarget = await readlink(source);
		let canonicalTarget: string;
		try {
			canonicalTarget = await realpath(source);
		} catch {
			throw new Error(`Cannot snapshot dangling or cyclic symlink: ${source}`);
		}
		if (!containsPath(sourceRoot, canonicalTarget)) {
			throw new Error(`Cannot snapshot symlink outside the working tree: ${source} -> ${originalTarget}`);
		}
		const targetReference = path.relative(sourceRoot, canonicalTarget);
		const firstSegment = targetReference.split(path.sep)[0];
		if (firstSegment === ".git" || firstSegment === ".schema") {
			throw new Error(`Cannot snapshot symlink into excluded control state: ${source} -> ${originalTarget}`);
		}
		const snapshotTarget = path.join(destinationRoot, targetReference);
		await symlink(path.relative(path.dirname(destination), snapshotTarget) || ".", destination);
		return;
	}
	throw new Error(`Cannot snapshot non-file candidate entry: ${source}`);
}

async function makeTreeRemovable(entry: string): Promise<void> {
	const info = await lstat(entry);
	if (!info.isDirectory() || info.isSymbolicLink()) return;
	await chmod(entry, 0o700);
	for (const name of await readdir(entry)) {
		await makeTreeRemovable(path.join(entry, name));
	}
}

/**
 * Capture the verifier input before spending an evaluation. Git and harness
 * state are control metadata, not candidate content, so only those two roots are
 * excluded. COPYFILE_FICLONE keeps repeated snapshots cheap on CoW filesystems
 * and safely falls back to a normal copy elsewhere.
 */
export async function captureCandidateSnapshot(worktree: string, sessionId: string): Promise<string> {
	const sessionDirectory = await ensureSessionDirectory(worktree, sessionId);
	const candidatesDirectory = path.join(sessionDirectory, "candidates");
	const worktreeRoot = await realpath(worktree);
	await ensureDirectory(candidatesDirectory);

	const snapshotId = crypto.randomUUID();
	const temporary = path.join(candidatesDirectory, `.snapshot.${snapshotId}.tmp`);
	const destination = path.join(candidatesDirectory, snapshotId);
	await mkdir(temporary, { mode: 0o700 });

	try {
		for (const name of await readdir(worktreeRoot)) {
			if (name === ".git" || name === ".schema") continue;
			await cloneCandidateTree(path.join(worktreeRoot, name), path.join(temporary, name), worktreeRoot, temporary);
		}
		await chmod(temporary, (await lstat(worktreeRoot)).mode & 0o777);
		await rename(temporary, destination);
		return path.posix.join("candidates", snapshotId);
	} catch (error) {
		await makeTreeRemovable(temporary).catch(() => {});
		await rm(temporary, { recursive: true, force: true });
		throw error;
	}
}

export async function resolveCandidateSnapshot(
	worktree: string,
	sessionId: string,
	reference: string,
): Promise<string> {
	const match = /^candidates\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.exec(reference);
	if (!match) {
		throw new Error(`Unsafe candidate snapshot reference: ${JSON.stringify(reference)}`);
	}

	const canonicalWorktree = await realpath(worktree);
	const sessionDirectory = sessionStateDirectory(worktree, sessionId);
	const canonicalSession = await realpath(sessionDirectory);
	const expectedSession = path.join(canonicalWorktree, ".schema", sessionId);
	if (canonicalSession !== expectedSession) {
		throw new Error(`Refusing unsafe schema session directory: ${sessionDirectory}`);
	}

	const candidatesDirectory = path.join(sessionDirectory, "candidates");
	const candidatesInfo = await lstat(candidatesDirectory);
	if (candidatesInfo.isSymbolicLink() || !candidatesInfo.isDirectory()) {
		throw new Error(`Refusing unsafe candidates directory: ${candidatesDirectory}`);
	}
	const canonicalCandidates = await realpath(candidatesDirectory);
	if (canonicalCandidates !== path.join(canonicalSession, "candidates")) {
		throw new Error(`Refusing unsafe candidates directory: ${candidatesDirectory}`);
	}

	const resolved = path.join(candidatesDirectory, match[1]!);
	const info = await lstat(resolved);
	if (info.isSymbolicLink() || !info.isDirectory()) {
		throw new Error(`Refusing unsafe candidate snapshot: ${resolved}`);
	}
	const canonicalResolved = await realpath(resolved);
	if (path.dirname(canonicalResolved) !== canonicalCandidates) {
		throw new Error(`Refusing unsafe candidate snapshot: ${resolved}`);
	}
	return canonicalResolved;
}

export async function readLedger(worktree: string, sessionId: string): Promise<LedgerRow[]> {
	const filename = path.join(sessionStateDirectory(worktree, sessionId), "ledger.jsonl");
	try {
		const content = await readFile(filename, "utf8");
		if (!content.trim()) return [];
		// Skip unparseable lines rather than throwing. The ledger is append-only and
		// read from a gate that runs before every mutating tool call: one torn write
		// must not be able to take down the host session.
		const rows: LedgerRow[] = [];
		for (const line of content.split(/\r?\n/)) {
			if (!line.trim()) continue;
			try {
				rows.push(JSON.parse(line) as LedgerRow);
			} catch {
				// ignore
			}
		}
		return rows;
	} catch (error) {
		if (isMissing(error)) return [];
		throw error;
	}
}

export async function appendLedger(worktree: string, sessionId: string, input: LedgerRowInput): Promise<LedgerRow> {
	const directory = await ensureSessionDirectory(worktree, sessionId);
	const ledger = await readLedger(worktree, sessionId);
	const row = { ...input, step: ledger.length + 1 } as LedgerRow;
	const file = await open(
		path.join(directory, "ledger.jsonl"),
		constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
		0o600,
	);
	try {
		await file.writeFile(`${JSON.stringify(row)}\n`, "utf8");
	} finally {
		await file.close();
	}
	return row;
}

export async function withSessionLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
	const previous = locks.get(key) ?? Promise.resolve();
	let release!: () => void;
	const current = new Promise<void>(resolve => {
		release = resolve;
	});
	const tail = previous.then(() => current);
	locks.set(key, tail);
	await previous;

	try {
		return await operation();
	} finally {
		release();
		if (locks.get(key) === tail) locks.delete(key);
	}
}
