import { describe, expect, test } from "bun:test"
import {
  ERROR_BACKOFF_BASE_MS,
  ERROR_BACKOFF_MAX_MS,
  MAX_IDLE_CYCLES,
  POLICY_BLOCK_STOP_AT,
  computeErrorBackoff,
  decideVerdict,
  isPolicyRefusal,
  reconcileTerminalOutcome,
} from "../index.ts"
import {
  advanceIdleTracking,
  createRunState,
  type LedgerRow,
  type ParsedLedgerRow,
  type Prediction,
  type VerificationLedgerRow,
} from "../state.ts"

const prediction: Prediction = {
  hypothesis: "the focused fix is sufficient",
  predicted_pass_set: ["test/unit/widget.test.ts::handles   input"],
  ts: 1,
}

const CYBER_POLICY_MESSAGE =
  '{"type":"invalid_request","code":"cyber_policy","message":"This content was flagged for possible cybersecurity risk..."}'

function verification(
  scope: VerificationLedgerRow["scope"],
  pass: boolean,
  failing: string[] = [],
  recordedPrediction?: Prediction,
): VerificationLedgerRow {
  return {
    ts: 1,
    step: 1,
    scope,
    ...(recordedPrediction ? { prediction: recordedPrediction } : {}),
    actual: { pass, failing },
    cost: scope === "full" ? 1 : 0,
  }
}

describe("isPolicyRefusal", () => {
  test("matches tight provider-policy markers", () => {
    const messages = [
      CYBER_POLICY_MESSAGE,
      "content policy violation",
      "FLAGGED FOR POSSIBLE misuse",
      "cybersecurity risk detected",
      "usage policy refusal",
      "content_policy",
      "content was flagged by the provider",
      "moderation blocked the response",
      "SAFETY POLICY refusal",
    ]

    for (const message of messages) {
      expect(isPolicyRefusal({ name: "APIError", message })).toBeTrue()
    }
  })

  test("does not classify missing, auth, or bare-policy messages", () => {
    expect(isPolicyRefusal(undefined)).toBeFalse()
    expect(isPolicyRefusal({ name: "APIError", message: "" })).toBeFalse()
    expect(
      isPolicyRefusal({ name: "ProviderAuthError", message: "ProviderAuthError: invalid api key" }),
    ).toBeFalse()
    expect(isPolicyRefusal({ name: "APIError", message: "provider policy unavailable" })).toBeFalse()
  })
})

