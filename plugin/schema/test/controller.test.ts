import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { $ } from "bun"
import type { PluginInput } from "@opencode-ai/plugin"
import {
  MAX_IDLE_CYCLES,
  MAX_REVIEWS_PER_SESSION,
  POLICY_BLOCK_STOP_AT,
  SCHEMA_REMINDER,
  server,
} from "../index.ts"
import { readActions, readReviews } from "../actions.ts"
import { appendLedger, createRunState, readRun, writeRun } from "../state.ts"

const worktrees: string[] = []
const CYBER_POLICY_MESSAGE =
  '{"type":"invalid_request","code":"cyber_policy","message":"This content was flagged for possible cybersecurity risk..."}'

afterEach(async () => {
  await Promise.all(worktrees.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function worktree(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "schema-controller-"))
  worktrees.push(directory)
  return directory
}

function clientRecorder(
  options: {
    promptErrors?: number
    session?: Record<string, unknown>
    getGate?: Promise<void>
    onGet?: () => void
    reviewText?: string
    reviewPromptThrows?: number
    reviewInfoError?: unknown
  } = {},
) {
  const getCalls: unknown[] = []
  const promptCalls: unknown[] = []
  const createCalls: unknown[] = []
  const reviewPromptCalls: unknown[] = []
  let promptErrors = options.promptErrors ?? 0
  let reviewPromptThrows = options.reviewPromptThrows ?? 0
  const client = {
    session: {
      async create(input: unknown) {
        createCalls.push(input)
        return {
          data: { id: `reviewer-session-${createCalls.length}` },
          error: undefined,
        }
      },
      async get(input: unknown) {
        getCalls.push(input)
        options.onGet?.()
        if (options.getGate) await options.getGate
        return { data: options.session ?? {}, error: undefined }
      },
      async promptAsync(input: unknown) {
        promptCalls.push(input)
        if (promptErrors > 0) {
          promptErrors -= 1
          return { data: undefined, error: { message: "temporary failure" } }
        }
        return { data: undefined, error: undefined }
      },
      async prompt(input: unknown) {
        reviewPromptCalls.push(input)
        if (reviewPromptThrows > 0) {
          reviewPromptThrows -= 1
          throw new Error("reviewer unavailable")
        }
        return {
          data: {
            info: {
              modelID: "test-reviewer-model",
              ...(options.reviewInfoError ? { error: options.reviewInfoError } : {}),
            },
            parts: [{ type: "text", text: options.reviewText ?? "REVIEW_OK" }],
          },
          error: undefined,
        }
      },
    },
  } as unknown as PluginInput["client"]
  return { client, getCalls, promptCalls, createCalls, reviewPromptCalls }
}

function promptText(call: unknown): string {
  const prompt = call as { body?: { parts?: Array<{ text?: string }> } }
  return prompt.body?.parts?.[0]?.text ?? ""
}

function sessionErrorEvent(sessionID: string | undefined, name: string, message: string): never {
  return {
    event: {
      type: "session.error",
      properties: {
        ...(sessionID ? { sessionID } : {}),
        error: { name, data: { message } },
      },
    },
  } as never
}

async function controller(directory: string, client: PluginInput["client"]) {
  return server({ $, worktree: directory, directory, client } as unknown as PluginInput)
}

describe("idle controller", () => {
  test("ignores idle events from sessions without run.json", async () => {
    const directory = await worktree()
    const recorder = clientRecorder()
    const plugin = await controller(directory, recorder.client)

    await plugin.event!({
      event: { type: "session.idle", properties: { sessionID: "ordinary-session" } },
    })

    expect(recorder.getCalls).toHaveLength(0)
    expect(recorder.promptCalls).toHaveLength(0)
  })

  test("marks a green full run solved without resuming", async () => {
    const directory = await worktree()
    const sid = "session-solved"
    await writeRun(directory, sid, createRunState({ verify_cmd: "true" }))
    await appendLedger(directory, sid, {
      ts: 1,
      scope: "full",
      actual: { pass: true, failing: [] },
      cost: 1,
    })
    const recorder = clientRecorder()
    const plugin = await controller(directory, recorder.client)

    await plugin.event!({ event: { type: "session.idle", properties: { sessionID: sid } } })

    expect((await readRun(directory, sid))?.status).toBe("solved")
    expect((await readRun(directory, sid))?.inflight).toBeFalse()
    expect(recorder.promptCalls).toHaveLength(0)
  })

  test("sends one budget note, then stops", async () => {
    const directory = await worktree()
    const sid = "session-budget"
    const run = createRunState({ verify_cmd: "true" })
    run.verifyActionsUsed = run.verifyActionBudget
    run.errorStreak = 2
    run.policyBlockStreak = 2
    await writeRun(directory, sid, run)
    const recorder = clientRecorder()
    const plugin = await controller(directory, recorder.client)

    await plugin.event!({ event: { type: "session.idle", properties: { sessionID: sid } } })
    await plugin.event!({ event: { type: "session.idle", properties: { sessionID: sid } } })

    expect((await readRun(directory, sid))?.status).toBe("budget_limited")
    expect((await readRun(directory, sid))?.inflight).toBeFalse()
    expect((await readRun(directory, sid))?.errorStreak).toBe(0)
    expect((await readRun(directory, sid))?.policyBlockStreak).toBe(0)
    expect(recorder.getCalls).toEqual([{ path: { id: sid } }])
    expect(recorder.promptCalls).toHaveLength(1)
    expect(recorder.promptCalls[0]).toMatchObject({
      path: { id: sid },
      body: { agent: "schema", parts: [{ type: "text" }] },
    })
  })

  test("keeps a budget-limited run active until its note is delivered", async () => {
    const directory = await worktree()
    const sid = "session-budget-retry"
    const run = createRunState({ verify_cmd: "true" })
    run.verifyActionsUsed = run.verifyActionBudget
    await writeRun(directory, sid, run)
    const recorder = clientRecorder({ promptErrors: 1 })
    const plugin = await controller(directory, recorder.client)
    const consoleError = spyOn(console, "error").mockImplementation(() => {})

    try {
      await plugin.event!({ event: { type: "session.idle", properties: { sessionID: sid } } })
      expect((await readRun(directory, sid))?.status).toBe("active")
      expect((await readRun(directory, sid))?.inflight).toBeFalse()

      await plugin.event!({ event: { type: "session.idle", properties: { sessionID: sid } } })
      expect((await readRun(directory, sid))?.status).toBe("budget_limited")
      expect((await readRun(directory, sid))?.inflight).toBeFalse()
      expect(recorder.promptCalls).toHaveLength(2)
      expect(consoleError).toHaveBeenCalledTimes(1)
    } finally {
      consoleError.mockRestore()
    }
  })

  test("retries an undelivered surprise prompt without aging out its evidence", async () => {
    const directory = await worktree()
    const sid = "session-surprise-retry"
    await writeRun(directory, sid, createRunState({ verify_cmd: "true" }))
    await appendLedger(directory, sid, {
      ts: 1,
      scope: "targeted",
      prediction: {
        hypothesis: "the focused check passes",
        predicted_pass_set: ["test/unit/widget::focused"],
        ts: 1,
      },
      actual: { pass: false, failing: ["FAIL test/unit/widget::focused"] },
      cost: 0,
    })
    const recorder = clientRecorder({ promptErrors: 1 })
    const plugin = await controller(directory, recorder.client)
    const consoleError = spyOn(console, "error").mockImplementation(() => {})

    try {
      await plugin.event!({ event: { type: "session.idle", properties: { sessionID: sid } } })
      expect((await readRun(directory, sid))?.lastLedgerLen).toBe(0)
      expect((await readRun(directory, sid))?.idleCycles).toBe(1)

      await plugin.event!({ event: { type: "session.idle", properties: { sessionID: sid } } })
      expect((await readRun(directory, sid))?.lastLedgerLen).toBe(1)
      expect((await readRun(directory, sid))?.idleCycles).toBe(2)
      expect(recorder.promptCalls).toHaveLength(2)
      expect(JSON.stringify(recorder.promptCalls[0])).toContain("Reality contradicted")
      expect(JSON.stringify(recorder.promptCalls[1])).toContain("Reality contradicted")
      expect(consoleError).toHaveBeenCalledTimes(1)
    } finally {
      consoleError.mockRestore()
    }
  })

  test("resumes an errored turn once, then resets the streak on a clean idle", async () => {
    const directory = await worktree()
    const sid = "session-error"
    const run = createRunState({ verify_cmd: "true" })
    run.characterized = true
    run.policyBlockStreak = 2
    await writeRun(directory, sid, run)
    const recorder = clientRecorder()
    const plugin = await controller(directory, recorder.client)
    const idle = { event: { type: "session.idle" as const, properties: { sessionID: sid } } }

    await plugin.event!(sessionErrorEvent(sid, "APIError", "provider unavailable"))
    await plugin.event!(idle)

    expect(recorder.promptCalls).toHaveLength(1)
    expect(promptText(recorder.promptCalls[0])).toContain("Previous turn ended with an error")
    expect(promptText(recorder.promptCalls[0])).toContain("APIError: provider unavailable")
    expect((await readRun(directory, sid))?.errorStreak).toBe(1)
    expect((await readRun(directory, sid))?.policyBlockStreak).toBe(0)

    await plugin.event!(idle)

    expect(recorder.promptCalls).toHaveLength(2)
    expect(promptText(recorder.promptCalls[1])).toContain("Continue the schema loop")
    expect((await readRun(directory, sid))?.errorStreak).toBe(0)
    expect((await readRun(directory, sid))?.policyBlockStreak).toBe(0)
  })

  test("reframes a first policy refusal, then terminally blocks at the threshold", async () => {
    const directory = await worktree()
    const sid = "session-policy-blocked"
    const run = createRunState({ verify_cmd: "true" })
    run.characterized = true
    run.errorStreak = 4
    await writeRun(directory, sid, run)
    const recorder = clientRecorder()
    const plugin = await controller(directory, recorder.client)
    const idle = { event: { type: "session.idle" as const, properties: { sessionID: sid } } }

    await plugin.event!({
      event: { type: "goal.updated", properties: { sessionID: sid, goal: { status: "active" } } },
    } as never)
    await plugin.event!(sessionErrorEvent(sid, "APIError", CYBER_POLICY_MESSAGE))
    await plugin.event!(idle)

    const reframed = await readRun(directory, sid)
    expect(recorder.promptCalls).toHaveLength(1)
    expect(promptText(recorder.promptCalls[0])).toContain("content filter refused")
    expect(promptText(recorder.promptCalls[0])).toContain("reframe at a higher level")
    expect(reframed?.status).toBe("active")
    expect(reframed?.policyBlockStreak).toBe(1)
    expect(reframed?.errorStreak).toBe(0)

    // The pure verdict test covers the delayed second retry; seed its result here
    // so this integration test reaches the terminal third refusal without waiting 5s.
    if (!reframed) throw new Error("Expected active policy state")
    reframed.policyBlockStreak = POLICY_BLOCK_STOP_AT - 1
    await writeRun(directory, sid, reframed)
    await plugin.event!(sessionErrorEvent(sid, "APIError", CYBER_POLICY_MESSAGE))
    await plugin.event!(idle)

    const blocked = await readRun(directory, sid)
    expect(blocked?.status).toBe("blocked")
    expect(blocked?.policyBlockStreak).toBe(POLICY_BLOCK_STOP_AT - 1)
    expect(blocked?.inflight).toBeFalse()
    expect(recorder.promptCalls).toHaveLength(1)

    await plugin.event!(idle)
    expect(recorder.promptCalls).toHaveLength(1)
  })

  test("a clean idle resets the policy-block streak", async () => {
    const directory = await worktree()
    const sid = "session-policy-clean"
    const run = createRunState({ verify_cmd: "true" })
    run.characterized = true
    await writeRun(directory, sid, run)
    const recorder = clientRecorder()
    const plugin = await controller(directory, recorder.client)
    const idle = { event: { type: "session.idle" as const, properties: { sessionID: sid } } }

    await plugin.event!(sessionErrorEvent(sid, "APIError", CYBER_POLICY_MESSAGE))
    await plugin.event!(idle)
    expect((await readRun(directory, sid))?.policyBlockStreak).toBe(1)

    await plugin.event!(idle)
    expect(recorder.promptCalls).toHaveLength(2)
    expect(promptText(recorder.promptCalls[1])).toContain("Continue the schema loop")
    expect((await readRun(directory, sid))?.policyBlockStreak).toBe(0)
  })

  test("ignores context overflow errors recovered by the fork", async () => {
    const directory = await worktree()
    const sid = "session-context-overflow"
    await writeRun(directory, sid, createRunState({ verify_cmd: "true" }))
    const recorder = clientRecorder()
    const plugin = await controller(directory, recorder.client)

    await plugin.event!(sessionErrorEvent(sid, "ContextOverflowError", CYBER_POLICY_MESSAGE))
    await plugin.event!({ event: { type: "session.idle", properties: { sessionID: sid } } })

    expect(recorder.promptCalls).toHaveLength(1)
    expect(promptText(recorder.promptCalls[0])).toContain("Continue the schema loop")
    expect(promptText(recorder.promptCalls[0])).not.toContain("Previous turn ended with an error")
    expect((await readRun(directory, sid))?.errorStreak).toBe(0)
    expect((await readRun(directory, sid))?.policyBlockStreak).toBe(0)
  })

  test("respects a user abort as a deliberate active pause", async () => {
    const directory = await worktree()
    const sid = "session-aborted"
    const run = createRunState({ verify_cmd: "true" })
    run.characterized = true
    run.errorStreak = 4
    await writeRun(directory, sid, run)
    const recorder = clientRecorder()
    const plugin = await controller(directory, recorder.client)

    await plugin.event!(sessionErrorEvent(sid, "MessageAbortedError", "cancelled by user"))
    await plugin.event!({ event: { type: "session.idle", properties: { sessionID: sid } } })

    const paused = await readRun(directory, sid)
    expect(recorder.promptCalls).toHaveLength(0)
    expect(paused?.status).toBe("active")
    expect(paused?.inflight).toBeFalse()
    expect(paused?.errorStreak).toBe(0)
  })

  test("ignores session.error events without a session ID", async () => {
    const directory = await worktree()
    const sid = "session-missing-error-id"
    await writeRun(directory, sid, createRunState({ verify_cmd: "true" }))
    const recorder = clientRecorder()
    const plugin = await controller(directory, recorder.client)

    await plugin.event!(sessionErrorEvent(undefined, "APIError", "unscoped"))
    await plugin.event!({ event: { type: "session.idle", properties: { sessionID: sid } } })

    expect(recorder.promptCalls).toHaveLength(1)
    expect(promptText(recorder.promptCalls[0])).toContain("Continue the schema loop")
    expect(promptText(recorder.promptCalls[0])).not.toContain("Previous turn ended with an error")
    expect((await readRun(directory, sid))?.errorStreak).toBe(0)
  })

  test("uses only the latest pending error for a session", async () => {
    const directory = await worktree()
    const sid = "session-latest-error"
    await writeRun(directory, sid, createRunState({ verify_cmd: "true" }))
    const recorder = clientRecorder()
    const plugin = await controller(directory, recorder.client)

    await plugin.event!(sessionErrorEvent(sid, "UnknownError", "first error"))
    await plugin.event!(sessionErrorEvent(sid, "APIError", "latest error"))
    await plugin.event!({ event: { type: "session.idle", properties: { sessionID: sid } } })

    expect(recorder.promptCalls).toHaveLength(1)
    expect(promptText(recorder.promptCalls[0])).toContain("APIError: latest error")
    expect(promptText(recorder.promptCalls[0])).not.toContain("first error")
  })

  test("coalesces concurrent idle events for one session", async () => {
    const directory = await worktree()
    const sid = "session-concurrent-idle"
    await writeRun(directory, sid, createRunState({ verify_cmd: "true" }))
    const recorder = clientRecorder()
    const plugin = await controller(directory, recorder.client)
    const idle = { event: { type: "session.idle" as const, properties: { sessionID: sid } } }

    await Promise.all(Array.from({ length: 8 }, () => plugin.event!(idle)))

    expect(recorder.getCalls).toHaveLength(1)
    expect(recorder.promptCalls).toHaveLength(1)
    expect((await readRun(directory, sid))?.stallCount).toBe(1)
    expect((await readRun(directory, sid))?.idleCycles).toBe(1)
    expect((await readRun(directory, sid))?.inflight).toBeFalse()
  })

  test("preserves a pending error when an idle arrives during a running controller", async () => {
    const directory = await worktree()
    const sid = "session-pending-during-controller"
    await writeRun(directory, sid, createRunState({ verify_cmd: "true" }))
    let releaseGet!: () => void
    const getGate = new Promise<void>((resolve) => {
      releaseGet = resolve
    })
    let markGetStarted!: () => void
    const getStarted = new Promise<void>((resolve) => {
      markGetStarted = resolve
    })
    const recorder = clientRecorder({ getGate, onGet: markGetStarted })
    const plugin = await controller(directory, recorder.client)
    const idle = { event: { type: "session.idle" as const, properties: { sessionID: sid } } }

    const firstIdle = plugin.event!(idle)
    await getStarted
    await plugin.event!(sessionErrorEvent(sid, "MessageAbortedError", "cancelled"))
    await plugin.event!(idle)
    releaseGet()
    await firstIdle

    expect(recorder.promptCalls).toHaveLength(1)
    await plugin.event!(idle)

    expect(recorder.promptCalls).toHaveLength(1)
    expect((await readRun(directory, sid))?.idleCycles).toBe(2)
    expect((await readRun(directory, sid))?.errorStreak).toBe(0)
  })

  test("persists unchanged-ledger idle counts and uses the stall prompt on three", async () => {
    const directory = await worktree()
    const sid = "session-stall"
    await writeRun(directory, sid, createRunState({ verify_cmd: "true" }))
    const recorder = clientRecorder()
    const plugin = await controller(directory, recorder.client)

    for (let idle = 0; idle < 3; idle += 1) {
      await plugin.event!({ event: { type: "session.idle", properties: { sessionID: sid } } })
    }

    expect((await readRun(directory, sid))?.stallCount).toBe(3)
    expect(recorder.promptCalls).toHaveLength(3)
    expect(JSON.stringify(recorder.promptCalls[2])).toContain("Three idle cycles")
  })

  test("keeps sending stall nudges after six unchanged idles", async () => {
    const directory = await worktree()
    const sid = "session-stalled"
    const run = createRunState({ verify_cmd: "true" })
    run.stallCount = 5
    await writeRun(directory, sid, run)
    const recorder = clientRecorder()
    const plugin = await controller(directory, recorder.client)

    await plugin.event!({ event: { type: "session.idle", properties: { sessionID: sid } } })
    await plugin.event!({ event: { type: "session.idle", properties: { sessionID: sid } } })

    const active = await readRun(directory, sid)
    expect(active?.status).toBe("active")
    expect(active?.stallCount).toBe(7)
    expect(active?.idleCycles).toBe(2)
    expect(active?.inflight).toBeFalse()
    expect(recorder.getCalls).toHaveLength(2)
    expect(recorder.promptCalls).toHaveLength(2)
    expect(recorder.promptCalls.every((call) => promptText(call).includes("Three idle cycles"))).toBeTrue()
  })

  test("the absolute cutoff stops despite fresh ledger evidence", async () => {
    const directory = await worktree()
    const sid = "session-absolute-stall"
    const run = createRunState({ verify_cmd: "true" })
    run.idleCycles = MAX_IDLE_CYCLES - 1
    run.stallCount = 6
    await writeRun(directory, sid, run)
    await appendLedger(directory, sid, {
      ts: 1,
      scope: "characterize",
      actual: { pass: false, failing: [] },
      cost: 0,
    })
    const recorder = clientRecorder()
    const plugin = await controller(directory, recorder.client)

    await plugin.event!({ event: { type: "session.idle", properties: { sessionID: sid } } })

    const stopped = await readRun(directory, sid)
    expect(stopped?.status).toBe("stalled")
    expect(stopped?.stallCount).toBe(0)
    expect(stopped?.idleCycles).toBe(MAX_IDLE_CYCLES)
    expect(recorder.getCalls).toHaveLength(0)
    expect(recorder.promptCalls).toHaveLength(0)
  })

  test("never resumes a child session (subagent/teammate), only bookkeeps", async () => {
    const directory = await worktree()
    const sid = "session-child"
    await writeRun(directory, sid, createRunState({ verify_cmd: "true" }))
    const recorder = clientRecorder({ session: { parentID: "session-parent" } })
    const plugin = await controller(directory, recorder.client)

    await plugin.event!({ event: { type: "session.idle", properties: { sessionID: sid } } })

    const run = await readRun(directory, sid)
    expect(recorder.getCalls).toHaveLength(1)
    expect(recorder.promptCalls).toHaveLength(0)
    expect(run?.status).toBe("active")
    expect(run?.idleCycles).toBe(1)
    expect(run?.inflight).toBeFalse()
  })

  test("defers clean turns to an active goal but resumes errored turns itself", async () => {
    const directory = await worktree()
    const sid = "session-goal"
    const run = createRunState({ verify_cmd: "true" })
    run.errorStreak = 3
    run.policyBlockStreak = 2
    await writeRun(directory, sid, run)
    const recorder = clientRecorder()
    const plugin = await controller(directory, recorder.client)
    const goalEvent = (status: string) =>
      ({ event: { type: "goal.updated", properties: { sessionID: sid, goal: { status } } } }) as never
    const idle = { event: { type: "session.idle" as const, properties: { sessionID: sid } } }

    await plugin.event!(goalEvent("active"))
    await plugin.event!(idle)
    expect(recorder.promptCalls).toHaveLength(0)
    expect((await readRun(directory, sid))?.idleCycles).toBe(1)
    expect((await readRun(directory, sid))?.inflight).toBeFalse()
    expect((await readRun(directory, sid))?.errorStreak).toBe(0)
    expect((await readRun(directory, sid))?.policyBlockStreak).toBe(0)

    await plugin.event!(sessionErrorEvent(sid, "APIError", "provider unavailable"))
    await plugin.event!(idle)
    expect(recorder.promptCalls).toHaveLength(1)
    expect(promptText(recorder.promptCalls[0])).toContain("APIError: provider unavailable")
    expect((await readRun(directory, sid))?.errorStreak).toBe(1)
    expect((await readRun(directory, sid))?.policyBlockStreak).toBe(0)
  })

  test("goal deference still finalizes a budget-exhausted run", async () => {
    const directory = await worktree()
    const sid = "session-goal-budget"
    const run = createRunState({ verify_cmd: "true" })
    run.verifyActionsUsed = run.verifyActionBudget
    await writeRun(directory, sid, run)
    const recorder = clientRecorder()
    const plugin = await controller(directory, recorder.client)

    await plugin.event!({
      event: { type: "goal.updated", properties: { sessionID: sid, goal: { status: "active" } } },
    } as never)
    await plugin.event!({ event: { type: "session.idle", properties: { sessionID: sid } } })

    expect(recorder.promptCalls).toHaveLength(0)
    expect((await readRun(directory, sid))?.status).toBe("budget_limited")
  })

  test("dispatches a surprise review, persists one reviewer session, and injects redirects", async () => {
    const directory = await worktree()
    const sid = "session-reviewed-surprise"
    const run = createRunState({ verify_cmd: "true" })
    run.pendingReview = {
      trigger: "surprise",
      key: "surprise:1",
      ts: 1,
      detail: "a new parser failure appeared",
    }
    await writeRun(directory, sid, run)
    await appendLedger(directory, sid, {
      ts: 1,
      scope: "targeted",
      actual: { pass: false, failing: ["FAIL parser"] },
      cost: 0,
      surprise: {
        kind: "side_effect_flip",
        detail: "New unpredicted failure: FAIL parser",
      },
    })
    const correction = "The first wrong action was the broad edit. Run the focused parser check."
    const recorder = clientRecorder({ reviewText: `<think>private</think>${correction}` })
    const plugin = await controller(directory, recorder.client)

    await plugin.event!({ event: { type: "session.idle", properties: { sessionID: sid } } })

    const reviewed = await readRun(directory, sid)
    expect(recorder.createCalls).toEqual([
      {
        body: { title: `schema-reviewer:${sid}` },
        query: { directory },
      },
    ])
    expect(recorder.reviewPromptCalls).toHaveLength(1)
    expect(recorder.reviewPromptCalls[0]).toMatchObject({
      path: { id: "reviewer-session-1" },
      body: { agent: "reviewer", parts: [{ type: "text" }] },
    })
    expect(promptText(recorder.promptCalls[0])).toContain(`<action_review>${correction}</action_review>`)
    expect(promptText(recorder.promptCalls[0])).toContain("Reality contradicted your prediction")
    expect(promptText(recorder.promptCalls[0])).not.toContain("<think>")
    expect(reviewed).toMatchObject({
      reviewerSessionID: "reviewer-session-1",
      pendingReview: null,
      lastReviewKey: "surprise:1",
      reviewCount: 1,
    })
    expect(await readReviews(directory, sid)).toMatchObject([
      {
        step: 1,
        trigger: "surprise",
        key: "surprise:1",
        verdict: "redirect",
        message: correction,
        model: "test-reviewer-model",
      },
    ])

    await plugin.event!({
      event: {
        type: "session.idle",
        properties: { sessionID: "reviewer-session-1" },
      },
    })
    expect(recorder.createCalls).toHaveLength(1)
    expect(recorder.reviewPromptCalls).toHaveLength(1)

    if (!reviewed) throw new Error("Expected persisted review state")
    reviewed.pendingReview = {
      trigger: "surprise",
      key: "surprise:2",
      ts: 2,
      detail: "another contradiction",
    }
    reviewed.lastReviewTs = 0
    await writeRun(directory, sid, reviewed)
    await appendLedger(directory, sid, {
      ts: 2,
      scope: "targeted",
      actual: { pass: false, failing: ["FAIL another"] },
      cost: 0,
      surprise: {
        kind: "side_effect_flip",
        detail: "New unpredicted failure: FAIL another",
      },
    })
    await plugin.event!({ event: { type: "session.idle", properties: { sessionID: sid } } })

    expect(recorder.createCalls).toHaveLength(1)
    expect(recorder.reviewPromptCalls).toHaveLength(2)
    expect((await readRun(directory, sid))?.reviewerSessionID).toBe("reviewer-session-1")
    expect(await readReviews(directory, sid)).toHaveLength(2)
  })

  test("REVIEW_OK records an approval without changing the resume prompt", async () => {
    const directory = await worktree()
    const sid = "session-review-ok"
    const run = createRunState({ verify_cmd: "true" })
    run.pendingReview = {
      trigger: "risky_intent",
      key: "risky:call-ok",
      ts: 1,
      detail: "git-reset-hard",
    }
    await writeRun(directory, sid, run)
    const recorder = clientRecorder({ reviewText: "<think>checked</think>\nREVIEW_OK" })
    const plugin = await controller(directory, recorder.client)

    await plugin.event!({ event: { type: "session.idle", properties: { sessionID: sid } } })

    expect(recorder.reviewPromptCalls).toHaveLength(1)
    expect(promptText(recorder.promptCalls[0])).not.toContain("<action_review>")
    expect(promptText(recorder.promptCalls[0])).toContain("Continue the schema loop")
    expect(await readReviews(directory, sid)).toMatchObject([
      { verdict: "ok", message: "REVIEW_OK" },
    ])
  })

  test("rate limits a second trigger and retains it for the next idle", async () => {
    const directory = await worktree()
    const sid = "session-review-rate"
    const run = createRunState({ verify_cmd: "true" })
    run.pendingReview = {
      trigger: "risky_intent",
      key: "risky:first",
      ts: 1,
    }
    await writeRun(directory, sid, run)
    const recorder = clientRecorder()
    const plugin = await controller(directory, recorder.client)
    const idle = { event: { type: "session.idle" as const, properties: { sessionID: sid } } }

    await plugin.event!(idle)
    const afterFirst = await readRun(directory, sid)
    if (!afterFirst) throw new Error("Expected active review state")
    afterFirst.pendingReview = {
      trigger: "verify_fail",
      key: "verify_fail:2",
      ts: Date.now(),
    }
    await writeRun(directory, sid, afterFirst)
    await plugin.event!(idle)

    expect(recorder.reviewPromptCalls).toHaveLength(1)
    expect(recorder.promptCalls).toHaveLength(2)
    expect((await readRun(directory, sid))?.pendingReview?.key).toBe("verify_fail:2")
  })

  test("dedupes reviewed keys and drops triggers at the session cap", async () => {
    const directory = await worktree()
    const dedupeSid = "session-review-dedupe"
    const dedupe = createRunState({ verify_cmd: "true" })
    dedupe.lastReviewKey = "stall:3"
    dedupe.pendingReview = { trigger: "stall", key: "stall:3", ts: 1 }
    await writeRun(directory, dedupeSid, dedupe)
    const capSid = "session-review-cap"
    const capped = createRunState({ verify_cmd: "true" })
    capped.reviewCount = MAX_REVIEWS_PER_SESSION
    capped.pendingReview = { trigger: "stall", key: "stall:4", ts: 1 }
    await writeRun(directory, capSid, capped)
    const recorder = clientRecorder()
    const plugin = await controller(directory, recorder.client)

    await plugin.event!({
      event: { type: "session.idle", properties: { sessionID: dedupeSid } },
    })
    await plugin.event!({
      event: { type: "session.idle", properties: { sessionID: capSid } },
    })

    expect(recorder.createCalls).toHaveLength(0)
    expect(recorder.reviewPromptCalls).toHaveLength(0)
    expect((await readRun(directory, dedupeSid))?.pendingReview).toBeNull()
    expect((await readRun(directory, capSid))?.pendingReview).toBeNull()
  })

  test("reviewer prompt failures keep the trigger and resume with the base nudge", async () => {
    const directory = await worktree()
    const sid = "session-review-error"
    const run = createRunState({ verify_cmd: "true" })
    run.pendingReview = {
      trigger: "surprise",
      key: "surprise:1",
      ts: 1,
      detail: "prediction contradicted",
    }
    await writeRun(directory, sid, run)
    await appendLedger(directory, sid, {
      ts: 1,
      scope: "targeted",
      actual: { pass: false, failing: ["FAIL changed"] },
      cost: 0,
      surprise: {
        kind: "side_effect_flip",
        detail: "New unpredicted failure: FAIL changed",
      },
    })
    const recorder = clientRecorder({ reviewPromptThrows: 1 })
    const plugin = await controller(directory, recorder.client)

    await plugin.event!({ event: { type: "session.idle", properties: { sessionID: sid } } })

    expect(recorder.reviewPromptCalls).toHaveLength(1)
    expect(recorder.promptCalls).toHaveLength(1)
    expect(promptText(recorder.promptCalls[0])).not.toContain("<action_review>")
    expect(promptText(recorder.promptCalls[0])).toContain("Reality contradicted your prediction")
    expect((await readRun(directory, sid))).toMatchObject({
      reviewerSessionID: null,
      pendingReview: { key: "surprise:1" },
      reviewCount: 0,
    })
    expect(await readReviews(directory, sid)).toEqual([])
  })

  test("persists completed review economics when schema resume delivery fails", async () => {
    const directory = await worktree()
    const sid = "session-review-resume-error"
    const run = createRunState({ verify_cmd: "true" })
    run.pendingReview = {
      trigger: "surprise",
      key: "surprise:1",
      ts: 1,
    }
    await writeRun(directory, sid, run)
    await appendLedger(directory, sid, {
      ts: 1,
      scope: "targeted",
      actual: { pass: false, failing: ["FAIL changed"] },
      cost: 0,
      surprise: {
        kind: "side_effect_flip",
        detail: "New unpredicted failure: FAIL changed",
      },
    })
    const recorder = clientRecorder({ promptErrors: 1 })
    const plugin = await controller(directory, recorder.client)
    const consoleError = spyOn(console, "error").mockImplementation(() => {})
    const idle = { event: { type: "session.idle" as const, properties: { sessionID: sid } } }

    try {
      await plugin.event!(idle)
      expect(await readRun(directory, sid)).toMatchObject({
        reviewerSessionID: "reviewer-session-1",
        pendingReview: null,
        lastReviewKey: "surprise:1",
        reviewCount: 1,
        lastLedgerLen: 0,
        inflight: false,
      })
      expect(await readReviews(directory, sid)).toHaveLength(1)

      await plugin.event!(idle)
      expect(recorder.reviewPromptCalls).toHaveLength(1)
      expect(recorder.promptCalls).toHaveLength(2)
      expect(await readReviews(directory, sid)).toHaveLength(1)
      expect((await readRun(directory, sid))?.lastLedgerLen).toBe(1)
    } finally {
      consoleError.mockRestore()
    }
  })

  test("persists completed reviews on the error-recovery return path", async () => {
    const directory = await worktree()
    const sid = "session-review-error-return"
    const run = createRunState({ verify_cmd: "true" })
    run.pendingReview = {
      trigger: "risky_intent",
      key: "risky:error-return",
      ts: 1,
    }
    await writeRun(directory, sid, run)
    const recorder = clientRecorder()
    const plugin = await controller(directory, recorder.client)

    await plugin.event!(sessionErrorEvent(sid, "APIError", "provider unavailable"))
    await plugin.event!({ event: { type: "session.idle", properties: { sessionID: sid } } })

    expect(await readRun(directory, sid)).toMatchObject({
      reviewerSessionID: "reviewer-session-1",
      pendingReview: null,
      lastReviewKey: "risky:error-return",
      reviewCount: 1,
      errorStreak: 1,
    })
    expect(await readReviews(directory, sid)).toHaveLength(1)
  })

  test("treats assistant-level reviewer errors as retryable dispatch failures", async () => {
    const directory = await worktree()
    const sid = "session-review-assistant-error"
    const run = createRunState({ verify_cmd: "true" })
    run.pendingReview = {
      trigger: "risky_intent",
      key: "risky:assistant-error",
      ts: 1,
    }
    await writeRun(directory, sid, run)
    const recorder = clientRecorder({
      reviewText: "",
      reviewInfoError: { name: "APIError", message: "model failed" },
    })
    const plugin = await controller(directory, recorder.client)

    await plugin.event!({ event: { type: "session.idle", properties: { sessionID: sid } } })

    expect(await readRun(directory, sid)).toMatchObject({
      reviewerSessionID: null,
      pendingReview: { key: "risky:assistant-error" },
      reviewCount: 0,
    })
    expect(await readReviews(directory, sid)).toEqual([])
    expect(recorder.promptCalls).toHaveLength(1)
  })

  test("adds the schema reminder only when run.json exists", async () => {
    const directory = await worktree()
    const sid = "session-system"
    await writeRun(directory, sid, createRunState({ verify_cmd: "true" }))
    const recorder = clientRecorder()
    const plugin = await controller(directory, recorder.client)
    const system = ["base"]

    await plugin["experimental.chat.system.transform"]!(
      { sessionID: sid, model: {} as never },
      { system },
    )

    expect(system).toEqual(["base", SCHEMA_REMINDER])
  })
})

describe("action capture hooks", () => {
  test("stages risky intent before execution and appends the completed action afterward", async () => {
    const directory = await worktree()
    const sid = "session-risky-action"
    const run = createRunState({ verify_cmd: "true" })
    run.characterized = true
    run.lastLedgerLen = 7
    await writeRun(directory, sid, run)
    const recorder = clientRecorder()
    const plugin = await controller(directory, recorder.client)
    const before = {
      args: { command: "git reset --hard HEAD" },
      status: undefined as "deny" | undefined,
      reason: undefined as string | undefined,
    }

    await plugin["tool.execute.before"]!(
      { tool: "bash", sessionID: sid, callID: "call-risky" },
      before,
    )

    expect(before.status).toBeUndefined()
    expect((await readRun(directory, sid))?.pendingReview).toMatchObject({
      trigger: "risky_intent",
      key: "risky:call-risky",
      detail: "git-reset-hard",
    })
    expect(await readActions(directory, sid)).toEqual([])

    await plugin["tool.execute.after"]!(
      {
        tool: "bash",
        sessionID: sid,
        callID: "call-risky",
        args: { command: "git reset --hard HEAD" },
      },
      { title: "bash", output: "", metadata: {} },
    )

    expect(await readActions(directory, sid)).toMatchObject([
      {
        step: 1,
        ref: 7,
        tool: "bash",
        digest: "git reset --hard HEAD",
        outcome: "ok",
        risky: "git-reset-hard",
      },
    ])
  })

  test("does not log excluded tools", async () => {
    const directory = await worktree()
    const sid = "session-excluded-action"
    const run = createRunState({ verify_cmd: "true" })
    run.characterized = true
    await writeRun(directory, sid, run)
    const recorder = clientRecorder()
    const plugin = await controller(directory, recorder.client)

    await plugin["tool.execute.before"]!(
      { tool: "read", sessionID: sid, callID: "call-read" },
      { args: { filePath: "src/a.ts" } },
    )
    await plugin["tool.execute.after"]!(
      {
        tool: "read",
        sessionID: sid,
        callID: "call-read",
        args: { filePath: "src/a.ts" },
      },
      { title: "read", output: "", metadata: {} },
    )

    expect((await readRun(directory, sid))?.pendingReview).toBeNull()
    expect(await readActions(directory, sid)).toEqual([])
  })

  test("the characterization gate denies risky commands before staging or logging", async () => {
    const directory = await worktree()
    const sid = "session-pre-characterization-risk"
    await writeRun(directory, sid, createRunState({ verify_cmd: "true" }))
    const recorder = clientRecorder()
    const plugin = await controller(directory, recorder.client)
    const output: { args: unknown; status?: "deny"; reason?: string } = {
      args: { command: "rm -rf ./build" },
    }

    await plugin["tool.execute.before"]!(
      { tool: "bash", sessionID: sid, callID: "call-denied" },
      output,
    )

    expect(output.status).toBe("deny")
    expect((await readRun(directory, sid))?.pendingReview).toBeNull()
    expect(await readActions(directory, sid)).toEqual([])
  })
})
