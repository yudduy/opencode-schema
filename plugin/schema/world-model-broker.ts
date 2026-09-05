#!/usr/bin/env bun

import { constants } from "node:fs"
import {
  access,
  lstat,
  mkdtemp,
  open,
  opendir,
  readlink,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises"
import { randomBytes } from "node:crypto"
import path from "node:path"
import { obviouslyInvokesVerifier } from "./mechanisms.ts"
import {
  resolveCandidateSnapshot,
  runFile,
  worldModelFile,
  type Benchmark,
  type RunState,
  type WorldModelRegistration,
} from "./state.ts"
import {
  assertWorldModelSandboxAvailable,
  offlineWorldModelInvocation,
  runWorldModelProcess,
  SANDBOX_PROBE_TIMEOUT_MS,
  WORLD_MODEL_TIMEOUT_MS,
  type WorldModelBrokerRequest,
  type WorldModelProcessResult,
} from "./world-model.ts"

const MAX_REQUEST_BYTES = 16 * 1024
const MAX_ERROR_BYTES = 1_000
const MAX_MODEL_BYTES = 1_000_000
const MAX_STATE_BYTES = 1_000_000
const MAX_SNAPSHOT_DEPTH = 64
const MAX_SNAPSHOT_ENTRIES = 10_000
const UNSAFE_EXECUTION_ERROR =
  "World-model broker rejected unsafe execution state"
const SNAPSHOT_PATTERN =
  /^\.schema\/([^/\\\0]+)\/candidates\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/

type BrokerOptions = {
  workspace: string
  privateDir: string
  readyFile?: string
  parentPid?: number
}

export type WorldModelBroker = {
  url: string
  closed: Promise<void>
  close(): Promise<void>
}

function exceptionMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  })
}

function errorResponse(status: number, error: unknown): Response {
  return jsonResponse(
    { error: exceptionMessage(error).slice(0, MAX_ERROR_BYTES) },
    status,
  )
}

function containsPath(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  )
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error("World-model broker request has unexpected fields.")
  }
}

async function readBrokerState<T>(
  filename: string,
  label: string,
  signal?: AbortSignal,
): Promise<T | null> {
  if (signal?.aborted) throw new Error("World-model broker request aborted.")
  let file
  try {
    file = await open(
      filename,
      constants.O_RDONLY |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
    )
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null
    }
    throw new Error(`World-model broker found unsafe ${label}.`)
  }

  try {
    const descriptorPath = await realpath(
      process.platform === "linux"
        ? `/proc/self/fd/${file.fd}`
        : `/dev/fd/${file.fd}`,
    )
    const info = await file.stat()
    if (
      descriptorPath !== filename ||
      !info.isFile() ||
      info.nlink !== 1 ||
      info.size > MAX_STATE_BYTES
    ) {
      throw new Error(`World-model broker found unsafe ${label}.`)
    }
    const contents = Buffer.alloc(MAX_STATE_BYTES + 1)
    let length = 0
    while (length < contents.length) {
      if (signal?.aborted) {
        throw new Error("World-model broker request aborted.")
      }
      const { bytesRead } = await file.read(
        contents,
        length,
        contents.length - length,
        null,
      )
      if (bytesRead === 0) break
      length += bytesRead
    }
    if (length > MAX_STATE_BYTES) {
      throw new Error(`World-model broker found oversized ${label}.`)
    }
    try {
      return JSON.parse(contents.subarray(0, length).toString("utf8")) as T
    } catch {
      throw new Error(`World-model broker found invalid ${label} JSON.`)
    }
  } finally {
    await file.close()
  }
}

function parseRequest(value: unknown): WorldModelBrokerRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("World-model broker request must be one JSON object.")
  }
  const request = value as Record<string, unknown>
  if (request.action === "probe") {
    assertExactKeys(request, ["action"])
    return { action: "probe" }
  }
  if (request.action === "execute") {
    assertExactKeys(request, ["action", "candidate"])
    if (typeof request.candidate !== "string" || request.candidate.length === 0) {
      throw new Error("World-model broker candidate must be a non-empty string.")
    }
    return {
      action: "execute",
      candidate: request.candidate,
    }
  }
  throw new Error("Unknown world-model broker action.")
}

