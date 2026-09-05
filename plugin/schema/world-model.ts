import { constants, realpathSync } from "node:fs"
import { access, lstat, readFile, realpath } from "node:fs/promises"
import path from "node:path"
import {
  obviouslyInvokesVerifier,
  parseWorldModelOutput,
} from "./mechanisms.ts"
import type {
  VerificationActual,
  WorldModelRegistration,
} from "./state.ts"

export const WORLD_MODEL_TIMEOUT_MS = 60_000
export const SANDBOX_PROBE_TIMEOUT_MS = 5_000
export const WORLD_MODEL_BROKER_URL_ENV = "SCHEMA_WORLD_MODEL_BROKER_URL"
const BROKER_RESPONSE_GRACE_MS = 5_000
const BROKER_PATH_PATTERN = /^\/world-model\/[A-Za-z0-9_-]{32}$/
const MAX_BROKER_RESPONSE_BYTES = 1_000_000
const MAX_WORLD_MODEL_OUTPUT_BYTES = 1_000_000
const OUTPUT_LIMIT_ERROR =
  "World model exceeded its 1 MB combined output limit."
const SINGLE_PROCESS_ERROR =
  "World model violated its execution contract: world models must be a single process and may not spawn subprocesses. Import required code instead of shelling out, and compute a prediction rather than executing anything."
const MACOS_PATH =
  "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
const LINUX_PATH =
  "/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin"
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
]
const MACOS_RUNTIME_FILES = ["/dev/null", "/dev/urandom"]
const LINUX_RUNTIME_ROOTS = ["/usr", "/bin", "/sbin", "/lib", "/lib64"]
const LINUX_RUNTIME_FILES = [
  "/etc/ld.so.cache",
  "/etc/ld.so.conf",
  "/etc/ld.so.conf.d",
  "/etc/alternatives",
  "/etc/localtime",
]

export type WorldModelInvocation = {
  command: string
  args: string[]
  seccomp?: Uint8Array
}

export type WorldModelProcessResult = {
  stdout: string
  stderr: string
  exitCode: number
  killed: boolean
}

export type WorldModelProcessRunner = (
  invocation: WorldModelInvocation,
  options: {
    cwd: string
    signal?: AbortSignal
    timeoutMs: number
  },
) => Promise<WorldModelProcessResult>

export type WorldModelEnvironment = Readonly<
  Record<string, string | undefined>
>

export type WorldModelBrokerRequest =
  | { action: "probe" }
  | {
      action: "execute"
      candidate: string
    }

export type WorldModelBrokerClient = (
  url: string,
  request: WorldModelBrokerRequest,
  options: {
    signal?: AbortSignal
    timeoutMs: number
  },
) => Promise<WorldModelProcessResult>

function schemeLiteral(value: string): string {
  return JSON.stringify(value)
}

function canonicalPath(value: string): string {
  try {
    return realpathSync(value)
  } catch {
    return path.resolve(value)
  }
}

function parentPaths(value: string): string[] {
  const parents: string[] = []
  let current = path.dirname(value)
  while (true) {
    parents.push(current)
    const parent = path.dirname(current)
    if (parent === current) return parents
    current = parent
  }
}

export function macosWorldModelProfile(
  executable: string,
  candidate: string,
): string {
  const metadataPaths = [
    ...new Set(
      [
        ...MACOS_RUNTIME_ROOTS,
        ...MACOS_RUNTIME_FILES,
        executable,
        candidate,
      ].flatMap(parentPaths),
    ),
  ]
  return [
    "(version 1)",
    "(deny default)",
    "(deny network*)",
    "(deny file-write*)",
    "(allow process*)",
    "(deny process-fork (with send-signal SIGKILL))",
    `(allow file-read-data (literal ${schemeLiteral(path.parse(executable).root)}))`,
    `(allow file-read-metadata ${metadataPaths
      .map((value) => `(literal ${schemeLiteral(value)})`)
      .join(" ")})`,
    `(allow file-read* ${MACOS_RUNTIME_ROOTS
      .map((root) => `(subpath ${schemeLiteral(root)})`)
      .join(" ")} ${MACOS_RUNTIME_FILES
      .map((file) => `(literal ${schemeLiteral(file)})`)
      .join(" ")})`,
    `(allow file-read* (literal ${schemeLiteral(executable)}) (subpath ${schemeLiteral(candidate)}))`,
  ].join("\n")
}

type SeccompInstruction = {
  code: number
  jt: number
  jf: number
  value: number
}

