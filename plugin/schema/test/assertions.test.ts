import { describe, expect, test } from "bun:test"
import { detectSurprise, evaluateAssertions } from "../index"
import type { VerificationLedgerRow } from "../state"

/** The refutation half of the loop, tested directly.
 *
 * Measured over 121 real sessions before this existed: surprise fired on 0.53% of
 * 1,502 predictions, because `predicted_pass_set` was prose and detection asked
 * whether that prose appeared inside a grepped FAIL line. A claim like
 * "score >= 0.8" can never match a failure line, so the mechanism the harness
 * exists to provide was structurally unable to fire. These tests exist to keep it
 * firing. */

function row(
  actual: Partial<VerificationLedgerRow["actual"]>,
  prediction?: VerificationLedgerRow["prediction"],
): VerificationLedgerRow {
  return {
    ts: 0,
    step: 1,
    scope: "full",
    actual: { pass: true, failing: [], ...actual },
    cost: 1,
    ...(prediction ? { prediction } : {}),
  } as VerificationLedgerRow
}

const predict = (assertions: any[]) => ({
  hypothesis: "h",
  predicted_pass_set: [],
  assertions,
  ts: 0,
})

describe("evaluateAssertions", () => {
  test("a satisfied numeric claim is not a refutation", () => {
    const failed = evaluateAssertions(
      predict([{ metric: "score", op: ">=", value: 0.8 }]),
      { pass: true, failing: [], score: 0.9 },
    )
    expect(failed).toHaveLength(0)
  })

  test("a violated numeric claim is a refutation, and reports what was observed", () => {
    const failed = evaluateAssertions(
      predict([{ metric: "score", op: ">=", value: 0.8 }]),
      { pass: true, failing: [], score: 0.42 },
    )
    expect(failed).toHaveLength(1)
    expect(failed[0].observed).toBe(0.42)
  })

  test("tolerance widens equality rather than demanding exactness", () => {
    const near = { metric: "score", op: "==", value: 1.0, tol: 0.01 } as const
    expect(evaluateAssertions(predict([near]), { pass: true, failing: [], score: 1.005 })).toHaveLength(0)
    expect(evaluateAssertions(predict([near]), { pass: true, failing: [], score: 1.2 })).toHaveLength(1)
  })

  test("boolean and count metrics are checkable too", () => {
    expect(
      evaluateAssertions(predict([{ metric: "pass", op: "==", value: true }]), {
        pass: false,
        failing: ["a"],
      }),
    ).toHaveLength(1)
    expect(
      evaluateAssertions(predict([{ metric: "failing_count", op: "<=", value: 0 }]), {
        pass: false,
        failing: ["a", "b"],
      }),
    ).toHaveLength(1)
  })

  test("a metric reality did not report is unfalsified, not false", () => {
    // Firing here would make every un-scored run a surprise, which is how a
    // detector becomes noise and then gets ignored.
    expect(
      evaluateAssertions(predict([{ metric: "score", op: ">=", value: 0.8 }]), {
        pass: true,
        failing: [],
      }),
    ).toHaveLength(0)
  })

  test("no assertions means nothing to refute", () => {
    expect(evaluateAssertions({ assertions: [] }, { pass: true, failing: [] })).toHaveLength(0)
    expect(evaluateAssertions({}, { pass: true, failing: [] })).toHaveLength(0)
  })
})

describe("detectSurprise fires on a refuted assertion", () => {
  test("the case the old prose matcher could never catch", () => {
    // A green suite that nonetheless missed its predicted score. Under the old
    // rule this produced no surprise at all: `pass` was true and there were no
    // FAIL lines for the prose to match against.
    const surprise = detectSurprise(
      row({ pass: true, failing: [], score: 0.42 }, predict([{ metric: "score", op: ">=", value: 0.8 }])),
      [],
    )
    expect(surprise).not.toBeNull()
    expect(surprise!.kind).toBe("assertion_failed")
    expect(surprise!.detail).toContain("0.42")
  })

  test("a met assertion with a clean run is not a surprise", () => {
    expect(
      detectSurprise(
        row({ pass: true, failing: [], score: 0.95 }, predict([{ metric: "score", op: ">=", value: 0.8 }])),
        [],
      ),
    ).toBeNull()
  })

  test("assertions outrank prose: a refuted number fires even when names look fine", () => {
    const surprise = detectSurprise(
      row(
        { pass: true, failing: [], score: 0.1 },
        {
          hypothesis: "h",
          predicted_pass_set: ["suite"],
          assertions: [{ metric: "score", op: ">", value: 0.5 }],
          ts: 0,
        },
      ),
      [],
    )
    expect(surprise?.kind).toBe("assertion_failed")
  })

  test("prose matching still works when no assertion was offered", () => {
    const surprise = detectSurprise(
      row({ pass: false, failing: ["FAIL alpha"] }, {
        hypothesis: "h",
        predicted_pass_set: ["alpha"],
        ts: 0,
      }),
      [],
    )
    expect(surprise?.kind).toBe("predicted_pass_failed")
  })
})
