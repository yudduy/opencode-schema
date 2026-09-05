import { constants } from "node:fs"
import { lstat, open } from "node:fs/promises"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { tool, type Hooks, type Plugin, type PluginModule, type ToolResult } from "@opencode-ai/plugin"
import {
  EXCLUDED_ACTION_TOOLS,
  appendAction,
  appendReview,
  classifyRisky,
  digestArgs,
  readActionTail,
  type ActionRow,
} from "./actions.ts"
import {
  advanceIdleTracking,
  appendLedger,
  captureCandidateSnapshot,
  createRunState,
  deleteCandidateSnapshot,
  isVerificationLedgerRow,
  readLedger,
  readRun,
  readWorldModel,
  resolveCandidateSnapshot,
  writeRun,
  writeWorldModel,
  type ParsedLedgerRow,
  type Assertion,
  type Benchmark,
  type FrontierCandidate,
  type Prediction,
  type ReviewTrigger,
  type RunState,
  type SurpriseAnnotation,
  type VerificationActual,
  type VerificationLedgerRow,
  type WorldModelRegistration,
} from "./state.ts"
import { parseVerifyOutput, runBenchmarkCommand } from "./verify.ts"
import {
  buildReplayReport,
  combineSurprises,
  detectObservationSurprise,
  distinctOfficialCandidateCount,
  fullCandidateDedupGate,
  modeledFrontierGatePredicate,
  rankNextExperiments,
  scoreFrontier,
  worldModelGatePredicate,
  type FrontierPrediction,
  type ReplayPrediction,
  type ReplayReport,
} from "./mechanisms.ts"
import {
  assertWorldModelSandboxAvailable,
  executeWorldModel,
  validateWorldModelExecutable,
} from "./world-model.ts"
import {
  inferCanonicalTargetPath,
  inspectLiveCandidate,
  installCandidateOverlay,
  overlayArtifactInSnapshot,
  readCandidateArtifact,
  storeCandidateArtifact,
  type PreservedTarget,
} from "./frontier.ts"

export {
  buildReplayReport,
  combineSurprises,
  compareVerificationResults,
  detectObservationSurprise,
  distinctOfficialCandidateCount,
  fullCandidateDedupGate,
  modeledFrontierGatePredicate,
  obviouslyInvokesVerifier,
  parseWorldModelOutput,
  rankNextExperiments,
  scoreFrontier,
  worldModelGatePredicate,
} from "./mechanisms.ts"

export const CHARACTERIZE_REASON =
  "Characterize first: run run_verify({scope:'characterize'}) to capture a green baseline before editing (theory before edits)."

export const SCHEMA_REMINDER =
  "<schema_reminder>With a world model: propose many candidates, score the frontier for free, then officially evaluate only unseen bytes chosen for information. Without a world model: predict before full verification. Replay must stay green.</schema_reminder>"

export const STALL_NUDGE_AT = 3
export const MAX_IDLE_CYCLES = 500
export const ERROR_BACKOFF_BASE_MS = 5_000
export const ERROR_BACKOFF_MAX_MS = 300_000
export const POLICY_BLOCK_STOP_AT = 3
export const REVIEWER_AGENT = "reviewer"
export const MIN_REVIEW_INTERVAL_MS = 30_000
export const MAX_REVIEWS_PER_SESSION = 40

const riskyByCall = new Map<string, string>()

const prompts = {
  surprise:
    "Reality contradicted your prediction. Stop editing, localize the first wrong assumption, repair the world model, then run the cheapest discriminating check.",
  stall:
    "Three idle cycles produced no new evidence. Reconsider the representation, replace accumulated patches with one simpler rule, then choose a decisive cheap check.",
  continue:
    "Continue the schema loop: propose distinct candidates, score the frontier for free, and use next_experiment before spending on unseen bytes. Without a world model, record one scalar prediction first.",
  budget:
    "Verification budget exhausted. Stop running checks. Record the strongest confirmed model, unresolved uncertainty, and the next discriminating experiment.",
  error: (detail: string) =>
    `Previous turn ended with an error: ${detail}. No new evidence was recorded. Re-read run state, world_model.md, and the ledger; re-establish your last prediction, then continue the schema loop with the cheapest discriminating check.`,
  policy: (detail: string) =>
    `The provider's content filter refused the previous output: ${detail}. This is frequently an over-broad false positive on authorized or defensive research, but retrying the identical request will be refused again. DO NOT repeat it: reframe at a higher level of abstraction, describe intent rather than emitting the flagged artifact, or decompose the step differently. If the task genuinely cannot proceed on this model without the flagged action, record the blocker in notes.md and stop.`,
} as const

export type EditGateDecision = { status: "deny"; reason: string } | null

const gatedTools = new Set([
  "edit",
  "write",
  "patch",
  "apply_patch",
  "bash",
  "shell",
  "memory",
  "task",
  "workflow",
  "repo_clone",
  "spawn_agent",
  "followup_task",
])
const z = tool.schema

export function editGatePredicate(run: RunState | null, toolName: string): EditGateDecision {
  if (!run || run.characterized === true || !gatedTools.has(toolName)) return null
  // A harness-side snapshot failure is not the agent failing to theorize first.
  // Keeping the gate shut there is a deadlock: characterize cannot run until the
  // workspace is repaired, and repair is exactly what the gate forbids.
  if (run.characterizeBlocked === true) return null
  return { status: "deny", reason: CHARACTERIZE_REASON }
}

export function executorFanoutPredicate(
  toolName: string,
  args: unknown,
): { rewrite: Record<string, unknown> } | null {
  if (toolName !== "task" || args === null || typeof args !== "object") return null
  const values = args as Record<string, unknown>
  const subagent = values.subagent_type ?? values.agent ?? values.agentType
  if (subagent !== "executor" || values.worktree === true) return null
  return { rewrite: { ...values, worktree: true } }
}

export type Verdict = {
  action:
    | "solved"
    | "stalled"
    | "blocked"
    | "aborted"
    | "policy"
    | "error"
    | "surprise"
    | "stall"
    | "budget"
    | "continue"
  prompt?: string
}

type PendingError = { name?: string; message?: string }

const policyRefusalMarkers = [
  "flagged for possible",
  "cyber_policy",
  "cybersecurity risk",
  "content policy",
  "usage policy",
  "content_policy",
  "content was flagged",
  "moderation",
  "safety policy",
] as const

export function computeErrorBackoff(streak: number): number {
  if (streak <= 1) return 0
  return Math.min(ERROR_BACKOFF_BASE_MS * 2 ** (streak - 2), ERROR_BACKOFF_MAX_MS)
}

export function isPolicyRefusal(error?: PendingError | null): boolean {
  const message = error?.message?.toLowerCase()
  return !!message && policyRefusalMarkers.some((marker) => message.includes(marker))
}

function errorDetail(error: PendingError): string {
  return `${error.name}: ${error.message}`.replace(/[\r\n]+/g, " ").slice(0, 200)
}

export function normalizeCheckName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/(?:[\\/]+|::)+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function normalizedNamesMatch(left: string, right: string): boolean {
  if (!left || !right) return false
  if (left === right) return true

  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left]
  if (shorter === longer.split(" ").at(-1)) return true
  return shorter.length >= 3 && longer.length >= 3 && longer.includes(shorter)
}

function withoutFailureMarker(value: string): string {
  return value
    .replace(/^(?:(?:fail|not ok(?:\s+\d+)?)\b|✗)\s*(?:[:\-]\s*)?/, "")
    .trim()
}

function contradictsPrediction(row: VerificationLedgerRow): boolean {
  if (!row.prediction) return false
  const failing = row.actual.failing.map(normalizeCheckName)
  return row.prediction.predicted_pass_set.some((check) => {
    const predicted = normalizeCheckName(check)
    return failing.some(
      (failure) =>
        normalizedNamesMatch(predicted, failure) ||
        normalizedNamesMatch(predicted, withoutFailureMarker(failure)),
    )
  })
}

function failureMatchesCheck(check: string, failure: string): boolean {
  const normalizedCheck = normalizeCheckName(check)
  const normalizedFailure = normalizeCheckName(failure)
  return (
    normalizedNamesMatch(normalizedCheck, normalizedFailure) ||
    normalizedNamesMatch(normalizedCheck, withoutFailureMarker(normalizedFailure))
  )
}

