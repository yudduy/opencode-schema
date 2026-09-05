import { constants } from "node:fs"
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises"
import { createHash } from "node:crypto"
import path from "node:path"
import {
  ensureSessionDirectory,
  sessionStateDirectory,
  type Benchmark,
  type LiveCandidate,
} from "./state.ts"

const ARTIFACT_PATTERN = /^artifacts\/([0-9a-f]{64})$/
const MAX_WRAPPER_FILES = 32
const MAX_WRAPPER_BYTES = 1_000_000

export type CandidateArtifact = {
  path: string
  contentHash: string
  artifact: string
}

export type PreservedTarget = {
  contentHash: string
  artifact: string
}

export type CanonicalTarget = {
  relativePath: string
  absolutePath: string
  evidence: { source: string; token: string }[]
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
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

function safeRelativePath(root: string, absolute: string, label: string): string {
  if (!containsPath(root, absolute) || absolute === root) {
    throw new Error(`${label} must stay inside the working tree.`)
  }
  const relative = path.relative(root, absolute)
  const first = relative.split(path.sep)[0]
  if (first === ".git" || first === ".schema") {
    throw new Error(`${label} cannot use git or schema control state.`)
  }
  return relative
}

async function assertSafeAncestors(
  root: string,
  absolute: string,
  label: string,
): Promise<void> {
  const relative = safeRelativePath(root, absolute, label)
  let current = root
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment)
    const info = await lstat(current)
    if (info.isSymbolicLink()) {
      throw new Error(`${label} cannot traverse a symlink: ${current}`)
    }
  }
}

async function readRegularFile(
  root: string,
  requested: string,
  label: string,
): Promise<{ absolutePath: string; relativePath: string; bytes: Buffer; mode: number }> {
  if (!requested || path.isAbsolute(requested) || requested.includes("\0")) {
    throw new Error(`${label} path must be a non-empty worktree-relative path.`)
  }
  const absolutePath = path.resolve(root, requested)
  await assertSafeAncestors(root, absolutePath, label)
  const canonical = await realpath(absolutePath)
  const relativePath = safeRelativePath(root, canonical, label)
  const handle = await open(
    canonical,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  )
  try {
    const info = await handle.stat()
    if (!info.isFile()) {
      throw new Error(`${label} must name a regular file.`)
    }
    return {
      absolutePath: canonical,
      relativePath,
      bytes: await handle.readFile(),
      mode: info.mode & 0o777,
    }
  } finally {
    await handle.close()
  }
}