describe("decideVerdict", () => {
  test("a green full run solves even when an abort is pending", () => {
    const run = createRunState()
    run.verifyActionsUsed = run.verifyActionBudget
    expect(
      decideVerdict(run, [verification("full", true)], {
        name: "MessageAbortedError",
        message: "cancelled",
      }).action,
    ).toBe("solved")
  })

  test("a pending abort wins over an exhausted budget", () => {
    const run = createRunState()
    run.verifyActionsUsed = run.verifyActionBudget
    expect(
      decideVerdict(run, [], { name: "MessageAbortedError", message: "cancelled" }).action,
    ).toBe("aborted")
  })

  test("a green full run and an abort each beat a pending policy refusal", () => {
    const policyError = { name: "APIError", message: CYBER_POLICY_MESSAGE }
    expect(decideVerdict(createRunState(), [verification("full", true)], policyError).action).toBe(
      "solved",
    )
    expect(
      decideVerdict(createRunState(), [], {
        name: "MessageAbortedError",
        message: CYBER_POLICY_MESSAGE,
      }).action,
    ).toBe("aborted")
  })

  test("an exhausted budget wins over a pending non-abort error", () => {
    const run = createRunState()
    run.verifyActionsUsed = run.verifyActionBudget
    expect(decideVerdict(run, [], { name: "APIError", message: "unavailable" }).action).toBe(
      "budget",
    )
  })

  test("the required budget note takes precedence over idle cutoffs", () => {
    const run = createRunState()
    run.verifyActionsUsed = run.verifyActionBudget
    run.idleCycles = MAX_IDLE_CYCLES
    expect(decideVerdict(run, []).action).toBe("budget")
  })

  test("the lifetime idle cutoff wins over a pending error", () => {
    const run = createRunState()
    run.idleCycles = MAX_IDLE_CYCLES
    expect(decideVerdict(run, [], { name: "APIError", message: "unavailable" }).action).toBe(
      "stalled",
    )
  })

  test("policy refusals reframe twice, then block on the third refusal", () => {
    const policyError = { name: "APIError", message: CYBER_POLICY_MESSAGE }

    for (const streak of [0, 1]) {
      const run = createRunState()
      run.policyBlockStreak = streak
      expect(decideVerdict(run, [], policyError).action).toBe("policy")
    }

    const blocked = createRunState()
    blocked.policyBlockStreak = POLICY_BLOCK_STOP_AT - 1
    expect(decideVerdict(blocked, [], policyError)).toEqual({ action: "blocked" })
  })

  test("budget and the lifetime idle cutoff beat a pending policy refusal", () => {
    const policyError = { name: "APIError", message: CYBER_POLICY_MESSAGE }
    const budget = createRunState()
    budget.verifyActionsUsed = budget.verifyActionBudget
    expect(decideVerdict(budget, [], policyError).action).toBe("budget")

    const stalled = createRunState()
    stalled.idleCycles = MAX_IDLE_CYCLES
    expect(decideVerdict(stalled, [], policyError).action).toBe("stalled")
  })

  test("a policy refusal beats contradiction and uses the bounded reframe prompt", () => {
    const row = verification(
      "targeted",
      false,
      ["FAIL test/unit/widget.test.ts::handles input"],
      prediction,
    )
    const message = `content policy violation\n${"x".repeat(240)}TAIL`
    const detail = `APIError: ${message}`.replace(/[\r\n]+/g, " ").slice(0, 200)
    const verdict = decideVerdict(createRunState(), [row], { name: "APIError", message })

    expect(verdict.action).toBe("policy")
    expect(verdict.prompt).toContain(detail)
    expect(verdict.prompt).not.toContain("\n")
    expect(verdict.prompt).not.toContain("TAIL")
    expect(verdict.prompt).toContain("retrying the identical request will be refused again")
    expect(verdict.prompt).toContain("DO NOT repeat it")
    expect(verdict.prompt).toContain("reframe at a higher level of abstraction")
    expect(verdict.prompt).toContain("decompose the step differently")
    expect(verdict.prompt).toContain("notes.md and stop")
  })

  test("a pending error wins over a new contradiction", () => {
    const row = verification(
      "targeted",
      false,
      ["FAIL test/unit/widget.test.ts::handles input"],
      prediction,
    )
    const verdict = decideVerdict(createRunState(), [row], {
      name: "APIError",
      message: "provider unavailable",
    })
    expect(verdict.action).toBe("error")
  })

  test("the error prompt includes a sanitized, truncated detail and recovery instructions", () => {
    const message = `first line\n${"x".repeat(240)}TAIL`
    const detail = `APIError: ${message}`.replace(/[\r\n]+/g, " ").slice(0, 200)
    const verdict = decideVerdict(createRunState(), [], { name: "APIError", message })

    expect(verdict.action).toBe("error")
    expect(verdict.prompt).toContain(detail)
    expect(verdict.prompt).not.toContain("\n")
    expect(verdict.prompt).not.toContain("TAIL")
    expect(verdict.prompt).toContain("No new evidence was recorded")
    expect(verdict.prompt).toContain("run state, world_model.md, and the ledger")
    expect(verdict.prompt).toContain("re-establish your last prediction")
    expect(verdict.prompt).toContain("cheapest discriminating check")
  })

  test("a normalized predicted-pass failure is a surprise", () => {
    const row = verification(
      "targeted",
      false,
      ["FAIL test\\unit/widget.test.ts / handles input"],
      prediction,
    )
    expect(decideVerdict(createRunState(), [row]).action).toBe("surprise")
  })

  test("a persisted surprise without a prediction still produces the surprise verdict", () => {
    const row = verification("targeted", false, ["FAIL newly broken"])
    row.surprise = {
      kind: "side_effect_flip",
      detail: "New unpredicted failure: FAIL newly broken",
    }
    expect(decideVerdict(createRunState(), [row]).action).toBe("surprise")
  })

  test("an unrelated failure is not treated as a v1 contradiction", () => {
    const row = verification("targeted", false, ["FAIL another test"], prediction)
    expect(decideVerdict(createRunState(), [row]).action).toBe("continue")
  })

  test("qualified and short check names contradict in both directions", () => {
    const cases = [
      ["tests/x.py::test_a", "test_a"],
      ["test_a", "tests/x.py::test_a"],
      ["tests/x.py::test_a", "FAIL test_a"],
    ] as const

    for (const [predicted, failing] of cases) {
      const row = verification("targeted", false, [failing], {
        hypothesis: "the check passes",
        predicted_pass_set: [predicted],
        ts: 1,
      })
      expect(decideVerdict(createRunState(), [row]).action).toBe("surprise")
    }
  })

  test("clearly distinct short check names do not contradict", () => {
    const row = verification("targeted", false, ["test_b"], {
      hypothesis: "the check passes",
      predicted_pass_set: ["test_a"],
      ts: 1,
    })
    expect(decideVerdict(createRunState(), [row]).action).toBe("continue")
  })

  test("a handled contradiction ages out and three unchanged idles can stall", () => {
    const ledger: LedgerRow[] = [
      verification("targeted", false, ["FAIL test/unit/widget.test.ts::handles input"], prediction),
    ]
    let run = createRunState()

    expect(decideVerdict(run, ledger).action).toBe("surprise")
    run = advanceIdleTracking(run, ledger.length)
    expect(decideVerdict(run, ledger).action).toBe("continue")
    run = advanceIdleTracking(run, ledger.length)
    expect(decideVerdict(run, ledger).action).toBe("continue")
    run = advanceIdleTracking(run, ledger.length)
    expect(decideVerdict(run, ledger).action).toBe("stall")
  })

  test("the third unchanged-ledger idle stalls", () => {
    const run = createRunState()
    run.stallCount = 2
    run.lastLedgerLen = 0
    expect(decideVerdict(run, []).action).toBe("stall")
  })

  test("high stall counts keep nudging instead of terminating", () => {
    const run = createRunState()
    run.stallCount = 6
    expect(decideVerdict(run, []).action).toBe("stall")
  })

  test("the absolute idle-cycle cutoff terminates despite new ledger activity", () => {
    const run = createRunState()
    run.idleCycles = MAX_IDLE_CYCLES
    expect(decideVerdict(run, [verification("characterize", false)]).action).toBe("stalled")
  })

  test("new ledger activity resets stall detection", () => {
    const run = createRunState()
    run.stallCount = 2
    const ledger: LedgerRow[] = [verification("characterize", true)]
    expect(decideVerdict(run, ledger).action).toBe("continue")
  })

  test("the default action is continue", () => {
    const run = createRunState()
    run.lastLedgerLen = 1
    expect(decideVerdict(run, [verification("characterize", true)]).action).toBe("continue")
  })

  test("ignores passthrough ledger scopes", () => {
    const external: ParsedLedgerRow = {
      ts: 1,
      step: 1,
      scope: "proxy",
      result: { pass: false },
    }
    expect(decideVerdict(createRunState(), [external]).action).toBe("continue")
  })
})

