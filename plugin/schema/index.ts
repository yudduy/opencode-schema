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
  createRunState,
  isVerificationLedgerRow,
  readLedger,
  readRun,
  writeRun,
  type ParsedLedgerRow,
  type Assertion,
  type Prediction,
  type ReviewTrigger,
  type RunState,
  type SurpriseAnnotation,
  type VerificationLedgerRow,
} from "./state.ts"
import { parseVerifyOutput, runBenchmarkCommand } from "./verify.ts"

export const CHARACTERIZE_REASON =
  "Characterize first: run run_verify({scope:'characterize'}) to capture a green baseline before editing (theory before edits)."

export const SCHEMA_REMINDER =
  "<schema_reminder>Predict before you verify. Run the cheapest discriminating check first. Stop and repair the model on any surprise. Never spend a full run on a red prediction.</schema_reminder>"

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
    "Continue the schema loop: refine the world model, record a prediction, and run the cheapest discriminating check.",
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
    title: "Schema tool error",
    output: message,
    metadata: { error: message },
  }
}

function verificationResult(
  parsed: ReturnType<typeof parseVerifyOutput>,
  run: RunState,
): ToolResult {
  const result = {
    ...parsed,
    verifyActionsUsed: run.verifyActionsUsed,
    budget: run.verifyActionBudget,
    ...(run.verifyActionsUsed >= run.verifyActionBudget ? { status: "budget_limited" as const } : {}),
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
              run.status = "active"
              run.benchmark = {
                verify_cmd: args.verify_cmd,
                ...(args.targeted_cmd ? { targeted_cmd: args.targeted_cmd } : {}),
                ...(args.score_cmd ? { score_cmd: args.score_cmd } : {}),
              }
              if (args.verify_action_budget !== undefined) {
                run.verifyActionBudget = args.verify_action_budget
              }
              await writeRun(worktree, context.sessionID, run)
              return "Benchmark registered; characterize before editing."
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
        },
        async execute(args, context) {
          return withLock(`session:${context.sessionID}`, async () => {
            try {
              const run = await readRun(worktree, context.sessionID)
              if (!run?.benchmark) throw new Error("Register a benchmark before running verification.")
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
              if (args.scope === "full" && !run.lastPrediction) {
                return {
                  title: "Prediction required",
                  output: "Call predict before run_verify({scope:'full'}).",
                  metadata: { error: "prediction_required" },
                }
              }

              const command =
                args.scope === "targeted"
                  ? (run.benchmark.targeted_cmd ?? run.benchmark.verify_cmd)
                  : run.benchmark.verify_cmd
              const output = await runBenchmarkCommand($, worktree, command)
              let scoreOutput = ""
              if (args.scope === "full" && run.benchmark.score_cmd) {
                const score = await runBenchmarkCommand($, worktree, run.benchmark.score_cmd)
                scoreOutput = `${score.stdout}\n${score.stderr}`
              }
              const parsed = parseVerifyOutput(output.exitCode, output.stdout, output.stderr, scoreOutput)
              const ledger = await readLedger(worktree, context.sessionID)
              let baselineFailing: string[] = []
              for (let index = ledger.length - 1; index >= 0; index -= 1) {
                const row = ledger[index]
                if (isVerificationLedgerRow(row) && row.scope === "characterize") {
                  baselineFailing = row.actual.failing
                  break
                }
              }
              const ts = Date.now()
              const prediction = run.lastPrediction
              const candidate: VerificationLedgerRow = {
                ts,
                step: ledger.length + 1,
                scope: args.scope,
                ...((args.scope === "targeted" || args.scope === "full") && prediction
                  ? { prediction }
                  : {}),
                actual: parsed,
                cost: args.scope === "full" ? 1 : 0,
              }
              const surprise =
                args.scope === "targeted" || args.scope === "full"
                  ? detectSurprise(candidate, baselineFailing)
                  : null

              if (args.scope === "characterize") run.characterized = true
              if (args.scope === "full") run.verifyActionsUsed += 1
              run.stallCount = 0
              const row = await appendLedger(worktree, context.sessionID, {
                ts,
                scope: args.scope,
                ...((args.scope === "targeted" || args.scope === "full") && prediction
                  ? { prediction }
                  : {}),
                actual: parsed,
                cost: args.scope === "full" ? 1 : 0,
                ...(surprise ? { surprise } : {}),
              })
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
              if (args.scope === "targeted" || args.scope === "full") run.lastPrediction = null
              if (args.scope === "full") {
                // The outcome is decided here, not at the next idle — one-shot
                // `opencode run` may exit before the controller ever fires.
                if (parsed.pass) run.status = "solved"
                else if (run.status === "solved") run.status = "active"
              }
              await writeRun(worktree, context.sessionID, run)
              return verificationResult(parsed, run)
            } catch (error) {
              return toolError(error)
            }
          })
        },
      }),
      predict: tool({
        description: "Record a falsifiable prediction before expensive verification.",
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