export function contentHash(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`
}

async function ensureArtifactDirectory(
  worktree: string,
  sessionID: string,
): Promise<string> {
  const sessionDirectory = await ensureSessionDirectory(worktree, sessionID)
  const directory = path.join(sessionDirectory, "artifacts")
  try {
    const info = await lstat(directory)
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`Refusing unsafe candidate artifact directory: ${directory}`)
    }
  } catch (error) {
    if (!isMissing(error)) throw error
    await mkdir(directory, { mode: 0o700 })
  }
  const info = await lstat(directory)
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`Refusing unsafe candidate artifact directory: ${directory}`)
  }
  return directory
}

async function storeArtifactBytes(
  worktree: string,
  sessionID: string,
  bytes: Uint8Array,
): Promise<PreservedTarget> {
  const hash = contentHash(bytes)
  const digest = hash.slice("sha256:".length)
  const directory = await ensureArtifactDirectory(worktree, sessionID)
  const destination = path.join(directory, digest)
  try {
    const existing = await lstat(destination)
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error(`Refusing unsafe candidate artifact: ${destination}`)
    }
    const stored = await readFile(destination)
    if (contentHash(stored) !== hash) {
      throw new Error(`Candidate artifact hash mismatch: ${destination}`)
    }
  } catch (error) {
    if (!isMissing(error)) throw error
    const temporary = path.join(directory, `.artifact-${crypto.randomUUID()}.tmp`)
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 })
    await rename(temporary, destination)
  }
  return { contentHash: hash, artifact: path.posix.join("artifacts", digest) }
}

export async function storeCandidateArtifact(
  worktree: string,
  sessionID: string,
  candidatePath: string,
): Promise<CandidateArtifact> {
  const root = await realpath(worktree)
  const candidate = await readRegularFile(
    root,
    candidatePath,
    "Candidate",
  )
  const stored = await storeArtifactBytes(worktree, sessionID, candidate.bytes)
  return {
    path: candidate.relativePath,
    contentHash: stored.contentHash,
    artifact: stored.artifact,
  }
}

export async function readCandidateArtifact(
  worktree: string,
  sessionID: string,
  reference: string,
  expectedHash: string,
): Promise<Buffer> {
  const match = ARTIFACT_PATTERN.exec(reference)
  if (!match) {
    throw new Error(`Unsafe candidate artifact reference: ${JSON.stringify(reference)}`)
  }
  const root = await realpath(worktree)
  const sessionDirectory = sessionStateDirectory(worktree, sessionID)
  const canonicalSession = await realpath(sessionDirectory)
  if (canonicalSession !== path.join(root, ".schema", sessionID)) {
    throw new Error(`Refusing unsafe schema session directory: ${sessionDirectory}`)
  }
  const artifactDirectory = path.join(canonicalSession, "artifacts")
  const artifactDirectoryInfo = await lstat(artifactDirectory)
  if (
    artifactDirectoryInfo.isSymbolicLink() ||
    !artifactDirectoryInfo.isDirectory() ||
    (await realpath(artifactDirectory)) !== artifactDirectory
  ) {
    throw new Error(`Refusing unsafe candidate artifact directory: ${artifactDirectory}`)
  }
  const artifact = path.join(artifactDirectory, match[1])
  const info = await lstat(artifact)
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`Refusing unsafe candidate artifact: ${artifact}`)
  }
  const bytes = await readFile(artifact)
  if (contentHash(bytes) !== expectedHash) {
    throw new Error(`Candidate artifact does not match ${expectedHash}.`)
  }
  return bytes
}

function wrapperReferences(source: string): string[] {
  return [
    ...source.matchAll(
      /(?:^|[\s;&|])((?:\.\.?\/)[A-Za-z0-9._/-]+)(?=$|[\s;&|"'()])/gm,
    ),
  ].map((match) => match[1])
}

function rootedReferences(
  source: string,
): { variable: "PWD" | "WORKSPACE"; suffix: string; token: string }[] {
  return [
    ...source.matchAll(
      /(?<token>\$(?:\{(?<braced>PWD|WORKSPACE)\}|(?<plain>PWD|WORKSPACE))\/(?<suffix>[A-Za-z0-9._/-]+))/g,
    ),
  ].map((match) => ({
    variable: (match.groups?.braced ?? match.groups?.plain) as
      | "PWD"
      | "WORKSPACE",
    suffix: match.groups!.suffix,
    token: match.groups!.token,
  }))
}

function staticWorkspaceUsesPwd(source: string): boolean {
  return /\bWORKSPACE\s*=\s*["']?\$(?:\{PWD\}|PWD)(?:\/?)["']?(?=$|[\s;])/m.test(
    source,
  )
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

async function readableWrapper(
  root: string,
  reference: string,
): Promise<{ path: string; source: string } | null> {
  const requested = path.resolve(root, reference)
  if (!containsPath(root, requested) || requested === root) return null
  let info
  try {
    info = await lstat(requested)
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
  if (info.isSymbolicLink()) {
    throw new Error(`Registered verifier wrapper cannot be a symlink: ${reference}`)
  }
  if (!info.isFile()) return null
  if (info.size > MAX_WRAPPER_BYTES) {
    throw new Error(`Registered verifier wrapper is too large to inspect: ${reference}`)
  }
  const canonical = await realpath(requested)
  return {
    path: safeRelativePath(root, canonical, "Verifier wrapper"),
    source: await readFile(canonical, "utf8"),
  }
}

/**
 * Infer only proof-positive, worktree-rooted verifier inputs. Arbitrary shell
 * is undecidable; zero or ambiguous static references fail instead of guessing.
 */
export async function inferCanonicalTargetPath(
  worktree: string,
  benchmark: Pick<Benchmark, "verify_cmd" | "score_cmd">,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<CanonicalTarget> {
  const root = await realpath(worktree)
  // Only the verifier establishes the fixed program input. score_cmd may name
  // derived metrics or result files; treating those as overlay targets can
  // replace evidence instead of the candidate program.
  const sources = new Map<string, string>([
    ["verify_cmd", benchmark.verify_cmd],
  ])
  const wrapperPaths = new Set<string>()
  const pending = [...sources.entries()]

  for (let index = 0; index < pending.length; index += 1) {
    if (wrapperPaths.size >= MAX_WRAPPER_FILES) {
      throw new Error("Too many verifier wrappers to infer one canonical target.")
    }
    const [, source] = pending[index]
    for (const reference of wrapperReferences(source)) {
      const wrapper = await readableWrapper(root, reference)
      if (!wrapper || wrapperPaths.has(wrapper.path)) continue
      wrapperPaths.add(wrapper.path)
      const name = `wrapper:${wrapper.path}`
      sources.set(name, wrapper.source)
      pending.push([name, wrapper.source])
    }
  }

  const combinedSource = [...sources.values()].join("\n")
  let workspaceRoot: string | null = null
  if (staticWorkspaceUsesPwd(combinedSource)) {
    workspaceRoot = root
  } else if (environment.WORKSPACE) {
    const requestedWorkspace = path.resolve(environment.WORKSPACE)
    let canonicalWorkspace: string
    try {
      canonicalWorkspace = await realpath(requestedWorkspace)
    } catch {
      throw new Error(
        `Cannot infer verifier target: WORKSPACE does not resolve (${environment.WORKSPACE}).`,
      )
    }
    if (canonicalWorkspace !== root) {
      throw new Error(
        `Cannot infer verifier target: WORKSPACE resolves to ${canonicalWorkspace}, not ${root}.`,
      )
    }
    workspaceRoot = canonicalWorkspace
  }

  const candidates = new Map<
    string,
    { evidence: { source: string; token: string }[] }
  >()
  const record = (
    sourceName: string,
    token: string,
    base: string,
    suffix: string,
  ) => {
    const absolutePath = path.resolve(base, suffix)
    const relativePath = safeRelativePath(root, absolutePath, "Verifier target")
    if (wrapperPaths.has(relativePath)) return
    const present = candidates.get(relativePath) ?? {
      evidence: [],
    }
    present.evidence.push({ source: sourceName, token })
    candidates.set(relativePath, present)
  }

  const literalRootPattern = new RegExp(
    `${escapeRegExp(root)}\\/(?<suffix>[A-Za-z0-9._/-]+)`,
    "g",
  )
  for (const [sourceName, source] of sources) {
    for (const reference of rootedReferences(source)) {
      if (reference.variable === "WORKSPACE" && !workspaceRoot) {
        throw new Error(
          "Cannot infer verifier target: $WORKSPACE is not statically bound to this worktree.",
        )
      }
      record(
        sourceName,
        reference.token,
        reference.variable === "PWD" ? root : workspaceRoot!,
        reference.suffix,
      )
    }
    for (const match of source.matchAll(literalRootPattern)) {
      record(sourceName, match[0], root, match.groups!.suffix)
    }
  }

  const entries = [...candidates.entries()]
  if (entries.length !== 1) {
    const detail =
      entries.length === 0
        ? "found none"
        : `found ${entries.map(([relative]) => relative).join(", ")}`
    throw new Error(
      `Cannot infer exactly one canonical verifier target from the registered full commands: ${detail}. Use one explicit $PWD/<path>, $WORKSPACE/<path>, or absolute in-worktree reference.`,
    )
  }

  const [relativePath, target] = entries[0]
  const validated = await readRegularFile(root, relativePath, "Verifier target")
  return {
    relativePath: validated.relativePath,
    absolutePath: validated.absolutePath,
    evidence: target.evidence,
  }
}

async function atomicInstall(
  target: { absolutePath: string; mode: number },
  bytes: Uint8Array,
): Promise<void> {
  const temporary = path.join(
    path.dirname(target.absolutePath),
    `.schema-overlay-${crypto.randomUUID()}.tmp`,
  )
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: target.mode })
    await chmod(temporary, target.mode)
    await rename(temporary, target.absolutePath)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

export async function overlayArtifactInSnapshot(
  snapshot: string,
  bytes: Uint8Array,
  targetPath: string,
): Promise<void> {
  const root = await realpath(snapshot)
  const target = await readRegularFile(root, targetPath, "Snapshot target")
  await atomicInstall(target, bytes)
}

export async function installCandidateOverlay(
  worktree: string,
  sessionID: string,
  bytes: Uint8Array,
  targetPath: string,
): Promise<PreservedTarget> {
  const root = await realpath(worktree)
  const target = await readRegularFile(root, targetPath, "Verifier target")
  const previous = await storeArtifactBytes(worktree, sessionID, target.bytes)
  await atomicInstall(target, bytes)
  return previous
}

export async function inspectLiveCandidate(
  worktree: string,
  targetPath: string,
  selected: { id: string; contentHash: string },
): Promise<LiveCandidate> {
  const root = await realpath(worktree)
  const target = await readRegularFile(root, targetPath, "Verifier target")
  const liveHash = contentHash(target.bytes)
  const matchesSelected = liveHash === selected.contentHash
  return {
    id: matchesSelected ? selected.id : null,
    contentHash: liveHash,
    targetPath: target.relativePath,
    matchesSelected,
  }
}