/** Read the value an assertion refers to out of an observed verification. */
function actualFor(metric: Assertion["metric"], actual: VerificationLedgerRow["actual"]) {
  if (metric === "score") return actual.score
  if (metric === "pass") return actual.pass
  return actual.failing.length
}

function compare(op: Assertion["op"], left: number | boolean, right: number | boolean, tol = 0): boolean {
  if (typeof left === "boolean" || typeof right === "boolean") {
    const l = Boolean(left)
    const r = Boolean(right)
    return op === "!=" ? l !== r : l === r
  }
  switch (op) {
    case ">=": return left >= right - tol
    case "<=": return left <= right + tol
    case ">": return left > right - tol
    case "<": return left < right + tol
    case "==": return Math.abs(left - right) <= tol
    case "!=": return Math.abs(left - right) > tol
  }
}

/** The refutation step, as an evaluation rather than a string match. */
export function evaluateAssertions(
  prediction: { assertions?: Assertion[] },
  actual: VerificationLedgerRow["actual"],
): { assertion: Assertion; observed: number | boolean | undefined }[] {
  const failed: { assertion: Assertion; observed: number | boolean | undefined }[] = []
  for (const assertion of prediction.assertions ?? []) {
    const observed = actualFor(assertion.metric, actual)
    // An assertion about a metric reality did not report is unfalsified, not false —
    // treating a missing score as a refutation would fire on every un-scored run.
    if (observed === undefined) continue
    if (!compare(assertion.op, observed, assertion.value, assertion.tol ?? 0)) {
      failed.push({ assertion, observed })
    }
  }
  return failed
}

export function detectSurprise(
  row: VerificationLedgerRow,
  baselineFailing: string[],
): SurpriseAnnotation | null {
  if (!row.prediction) return null

  const failedAssertions = evaluateAssertions(row.prediction, row.actual)
  if (failedAssertions.length > 0) {
    const { assertion, observed } = failedAssertions[0]
    return {
      kind: "assertion_failed",
      detail:
        `Predicted ${assertion.metric} ${assertion.op} ${assertion.value}` +
        `, observed ${observed}` +
        (failedAssertions.length > 1 ? ` (+${failedAssertions.length - 1} more)` : ""),
    }
  }

  for (const predicted of row.prediction.predicted_pass_set) {
    const failure = row.actual.failing.find((candidate) =>
      failureMatchesCheck(predicted, candidate),
    )
    if (failure) {
      return {
        kind: "predicted_pass_failed",
        detail: `Predicted pass failed: ${failure}`.slice(0, 200),
      }
    }
  }

  for (const failure of row.actual.failing) {
    const predicted = row.prediction.predicted_pass_set.some((check) =>
      failureMatchesCheck(check, failure),
    )
    const baseline = baselineFailing.some((check) =>
      failureMatchesCheck(check, failure),
    )
    if (!predicted && !baseline) {
      return {
        kind: "side_effect_flip",
        detail: `New unpredicted failure: ${failure}`.slice(0, 200),
      }
    }
  }

  return null
}

export function reconcileTerminalOutcome(
  run: RunState,
  ledger: ParsedLedgerRow[],
): "solved" | null {
  // A stall or budget verdict is a judgment about progress at that moment, not
  // ground truth about the task. If the session was later driven (manually) to
  // a green full run, the recorded outcome must say solved.
  if (run.status !== "stalled" && run.status !== "budget_limited") return null
  for (let index = ledger.length - 1; index >= 0; index -= 1) {
    const row = ledger[index]
    if (isVerificationLedgerRow(row) && row.scope === "full") {
      return row.actual.pass === true ? "solved" : null
    }
  }
  return null
}

export function decideVerdict(
  run: RunState,
  ledgerTail: ParsedLedgerRow[],
  lastError?: PendingError | null,
): Verdict {
  let latestFull: VerificationLedgerRow | undefined
  for (let index = ledgerTail.length - 1; index >= 0; index -= 1) {
    const row = ledgerTail[index]
    if (isVerificationLedgerRow(row) && row.scope === "full") {
      latestFull = row
      break
    }
  }
  if (latestFull?.actual.pass === true) return { action: "solved" }

  if (lastError?.name === "MessageAbortedError") return { action: "aborted" }
  if (run.verifyActionsUsed >= run.verifyActionBudget) return { action: "budget", prompt: prompts.budget }
  if (run.idleCycles >= MAX_IDLE_CYCLES) return { action: "stalled" }
  if (lastError && isPolicyRefusal(lastError)) {
    if ((run.policyBlockStreak ?? 0) + 1 >= POLICY_BLOCK_STOP_AT) {
      return { action: "blocked" }
    }
    return { action: "policy", prompt: prompts.policy(errorDetail(lastError)) }
  }
  if (lastError) {
    return { action: "error", prompt: prompts.error(errorDetail(lastError)) }
  }

  const idleState = advanceIdleTracking(run, ledgerTail.length)
  const newRows = ledgerTail.slice(Math.max(0, run.lastLedgerLen))
  const hasContradiction = newRows.some(
    (row) =>
      isVerificationLedgerRow(row) &&
      (row.scope === "full" || row.scope === "targeted") &&
      (row.surprise != null || contradictsPrediction(row)),
  )
  if (hasContradiction) {
    return { action: "surprise", prompt: prompts.surprise }
  }

  if (idleState.stallCount >= STALL_NUDGE_AT) return { action: "stall", prompt: prompts.stall }
  return { action: "continue", prompt: prompts.continue }
}

function compactReviewValue(value: string, limit = 240): string {
  return value
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, limit)
    .replace(/[&<>]/g, (character) => {
      if (character === "&") return "&amp;"
      if (character === "<") return "&lt;"
      return "&gt;"
    })
}

export function composeReviewRequest(
  trigger: ReviewTrigger,
  detail: string | undefined,
  ledgerTail: ParsedLedgerRow[],
  actionTail: ActionRow[],
): string {
  const ledgerLines = ledgerTail.map((row) => {
    if (!isVerificationLedgerRow(row)) {
      return `step=${row.step} scope=${compactReviewValue(row.scope, 80)}`
    }
    const failing = compactReviewValue(row.actual.failing.slice(0, 3).join("; "), 200)
    return [
      `step=${row.step}`,
      `scope=${row.scope}`,
      `pass=${row.actual.pass}`,
      ...(failing ? [`failing=${failing}`] : []),
      ...(row.surprise ? [`surprise=${row.surprise.kind}`] : []),
    ].join(" ")
  })
  const actionLines = actionTail.map((row) =>
    [
      `step=${row.step}`,
      `tool=${compactReviewValue(row.tool, 80)}`,
      `digest=${compactReviewValue(row.digest, 200)}`,
      `outcome=${row.outcome}`,
      ...(row.risky ? [`risky=${compactReviewValue(row.risky, 80)}`] : []),
    ].join(" "),
  )

  return [
    `<action_review_request trigger="${trigger}">`,
    `<trigger_detail>${compactReviewValue(detail ?? "")}</trigger_detail>`,
    "<ledger_tail>",
    ...ledgerLines,
    "</ledger_tail>",
    "<action_tail>",
    ...actionLines,
    "</action_tail>",
    "You may read world_model.md and the repository to verify claims.",
    "Reply exactly REVIEW_OK if the actions are sound; otherwise use at most 3 sentences naming the first wrong action and the cheapest corrective check.",
    "</action_review_request>",
  ].join("\n")
}

function toolError(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error)
  return {
    title: `Schema tool error: ${message}`,
    output: message,
    metadata: { error: message },
  }
}

function registeredVerificationCommands(benchmark: Benchmark): string[] {
  return [
    benchmark.verify_cmd,
    ...(benchmark.targeted_cmd ? [benchmark.targeted_cmd] : []),
    ...(benchmark.score_cmd ? [benchmark.score_cmd] : []),
  ]
}

function benchmarksEqual(left: Benchmark, right: Benchmark): boolean {
  return (
    left.verify_cmd === right.verify_cmd &&
    left.targeted_cmd === right.targeted_cmd &&
    left.score_cmd === right.score_cmd
  )
}

function exceptionMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function replayHistory(
  worktree: string,
  sessionID: string,
  benchmark: Benchmark,
  worldModel: WorldModelRegistration,
  ledger: ParsedLedgerRow[],
  signal?: AbortSignal,
): Promise<ReplayReport> {
  const predictions: ReplayPrediction[] = []
  for (const row of ledger) {
    if (!isVerificationLedgerRow(row)) continue
    if (!row.candidate) {
      predictions.push({
        step: row.step,
        actual: row.actual,
        error: "Candidate snapshot is unavailable for this legacy verification row.",
      })
      continue
    }
    try {
      const candidate = await resolveCandidateSnapshot(
        worktree,
        sessionID,
        row.candidate,
      )
      const predicted = await executeWorldModel(
        worktree,
        worldModel,
        registeredVerificationCommands(benchmark),
        candidate,
        signal,
      )
      predictions.push({ step: row.step, actual: row.actual, predicted })
    } catch (error) {
      predictions.push({
        step: row.step,
        actual: row.actual,
        error: exceptionMessage(error),
      })
    }
  }
  return buildReplayReport(predictions)
}

function replayResult(report: ReplayReport) {
  return {
    reproduced: `${report.reproduced}/${report.total}`,
    green: report.green,
    rows: report.rows,
  }
}

function officiallyEvaluatedHashes(ledger: readonly ParsedLedgerRow[]): string[] {
  return ledger.flatMap((row) =>
    row.scope === "full" && typeof row.contentHash === "string"
      ? [row.contentHash]
      : [],
  )
}

function verificationResult(
  parsed: ReturnType<typeof parseVerifyOutput>,
  run: RunState,
  predicted?: VerificationActual,
  surprise?: SurpriseAnnotation | null,
  details: Record<string, unknown> = {},
): ToolResult {
  const result = {
    ...(predicted ? { predicted } : {}),
    ...parsed,
    ...(surprise ? { surprise } : {}),
    verifyActionsUsed: run.verifyActionsUsed,
    budget: run.verifyActionBudget,
    ...(run.verifyActionsUsed >= run.verifyActionBudget ? { status: "budget_limited" as const } : {}),
    ...details,
  }
  return {
    title: "Schema verification",
    output: JSON.stringify(result),
    metadata: result,
  }
}