describe("reconcileTerminalOutcome", () => {
  // Observed in the wild: a session was marked "stalled", the user kept driving
  // it manually to a green full run, and the terminal status never updated —
  // run.json recorded a stall for a session that actually solved.
  test("a stalled run whose latest full is green reconciles to solved", () => {
    const run = createRunState()
    run.status = "stalled"
    const ledger: LedgerRow[] = [verification("full", true, [], prediction)]
    expect(reconcileTerminalOutcome(run, ledger)).toBe("solved")
  })

  test("budget_limited with a green full also reconciles to solved", () => {
    const run = createRunState()
    run.status = "budget_limited"
    expect(reconcileTerminalOutcome(run, [verification("full", true)])).toBe("solved")
  })

  test("no flip without a green full, and later reds win over earlier greens", () => {
    const stalled = createRunState()
    stalled.status = "stalled"
    expect(reconcileTerminalOutcome(stalled, [verification("targeted", true)])).toBeNull()
    expect(
      reconcileTerminalOutcome(stalled, [verification("full", true), verification("full", false)]),
    ).toBeNull()
  })

  test("active, solved, and blocked statuses are never touched", () => {
    const ledger: LedgerRow[] = [verification("full", true)]
    for (const status of ["active", "solved", "blocked"] as const) {
      const run = createRunState()
      run.status = status
      expect(reconcileTerminalOutcome(run, ledger)).toBeNull()
    }
  })
})

describe("computeErrorBackoff", () => {
  test("backs off exponentially from the second error and caps at five minutes", () => {
    expect(computeErrorBackoff(1)).toBe(0)
    expect(computeErrorBackoff(2)).toBe(ERROR_BACKOFF_BASE_MS)
    expect(computeErrorBackoff(3)).toBe(10_000)
    expect(computeErrorBackoff(8)).toBe(ERROR_BACKOFF_MAX_MS)
    expect(computeErrorBackoff(100)).toBe(ERROR_BACKOFF_MAX_MS)
  })
})