function seccompFilter(
  architecture: NodeJS.Architecture,
): Uint8Array {
  const load = (offset: number): SeccompInstruction => ({
    code: 0x20,
    jt: 0,
    jf: 0,
    value: offset,
  })
  const jumpEqual = (
    value: number,
    jt: number,
    jf: number,
  ): SeccompInstruction => ({
    code: 0x15,
    jt,
    jf,
    value,
  })
  const jumpSet = (
    value: number,
    jt: number,
    jf: number,
  ): SeccompInstruction => ({
    code: 0x45,
    jt,
    jf,
    value,
  })
  const returnValue = (value: number): SeccompInstruction => ({
    code: 0x06,
    jt: 0,
    jf: 0,
    value,
  })

  const killProcess = 0x80000000
  const allow = 0x7fff0000
  const errnoFunctionNotImplemented = 0x00050000 | 38
  const cloneThread = 0x00010000
  let auditArchitecture: number
  let clone: number
  let processCreation: number[]
  if (architecture === "x64") {
    auditArchitecture = 0xc000003e
    clone = 56
    processCreation = [57, 58]
  } else if (architecture === "arm64") {
    auditArchitecture = 0xc00000b7
    clone = 220
    processCreation = []
  } else {
    throw new Error(
      `World models require a no-fork sandbox; unsupported Linux architecture: ${architecture}.`,
    )
  }

  const instructions: SeccompInstruction[] = [
    load(4),
    jumpEqual(auditArchitecture, 1, 0),
    returnValue(killProcess),
    load(0),
  ]
  if (architecture === "x64") {
    instructions.push(
      jumpSet(0x40000000, 0, 1),
      returnValue(killProcess),
    )
  }
  instructions.push(
    jumpEqual(435, 0, 1),
    returnValue(errnoFunctionNotImplemented),
  )
  for (const syscall of processCreation) {
    instructions.push(
      jumpEqual(syscall, 0, 1),
      returnValue(killProcess),
    )
  }
  instructions.push(
    jumpEqual(clone, 0, 3),
    load(16),
    jumpSet(cloneThread, 1, 0),
    returnValue(killProcess),
    returnValue(allow),
  )

  const bytes = Buffer.alloc(instructions.length * 8)
  instructions.forEach((instruction, index) => {
    const offset = index * 8
    bytes.writeUInt16LE(instruction.code, offset)
    bytes.writeUInt8(instruction.jt, offset + 2)
    bytes.writeUInt8(instruction.jf, offset + 3)
    bytes.writeUInt32LE(instruction.value, offset + 4)
  })
  return bytes
}

// Shebang-based predictors need system runtimes. The sandbox isolates data and
// side effects, while the single-process limit structurally prevents wrappers
// that spawn a candidate or verifier. Source validation still rejects obvious
// verifier delegation for an earlier, more specific declaration-time error.
export function offlineWorldModelInvocation(
  executable: string,
  candidate: string,
  worktree: string,
  platform: NodeJS.Platform = process.platform,
): WorldModelInvocation {
  const resolvedWorktree = canonicalPath(worktree)
  if (resolvedWorktree === path.parse(resolvedWorktree).root) {
    throw new Error("World-model worktree cannot be the filesystem root.")
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
    }
  }
  if (platform === "linux") {
    return {
      command: "/usr/bin/bwrap",
      seccomp: seccompFilter(process.arch),
      args: [
        "--die-with-parent",
        "--new-session",
        "--unshare-all",
        "--seccomp",
        "0",
        ...LINUX_RUNTIME_ROOTS.flatMap((root) => [
          "--ro-bind-try",
          root,
          root,
        ]),
        ...LINUX_RUNTIME_FILES.flatMap((file) => [
          "--ro-bind-try",
          file,
          file,
        ]),
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
    }
  }
  throw new Error(
    `World models require an offline read-only sandbox; unsupported platform: ${platform}.`,
  )
}

export const runWorldModelProcess: WorldModelProcessRunner = async (
  invocation,
  options,
) => {
  const command = [invocation.command, ...invocation.args]
  const child = Bun.spawn(command, {
    cwd: options.cwd,
    detached: true,
    stdin: invocation.seccomp ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  let killed = false
  let outputLimitExceeded = false
  const killProcessGroup = (markKilled: boolean) => {
    if (markKilled) killed = true
    try {
      process.kill(-child.pid, "SIGKILL")
    } catch {
      child.kill("SIGKILL")
    }
  }
  const timeout = setTimeout(() => killProcessGroup(true), options.timeoutMs)
  const signal = options.signal
  const abort = () => killProcessGroup(true)
  if (signal?.aborted) abort()
  else signal?.addEventListener("abort", abort, { once: true })

  const outputState = { total: 0 }
  const readOutput = async (
    stream: ReadableStream<Uint8Array>,
  ): Promise<string> => {
    const reader = stream.getReader()
    const chunks: Uint8Array[] = []
    let length = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        outputState.total += value.byteLength
        if (outputState.total > MAX_WORLD_MODEL_OUTPUT_BYTES) {
          if (!outputLimitExceeded) {
            outputLimitExceeded = true
            killProcessGroup(false)
          }
          continue
        }
        if (outputLimitExceeded) continue
        chunks.push(value)
        length += value.byteLength
      }
    } catch (error) {
      if (!killed && !outputLimitExceeded) throw error
    } finally {
      reader.releaseLock()
    }
    return Buffer.concat(chunks, length).toString("utf8")
  }

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readOutput(child.stdout),
      readOutput(child.stderr),
      child.exited,
    ])
    if (outputLimitExceeded) {
      return {
        stdout: "",
        stderr: OUTPUT_LIMIT_ERROR,
        exitCode: 1,
        killed,
      }
    }
    return {
      stdout,
      stderr,
      exitCode,
      killed,
    }
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener("abort", abort)
    // The sandbox denies predictor forks. Group cleanup remains defense in depth
    // for sandbox setup regressions and guarantees broker shutdown cannot leave a
    // predictor descendant behind.
    killProcessGroup(false)
  }
}

function exceptionMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isSubprocessDenial(stderr: string): boolean {
  const normalized = stderr.toLowerCase()
  return (
    (normalized.includes("fork") ||
      normalized.includes("posix_spawn") ||
      normalized.includes("subprocess")) &&
    (normalized.includes("operation not permitted") ||
      normalized.includes("resource temporarily unavailable") ||
      normalized.includes("cannot fork"))
  )
}

function parseBrokerProcessResult(value: unknown): WorldModelProcessResult {
  const keys =
    typeof value === "object" && value !== null ? Object.keys(value).sort() : []
  if (
    typeof value !== "object" ||
    value === null ||
    keys.join("\0") !== "exitCode\0killed\0stderr\0stdout" ||
    typeof (value as Record<string, unknown>).stdout !== "string" ||
    typeof (value as Record<string, unknown>).stderr !== "string" ||
    !Number.isInteger((value as Record<string, unknown>).exitCode) ||
    typeof (value as Record<string, unknown>).killed !== "boolean"
  ) {
    throw new Error("World-model broker returned an invalid process result.")
  }
  return value as WorldModelProcessResult
}

async function readBrokerResponse(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("Content-Length"))
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_BROKER_RESPONSE_BYTES
  ) {
    throw new Error("World-model broker response is too large.")
  }
  if (!response.body) return ""

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_BROKER_RESPONSE_BYTES) {
      await reader.cancel()
      throw new Error("World-model broker response is too large.")
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks, total).toString("utf8")
}

/**
 * dyno/run_arm.sh starts the broker outside its held-out-data sandbox and passes
 * this tokenized loopback URL explicitly. The outer sandbox protects held-out
 * reads; the broker still applies this file's offline sandbox to every predictor,
 * denying network, writes, and subprocesses. Never infer this mode from ambient
 * sandbox state or broker reachability.
 */
export function worldModelBrokerURL(
  environment: WorldModelEnvironment = process.env,
): string | null {
  const value = environment[WORLD_MODEL_BROKER_URL_ENV]
  if (value === undefined) return null

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(
      `${WORLD_MODEL_BROKER_URL_ENV} must be a tokenized loopback HTTP URL.`,
    )
  }
  const port = Number(parsed.port)
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    !BROKER_PATH_PATTERN.test(parsed.pathname)
  ) {
    throw new Error(
      `${WORLD_MODEL_BROKER_URL_ENV} must be a tokenized loopback HTTP URL.`,
    )
  }
  return parsed.href
}

export const runWorldModelBrokerRequest: WorldModelBrokerClient = async (
  url,
  request,
  options,
) => {
  const controller = new AbortController()
  let timedOut = false
  const abort = () => controller.abort()
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, options.timeoutMs + BROKER_RESPONSE_GRACE_MS)
  if (options.signal?.aborted) abort()
  else options.signal?.addEventListener("abort", abort, { once: true })

  let response: Response
  let responseBody: string
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: controller.signal,
      redirect: "error",
    })
    responseBody = await readBrokerResponse(response)
  } catch (error) {
    if (timedOut) throw new Error("World-model broker request timed out.")
    if (options.signal?.aborted) {
      throw new Error("World-model broker request aborted.")
    }
    throw new Error(
      `World-model broker request failed: ${exceptionMessage(error)}.`,
    )
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener("abort", abort)
  }

  let body: unknown
  try {
    body = JSON.parse(responseBody)
  } catch {
    throw new Error(
      `World-model broker returned invalid JSON with status ${response.status}.`,
    )
  }
  if (!response.ok) {
    const detail =
      typeof body === "object" &&
      body !== null &&
      typeof (body as Record<string, unknown>).error === "string"
        ? (body as Record<string, string>).error
        : response.statusText
    throw new Error(
      `World-model broker request failed (${response.status}): ${detail}.`,
    )
  }
  return parseBrokerProcessResult(body)
}