async function assertSafeSnapshotEntry(
  snapshotRoot: string,
  entry: string,
  signal: AbortSignal,
  state: { entries: number },
  depth = 0,
): Promise<void> {
  if (signal.aborted) throw new Error("World-model broker request aborted.")
  state.entries += 1
  if (
    state.entries > MAX_SNAPSHOT_ENTRIES ||
    depth > MAX_SNAPSHOT_DEPTH
  ) {
    throw new Error("World-model candidate exceeds broker scan limits.")
  }
  const info = await lstat(entry)
  if (info.isFile()) {
    if (info.nlink !== 1) {
      throw new Error(
        `World-model candidate contains a multiply-linked file: ${entry}`,
      )
    }
    return
  }
  if (info.isDirectory() && !info.isSymbolicLink()) {
    const directory = await opendir(entry)
    try {
      while (true) {
        if (signal.aborted) {
          throw new Error("World-model broker request aborted.")
        }
        const child = await directory.read()
        if (!child) break
        await assertSafeSnapshotEntry(
          snapshotRoot,
          path.join(entry, child.name),
          signal,
          state,
          depth + 1,
        )
      }
    } finally {
      try {
        await directory.close()
      } catch {
        // Reading to EOF closes the directory on some runtimes.
      }
    }
    return
  }
  if (info.isSymbolicLink()) {
    const unsafeLink = new Error(
      `World-model candidate contains an unsafe symlink: ${entry}`,
    )
    let link: string
    try {
      link = await readlink(entry)
    } catch {
      throw unsafeLink
    }
    const lexicalTarget = path.resolve(path.dirname(entry), link)
    if (!containsPath(snapshotRoot, lexicalTarget)) throw unsafeLink
    let target: string
    try {
      target = await realpath(entry)
    } catch {
      throw unsafeLink
    }
    if (!containsPath(snapshotRoot, target)) throw unsafeLink
    return
  }
  throw new Error(
    `World-model candidate contains an unsupported filesystem entry: ${entry}`,
  )
}

async function validateBrokerWorldModel(
  workspace: string,
  registration: WorldModelRegistration,
  registeredCommands: readonly string[],
  signal: AbortSignal,
): Promise<string> {
  if (
    registration.version !== 1 ||
    typeof registration.path !== "string" ||
    registration.path.length === 0 ||
    path.isAbsolute(registration.path)
  ) {
    throw new Error("World-model broker found an invalid registration.")
  }

  const requested = path.resolve(workspace, registration.path)
  return inspectBrokerWorldModel(
    requested,
    registeredCommands,
    signal,
    (executable) => {
      const relative = path.relative(workspace, executable)
      return (
        relative !== "" &&
        relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative) &&
        relative === registration.path
      )
    },
  )
}

async function inspectBrokerWorldModel(
  requested: string,
  registeredCommands: readonly string[],
  signal: AbortSignal,
  pathIsSafe: (executable: string) => boolean,
): Promise<string> {
  let file
  try {
    file = await open(
      requested,
      constants.O_RDONLY |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
    )
  } catch {
    throw new Error("World-model broker found an unsafe executable.")
  }

  try {
    if (signal.aborted) {
      throw new Error("World-model broker request aborted.")
    }
    const executable = await realpath(
      process.platform === "linux"
        ? `/proc/self/fd/${file.fd}`
        : `/dev/fd/${file.fd}`,
    )
    const info = await file.stat()
    if (
      !pathIsSafe(executable) ||
      !info.isFile() ||
      info.nlink !== 1 ||
      info.size > MAX_MODEL_BYTES ||
      (info.mode & 0o111) === 0
    ) {
      throw new Error("World-model broker found an unsafe executable.")
    }

    const contents = Buffer.alloc(MAX_MODEL_BYTES + 1)
    let length = 0
    while (length < contents.length) {
      if (signal.aborted) {
        throw new Error("World-model broker request aborted.")
      }
      const { bytesRead } = await file.read(
        contents,
        length,
        contents.length - length,
        null,
      )
      if (bytesRead === 0) break
      length += bytesRead
    }
    if (length > MAX_MODEL_BYTES) {
      throw new Error("World-model broker found an oversized executable.")
    }
    const source = contents.subarray(0, length).toString("utf8")
    if (
      registeredCommands.some((command) =>
        obviouslyInvokesVerifier(source, command),
      )
    ) {
      throw new Error(
        "World model rejected: it directly references a registered verification command.",
      )
    }
    return executable
  } finally {
    await file.close()
  }
}

