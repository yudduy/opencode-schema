import { constants } from "node:fs"
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
} from "node:fs/promises"
import path from "node:path"

export const DEFAULT_VERIFY_ACTION_BUDGET = 12

export type RunStatus = "active" | "solved" | "stalled" | "blocked" | "budget_limited"

export type Benchmark = {
  verify_cmd: string
  targeted_cmd?: string
  score_cmd?: string
}

/** A machine-refutable claim about the next verification.
 *
 * The original `predicted_pass_set: string[]` was prose, and `detectSurprise`
 * could only ask whether that prose appeared inside a grepped FAIL line — which
 * for a claim like "score >= 0.8" it never can. Measured over 121 sessions:
 * surprise fired on 0.53% of predictions. An assertion states a metric, a
 * comparison and a literal, so it can simply be evaluated. */
export type Assertion = {
  metric: "score" | "pass" | "failing_count"
  op: ">=" | "<=" | ">" | "<" | "==" | "!="
  value: number | boolean
  tol?: number
}

export type Prediction = {
  hypothesis: string
  predicted_pass_set: string[]
  assertions?: Assertion[]
  predicted_side_effects?: string
  ts: number
}

export type SurpriseKind = "predicted_pass_failed" | "side_effect_flip" | "assertion_failed"

export type SurpriseAnnotation = {
  kind: SurpriseKind
  detail: string
}

export type ReviewTrigger =
  | "surprise"
  | "verify_fail"
  | "risky_intent"
  | "stall"
  | "policy_block"

export type PendingReview = {
  trigger: ReviewTrigger
  key: string
  ts: number
  detail?: string
}

/** A region of behaviour space the agent commits to exploring.
 *
 * Kept problem-agnostic on purpose: the niches are whatever approach families the
 * agent names for THIS task, not a fixed taxonomy and not something that requires a
 * ceiling memo to exist. That follows the QD-with-AI-feedback line (Bradley et al.,
 * arXiv 2310.13032), where the diversity descriptor is supplied by the model rather
 * than hand-engineered per domain. */
export type Niche = { id: string; description: string }

/** Best candidate seen in a niche — the "elite" of MAP-Elites. */
export type Elite = {
  niche: string
  score: number
  summary: string
  programSha?: string
  ts: number
}

export type FrontierCandidate = {
  id: string
  path: string
  rationale: string
  contentHash: string
  artifact: string
  proposedAt: number
  predicted?: VerificationActual
  predictedAt?: number
}

export type LiveCandidate = {
  id: string | null
  contentHash: string
  targetPath: string
  matchesSelected: boolean
}

export type RunState = {
  status: RunStatus
  benchmark: Benchmark | null
  characterized: boolean
  /**
   * Set when a characterize attempt failed inside the harness rather than on the
   * benchmark — a snapshot the workspace cannot produce, not a red baseline. The
   * edit gate must then let go: it blocks edits until characterize succeeds, and
   * repairing the workspace is itself an edit, so holding the gate strands the
   * agent with no legal move. Optional so run.json files written before this
   * field existed still parse.
   */
  characterizeBlocked?: boolean
  verifyActionsUsed: number
  verifyActionBudget: number
  lastPrediction: Prediction | null
  stallCount: number
  idleCycles: number
  lastLedgerLen: number
  errorStreak: number
  policyBlockStreak: number
  inflight: boolean
  reviewerSessionID: string | null
  pendingReview: PendingReview | null
  lastReviewKey: string | null
  lastReviewTs: number
  reviewCount: number
  /** Declared behaviour space. Empty until the agent commits to one. */
  niches: Niche[]
  /** niche id -> its elite. This replaces following a single champion. */
  archive: Record<string, Elite>
  /** Niche of the most recent expensive verification, for the diversity gate. */
  lastVerifiedNiche: string | null
  /** Immutable candidate programs registered for free world-model exploration. */
  frontier: FrontierCandidate[]
  /** Canonical verifier input inferred from the registered benchmark. */
  frontierTarget: string | null
  /** Bytes currently installed at the canonical verifier input. */
  liveCandidate: LiveCandidate | null
}

export type VerificationActual = {
  pass: boolean
  failing: string[]
  score?: number
}

export type WorldModelRegistration = {
  version: 1
  path: string
}

type LedgerBase = {
  ts: number
  step: number
}

export type PredictionLedgerRow = LedgerBase & {
  scope: "predict"
  prediction: Prediction
  actual?: never
  cost?: never
  surprise?: never
}