function markdownCell(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|")
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

export const server: Plugin = async ({ client, $, worktree }) => {
  const locks = new Map<string, Promise<void>>()
  const runningControllers = new Set<string>()
  // Sessions currently driven by the fork's GoalDriver (tracked from goal.updated
  // events; there is no SDK goal getter). While a goal is active the goal loop owns
  // clean continuation; errored turns are recovered below because GoalDriver skips them.
  const activeGoals = new Map<string, boolean>()
  const lastErrors = new Map<string, PendingError>()

  async function withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = locks.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    locks.set(key, current)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (locks.get(key) === current) locks.delete(key)
    }
  }

  async function ensureReviewerSession(
    sessionID: string,
    run: RunState,
    directory: string,
  ): Promise<string> {
    if (run.reviewerSessionID) return run.reviewerSessionID

    const created = await client.session.create({
      body: { title: `schema-reviewer:${sessionID}` },
      query: { directory },
    })
    if (created.error || !created.data?.id) {
      throw new Error(`Unable to create reviewer session: ${JSON.stringify(created.error)}`)
    }
    run.reviewerSessionID = created.data.id
    return created.data.id
  }

  async function dispatchReview(
    sessionID: string,
    run: RunState,
    directory: string,
  ): Promise<string | null> {
    const pending = run.pendingReview
    if (!pending) return null

    if (pending.key === run.lastReviewKey) {
      run.pendingReview = null
      return null
    }
    if (run.reviewCount >= MAX_REVIEWS_PER_SESSION) {
      run.pendingReview = null
      return null
    }

    const now = Date.now()
    if (now - run.lastReviewTs < MIN_REVIEW_INTERVAL_MS) return null

    try {
      const reviewerSessionID = await ensureReviewerSession(sessionID, run, directory)
      const [ledger, actions] = await Promise.all([
        readLedger(directory, sessionID),
        readActionTail(directory, sessionID, 12),
      ])
      const request = composeReviewRequest(
        pending.trigger,
        pending.detail,
        ledger.slice(-8),
        actions,
      )
      const reviewed = await client.session.prompt({
        path: { id: reviewerSessionID },
        body: {
          agent: REVIEWER_AGENT,
          parts: [{ type: "text", text: request }],
        },
      })
      if (reviewed.error || !reviewed.data) {
        throw new Error(`Unable to run action reviewer: ${JSON.stringify(reviewed.error)}`)
      }
      if (reviewed.data.info.error) {
        throw new Error(`Action reviewer failed: ${JSON.stringify(reviewed.data.info.error)}`)
      }

      const message = reviewed.data.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("")
        .replace(/<think>[\s\S]*?<\/think>/gi, "")
        .trim()
      const verdict = message === "" || message === "REVIEW_OK" ? "ok" : "redirect"
      await appendReview(directory, sessionID, {
        ts: now,
        trigger: pending.trigger,
        key: pending.key,
        verdict,
        message,
        ...(reviewed.data.info.modelID ? { model: reviewed.data.info.modelID } : {}),
      })
      run.lastReviewKey = pending.key
      run.lastReviewTs = now
      run.reviewCount += 1
      run.pendingReview = null
      return verdict === "redirect" ? message : null
    } catch {
      run.reviewerSessionID = null
      return null
    }
  }

  async function persistReviewState(sessionID: string, run: RunState): Promise<void> {
    const persisted = await readRun(worktree, sessionID)
    if (!persisted) return
    persisted.reviewerSessionID = run.reviewerSessionID
    persisted.pendingReview = run.pendingReview
    persisted.lastReviewKey = run.lastReviewKey
    persisted.lastReviewTs = run.lastReviewTs
    persisted.reviewCount = run.reviewCount
    await writeRun(worktree, sessionID, persisted)
  }

  async function controlIdle(sessionID: string, pending?: PendingError): Promise<void> {
    await withLock(`session:${sessionID}`, async () => {
      let markedInflight = false
      try {
        const run = await readRun(worktree, sessionID)
        if (!run || run.inflight) return
        if (run.status !== "active") {
          const flipped = reconcileTerminalOutcome(run, await readLedger(worktree, sessionID))
          if (flipped) {
            run.status = flipped
            await writeRun(worktree, sessionID, run)
          }
          return
        }

        run.inflight = true
        run.idleCycles = (Number.isFinite(run.idleCycles) ? run.idleCycles : 0) + 1
        await writeRun(worktree, sessionID, run)
        markedInflight = true

        const ledger = await readLedger(worktree, sessionID)
        const verdict = decideVerdict(run, ledger, pending ?? null)
        const controllerOwnsErroredTurn =
          verdict.action === "error" || verdict.action === "policy" || verdict.action === "blocked"
        const next = advanceIdleTracking(run, ledger.length)
        if (
          verdict.action === "solved" ||
          verdict.action === "stalled" ||
          verdict.action === "blocked"
        ) {
          next.status = verdict.action
          await writeRun(worktree, sessionID, next)
          return
        }

        const session = await client.session.get({ path: { id: sessionID } })
        if (session.error) throw new Error(`Unable to load schema session: ${JSON.stringify(session.error)}`)

        // Child sessions (subagents/teammates) self-stop and return to their
        // parent; resuming one with agent:"schema" would hijack it. Mirror
        // GoalDriver's top-level-only rule: bookkeep, never drive.
        const info = session.data as { parentID?: string } | undefined
        if (info?.parentID) {
          await writeRun(worktree, sessionID, next)
          return
        }

        if (verdict.action === "aborted") {
          next.errorStreak = 0
          await writeRun(worktree, sessionID, next)
          return
        }

        if (verdict.action !== "error" && verdict.action !== "policy") {
          next.errorStreak = 0
          next.policyBlockStreak = 0
        }

        // GoalDriver skips errored turns by design, so this controller owns error
        // recovery and policy-wall handling (including the terminal branch above).
        // Clean continuation stays with the goal loop; budget exhaustion still
        // finalizes because run_verify already reported budget_limited.
        if (activeGoals.get(sessionID) && !controllerOwnsErroredTurn) {
          if (verdict.action === "budget") next.status = "budget_limited"
          await writeRun(worktree, sessionID, next)
          return
        }

        if (verdict.action === "error") {
          next.errorStreak = (run.errorStreak ?? 0) + 1
          next.policyBlockStreak = 0
          await writeRun(worktree, sessionID, next)
          await sleep(computeErrorBackoff(next.errorStreak))
          const latest = await readRun(worktree, sessionID)
          if (!latest || latest.status !== "active") return
        }
        if (verdict.action === "policy") {
          next.policyBlockStreak = (run.policyBlockStreak ?? 0) + 1
          next.errorStreak = 0
          await writeRun(worktree, sessionID, next)
          await sleep(computeErrorBackoff(next.policyBlockStreak))
          const latest = await readRun(worktree, sessionID)
          if (!latest || latest.status !== "active") return
        }

        if (verdict.action === "stall" && !next.pendingReview) {
          next.pendingReview = {
            trigger: "stall",
            key: `stall:${next.idleCycles}`,
            ts: Date.now(),
          }
        }
        const redirect = await dispatchReview(sessionID, next, worktree)
        await persistReviewState(sessionID, next)
        const resumePrompt = verdict.prompt ?? prompts.continue
        const resumed = await client.session.promptAsync({
          path: { id: sessionID },
          body: {
            agent: "schema",
            parts: [
              {
                type: "text",
                text: redirect
                  ? `<action_review>${redirect}</action_review>\n\n${resumePrompt}`
                  : resumePrompt,
              },
            ],
          },
        })
        if (resumed.error) throw new Error(`Unable to resume schema session: ${JSON.stringify(resumed.error)}`)

        if (verdict.action === "error" || verdict.action === "policy") return
        if (verdict.action === "budget") next.status = "budget_limited"
        await writeRun(worktree, sessionID, next)
      } finally {
        if (markedInflight) {
          const latest = await readRun(worktree, sessionID)
          if (latest) {
            latest.inflight = false
            await writeRun(worktree, sessionID, latest)
          }
        }
      }
    })
  }

  const hooks: Hooks = {
    tool: {
      register_benchmark: tool({
        description: "Register benchmark commands and an optional full-verification budget for this schema run.",
        args: {
          verify_cmd: z.string().min(1),
          targeted_cmd: z.string().min(1).optional(),
          score_cmd: z.string().min(1).optional(),
          notes: z.string().optional(),
          verify_action_budget: z.number().int().min(1).max(10_000).optional(),
        },
        async execute(args, context) {
          return withLock(`session:${context.sessionID}`, async () => {
            try {
              const existing = await readRun(worktree, context.sessionID)
              const run = existing ?? createRunState()
              const benchmark: Benchmark = {
                verify_cmd: args.verify_cmd,
                ...(args.targeted_cmd
                  ? { targeted_cmd: args.targeted_cmd }
                  : {}),
                ...(args.score_cmd ? { score_cmd: args.score_cmd } : {}),
              }
              const verifyActionBudget =
                args.verify_action_budget ?? run.verifyActionBudget
              const ledger = existing
                ? await readLedger(worktree, context.sessionID)
                : []
              const benchmarkChanged =
                !!existing?.benchmark &&
                !benchmarksEqual(existing.benchmark, benchmark)
              const budgetChanged =
                !!existing &&
                existing.verifyActionBudget !== verifyActionBudget
              if (
                existing &&
                ((ledger.length > 0 &&
                  (!existing.benchmark ||
                    benchmarkChanged ||
                    budgetChanged)) ||
                  (existing.frontier.length > 0 &&
                    (!existing.benchmark || benchmarkChanged)))
              ) {
                throw new Error(
                  "Benchmark registration is locked after evidence exists or candidate proposals are registered. Start a new opencode session to change commands; the budget is also locked after evidence.",
                )
              }

              run.status = "active"
              run.benchmark = benchmark
              run.verifyActionBudget = verifyActionBudget
              await writeRun(worktree, context.sessionID, run)
              return "Benchmark registered; characterize before editing."
            } catch (error) {
              return toolError(error)
            }
          })
        },
      }),
      set_world_model: tool({
        description:
          "Declare an executable offline predictor in the worktree. It receives a candidate snapshot path and prints one JSON verifier result.",
        args: {
          path: z.string().min(1),
        },
        async execute(args, context) {
          return withLock(`session:${context.sessionID}`, async () => {
            try {
              const run = await readRun(worktree, context.sessionID)
              if (!run?.benchmark) {
                throw new Error(
                  "Register a benchmark before declaring a world model.",
                )
              }
              const ledger = await readLedger(worktree, context.sessionID)
              const unreplayable = ledger.filter(
                (row) => isVerificationLedgerRow(row) && !row.candidate,
              )
              if (unreplayable.length > 0) {
                throw new Error(
                  `Cannot declare a world model: ${unreplayable.length} existing verification row(s) lack candidate snapshots. ` +
                    "These legacy rows cannot be replayed. Continue this session without a world model, or start a new opencode session.",
                )
              }

              const validated = await validateWorldModelExecutable(
                worktree,
                args.path,
                registeredVerificationCommands(run.benchmark),
              )
              await assertWorldModelSandboxAvailable(worktree)
              await writeWorldModel(
                worktree,
                context.sessionID,
                validated.registration,
              )

              const result = {
                declared: true,
                worldModel: validated.registration,
                historyRows: ledger.filter(isVerificationLedgerRow).length,
                message:
                  "Run replay_verify() to test the model against every recorded verification.",
              }
              return {
                title: "Schema world model",
                output: JSON.stringify(result),
                metadata: result,
              }
            } catch (error) {
              return toolError(error)
            }
          })
        },
      }),
      propose: tool({
        description:
          "Register several immutable candidate program files for wide, free world-model exploration.",
        args: {
          candidates: z
            .array(
              z.object({
                id: z.string().min(1),
                path: z.string().min(1),
                rationale: z.string().min(1),
              }),
            )
            .min(1)
            .max(50),
        },
        async execute(args, context) {
          return withLock(`session:${context.sessionID}`, async () => {
            try {
              const run = await readRun(worktree, context.sessionID)
              if (!run?.benchmark) {
                throw new Error("Register a benchmark before proposing candidates.")
              }
              const existingIds = new Set(run.frontier.map((candidate) => candidate.id))
              const requestIds = new Set<string>()
              for (const candidate of args.candidates) {
                if (existingIds.has(candidate.id) || requestIds.has(candidate.id)) {
                  throw new Error(
                    `Candidate id '${candidate.id}' is already registered; use a new id for new bytes.`,
                  )
                }
                requestIds.add(candidate.id)
              }

              const inferred = run.frontierTarget
                ? null
                : await inferCanonicalTargetPath(worktree, run.benchmark)
              const targetPath =
                run.frontierTarget ?? inferred?.relativePath
              if (!targetPath) {
                throw new Error("Unable to resolve the canonical verifier target.")
              }

              const proposedAt = Date.now()
              const additions: FrontierCandidate[] = []
              for (const candidate of args.candidates) {
                const stored = await storeCandidateArtifact(
                  worktree,
                  context.sessionID,
                  candidate.path,
                )
                additions.push({
                  id: candidate.id,
                  path: stored.path,
                  rationale: candidate.rationale,
                  contentHash: stored.contentHash,
                  artifact: stored.artifact,
                  proposedAt,
                })
              }
              run.frontierTarget = targetPath
              run.frontier.push(...additions)
              await writeRun(worktree, context.sessionID, run)

              const result = {
                proposed: additions.map(
                  ({ id, path: candidatePath, rationale, contentHash }) => ({
                    id,
                    path: candidatePath,
                    rationale,
                    contentHash,
                  }),
                ),
                frontierSize: run.frontier.length,
                targetPath,
                liveCandidate: run.liveCandidate,
                ...(inferred ? { inference: inferred.evidence } : {}),
              }
              return {
                title: "Schema candidate frontier",
                output: JSON.stringify(result),
                metadata: result,
              }
            } catch (error) {
              return toolError(error)
            }
          })
        },
      }),
      score_frontier: tool({
        description:
          "Run the declared world model over every proposed candidate. This is free, unlimited, and spends no official budget.",
        args: {},
        async execute(_args, context) {
          return withLock(`session:${context.sessionID}`, () =>
            withLock("worktree:verification", async () => {
              try {
                const run = await readRun(worktree, context.sessionID)
                if (!run?.benchmark) {
                  throw new Error("Register a benchmark before scoring candidates.")
                }
                const worldModel = await readWorldModel(
                  worktree,
                  context.sessionID,
                )
                if (!worldModel) {
                  throw new Error(
                    "Declare a world model with set_world_model before scoring the frontier.",
                  )
                }
                if (run.frontier.length === 0) {
                  const result = {
                    frontier: [],
                    cost: 0,
                    verifyActionsUsed: run.verifyActionsUsed,
                    budget: run.verifyActionBudget,
                    remaining: Math.max(
                      0,
                      run.verifyActionBudget - run.verifyActionsUsed,
                    ),
                    liveCandidate: run.liveCandidate,
                    message:
                      "The frontier is empty. Call propose(...) with several real candidate files; scoring remains free.",
                  }
                  return {
                    title: "Schema frontier scoring",
                    output: JSON.stringify(result),
                    metadata: result,
                  }
                }
                if (!run.frontierTarget) {
                  throw new Error(
                    "Frontier target is missing; propose the candidates again in a new session.",
                  )
                }

                const predictions: FrontierPrediction[] = []
                for (const candidate of run.frontier) {
                  const bytes = await readCandidateArtifact(
                    worktree,
                    context.sessionID,
                    candidate.artifact,
                    candidate.contentHash,
                  )
                  let snapshotReference: string | null = null
                  try {
                    snapshotReference = await captureCandidateSnapshot(
                      worktree,
                      context.sessionID,
                    )
                    const snapshot = await resolveCandidateSnapshot(
                      worktree,
                      context.sessionID,
                      snapshotReference,
                    )
                    await overlayArtifactInSnapshot(
                      snapshot,
                      bytes,
                      run.frontierTarget,
                    )
                    const predicted = await executeWorldModel(
                      worktree,
                      worldModel,
                      registeredVerificationCommands(run.benchmark),
                      snapshot,
                      context.abort,
                    )
                    predictions.push({
                      id: candidate.id,
                      contentHash: candidate.contentHash,
                      predicted,
                    })
                  } finally {
                    if (snapshotReference) {
                      await deleteCandidateSnapshot(
                        worktree,
                        context.sessionID,
                        snapshotReference,
                      )
                    }
                  }
                }

                const predictedAt = Date.now()
                const predictionById = new Map(
                  predictions.map((prediction) => [
                    prediction.id,
                    prediction.predicted,
                  ]),
                )
                run.frontier = run.frontier.map((candidate) => ({
                  ...candidate,
                  predicted: predictionById.get(candidate.id)!,
                  predictedAt,
                }))
                const ledger = await readLedger(worktree, context.sessionID)
                const frontier = scoreFrontier(
                  run.frontier,
                  predictions,
                  officiallyEvaluatedHashes(ledger),
                )
                await writeRun(worktree, context.sessionID, run)
                const result = {
                  frontier,
                  cost: 0,
                  verifyActionsUsed: run.verifyActionsUsed,
                  budget: run.verifyActionBudget,
                  remaining: Math.max(
                    0,
                    run.verifyActionBudget - run.verifyActionsUsed,
                  ),
                  liveCandidate: run.liveCandidate,
                }
                return {
                  title: "Schema frontier scoring",
                  output: JSON.stringify(result),
                  metadata: result,
                }
              } catch (error) {
                return toolError(error)
              }
            }),
          )
        },
      }),
      next_experiment: tool({
        description:
          "Advisory ranking of unseen, model-scored candidates by disagreement or inferred pass/fail-boundary proximity.",
        args: {},
        async execute(_args, context) {
          return withLock(`session:${context.sessionID}`, async () => {
            try {
              const run = await readRun(worktree, context.sessionID)
              if (!run?.benchmark) {
                throw new Error("Register a benchmark before ranking experiments.")
              }
              if (!(await readWorldModel(worktree, context.sessionID))) {
                throw new Error(
                  "Declare a world model with set_world_model before ranking experiments.",
                )
              }
              const ledger = await readLedger(worktree, context.sessionID)
              const evaluatedHashes = officiallyEvaluatedHashes(ledger)
              const scoredCandidates = run.frontier.filter(
                (
                  candidate,
                ): candidate is FrontierCandidate & {
                  predicted: VerificationActual
                } => candidate.predicted !== undefined,
              )
              const predictions = scoredCandidates.map((candidate) => ({
                id: candidate.id,
                contentHash: candidate.contentHash,
                predicted: candidate.predicted,
              }))
              const scored = scoreFrontier(
                scoredCandidates,
                predictions,
                evaluatedHashes,
              )
              const ranking = rankNextExperiments(scored, evaluatedHashes)
              let message: string | undefined
              if (run.frontier.length === 0) {
                message =
                  "The frontier is empty. Call propose(...) with several genuinely different candidate files."
              } else if (scoredCandidates.length === 0) {
                message =
                  "No candidate has a model prediction yet. Call score_frontier(); scoring is free."
              } else if (ranking.length === 0) {
                message =
                  "Every proposed candidate byte sequence was already officially evaluated. Call propose(...) with new candidate bytes."
              }
              const result = {
                ranking,
                cost: 0,
                liveCandidate: run.liveCandidate,
                ...(message ? { message } : {}),
              }
              return {
                title: "Schema next experiment",
                output: JSON.stringify(result),
                metadata: result,
              }
            } catch (error) {
              return toolError(error)
            }
          })
        },
      }),
      run_verify: tool({
        description: "Run a characterized, targeted, or full benchmark verification.",
        args: {
          scope: z.enum(["characterize", "targeted", "full"]),
          candidate: z
            .string()
            .optional()
            .describe("Proposed candidate id to install for an official full run."),
          niche: z
            .string()
            .optional()
            .describe("Which declared niche this candidate belongs to. Required for a full run once niches exist."),
        },
        async execute(args, context) {
          return withLock(`session:${context.sessionID}`, () =>
            withLock("worktree:verification", async () => {
              let unrecordedSnapshot: string | undefined
              let installedCandidate:
                | {
                    run: RunState
                    candidate: FrontierCandidate
                    targetPath: string
                    previousLive: PreservedTarget
                  }
                | undefined
              let verificationRecorded = false
              try {
                const run = await readRun(worktree, context.sessionID)
                if (!run?.benchmark) {
                  throw new Error("Register a benchmark before running verification.")
                }
                if (args.candidate && args.scope !== "full") {
                  throw new Error("A proposed candidate may only be selected for a full run.")
                }

                const ledger = await readLedger(worktree, context.sessionID)
                const worldModel = await readWorldModel(
                  worktree,
                  context.sessionID,
                )
                const frontierMode =
                  args.scope === "full" &&
                  worldModel !== null
                let selectedCandidate: FrontierCandidate | undefined
                let selectedBytes: Buffer | undefined
                const evaluatedHashes = officiallyEvaluatedHashes(ledger)
                const proposalGate = modeledFrontierGatePredicate(
                  args.scope,
                  worldModel,
                  args.candidate,
                  run.frontier,
                  evaluatedHashes,
                )

                if (proposalGate) {
                  const result = {
                    error: proposalGate.error,
                    message: proposalGate.reason,
                    allEvaluated: proposalGate.allEvaluated,
                    cost: 0,
                    verifyActionsUsed: run.verifyActionsUsed,
                    budget: run.verifyActionBudget,
                    liveCandidate: run.liveCandidate,
                  }
                  return {
                    title: proposalGate.allEvaluated
                      ? "New candidates required"
                      : "Proposed candidate required",
                    output: proposalGate.reason,
                    metadata: result,
                  }
                }

                if (frontierMode) {
                  selectedCandidate = run.frontier.find(
                    (candidate) => candidate.id === args.candidate,
                  )
                  if (!selectedCandidate) {
                    throw new Error(
                      "Modeled-frontier gate admitted an unproposed candidate.",
                    )
                  }
                  if (!run.frontierTarget) {
                    throw new Error(
                      "Frontier target is missing; propose the candidates again in a new session.",
                    )
                  }
                  selectedBytes = await readCandidateArtifact(
                    worktree,
                    context.sessionID,
                    selectedCandidate.artifact,
                    selectedCandidate.contentHash,
                  )
                  const duplicate = fullCandidateDedupGate(
                    selectedCandidate.contentHash,
                    evaluatedHashes,
                    run.frontier.map((candidate) => candidate.contentHash),
                  )
                  if (duplicate) {
                    const distinctCandidatesOfficiallyEvaluated =
                      distinctOfficialCandidateCount(ledger)
                    const result = {
                      error: "candidate_already_evaluated",
                      message: duplicate.reason,
                      candidateId: selectedCandidate.id,
                      contentHash: selectedCandidate.contentHash,
                      allEvaluated: duplicate.allEvaluated,
                      cost: 0,
                      verifyActionsUsed: run.verifyActionsUsed,
                      budget: run.verifyActionBudget,
                      distinctCandidatesOfficiallyEvaluated,
                      liveCandidate: run.liveCandidate,
                    }
                    return {
                      title: "Candidate already evaluated",
                      output: duplicate.reason,
                      metadata: result,
                    }
                  }
                } else if (args.candidate) {
                  return {
                    title: "Candidate unavailable",
                    output:
                      "Candidate selection requires both a declared world model and a non-empty proposed frontier.",
                    metadata: { error: "candidate_unavailable" },
                  }
                }

                if (
                  args.scope === "full" &&
                  run.verifyActionsUsed >= run.verifyActionBudget
                ) {
                  run.status = "budget_limited"
                  await writeRun(worktree, context.sessionID, run)
                  return {
                    title: "Budget exhausted",
                    output:
                      "Full-run budget spent. Stop running checks; record the strongest confirmed model.",
                    metadata: {
                      error: "budget_exhausted",
                      verifyActionsUsed: run.verifyActionsUsed,
                      verifyActionBudget: run.verifyActionBudget,
                    },
                  }
                }

                // The old archive gate remains exactly as before without a declared
                // world model. In frontier mode, next_experiment remains advisory.
                if (
                  args.scope === "full" &&
                  !frontierMode &&
                  run.niches.length > 0
                ) {
                  if (!args.niche) {
                    return {
                      title: "Niche required",
                      output:
                        `Declared niches: ${run.niches.map((n) => n.id).join(", ")}. ` +
                        "Say which one this candidate belongs to: run_verify({scope:'full', niche:'<id>'}).",
                      metadata: { error: "niche_required" },
                    }
                  }
                  if (!run.niches.some((n) => n.id === args.niche)) {
                    return {
                      title: "Unknown niche",
                      output: `'${args.niche}' is not declared. Declared: ${run.niches.map((n) => n.id).join(", ")}.`,
                      metadata: { error: "niche_unknown" },
                    }
                  }
                  const unexplored = run.niches
                    .filter((n) => !run.archive[n.id])
                    .map((n) => n.id)
                  if (
                    unexplored.length > 0 &&
                    run.archive[args.niche] &&
                    run.lastVerifiedNiche === args.niche
                  ) {
                    return {
                      title: "Diversity gate",
                      output:
                        `Two consecutive expensive runs in '${args.niche}', which already has an elite, ` +
                        `while ${unexplored.join(", ")} ${unexplored.length === 1 ? "has" : "have"} never been tried. ` +
                        "Sample a different niche, or improve the cheap evidence for this one first. " +
                        "Greedy descent on one lineage is what an archive exists to prevent.",
                      metadata: { error: "diversity_gate", unexplored },
                    }
                  }
                }
                if (
                  args.scope === "full" &&
                  !worldModel &&
                  !run.lastPrediction
                ) {
                  return {
                    title: "Prediction required",
                    output: "Call predict before run_verify({scope:'full'}).",
                    metadata: { error: "prediction_required" },
                  }
                }

                if (worldModel && args.scope === "full") {
                  const replay = await replayHistory(
                    worktree,
                    context.sessionID,
                    run.benchmark,
                    worldModel,
                    ledger,
                    context.abort,
                  )
                  const replayGate = worldModelGatePredicate(
                    args.scope,
                    worldModel,
                    replay,
                  )
                  if (replayGate) {
                    return {
                      title: "World-model replay red",
                      output: replayGate.reason,
                      metadata: {
                        error: "world_model_replay_red",
                        ...replayResult(replay),
                        cost: 0,
                        verifyActionsUsed: run.verifyActionsUsed,
                        budget: run.verifyActionBudget,
                      },
                    }
                  }
                }

                let candidateReference: string
                let predicted: VerificationActual | undefined
                let previousLive: PreservedTarget | undefined
                try {
                  candidateReference = await captureCandidateSnapshot(
                    worktree,
                    context.sessionID,
                  )
                  unrecordedSnapshot = candidateReference
                } catch (error) {
                  // The workspace cannot be snapshotted. Release the edit gate so
                  // the agent can repair whatever makes it unsnapshottable; the
                  // gate would otherwise deny the only action that can fix this.
                  if (args.scope === "characterize" && !run.characterizeBlocked) {
                    run.characterizeBlocked = true
                    await writeRun(worktree, context.sessionID, run)
                  }
                  throw new Error(
                    `Candidate snapshot failed before evaluation; no budget was spent: ${exceptionMessage(error)}`,
                  )
                }

                if (worldModel) {
                  try {
                    const candidateSnapshot = await resolveCandidateSnapshot(
                      worktree,
                      context.sessionID,
                      candidateReference,
                    )
                    if (selectedCandidate && selectedBytes && run.frontierTarget) {
                      await overlayArtifactInSnapshot(
                        candidateSnapshot,
                        selectedBytes,
                        run.frontierTarget,
                      )
                    }
                    predicted = await executeWorldModel(
                      worktree,
                      worldModel,
                      registeredVerificationCommands(run.benchmark),
                      candidateSnapshot,
                      context.abort,
                    )
                    if (selectedCandidate && selectedBytes && run.frontierTarget) {
                      previousLive = await installCandidateOverlay(
                        worktree,
                        context.sessionID,
                        selectedBytes,
                        run.frontierTarget,
                      )
                      installedCandidate = {
                        run,
                        candidate: selectedCandidate,
                        targetPath: run.frontierTarget,
                        previousLive,
                      }
                      run.liveCandidate = await inspectLiveCandidate(
                        worktree,
                        run.frontierTarget,
                        selectedCandidate,
                      )
                      // The overlay intentionally remains live. Persist it before
                      // invoking external commands so even an infrastructure error
                      // cannot leave disk state ahead of run.json.
                      await writeRun(worktree, context.sessionID, run)
                    }
                  } catch (error) {
                    throw new Error(
                      `World-model preflight failed before evaluation; no budget was spent: ${exceptionMessage(error)}`,
                    )
                  }
                }

                const command =
                  args.scope === "targeted"
                    ? (run.benchmark.targeted_cmd ?? run.benchmark.verify_cmd)
                    : run.benchmark.verify_cmd
                const output = await runBenchmarkCommand($, worktree, command)
                let scoreOutput = ""
                if (args.scope === "full" && run.benchmark.score_cmd) {
                  // When the scorer IS the verifier — the common case, since a
                  // benchmark whose verify.sh already prints the score has nothing
                  // else to name — running it again buys nothing and costs a second
                  // metered evaluation. The ledger recorded one full run while the
                  // meter charged two, so the arm silently ran at half its budget:
                  // 8 distinct candidates out of K=16, which is exactly the
                  // "harness explores less" result five experiments reported.
                  if (run.benchmark.score_cmd === command) {
                    scoreOutput = `${output.stdout}\n${output.stderr}`
                  } else {
                    const score = await runBenchmarkCommand(
                      $,
                      worktree,
                      run.benchmark.score_cmd,
                    )
                    scoreOutput = `${score.stdout}\n${score.stderr}`
                  }
                }
                const parsed = parseVerifyOutput(
                  output.exitCode,
                  output.stdout,
                  output.stderr,
                  scoreOutput,
                )
                if (selectedCandidate && run.frontierTarget) {
                  run.liveCandidate = await inspectLiveCandidate(
                    worktree,
                    run.frontierTarget,
                    selectedCandidate,
                  )
                }

                let baselineFailing: string[] = []
                for (let index = ledger.length - 1; index >= 0; index -= 1) {
                  const row = ledger[index]
                  if (
                    isVerificationLedgerRow(row) &&
                    row.scope === "characterize"
                  ) {
                    baselineFailing = row.actual.failing
                    break
                  }
                }
                const ts = Date.now()
                const prediction = run.lastPrediction
                const distinctCandidatesOfficiallyEvaluated = selectedCandidate
                  ? new Set([
                      ...evaluatedHashes,
                      selectedCandidate.contentHash,
                    ]).size
                  : undefined
                const frontierFields =
                  selectedCandidate && run.frontierTarget
                    ? {
                        candidateId: selectedCandidate.id,
                        candidatePath: selectedCandidate.path,
                        contentHash: selectedCandidate.contentHash,
                        targetPath: run.frontierTarget,
                        distinctCandidatesOfficiallyEvaluated:
                          distinctCandidatesOfficiallyEvaluated!,
                      }
                    : {}
                const verificationCandidate: VerificationLedgerRow = {
                  ts,
                  step: ledger.length + 1,
                  scope: args.scope,
                  candidate: candidateReference,
                  ...frontierFields,
                  ...((args.scope === "targeted" ||
                    args.scope === "full") &&
                  prediction
                    ? { prediction }
                    : {}),
                  ...(predicted ? { predicted } : {}),
                  actual: parsed,
                  cost: args.scope === "full" ? 1 : 0,
                }
                const scalarSurprise =
                  args.scope === "targeted" || args.scope === "full"
                    ? detectSurprise(
                        verificationCandidate,
                        baselineFailing,
                      )
                    : null
                const surprise = combineSurprises(
                  predicted
                    ? detectObservationSurprise(predicted, parsed)
                    : null,
                  scalarSurprise,
                )

                if (args.scope === "characterize") run.characterized = true
                if (args.scope === "full") run.verifyActionsUsed += 1
                run.stallCount = 0
                const row = await appendLedger(worktree, context.sessionID, {
                  ts,
                  scope: args.scope,
                  candidate: candidateReference,
                  ...frontierFields,
                  ...((args.scope === "targeted" ||
                    args.scope === "full") &&
                  prediction
                    ? { prediction }
                    : {}),
                  ...(predicted ? { predicted } : {}),
                  actual: parsed,
                  cost: args.scope === "full" ? 1 : 0,
                  ...(surprise ? { surprise } : {}),
                })
                verificationRecorded = true
                unrecordedSnapshot = undefined
                if (args.scope === "full" && !parsed.pass) {
                  run.pendingReview = {
                    trigger: surprise ? "surprise" : "verify_fail",
                    key: `${surprise ? "surprise" : "verify_fail"}:${row.step}`,
                    ts,
                    detail:
                      surprise?.detail ||
                      parsed.failing.slice(0, 3).join("; ").slice(0, 200) ||
                      "Full verification failed.",
                  }
                }
                if (args.scope === "full" && args.niche) {
                  run.lastVerifiedNiche = args.niche
                }
                if (args.scope === "targeted" || args.scope === "full") {
                  run.lastPrediction = null
                }
                if (args.scope === "full") {
                  if (parsed.pass) run.status = "solved"
                  else if (run.status === "solved") run.status = "active"
                }
                await writeRun(worktree, context.sessionID, run)
                return verificationResult(parsed, run, predicted, surprise, {
                  ...(selectedCandidate
                    ? {
                        candidateId: selectedCandidate.id,
                        contentHash: selectedCandidate.contentHash,
                        targetPath: run.frontierTarget,
                        distinctCandidatesOfficiallyEvaluated,
                        liveCandidate: run.liveCandidate,
                        previousLive: previousLive
                          ? {
                              ...previousLive,
                              preservedAt: path.posix.join(
                                ".schema",
                                context.sessionID,
                                previousLive.artifact,
                              ),
                            }
                          : undefined,
                      }
                    : {}),
                })
              } catch (error) {
                if (installedCandidate && !verificationRecorded) {
                  const {
                    run,
                    candidate,
                    targetPath,
                    previousLive,
                  } = installedCandidate
                  run.liveCandidate = await inspectLiveCandidate(
                    worktree,
                    targetPath,
                    candidate,
                  ).catch(() => run.liveCandidate)
                  await writeRun(
                    worktree,
                    context.sessionID,
                    run,
                  ).catch(() => {})
                  const message = exceptionMessage(error)
                  const preservedAt = path.posix.join(
                    ".schema",
                    context.sessionID,
                    previousLive.artifact,
                  )
                  const result = {
                    error: message,
                    cost: 0,
                    verifyActionsUsed: run.verifyActionsUsed,
                    budget: run.verifyActionBudget,
                    candidateId: candidate.id,
                    contentHash: candidate.contentHash,
                    targetPath,
                    liveCandidate: run.liveCandidate,
                    previousLive: {
                      ...previousLive,
                      preservedAt,
                    },
                  }
                  return {
                    title: "Schema verification error",
                    output:
                      `${message} Candidate '${candidate.id}' remains live at ${targetPath}; ` +
                      `the prior bytes are preserved at ${preservedAt}.`,
                    metadata: result,
                  }
                }
                return toolError(error)
              } finally {
                if (unrecordedSnapshot) {
                  await deleteCandidateSnapshot(
                    worktree,
                    context.sessionID,
                    unrecordedSnapshot,
                  ).catch(() => {})
                }
              }
            }),
          )
        },
      }),
      replay_verify: tool({
        description:
          "Run the declared world model against every recorded candidate and compare complete predicted observations. Replay is free.",
        args: {},
        async execute(_args, context) {
          return withLock(`session:${context.sessionID}`, async () => {
            try {
              const run = await readRun(worktree, context.sessionID)
              if (!run?.benchmark) {
                throw new Error("Register a benchmark before replay.")
              }
              const worldModel = await readWorldModel(
                worktree,
                context.sessionID,
              )
              if (!worldModel) {
                throw new Error(
                  "Declare a world model with set_world_model before replay.",
                )
              }
              const ledger = await readLedger(worktree, context.sessionID)
              const report = await replayHistory(
                worktree,
                context.sessionID,
                run.benchmark,
                worldModel,
                ledger,
                context.abort,
              )
              const result = {
                ...replayResult(report),
                cost: 0,
                verifyActionsUsed: run.verifyActionsUsed,
                budget: run.verifyActionBudget,
                remaining: Math.max(
                  0,
                  run.verifyActionBudget - run.verifyActionsUsed,
                ),
              }
              return {
                title: "Schema replay verification",
                output: JSON.stringify(result),
                metadata: result,
              }
            } catch (error) {
              return toolError(error)
            }
          })
        },
      }),
      predict: tool({
        description:
          "Record the legacy scalar prediction required before full verification when no world model is declared.",
        args: {
          hypothesis: z.string().min(1),
          predicted_pass_set: z.array(z.string().min(1)),
          assertions: z
            .array(
              z.object({
                metric: z.enum(["score", "pass", "failing_count"]),
                op: z.enum([">=", "<=", ">", "<", "==", "!="]),
                value: z.union([z.number(), z.boolean()]),
                tol: z.number().optional(),
              }),
            )
            .optional()
            .describe("Machine-checkable claims about the next verification. These are what make the prediction refutable."),
          predicted_side_effects: z.string().optional(),
        },
        async execute(args, context) {
          return withLock(`session:${context.sessionID}`, async () => {
            try {
              const run = await readRun(worktree, context.sessionID)
              if (!run) throw new Error("Register a benchmark before recording a prediction.")
              if (run.lastPrediction) {
                return {
                  title: "Prediction still open",
                  output:
                    `A prediction is already open and unresolved: "${run.lastPrediction.hypothesis.slice(0, 120)}". ` +
                    "Resolve it with run_verify before making another. A conjecture nobody tested is not evidence.",
                  metadata: { error: "prediction_unresolved" },
                }
              }
              const prediction: Prediction = {
                hypothesis: args.hypothesis,
                predicted_pass_set: args.predicted_pass_set,
                ...(args.assertions?.length ? { assertions: args.assertions } : {}),
                ...(args.predicted_side_effects !== undefined
                  ? { predicted_side_effects: args.predicted_side_effects }
                  : {}),
                ts: Date.now(),
              }
              run.lastPrediction = prediction
              await appendLedger(worktree, context.sessionID, {
                ts: Date.now(),
                scope: "predict",
                prediction,
              })
              await writeRun(worktree, context.sessionID, run)
              return "Prediction recorded. Run the cheapest discriminating check first."
            } catch (error) {
              return toolError(error)
            }
          })
        },
      }),
      declare_niches: tool({
        description:
          "Declare the behaviour space: the distinct approach families worth exploring for this task.",
        args: {
          niches: z
            .array(z.object({ id: z.string().min(1), description: z.string().min(1) }))
            .min(2)
            .max(8),
        },
        async execute(args, context) {
          return withLock(`session:${context.sessionID}`, async () => {
            try {
              const run = await readRun(worktree, context.sessionID)
              if (!run) throw new Error("Register a benchmark before declaring niches.")
              const seen = new Set<string>()
              for (const n of args.niches) {
                if (seen.has(n.id)) throw new Error(`Duplicate niche id '${n.id}'.`)
                seen.add(n.id)
              }
              run.niches = args.niches
              await writeRun(worktree, context.sessionID, run)
              return (
                `Behaviour space: ${args.niches.map((n) => n.id).join(", ")}. ` +
                "Keep at least one live candidate per niche; sample across them rather than descending on the best."
              )
            } catch (error) {
              return toolError(error)
            }
          })
        },
      }),

      record_candidate: tool({
        description: "Insert a scored candidate into the archive. Keeps the best per niche.",
        args: {
          niche: z.string().min(1),
          score: z.number(),
          summary: z.string().min(1),
          program_sha: z.string().optional(),
        },
        async execute(args, context) {
          return withLock(`session:${context.sessionID}`, async () => {
            try {
              const run = await readRun(worktree, context.sessionID)
              if (!run) throw new Error("Register a benchmark before recording candidates.")
              if (run.niches.length && !run.niches.some((n) => n.id === args.niche)) {
                throw new Error(
                  `'${args.niche}' is not a declared niche (${run.niches.map((n) => n.id).join(", ")}).`,
                )
              }
              const incumbent = run.archive[args.niche]
              // Strictly-better insertion, per niche. A candidate that loses globally
              // can still be the elite of its own region — that is the whole point,
              // and it is where stepping stones come from.
              const promoted = !incumbent || args.score > incumbent.score
              if (promoted) {
                run.archive[args.niche] = {
                  niche: args.niche,
                  score: args.score,
                  summary: args.summary,
                  ...(args.program_sha ? { programSha: args.program_sha } : {}),
                  ts: Date.now(),
                }
                await writeRun(worktree, context.sessionID, run)
              }
              const covered = Object.keys(run.archive).length
              const total = run.niches.length || covered
              return (
                (promoted
                  ? `Elite of '${args.niche}' is now ${args.score}.`
                  : `Kept the incumbent elite of '${args.niche}' (${incumbent!.score} >= ${args.score}).`) +
                ` Archive covers ${covered}/${total} niches.`
              )
            } catch (error) {
              return toolError(error)
            }
          })
        },
      }),

      list_archive: tool({
        description: "Show the current elite per niche and which niches are still empty.",
        args: {},
        async execute(_args, context) {
          try {
            const run = await readRun(worktree, context.sessionID)
            if (!run) throw new Error("Register a benchmark first.")
            if (!run.niches.length) return "No behaviour space declared. Call declare_niches first."
            const lines = run.niches.map((n) => {
              const elite = run.archive[n.id]
              return elite
                ? `  ${n.id}: ${elite.score} — ${elite.summary.slice(0, 90)}`
                : `  ${n.id}: EMPTY — ${n.description.slice(0, 90)}`
            })
            const empty = run.niches.filter((n) => !run.archive[n.id]).map((n) => n.id)
            return (
              `Archive (${Object.keys(run.archive).length}/${run.niches.length} covered):\n` +
              lines.join("\n") +
              (empty.length ? `\nUntried: ${empty.join(", ")}. An untried niche is cheaper information than a fifth pass at the champion.` : "")
            )
          } catch (error) {
            return toolError(error)
          }
        },
      }),

      record_ad_hoc: tool({
        description: "Record a special case in the worktree ad-hoc inventory.",
        args: {
          special_case: z.string().min(1),
          anomaly: z.string().min(1),
          lines_added: z.number().int().optional(),
          checks_greened: z.number().int().optional(),
        },
        async execute(args) {
          return withLock("inventory", async () => {
            try {
              const inventory = path.join(path.resolve(worktree), "ad_hoc_inventory.md")
              let header = ""
              try {
                const info = await lstat(inventory)
                if (info.isSymbolicLink() || !info.isFile()) {
                  throw new Error(`Refusing unsafe ad-hoc inventory: ${inventory}`)
                }
              } catch (error) {
                if (!isMissing(error)) throw error
                header =
                  "# Ad-Hoc Inventory\n\n| Timestamp | Special case | Anomaly | Lines added | Checks greened |\n| --- | --- | --- | ---: | ---: |\n"
              }
              const row = `| ${new Date().toISOString()} | ${markdownCell(args.special_case)} | ${markdownCell(args.anomaly)} | ${args.lines_added ?? ""} | ${args.checks_greened ?? ""} |\n`
              const file = await open(
                inventory,
                constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
                0o600,
              )
              try {
                await file.writeFile(header + row, "utf8")
              } finally {
                await file.close()
              }
              return "Ad-hoc case recorded."
            } catch (error) {
              return toolError(error)
            }
          })
        },
      }),
    },
    "tool.execute.before": async (
      input,
      output: { args: unknown; status?: "deny"; reason?: string },
    ) => {
      try {
        const run = await readRun(worktree, input.sessionID)
        if (!run) return
        const decision = editGatePredicate(run, input.tool)
        if (decision) {
          output.status = decision.status
          output.reason = decision.reason
          return
        }
        const executorFanout = executorFanoutPredicate(input.tool, output.args)
        if (executorFanout) output.args = executorFanout.rewrite
        if (EXCLUDED_ACTION_TOOLS.has(input.tool)) return

        const risky = classifyRisky(input.tool, output.args)
        if (!risky || !run.characterized) return
        riskyByCall.set(input.callID, risky)
        await withLock(`session:${input.sessionID}`, async () => {
          const latest = await readRun(worktree, input.sessionID)
          if (!latest?.characterized) return
          const key = `risky:${input.callID}`
          if (latest.pendingReview?.key === key) return
          latest.pendingReview = {
            trigger: "risky_intent",
            key,
            ts: Date.now(),
            detail: risky,
          }
          await writeRun(worktree, input.sessionID, latest)
        })
      } catch (error) {
        console.error("schema tool gate failed", error)
      }
    },
    "tool.execute.after": async (input, output) => {
      try {
        const run = await readRun(worktree, input.sessionID)
        if (!run || EXCLUDED_ACTION_TOOLS.has(input.tool)) return
        await withLock(`session:${input.sessionID}`, async () => {
          const latest = await readRun(worktree, input.sessionID)
          if (!latest) return
          const risky = riskyByCall.get(input.callID)
          await appendAction(worktree, input.sessionID, {
            ts: Date.now(),
            ref: latest.lastLedgerLen,
            tool: input.tool,
            digest: digestArgs(input.tool, input.args),
            outcome: output.metadata?.error ? "error" : "ok",
            ...(risky ? { risky } : {}),
          })
        })
      } catch {
        // Action logging is advisory and must never affect tool execution.
      } finally {
        riskyByCall.delete(input.callID)
      }
    },
    event: async ({ event }) => {
      try {
        // goal.updated is forwarded raw over the bus (not in the typed SDK
        // union), so read it loosely — same as the fork's run command does.
        const raw = event as {
          type: string
          properties?: {
            sessionID?: string
            goal?: { status?: string }
            error?: { name?: unknown; data?: { message?: unknown } }
          }
        }
        if (raw.type === "goal.updated") {
          const sid = raw.properties?.sessionID
          if (sid) activeGoals.set(sid, raw.properties?.goal?.status === "active")
          return
        }
        if (raw.type === "session.error") {
          const sid = raw.properties?.sessionID
          if (!sid) return
          if (!(await readRun(worktree, sid))) return void lastErrors.delete(sid)
          const error = raw.properties?.error
          const name = typeof error?.name === "string" ? error.name : undefined
          // The fork auto-compacts and continues after context overflow; it owns recovery.
          if (name === "ContextOverflowError") return
          lastErrors.set(sid, {
            name,
            message: typeof error?.data?.message === "string" ? error.data.message : undefined,
          })
          return
        }
        if (event.type !== "session.idle") return
        const sessionID = event.properties.sessionID
        if (runningControllers.has(sessionID)) return
        const pending = lastErrors.get(sessionID)
        lastErrors.delete(sessionID)
        runningControllers.add(sessionID)
        try {
          await controlIdle(sessionID, pending)
        } finally {
          runningControllers.delete(sessionID)
        }
      } catch (error) {
        console.error("schema event hook failed", error)
      }
    },
    "experimental.chat.system.transform": async (input, output) => {
      try {
        if (!input.sessionID) return
        const run = await readRun(worktree, input.sessionID)
        if (!run) return
        output.system.push(SCHEMA_REMINDER)
      } catch (error) {
        console.error("schema system hook failed", error)
      }
    },
  }

  return hooks
}

export default { id: "schema", server } satisfies PluginModule