async function resolveBrokerExecutionUnsafe(
  workspace: string,
  request: Extract<WorldModelBrokerRequest, { action: "execute" }>,
  signal: AbortSignal,
): Promise<{
  executable: string
  candidate: string
  commands: string[]
}> {
  const match = SNAPSHOT_PATTERN.exec(request.candidate)
  if (!match) {
    throw new Error(
      "World-model broker candidate must be a canonical schema snapshot path.",
    )
  }
  const candidate = await resolveCandidateSnapshot(
    workspace,
    match[1],
    `candidates/${match[2]}`,
  )
  const candidateRelative = path
    .relative(workspace, candidate)
    .split(path.sep)
    .join(path.posix.sep)
  if (candidateRelative !== request.candidate) {
    throw new Error(
      "World-model broker candidate must use its canonical schema snapshot path.",
    )
  }
  // This early scan preserves candidate-first diagnostics. The authoritative
  // scan happens again only after the exact directory entry has been moved into
  // the broker-private staging directory.
  await assertSafeSnapshotEntry(
    candidate,
    candidate,
    signal,
    { entries: 0 },
  )
  const run = await readBrokerState<RunState>(
    runFile(workspace, match[1]),
    "run state",
    signal,
  )
  const worldModel = await readBrokerState<WorldModelRegistration>(
    worldModelFile(workspace, match[1]),
    "world-model state",
    signal,
  )
  if (!run?.benchmark || !worldModel) {
    throw new Error(
      "World-model broker requires a registered benchmark and world model for the candidate session.",
    )
  }
  const commands = registeredVerificationCommands(run.benchmark)
  const executable = await validateBrokerWorldModel(
    workspace,
    worldModel,
    commands,
    signal,
  )
  return { executable, candidate, commands }
}

type StagedBrokerExecution = {
  executable: string
  candidate: string
  restore(): Promise<void>
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? String(error.code)
    : undefined
}

async function restoreStagedEntry(
  staged: string,
  original: string,
  quarantine: string,
): Promise<void> {
  let quarantined = false
  try {
    await rename(original, quarantine)
    quarantined = true
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error
  }

  try {
    await rename(staged, original)
  } catch (error) {
    if (quarantined) {
      await rename(quarantine, original).catch(() => {})
    }
    throw error
  }
  if (quarantined) {
    await rm(quarantine, { recursive: true, force: true })
  }
}

async function stageBrokerExecution(
  privateDir: string,
  resolved: Awaited<ReturnType<typeof resolveBrokerExecution>>,
  signal: AbortSignal,
): Promise<StagedBrokerExecution> {
  const requestDir = await mkdtemp(path.join(privateDir, "request-"))
  const stagedExecutable = path.join(requestDir, "world-model")
  const stagedCandidate = path.join(requestDir, "candidate")
  let executableMoved = false
  let candidateMoved = false
  let restored = false

  const restore = async (): Promise<void> => {
    if (restored) return
    restored = true
    const errors: unknown[] = []
    if (candidateMoved) {
      try {
        await restoreStagedEntry(
          stagedCandidate,
          resolved.candidate,
          path.join(requestDir, "replaced-candidate"),
        )
        candidateMoved = false
      } catch (error) {
        errors.push(error)
      }
    }
    if (executableMoved) {
      try {
        await restoreStagedEntry(
          stagedExecutable,
          resolved.executable,
          path.join(requestDir, "replaced-world-model"),
        )
        executableMoved = false
      } catch (error) {
        errors.push(error)
      }
    }
    if (!candidateMoved && !executableMoved) {
      await rm(requestDir, { recursive: true, force: true })
    }
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        "World-model broker could not restore staged execution state.",
      )
    }
  }

  try {
    if (signal.aborted) {
      throw new Error("World-model broker request aborted.")
    }
    if (
      containsPath(resolved.candidate, resolved.executable) ||
      containsPath(resolved.executable, resolved.candidate)
    ) {
      throw new Error(
        "World-model executable and candidate snapshot must not overlap.",
      )
    }

    await rename(resolved.executable, stagedExecutable)
    executableMoved = true
    await rename(resolved.candidate, stagedCandidate)
    candidateMoved = true

    const executable = await inspectBrokerWorldModel(
      stagedExecutable,
      resolved.commands,
      signal,
      (actual) => actual === stagedExecutable,
    )
    await assertSafeSnapshotEntry(
      stagedCandidate,
      stagedCandidate,
      signal,
      { entries: 0 },
    )
    return { executable, candidate: stagedCandidate, restore }
  } catch (error) {
    await restore()
    throw error
  }
}

async function resolveBrokerExecution(
  workspace: string,
  request: Extract<WorldModelBrokerRequest, { action: "execute" }>,
  signal: AbortSignal,
): Promise<{
  executable: string
  candidate: string
  commands: string[]
}> {
  try {
    return await resolveBrokerExecutionUnsafe(
      workspace,
      request,
      signal,
    )
  } catch (error) {
    if (
      error instanceof Error &&
      error.message ===
        "World model rejected: it directly references a registered verification command."
    ) {
      throw error
    }
    throw new Error(UNSAFE_EXECUTION_ERROR)
  }
}