export type VerificationLedgerRow = LedgerBase & {
  scope: "characterize" | "targeted" | "full"
  /** Replay snapshot reference. Keep separate from frontier identity. */
  candidate?: string
  candidateId?: string
  candidatePath?: string
  contentHash?: string
  targetPath?: string
  distinctCandidatesOfficiallyEvaluated?: number
  prediction?: Prediction
  predicted?: VerificationActual
  actual: VerificationActual
  cost: number
  surprise?: SurpriseAnnotation
}

export type LedgerRow = PredictionLedgerRow | VerificationLedgerRow

// External compiled tools may append future scopes such as proxy, backtest, or
// candidate. Parsing preserves those rows; consumers must explicitly select a
// known row shape before interpreting its payload.
export type LedgerPassthroughRow = LedgerBase & {
  scope: string
  candidate?: string
  candidateId?: string
  candidatePath?: string
  contentHash?: string
  targetPath?: string
  distinctCandidatesOfficiallyEvaluated?: number
  prediction?: Prediction
  predicted?: VerificationActual
  actual?: VerificationActual
  cost?: number
  surprise?: SurpriseAnnotation
  [key: string]: unknown
}

export type ParsedLedgerRow = LedgerRow | LedgerPassthroughRow
export type LedgerRowInput =
  | Omit<PredictionLedgerRow, "step">
  | Omit<VerificationLedgerRow, "step">

export function isVerificationLedgerRow(row: ParsedLedgerRow): row is VerificationLedgerRow {
  if (
    row.scope !== "characterize" &&
    row.scope !== "targeted" &&
    row.scope !== "full"
  ) {
    return false
  }
  const actual = row.actual
  return (
    typeof row.cost === "number" &&
    !!actual &&
    typeof actual.pass === "boolean" &&
    Array.isArray(actual.failing)
  )
}

export function createRunState(benchmark: Benchmark | null = null): RunState {
  return {
    status: "active",
    benchmark,
    characterized: false,
    verifyActionsUsed: 0,
    verifyActionBudget: DEFAULT_VERIFY_ACTION_BUDGET,
    lastPrediction: null,
    stallCount: 0,
    idleCycles: 0,
    lastLedgerLen: 0,
    errorStreak: 0,
    policyBlockStreak: 0,
    inflight: false,
    reviewerSessionID: null,
    pendingReview: null,
    lastReviewKey: null,
    lastReviewTs: 0,
    reviewCount: 0,
    niches: [],
    archive: {},
    lastVerifiedNiche: null,
    frontier: [],
    frontierTarget: null,
    liveCandidate: null,
  }
}

export function sessionStateDirectory(worktree: string, sessionID: string): string {
  if (!sessionID || sessionID === "." || sessionID === ".." || /[\\/\0]/.test(sessionID)) {
    throw new Error("Invalid session ID")
  }
  return path.join(path.resolve(worktree), ".schema", sessionID)
}

async function ensureDirectory(directory: string): Promise<void> {
  try {
    const info = await lstat(directory)
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`Refusing unsafe schema directory: ${directory}`)
    }
  } catch (error) {
    if (!isMissing(error)) throw error
    try {
      await mkdir(directory, { mode: 0o700 })
    } catch (mkdirError) {
      if (!(mkdirError instanceof Error && "code" in mkdirError && mkdirError.code === "EEXIST")) {
        throw mkdirError
      }
    }
    const info = await lstat(directory)
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`Refusing unsafe schema directory: ${directory}`)
    }
  }
}

export async function ensureSessionDirectory(worktree: string, sessionID: string): Promise<string> {
  const schemaDirectory = path.join(path.resolve(worktree), ".schema")
  await ensureDirectory(schemaDirectory)
  const directory = sessionStateDirectory(worktree, sessionID)
  await ensureDirectory(directory)
  return directory
}

export function runFile(worktree: string, sessionID: string): string {
  return path.join(sessionStateDirectory(worktree, sessionID), "run.json")
}

export function ledgerFile(worktree: string, sessionID: string): string {
  return path.join(sessionStateDirectory(worktree, sessionID), "ledger.jsonl")
}

