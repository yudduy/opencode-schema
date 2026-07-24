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