function registeredVerificationCommands(benchmark: Benchmark): string[] {
  if (
    typeof benchmark.verify_cmd !== "string" ||
    benchmark.verify_cmd.length === 0 ||
    (benchmark.targeted_cmd !== undefined &&
      (typeof benchmark.targeted_cmd !== "string" ||
        benchmark.targeted_cmd.length === 0)) ||
    (benchmark.score_cmd !== undefined &&
      (typeof benchmark.score_cmd !== "string" ||
        benchmark.score_cmd.length === 0))
  ) {
    throw new Error("World-model broker found an invalid benchmark registration.")
  }
  return [
    benchmark.verify_cmd,
    ...(benchmark.targeted_cmd ? [benchmark.targeted_cmd] : []),
    ...(benchmark.score_cmd ? [benchmark.score_cmd] : []),
  ]
}

async function runProbe(
  workspace: string,
  signal?: AbortSignal,
): Promise<WorldModelProcessResult> {
  const invocation = offlineWorldModelInvocation(
    "/usr/bin/true",
    workspace,
    workspace,
  )
  await access(invocation.command, constants.X_OK)
  return runWorldModelProcess(invocation, {
    cwd: workspace,
    signal,
    timeoutMs: SANDBOX_PROBE_TIMEOUT_MS,
  })
}

async function publishReady(readyFile: string, url: string): Promise<void> {
  const temporary = `${readyFile}.tmp`
  await writeFile(temporary, `${url}\n`, { encoding: "utf8", mode: 0o600 })
  await rename(temporary, readyFile)
}

/**
 * The broker is outside dyno's holdout sandbox only to avoid nested Seatbelt.
 * run_arm.sh's outer profile hides held-out benchmark data from OpenCode, while
 * every broker invocation uses world-model.ts's deny-network, deny-write,
 * deny-fork, read-allowlisted predictor profile. The outer profile also denies
 * agent writes to privateDir, where the broker atomically owns and revalidates
 * each exact model and candidate before execution. Requests are treated as
 * hostile because the sandboxed agent receives the tokenized broker URL.
 */
