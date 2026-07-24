import { describe, expect, test } from "bun:test"
import { detectSurprise } from "../index.ts"
import type { Prediction, VerificationLedgerRow } from "../state.ts"

const prediction: Prediction = {
  hypothesis: "the focused fix is isolated",
  predicted_pass_set: ["tests/widget.test.ts::handles input"],
  ts: 1,
}

function row(
  failing: string[],
  recordedPrediction: Prediction | null = prediction,
): VerificationLedgerRow {
  return {
    ts: 1,
    step: 2,
    scope: "targeted",
    ...(recordedPrediction ? { prediction: recordedPrediction } : {}),
    actual: { pass: failing.length === 0, failing },
    cost: 0,
  }
}

describe("detectSurprise", () => {
  test("detects a normalized predicted-pass failure", () => {
    expect(
      detectSurprise(row(["FAIL tests\\widget.test.ts / handles input"]), []),
    ).toMatchObject({
      kind: "predicted_pass_failed",
    })
  })

  test("prioritizes a predicted-pass failure over a new side effect", () => {
    expect(
      detectSurprise(
        row([
          "FAIL tests/widget.test.ts::handles input",
          "FAIL tests/parser.test.ts::new regression",
        ]),
        [],
      )?.kind,
    ).toBe("predicted_pass_failed")
  })

  test("detects a newly broken unpredicted check", () => {
    expect(
      detectSurprise(row(["FAIL tests/parser.test.ts::new regression"]), []),
    ).toMatchObject({
      kind: "side_effect_flip",
    })
  })

  test("does not treat a characterized baseline failure as a side-effect flip", () => {
    expect(
      detectSurprise(
        row(["FAIL tests/parser.test.ts::known failure"]),
        ["FAIL tests/parser.test.ts::known failure"],
      ),
    ).toBeNull()
  })

  test("requires a recorded prediction", () => {
    expect(detectSurprise(row(["FAIL new regression"], null), [])).toBeNull()
  })
})