function brokerRelativePath(
  worktree: string,
  absolutePath: string,
  label: string,
): string {
  const canonicalWorktree = canonicalPath(worktree)
  const relative = path.relative(canonicalWorktree, absolutePath)
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`${label} must stay inside the working tree.`)
  }
  return relative.split(path.sep).join(path.posix.sep)
}

export async function assertWorldModelSandboxAvailable(
  worktree: string,
  platform: NodeJS.Platform = process.platform,
  runner: WorldModelProcessRunner = runWorldModelProcess,
  environment: WorldModelEnvironment = process.env,
  brokerClient: WorldModelBrokerClient = runWorldModelBrokerRequest,
): Promise<void> {
  const brokerURL = worldModelBrokerURL(environment)
  let result: WorldModelProcessResult
  if (brokerURL) {
    result = await brokerClient(
      brokerURL,
      { action: "probe" },
      { timeoutMs: SANDBOX_PROBE_TIMEOUT_MS },
    )
  } else {
    const invocation = offlineWorldModelInvocation(
      "/usr/bin/true",
      worktree,
      worktree,
      platform,
    )
    try {
      await access(invocation.command, constants.X_OK)
    } catch {
      throw new Error(
        `World-model sandbox is unavailable: expected executable ${invocation.command}.`,
      )
    }
    result = await runner(invocation, {
      cwd: worktree,
      timeoutMs: SANDBOX_PROBE_TIMEOUT_MS,
    })
  }
  if (result.killed || result.exitCode !== 0) {
    const detail = result.stderr.trim().slice(0, 300)
    throw new Error(
      `World-model sandbox probe failed${
        detail ? `: ${detail}` : ` with exit code ${result.exitCode}`
      }.`,
    )
  }
}

export async function validateWorldModelExecutable(
  worktree: string,
  worldModelPath: string,
  registeredCommands: readonly string[],
): Promise<{
  absolutePath: string
  registration: WorldModelRegistration
}> {
  if (path.isAbsolute(worldModelPath)) {
    throw new Error("World-model path must be relative to the working tree.")
  }

  const canonicalWorktree = await realpath(worktree)
  const requested = path.resolve(canonicalWorktree, worldModelPath)
  const info = await lstat(requested)
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(
      "World-model path must name a regular, non-symlink executable file.",
    )
  }
  const absolutePath = await realpath(requested)
  if (!absolutePath.startsWith(`${canonicalWorktree}${path.sep}`)) {
    throw new Error("World-model path must stay inside the working tree.")
  }
  try {
    await access(absolutePath, constants.X_OK)
  } catch {
    throw new Error("World-model file must be executable.")
  }

  const source = await readFile(absolutePath, "utf8")
  if (
    registeredCommands.some((command) =>
      obviouslyInvokesVerifier(source, command),
    )
  ) {
    throw new Error(
      "World model rejected: it directly references a registered verification command.",
    )
  }

  return {
    absolutePath,
    registration: {
      version: 1,
      path: path.relative(canonicalWorktree, absolutePath),
    },
  }
}

export async function executeWorldModel(
  worktree: string,
  worldModel: WorldModelRegistration,
  registeredCommands: readonly string[],
  candidate: string,
  signal?: AbortSignal,
  runner: WorldModelProcessRunner = runWorldModelProcess,
  environment: WorldModelEnvironment = process.env,
  brokerClient: WorldModelBrokerClient = runWorldModelBrokerRequest,
): Promise<VerificationActual> {
  const validated = await validateWorldModelExecutable(
    worktree,
    worldModel.path,
    registeredCommands,
  )
  const brokerURL = worldModelBrokerURL(environment)
  const result = brokerURL
    ? await brokerClient(
        brokerURL,
        {
          action: "execute",
          candidate: brokerRelativePath(
            worktree,
            candidate,
            "World-model candidate",
          ),
        },
        {
          signal,
          timeoutMs: WORLD_MODEL_TIMEOUT_MS,
        },
      )
    : await runner(
        offlineWorldModelInvocation(
          validated.absolutePath,
          candidate,
          worktree,
        ),
        {
          cwd: candidate,
          signal,
          timeoutMs: WORLD_MODEL_TIMEOUT_MS,
        },
      )
  if (result.killed) throw new Error("World model timed out.")
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim().slice(0, 300)
    if (
      (process.platform === "darwin" && result.exitCode === 137) ||
      (process.platform === "linux" && result.exitCode === 159) ||
      isSubprocessDenial(result.stderr)
    ) {
      throw new Error(`${SINGLE_PROCESS_ERROR}${detail ? ` ${detail}` : ""}`)
    }
    throw new Error(
      `World model exited ${result.exitCode}${detail ? `: ${detail}` : ""}.`,
    )
  }
  return parseWorldModelOutput(result.stdout)
}