export async function startWorldModelBroker(
  options: BrokerOptions,
): Promise<WorldModelBroker> {
  const workspace = await realpath(options.workspace)
  const privateDir = await realpath(options.privateDir)
  if (workspace === path.parse(workspace).root) {
    throw new Error("World-model broker workspace cannot be the filesystem root.")
  }
  if (privateDir === path.parse(privateDir).root) {
    throw new Error(
      "World-model broker private directory cannot be the filesystem root.",
    )
  }
  const workspaceInfo = await lstat(workspace)
  const privateInfo = await lstat(privateDir)
  if (!workspaceInfo.isDirectory() || workspaceInfo.isSymbolicLink()) {
    throw new Error("World-model broker workspace must be a real directory.")
  }
  if (
    !privateInfo.isDirectory() ||
    privateInfo.isSymbolicLink() ||
    containsPath(workspace, privateDir) ||
    containsPath(privateDir, workspace) ||
    workspaceInfo.dev !== privateInfo.dev
  ) {
    throw new Error(
      "World-model broker private directory must be a real, same-filesystem directory outside the workspace.",
    )
  }
  if (
    options.parentPid !== undefined &&
    (!Number.isInteger(options.parentPid) || options.parentPid < 1)
  ) {
    throw new Error("World-model broker parent PID must be a positive integer.")
  }

  // Publish no capability until the same real sandbox probe used by the plugin
  // succeeds outside the holdout boundary.
  await assertWorldModelSandboxAvailable(
    workspace,
    process.platform,
    runWorldModelProcess,
    {},
  )

  const token = randomBytes(24).toString("base64url")
  const endpoint = `/world-model/${token}`
  const activeControllers = new Set<AbortController>()
  const activeRequests = new Set<Promise<Response>>()
  let executionActive = false

  const handleRequest = async (request: Request): Promise<Response> => {
    if (request.method !== "POST") return errorResponse(405, "POST required")
    const url = new URL(request.url)
    if (url.pathname !== endpoint || url.search !== "") {
      return errorResponse(404, "Not found")
    }

    const contentLength = Number(request.headers.get("Content-Length"))
    if (
      !Number.isInteger(contentLength) ||
      contentLength < 1 ||
      contentLength > MAX_REQUEST_BYTES
    ) {
      return errorResponse(400, "Invalid request size")
    }

    let brokerRequest: WorldModelBrokerRequest
    try {
      const body = await request.text()
      if (new TextEncoder().encode(body).byteLength > MAX_REQUEST_BYTES) {
        throw new Error("World-model broker request is too large.")
      }
      brokerRequest = parseRequest(JSON.parse(body))
    } catch (error) {
      return errorResponse(400, error)
    }
    if (executionActive) {
      return errorResponse(
        429,
        "World-model broker already has an active request.",
      )
    }
    executionActive = true

    const controller = new AbortController()
    const abort = () => controller.abort()
    if (request.signal.aborted) abort()
    else request.signal.addEventListener("abort", abort, { once: true })
    activeControllers.add(controller)

    try {
      if (brokerRequest.action === "probe") {
        return jsonResponse(await runProbe(workspace, controller.signal))
      }
      const resolved = await resolveBrokerExecution(
        workspace,
        brokerRequest,
        controller.signal,
      )
      const staged = await stageBrokerExecution(
        privateDir,
        resolved,
        controller.signal,
      )
      try {
        return jsonResponse(
          await runWorldModelProcess(
            offlineWorldModelInvocation(
              staged.executable,
              staged.candidate,
              workspace,
            ),
            {
              cwd: staged.candidate,
              signal: controller.signal,
              timeoutMs: WORLD_MODEL_TIMEOUT_MS,
            },
          ),
        )
      } finally {
        await staged.restore()
      }
    } catch (error) {
      return errorResponse(400, error)
    } finally {
      executionActive = false
      activeControllers.delete(controller)
      request.signal.removeEventListener("abort", abort)
    }
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    // Bun otherwise drops an in-flight handler after its 10-second default.
    // Predictors retain the existing 60-second execution budget.
    idleTimeout: Math.ceil(
      (WORLD_MODEL_TIMEOUT_MS + SANDBOX_PROBE_TIMEOUT_MS) / 1_000,
    ),
    fetch(request) {
      const active = handleRequest(request)
      activeRequests.add(active)
      void active.finally(() => activeRequests.delete(active))
      return active
    },
  })
  const url = `http://127.0.0.1:${server.port}${endpoint}`

  let parentWatcher: ReturnType<typeof setInterval> | undefined
  let resolveClosed: () => void
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => {
    if (closing) return closing
    closing = (async () => {
      if (parentWatcher) clearInterval(parentWatcher)
      for (const controller of activeControllers) controller.abort()
      await server.stop(true)
      await Promise.allSettled([...activeRequests])
      if (options.readyFile) {
        await unlink(options.readyFile).catch(() => {})
        await unlink(`${options.readyFile}.tmp`).catch(() => {})
      }
      resolveClosed()
    })()
    return closing
  }

  try {
    if (options.readyFile) await publishReady(options.readyFile, url)
  } catch (error) {
    await close()
    throw error
  }
  if (options.parentPid !== undefined) {
    parentWatcher = setInterval(() => {
      if (process.ppid !== options.parentPid) void close()
    }, 500)
  }

  return { url, closed, close }
}

function parseArguments(argv: readonly string[]): Required<BrokerOptions> {
  let workspace = ""
  let privateDir = ""
  let readyFile = ""
  let parentPid = 0
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!value) throw new Error(`Missing value for ${flag ?? "argument"}.`)
    if (flag === "--workspace") workspace = value
    else if (flag === "--private-dir") privateDir = value
    else if (flag === "--ready-file") readyFile = value
    else if (flag === "--parent-pid") parentPid = Number(value)
    else throw new Error(`Unknown world-model broker flag: ${flag}.`)
  }
  if (
    !workspace ||
    !privateDir ||
    !readyFile ||
    !Number.isInteger(parentPid) ||
    parentPid < 1
  ) {
    throw new Error(
      "Usage: world-model-broker.ts --workspace <path> --private-dir <path> --ready-file <path> --parent-pid <pid>",
    )
  }
  return { workspace, privateDir, readyFile, parentPid }
}

async function main(): Promise<void> {
  const broker = await startWorldModelBroker(parseArguments(process.argv.slice(2)))
  const stop = () => {
    void broker.close()
  }
  process.once("SIGTERM", stop)
  process.once("SIGINT", stop)
  try {
    await broker.closed
  } finally {
    process.removeListener("SIGTERM", stop)
    process.removeListener("SIGINT", stop)
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`world-model broker: ${exceptionMessage(error)}`)
    process.exitCode = 1
  })
}