export function worldModelFile(worktree: string, sessionID: string): string {
  return path.join(sessionStateDirectory(worktree, sessionID), "world-model.json")
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

export async function readRun(worktree: string, sessionID: string): Promise<RunState | null> {
  try {
    const run = JSON.parse(await readFile(runFile(worktree, sessionID), "utf8")) as RunState
    return {
      ...run,
      errorStreak: run.errorStreak ?? 0,
      policyBlockStreak: run.policyBlockStreak ?? 0,
      reviewerSessionID: run.reviewerSessionID ?? null,
      pendingReview: run.pendingReview ?? null,
      lastReviewKey: run.lastReviewKey ?? null,
      lastReviewTs: run.lastReviewTs ?? 0,
      reviewCount: run.reviewCount ?? 0,
      niches: run.niches ?? [],
      archive: run.archive ?? {},
      lastVerifiedNiche: run.lastVerifiedNiche ?? null,
      frontier: run.frontier ?? [],
      frontierTarget: run.frontierTarget ?? null,
      liveCandidate: run.liveCandidate ?? null,
    }
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}

export async function writeRun(worktree: string, sessionID: string, run: RunState): Promise<void> {
  const directory = await ensureSessionDirectory(worktree, sessionID)
  const destination = path.join(directory, "run.json")
  const temporary = path.join(directory, `.run-${crypto.randomUUID()}.tmp`)
  await writeFile(temporary, `${JSON.stringify(run, null, 2)}\n`, "utf8")
  await rename(temporary, destination)
}

export async function readWorldModel(
  worktree: string,
  sessionID: string,
): Promise<WorldModelRegistration | null> {
  try {
    return JSON.parse(
      await readFile(worldModelFile(worktree, sessionID), "utf8"),
    ) as WorldModelRegistration
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}

export async function writeWorldModel(
  worktree: string,
  sessionID: string,
  worldModel: WorldModelRegistration,
): Promise<void> {
  const directory = await ensureSessionDirectory(worktree, sessionID)
  const destination = path.join(directory, "world-model.json")
  const temporary = path.join(
    directory,
    `.world-model-${crypto.randomUUID()}.tmp`,
  )
  await writeFile(temporary, `${JSON.stringify(worldModel, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  })
  await rename(temporary, destination)
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

async function cloneCandidateTree(
  source: string,
  destination: string,
  sourceRoot: string,
  destinationRoot: string,
): Promise<void> {
  const info = await lstat(source)
  if (info.isDirectory()) {
    // Populate with a writable mode before restoring a potentially read-only source mode.
    await mkdir(destination, { mode: 0o700 })
    for (const name of await readdir(source)) {
      await cloneCandidateTree(
        path.join(source, name),
        path.join(destination, name),
        sourceRoot,
        destinationRoot,
      )
    }
    await chmod(destination, info.mode & 0o777)
    return
  }
  if (info.isFile()) {
    await copyFile(source, destination, constants.COPYFILE_FICLONE)
    await chmod(destination, info.mode & 0o777)
    return
  }
  if (info.isSymbolicLink()) {
    const originalTarget = await readlink(source)
    let canonicalTarget: string
    try {
      canonicalTarget = await realpath(source)
    } catch {
      throw new Error(`Cannot snapshot dangling or cyclic symlink: ${source}`)
    }
    if (!containsPath(sourceRoot, canonicalTarget)) {
      throw new Error(
        `Cannot snapshot symlink outside the working tree: ${source} -> ${originalTarget}`,
      )
    }
    const targetReference = path.relative(sourceRoot, canonicalTarget)
    const firstSegment = targetReference.split(path.sep)[0]
    if (firstSegment === ".git" || firstSegment === ".schema") {
      throw new Error(
        `Cannot snapshot symlink into excluded control state: ${source} -> ${originalTarget}`,
      )
    }
    const snapshotTarget = path.join(destinationRoot, targetReference)
    await symlink(
      path.relative(path.dirname(destination), snapshotTarget) || ".",
      destination,
    )
    return
  }
  throw new Error(`Cannot snapshot non-file candidate entry: ${source}`)
}

async function makeTreeRemovable(entry: string): Promise<void> {
  const info = await lstat(entry)
  if (!info.isDirectory() || info.isSymbolicLink()) return
  await chmod(entry, 0o700)
  for (const name of await readdir(entry)) {
    await makeTreeRemovable(path.join(entry, name))
  }
}

/**
 * Capture the verifier's complete input, including ignored files it may read.
 * Only git and schema control state are excluded. This auditable replay state is
 * not a secret store; credentials must remain outside the task worktree.
 */
export async function captureCandidateSnapshot(
  worktree: string,
  sessionID: string,
): Promise<string> {
  const sessionDirectory = await ensureSessionDirectory(worktree, sessionID)
  const candidatesDirectory = path.join(sessionDirectory, "candidates")
  const worktreeRoot = await realpath(worktree)
  await ensureDirectory(candidatesDirectory)

  const snapshotID = crypto.randomUUID()
  const temporary = path.join(
    candidatesDirectory,
    `.snapshot.${snapshotID}.tmp`,
  )
  const destination = path.join(candidatesDirectory, snapshotID)
  await mkdir(temporary, { mode: 0o700 })

  try {
    for (const name of await readdir(worktreeRoot)) {
      if (name === ".git" || name === ".schema") continue
      await cloneCandidateTree(
        path.join(worktreeRoot, name),
        path.join(temporary, name),
        worktreeRoot,
        temporary,
      )
    }
    await chmod(temporary, (await lstat(worktreeRoot)).mode & 0o777)
    await rename(temporary, destination)
    return path.posix.join("candidates", snapshotID)
  } catch (error) {
    await makeTreeRemovable(temporary).catch(() => {})
    await rm(temporary, { recursive: true, force: true })
    throw error
  }
}

export async function resolveCandidateSnapshot(
  worktree: string,
  sessionID: string,
  reference: string,
): Promise<string> {
  const match =
    /^candidates\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.exec(
      reference,
    )
  if (!match) {
    throw new Error(
      `Unsafe candidate snapshot reference: ${JSON.stringify(reference)}`,
    )
  }

  const canonicalWorktree = await realpath(worktree)
  const sessionDirectory = sessionStateDirectory(worktree, sessionID)
  const canonicalSession = await realpath(sessionDirectory)
  const expectedSession = path.join(canonicalWorktree, ".schema", sessionID)
  if (canonicalSession !== expectedSession) {
    throw new Error(
      `Refusing unsafe schema session directory: ${sessionDirectory}`,
    )
  }

  const candidatesDirectory = path.join(sessionDirectory, "candidates")
  const candidatesInfo = await lstat(candidatesDirectory)
  if (candidatesInfo.isSymbolicLink() || !candidatesInfo.isDirectory()) {
    throw new Error(
      `Refusing unsafe candidates directory: ${candidatesDirectory}`,
    )
  }
  const canonicalCandidates = await realpath(candidatesDirectory)
  if (canonicalCandidates !== path.join(canonicalSession, "candidates")) {
    throw new Error(
      `Refusing unsafe candidates directory: ${candidatesDirectory}`,
    )
  }

  const resolved = path.join(candidatesDirectory, match[1])
  const info = await lstat(resolved)
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`Refusing unsafe candidate snapshot: ${resolved}`)
  }
  const canonicalResolved = await realpath(resolved)
  if (path.dirname(canonicalResolved) !== canonicalCandidates) {
    throw new Error(`Refusing unsafe candidate snapshot: ${resolved}`)
  }
  return canonicalResolved
}

export async function deleteCandidateSnapshot(
  worktree: string,
  sessionID: string,
  reference: string,
): Promise<void> {
  const resolved = await resolveCandidateSnapshot(worktree, sessionID, reference)
  await makeTreeRemovable(resolved)
  await rm(resolved, { recursive: true })
}

export async function readLedger(worktree: string, sessionID: string): Promise<ParsedLedgerRow[]> {
  let contents: string
  try {
    contents = await readFile(ledgerFile(worktree, sessionID), "utf8")
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }

  return contents
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as ParsedLedgerRow)
}

export async function appendLedger(
  worktree: string,
  sessionID: string,
  input: LedgerRowInput,
): Promise<LedgerRow> {
  const directory = await ensureSessionDirectory(worktree, sessionID)
  const row = { ...input, step: (await readLedger(worktree, sessionID)).length + 1 } as LedgerRow
  const ledger = await open(
    path.join(directory, "ledger.jsonl"),
    constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    await ledger.writeFile(`${JSON.stringify(row)}\n`, "utf8")
  } finally {
    await ledger.close()
  }
  return row
}

export function advanceIdleTracking(run: RunState, ledgerLength: number): RunState {
  const ledgerChanged = ledgerLength !== run.lastLedgerLen
  return {
    ...run,
    lastLedgerLen: ledgerLength,
    stallCount: ledgerChanged ? 0 : run.stallCount + 1,
  }
}
