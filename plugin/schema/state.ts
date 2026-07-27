import { constants } from "node:fs"
import { lstat, mkdir, open, readFile, rename, writeFile } from "node:fs/promises"
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

export type RunState = {
  status: RunStatus
  benchmark: Benchmark | null
  characterized: boolean
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
}

export type VerificationActual = {
  pass: boolean
  failing: string[]
  score?: number
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
  prediction?: Prediction
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
  prediction?: Prediction
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
  }
}

function sessionDirectory(worktree: string, sessionID: string): string {
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
      await mkdir(directory)
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
  const directory = sessionDirectory(worktree, sessionID)
  await ensureDirectory(directory)
  return directory
}

export function runFile(worktree: string, sessionID: string): string {
  return path.join(sessionDirectory(worktree, sessionID), "run.json")
}

export function ledgerFile(worktree: string, sessionID: string): string {
  return path.join(sessionDirectory(worktree, sessionID), "ledger.jsonl")
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
