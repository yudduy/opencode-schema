import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import { parseVerifyOutput, runBenchmarkCommand } from "../verify.ts"

describe("parseVerifyOutput", () => {
  test("exit zero with no failure markers passes", () => {
    expect(parseVerifyOutput(0, "all good\n")).toEqual({ pass: true, failing: [] })
  })

  test("FAIL and not ok lines are collected as failures", () => {
    expect(parseVerifyOutput(1, "ok 1\nFAIL x\nnot ok 3\nignored")).toEqual({
      pass: false,
      failing: ["FAIL x", "not ok 3"],
    })
  })

  test("uses the last score number", () => {
    expect(parseVerifyOutput(0, "ok", "", "score 0.5\nSCORE: 0.75").score).toBe(0.75)
  })

  test("fail inside a word or path is not a failure marker", () => {
    // Observed in the wild: a repo literally named "ecdsafail" turned every
    // path-printing line into a phantom failing check, feeding false surprises.
    const stdout = [
      "Compiling quantum_ecc v0.1.0 (/Users/x/project/ecdsafail)",
      '  File "/Users/x/project/ecdsafail/src/lib.py", line 648, in <module>',
      "FAIL: real_test",
    ].join("\n")
    expect(parseVerifyOutput(1, stdout).failing).toEqual(["FAIL: real_test"])
  })

  test("zero-count failure summaries on green runs are not failures", () => {
    // cargo test and bun test both print these on fully green runs.
    const cargo = "test result: ok. 42 passed; 0 failed; 0 ignored"
    const bun = "108 pass\n 0 fail"
    expect(parseVerifyOutput(0, cargo).failing).toEqual([])
    expect(parseVerifyOutput(0, bun).failing).toEqual([])
  })

  test("word-boundary failure markers are still collected", () => {
    const stdout = [
      "!! correctness FAILED: PHASE GARBAGE",
      "benchmarkCommand failed with exit code 1",
      "✗ renders header",
      "not ok 3 - flaky",
      "=== 1 failed, 3 passed ===",
    ].join("\n")
    expect(parseVerifyOutput(1, stdout).failing).toEqual([
      "!! correctness FAILED: PHASE GARBAGE",
      "benchmarkCommand failed with exit code 1",
      "✗ renders header",
      "not ok 3 - flaky",
      "=== 1 failed, 3 passed ===",
    ])
  })

  test("timeout terminates the benchmark process group", async () => {
    const started = Date.now()
    const result = await runBenchmarkCommand($, process.cwd(), "trap '' TERM; sleep 3", 100)
    expect(result).toMatchObject({ exitCode: 124, timedOut: true })
    expect(Date.now() - started).toBeLessThan(2_500)
  })

  test("cleans background descendants after the command leader exits", async () => {
    const started = Date.now()
    const result = await runBenchmarkCommand($, process.cwd(), "sleep 3 & exit 0", 100)
    expect(result).toMatchObject({ exitCode: 0, timedOut: false })
    expect(Date.now() - started).toBeLessThan(2_500)
  })
})
