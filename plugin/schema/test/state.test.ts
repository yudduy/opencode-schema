import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { $ } from "bun"
import type { PluginInput, ToolContext, ToolResult } from "@opencode-ai/plugin"
import { server } from "../index.ts"
import {
  appendLedger,
  createRunState,
  ledgerFile,
  readLedger,
  readRun,
  runFile,
  writeRun,
} from "../state.ts"

const worktrees: string[] = []

afterEach(async () => {
  await Promise.all(worktrees.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function worktree(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "schema-plugin-"))
  worktrees.push(directory)
  return directory
}

function context(directory: string, sessionID: string): ToolContext {
  return {
    sessionID,
    messageID: "message-test",
    agent: "schema",
    directory,
    worktree: directory,
    abort: new AbortController().signal,
    metadata() {},
    async ask() {},
  }
}

function metadata(result: ToolResult): Record<string, unknown> {
  if (typeof result === "string") throw new Error(`Expected structured tool result, received ${result}`)
  return result.metadata ?? {}
}

async function hooks(directory: string) {
  return server({
    $,
    worktree: directory,
    directory,
    client: {},
  } as unknown as PluginInput)
}

describe("schema tools", () => {
  test("new and legacy run states expose controller defaults", async () => {
    expect(createRunState().errorStreak).toBe(0)
    expect(createRunState().policyBlockStreak).toBe(0)
    expect(createRunState().reviewerSessionID).toBeNull()
    expect(createRunState().pendingReview).toBeNull()
    expect(createRunState().lastReviewKey).toBeNull()
    expect(createRunState().lastReviewTs).toBe(0)
    expect(createRunState().reviewCount).toBe(0)

    const directory = await worktree()
    const sid = "session-legacy-state"
    await writeRun(directory, sid, createRunState({ verify_cmd: "true" }))
    const legacy = JSON.parse(await readFile(runFile(directory, sid), "utf8")) as {
      errorStreak?: number
      policyBlockStreak?: number
      reviewerSessionID?: string | null
      pendingReview?: unknown
      lastReviewKey?: string | null
      lastReviewTs?: number
      reviewCount?: number
    }
    delete legacy.errorStreak
    delete legacy.policyBlockStreak
    delete legacy.reviewerSessionID
    delete legacy.pendingReview
    delete legacy.lastReviewKey
    delete legacy.lastReviewTs
    delete legacy.reviewCount
    await writeFile(runFile(directory, sid), `${JSON.stringify(legacy)}\n`, "utf8")

    expect(await readRun(directory, sid)).toMatchObject({
      errorStreak: 0,
      policyBlockStreak: 0,
      reviewerSessionID: null,
      pendingReview: null,
      lastReviewKey: null,
      lastReviewTs: 0,
      reviewCount: 0,
    })
  })

  test("register_benchmark accepts a custom budget and preserves it when omitted", async () => {
    const directory = await worktree()
    const plugin = await hooks(directory)
    const customSid = "session-custom-budget"

    await plugin.tool!.register_benchmark.execute(
      { verify_cmd: "true", verify_action_budget: 50 },
      context(directory, customSid),
    )
    expect((await readRun(directory, customSid))?.verifyActionBudget).toBe(50)

    await plugin.tool!.register_benchmark.execute(
      { verify_cmd: "false" },
      context(directory, customSid),
    )
    expect((await readRun(directory, customSid))?.verifyActionBudget).toBe(50)

    const defaultSid = "session-default-budget"
    await plugin.tool!.register_benchmark.execute(
      { verify_cmd: "true" },
      context(directory, defaultSid),
    )
    expect((await readRun(directory, defaultSid))?.verifyActionBudget).toBe(12)
  })

  test("full verification requires a prediction, then increments its counter", async () => {
    const directory = await worktree()
    const sid = "session-full"
    const plugin = await hooks(directory)
    const ctx = context(directory, sid)

    await plugin.tool!.register_benchmark.execute({ verify_cmd: "bash -c 'exit 0'" }, ctx)
    const denied = await plugin.tool!.run_verify.execute({ scope: "full" }, ctx)
    expect(metadata(denied)).toEqual({ error: "prediction_required" })
    expect((await readRun(directory, sid))?.verifyActionsUsed).toBe(0)
    expect(await readLedger(directory, sid)).toHaveLength(0)

    await plugin.tool!.predict.execute(
      { hypothesis: "the command exits cleanly", predicted_pass_set: ["benchmark"] },
      ctx,
    )
    const result = await plugin.tool!.run_verify.execute({ scope: "full" }, ctx)
    expect(metadata(result)).toMatchObject({
      pass: true,
      failing: [],
      verifyActionsUsed: 1,
      budget: 12,
    })
    expect((await readRun(directory, sid))?.verifyActionsUsed).toBe(1)
    const ledger = await readLedger(directory, sid)
    expect(ledger.map((row) => row.scope)).toEqual(["predict", "full"])
    expect(ledger[0]).not.toHaveProperty("actual")
    expect(ledger[0]).not.toHaveProperty("cost")
  })

  test("a green full run stamps solved at the tool site; a later red full un-solves", async () => {
    // One-shot `opencode run` exits at turn end, so the idle controller may
    // never fire — the outcome must be recorded the moment it is decided.
    const directory = await worktree()
    const sid = "session-solved-stamp"
    const plugin = await hooks(directory)
    const ctx = context(directory, sid)

    await plugin.tool!.register_benchmark.execute({ verify_cmd: "bash -c 'exit 0'" }, ctx)
    await plugin.tool!.predict.execute(
      { hypothesis: "green", predicted_pass_set: ["benchmark"] },
      ctx,
    )
    await plugin.tool!.run_verify.execute({ scope: "full" }, ctx)
    expect((await readRun(directory, sid))?.status).toBe("solved")

    const run = await readRun(directory, sid)
    run!.benchmark!.verify_cmd = "bash -c 'exit 1'"
    await writeRun(directory, sid, run!)
    await plugin.tool!.predict.execute(
      { hypothesis: "still green", predicted_pass_set: ["benchmark"] },
      ctx,
    )
    await plugin.tool!.run_verify.execute({ scope: "full" }, ctx)
    expect((await readRun(directory, sid))?.status).toBe("active")
  })

  test("serializes concurrent full verification state and ledger steps", async () => {
    const directory = await worktree()
    const sid = "session-concurrent-full"
    const plugin = await hooks(directory)
    const ctx = context(directory, sid)

    await plugin.tool!.register_benchmark.execute({ verify_cmd: "true" }, ctx)
    await plugin.tool!.predict.execute(
      { hypothesis: "both full runs pass", predicted_pass_set: ["benchmark"] },
      ctx,
    )

    const results = await Promise.all([
      plugin.tool!.run_verify.execute({ scope: "full" }, ctx),
      plugin.tool!.run_verify.execute({ scope: "full" }, ctx),
    ])

    expect(metadata(results[0])).toMatchObject({ verifyActionsUsed: 1 })
    expect(metadata(results[1])).toEqual({ error: "prediction_required" })
    expect((await readRun(directory, sid))?.verifyActionsUsed).toBe(1)
    const ledger = await readLedger(directory, sid)
    expect(ledger.map((row) => row.scope)).toEqual(["predict", "full"])
    expect(ledger.map((row) => row.step)).toEqual([1, 2])
  })

  test("serializes sequential prediction and full verification pairs", async () => {
    const directory = await worktree()
    const sid = "session-sequential-full"
    const plugin = await hooks(directory)
    const ctx = context(directory, sid)

    await plugin.tool!.register_benchmark.execute({ verify_cmd: "true" }, ctx)
    const counters: unknown[] = []
    for (const hypothesis of ["first pass", "second pass"]) {
      await plugin.tool!.predict.execute(
        { hypothesis, predicted_pass_set: ["benchmark"] },
        ctx,
      )
      counters.push(metadata(await plugin.tool!.run_verify.execute({ scope: "full" }, ctx)).verifyActionsUsed)
    }

    expect(counters).toEqual([1, 2])
    const ledger = await readLedger(directory, sid)
    expect(ledger.map((row) => row.scope)).toEqual(["predict", "full", "predict", "full"])
    expect(ledger.map((row) => row.step)).toEqual([1, 2, 3, 4])
  })

  test("characterize records a failing baseline and opens the edit gate", async () => {
    const directory = await worktree()
    const sid = "session-characterize"
    const plugin = await hooks(directory)
    const ctx = context(directory, sid)

    await plugin.tool!.register_benchmark.execute(
      { verify_cmd: "bash -c 'printf \"FAIL x\\n\"; exit 1'" },
      ctx,
    )
    const result = await plugin.tool!.run_verify.execute({ scope: "characterize" }, ctx)
    expect(metadata(result)).toMatchObject({ pass: false, failing: ["FAIL x"] })
    expect((await readRun(directory, sid))?.characterized).toBeTrue()

    const output: { args: unknown; status?: "deny"; reason?: string } = { args: {} }
    await plugin["tool.execute.before"]!({ tool: "edit", sessionID: sid, callID: "call" }, output)
    expect(output.status).toBeUndefined()
  })

  test("full-only scoring reports budget metadata; a green final full still solves", async () => {
    const directory = await worktree()
    const sid = "session-score"
    const plugin = await hooks(directory)
    const ctx = context(directory, sid)

    await plugin.tool!.register_benchmark.execute(
      { verify_cmd: "bash -c 'exit 0'", score_cmd: "printf 'SCORE: 2.5\\n'" },
      ctx,
    )
    const targeted = await plugin.tool!.run_verify.execute({ scope: "targeted" }, ctx)
    expect(metadata(targeted)).not.toHaveProperty("score")

    await plugin.tool!.predict.execute(
      { hypothesis: "the full run passes", predicted_pass_set: ["benchmark"] },
      ctx,
    )
    const beforeFull = await readRun(directory, sid)
    if (!beforeFull) throw new Error("Expected registered schema state")
    beforeFull.verifyActionBudget = 1
    await writeRun(directory, sid, beforeFull)

    const full = await plugin.tool!.run_verify.execute({ scope: "full" }, ctx)
    expect(metadata(full)).toMatchObject({ score: 2.5, status: "budget_limited" })
    // Solved outranks budget exhaustion — the green full decides the outcome
    // (same precedence decideVerdict applies).
    expect((await readRun(directory, sid))?.status).toBe("solved")

    const verificationRows = (await readLedger(directory, sid)).filter((row) => row.scope !== "predict")
    expect(verificationRows.map((row) => row.cost)).toEqual([0, 1])
  })

  test("denies a full run at the budget boundary without executing or appending", async () => {
    const directory = await worktree()
    const sid = "session-budget-deny"
    const plugin = await hooks(directory)
    const ctx = context(directory, sid)
    await plugin.tool!.register_benchmark.execute(
      { verify_cmd: "printf executed >> budget-marker", verify_action_budget: 1 },
      ctx,
    )
    await plugin.tool!.predict.execute(
      { hypothesis: "the command would pass", predicted_pass_set: ["benchmark"] },
      ctx,
    )
    const run = await readRun(directory, sid)
    if (!run) throw new Error("Expected registered schema state")
    run.verifyActionsUsed = run.verifyActionBudget
    await writeRun(directory, sid, run)
    const before = await readLedger(directory, sid)

    const denied = await plugin.tool!.run_verify.execute({ scope: "full" }, ctx)

    expect(metadata(denied)).toEqual({
      error: "budget_exhausted",
      verifyActionsUsed: 1,
      verifyActionBudget: 1,
    })
    expect((await readRun(directory, sid))?.status).toBe("budget_limited")
    expect(await readLedger(directory, sid)).toEqual(before)
    await expect(readFile(path.join(directory, "budget-marker"), "utf8")).rejects.toBeDefined()
  })

  // Contract change: ANY observation resolves the open prediction, not just an
  // expensive one. Coupled to the deny-a-second-prediction gate — if only `full`
  // resolved, an agent that learned it was wrong from a cheap targeted check could
  // never record the corrected prediction without first buying a full run, which
  // deadlocks the "on surprise, stop and repair the model" path.
  test("surprise fires end-to-end when an assertion is refuted", async () => {
    // The whole point of the harness, exercised through the real tool path: a run
    // that PASSES but misses its predicted score must still register as a surprise.
    // Under the old prose matcher this produced nothing at all.
    const directory = await worktree()
    const sid = "session-assertion-surprise"
    const plugin = await hooks(directory)
    const ctx = context(directory, sid)
    await plugin.tool!.register_benchmark.execute(
      { verify_cmd: "echo 'score: 0.42'", score_cmd: "echo 'score: 0.42'" },
      ctx,
    )
    await plugin.tool!.run_verify.execute({ scope: "characterize" }, ctx)
    await plugin.tool!.predict.execute(
      {
        hypothesis: "the rewrite lands above the target",
        predicted_pass_set: [],
        assertions: [{ metric: "score", op: ">=", value: 0.8 }],
      },
      ctx,
    )
    await plugin.tool!.run_verify.execute({ scope: "full" }, ctx)

    const ledger = await readLedger(directory, sid)
    const verified = ledger.filter((r: any) => r.scope === "full")
    expect(verified).toHaveLength(1)
    expect((verified[0] as any).surprise?.kind).toBe("assertion_failed")
    expect((verified[0] as any).surprise?.detail).toContain("0.42")
  })

  test("a second prediction is denied while one is unresolved", async () => {
    // Kills the predict-storm at its source: measured 1,502 predictions against 56
    // expensive verifications, with one unbroken streak of 72.
    const directory = await worktree()
    const sid = "session-prediction-storm"
    const plugin = await hooks(directory)
    const ctx = context(directory, sid)
    await plugin.tool!.register_benchmark.execute({ verify_cmd: "true" }, ctx)

    await plugin.tool!.predict.execute(
      { hypothesis: "first", predicted_pass_set: ["a"] },
      ctx,
    )
    expect(metadata(await plugin.tool!.predict.execute(
      { hypothesis: "second", predicted_pass_set: ["b"] },
      ctx,
    ))).toEqual({ error: "prediction_unresolved" })

    // Resolving it re-opens the slot. A successful predict returns a plain string,
    // so acceptance is asserted on the run state rather than on tool metadata.
    await plugin.tool!.run_verify.execute({ scope: "targeted" }, ctx)
    await plugin.tool!.predict.execute(
      { hypothesis: "third", predicted_pass_set: ["c"] },
      ctx,
    )
    expect((await readRun(directory, sid))?.lastPrediction).toMatchObject({
      hypothesis: "third",
    })
  })

  test("any verification consumes its prediction", async () => {
    const directory = await worktree()
    const sid = "session-prediction-freshness"
    const plugin = await hooks(directory)
    const ctx = context(directory, sid)
    await plugin.tool!.register_benchmark.execute({ verify_cmd: "true" }, ctx)
    await plugin.tool!.predict.execute(
      { hypothesis: "checks pass", predicted_pass_set: ["benchmark"] },
      ctx,
    )

    await plugin.tool!.run_verify.execute({ scope: "targeted" }, ctx)
    expect((await readRun(directory, sid))?.lastPrediction).toBeNull()

    await plugin.tool!.predict.execute(
      { hypothesis: "checks pass again", predicted_pass_set: ["benchmark"] },
      ctx,
    )
    await plugin.tool!.run_verify.execute({ scope: "full" }, ctx)
    expect((await readRun(directory, sid))?.lastPrediction).toBeNull()
    expect(metadata(await plugin.tool!.run_verify.execute({ scope: "full" }, ctx))).toEqual({
      error: "prediction_required",
    })
  })

  test("predict persists side effects and targeted verification records them in the ledger", async () => {
    const directory = await worktree()
    const sid = "session-targeted-surprise"
    const plugin = await hooks(directory)
    const ctx = context(directory, sid)
    await plugin.tool!.register_benchmark.execute(
      {
        verify_cmd: "true",
        targeted_cmd: "printf 'FAIL focused-regression\\n'; exit 1",
      },
      ctx,
    )
    await plugin.tool!.predict.execute(
      {
        hypothesis: "the focused check passes",
        predicted_pass_set: ["focused-check"],
        predicted_side_effects: "no unrelated failures",
      },
      ctx,
    )
    await plugin.tool!.run_verify.execute({ scope: "targeted" }, ctx)

    // The prediction is consumed by the observation; the ledger keeps the record.
    expect((await readRun(directory, sid))?.lastPrediction).toBeNull()
    expect(await readLedger(directory, sid)).toMatchObject([
      {
        scope: "predict",
        prediction: { predicted_side_effects: "no unrelated failures" },
      },
      {
        scope: "targeted",
        surprise: { kind: "side_effect_flip" },
      },
    ])
  })

  test("a rejected full ledger append does not consume its prediction", async () => {
    const directory = await worktree()
    const outside = await worktree()
    const sid = "session-full-append-rejected"
    const plugin = await hooks(directory)
    const ctx = context(directory, sid)
    await plugin.tool!.register_benchmark.execute({ verify_cmd: "true" }, ctx)
    await plugin.tool!.predict.execute(
      { hypothesis: "the full check passes", predicted_pass_set: ["benchmark"] },
      ctx,
    )
    await rm(ledgerFile(directory, sid))
    const target = path.join(outside, "ledger.jsonl")
    await writeFile(target, "", "utf8")
    await symlink(target, ledgerFile(directory, sid), "file")

    const result = await plugin.tool!.run_verify.execute({ scope: "full" }, ctx)

    expect(metadata(result).error).toBeString()
    expect((await readRun(directory, sid))).toMatchObject({
      verifyActionsUsed: 0,
      lastPrediction: {
        hypothesis: "the full check passes",
      },
    })
    expect(await readFile(target, "utf8")).toBe("")
  })

  test("failed full verification stages surprise and ordinary failure reviews", async () => {
    const directory = await worktree()
    const plugin = await hooks(directory)

    const surpriseSid = "session-full-surprise"
    const surpriseContext = context(directory, surpriseSid)
    await plugin.tool!.register_benchmark.execute(
      {
        verify_cmd:
          "if test -f schema-flip; then printf 'FAIL new-check\\n'; exit 1; else exit 0; fi",
      },
      surpriseContext,
    )
    await plugin.tool!.run_verify.execute({ scope: "characterize" }, surpriseContext)
    await writeFile(path.join(directory, "schema-flip"), "", "utf8")
    await plugin.tool!.predict.execute(
      { hypothesis: "the benchmark remains green", predicted_pass_set: ["benchmark"] },
      surpriseContext,
    )
    await plugin.tool!.run_verify.execute({ scope: "full" }, surpriseContext)

    const surpriseRun = await readRun(directory, surpriseSid)
    const surpriseLedger = await readLedger(directory, surpriseSid)
    expect(surpriseRun?.pendingReview).toMatchObject({
      trigger: "surprise",
      key: "surprise:3",
    })
    expect(surpriseLedger[2]).toMatchObject({
      scope: "full",
      surprise: { kind: "side_effect_flip" },
    })

    const failureSid = "session-full-failure"
    const failureContext = context(directory, failureSid)
    await plugin.tool!.register_benchmark.execute(
      { verify_cmd: "printf 'FAIL baseline\\n'; exit 1" },
      failureContext,
    )
    await plugin.tool!.run_verify.execute({ scope: "characterize" }, failureContext)
    await plugin.tool!.predict.execute(
      { hypothesis: "no new failures", predicted_pass_set: ["benchmark"] },
      failureContext,
    )
    await plugin.tool!.run_verify.execute({ scope: "full" }, failureContext)

    expect((await readRun(directory, failureSid))?.pendingReview).toMatchObject({
      trigger: "verify_fail",
      key: "verify_fail:3",
      detail: "FAIL baseline",
    })
  })

  test("prediction side effects and surprise annotations round-trip through the ledger", async () => {
    const directory = await worktree()
    const sid = "session-ledger-extensions"
    const prediction = {
      hypothesis: "the focused fix is isolated",
      predicted_pass_set: ["widget"],
      predicted_side_effects: "no parser changes",
      ts: 1,
    }

    await appendLedger(directory, sid, { ts: 1, scope: "predict", prediction })
    await appendLedger(directory, sid, {
      ts: 2,
      scope: "targeted",
      prediction,
      actual: { pass: false, failing: ["FAIL widget"] },
      cost: 0,
      surprise: {
        kind: "predicted_pass_failed",
        detail: "Predicted pass failed: widget",
      },
    })

    expect(await readLedger(directory, sid)).toMatchObject([
      { prediction: { predicted_side_effects: "no parser changes" } },
      {
        surprise: {
          kind: "predicted_pass_failed",
          detail: "Predicted pass failed: widget",
        },
      },
    ])
  })

  test("hooks leave non-schema sessions untouched", async () => {
    const directory = await worktree()
    const plugin = await hooks(directory)
    const gate: { args: unknown; status?: "deny"; reason?: string } = { args: {} }
    await plugin["tool.execute.before"]!(
      { tool: "edit", sessionID: "ordinary-session", callID: "call" },
      gate,
    )
    expect(gate).toEqual({ args: {} })

    const system: string[] = []
    await plugin["experimental.chat.system.transform"]!(
      { sessionID: "ordinary-session", model: {} as never },
      { system },
    )
    expect(system).toEqual([])
  })

  test("record_ad_hoc creates and appends only the worktree inventory", async () => {
    const directory = await worktree()
    const plugin = await hooks(directory)
    const ctx = context(directory, "session-inventory")
    await plugin.tool!.record_ad_hoc.execute(
      { special_case: "one branch", anomaly: "one input", lines_added: 2, checks_greened: 1 },
      ctx,
    )
    await plugin.tool!.record_ad_hoc.execute(
      { special_case: "second branch", anomaly: "second input" },
      ctx,
    )

    const inventory = await readFile(path.join(directory, "ad_hoc_inventory.md"), "utf8")
    expect(inventory.match(/# Ad-Hoc Inventory/g)).toHaveLength(1)
    expect(inventory).toContain("one branch")
    expect(inventory).toContain("second branch")
  })

  test("refuses a symlinked schema directory instead of writing outside the worktree", async () => {
    const directory = await worktree()
    const outside = await worktree()
    const sid = "session-symlink"
    await symlink(outside, path.join(directory, ".schema"), "dir")
    const plugin = await hooks(directory)

    const result = await plugin.tool!.register_benchmark.execute(
      { verify_cmd: "true" },
      context(directory, sid),
    )

    expect(metadata(result).error).toBeString()
    await expect(readFile(path.join(outside, sid, "run.json"), "utf8")).rejects.toBeDefined()
  })

  test("does not commit run state when a ledger append is rejected", async () => {
    const directory = await worktree()
    const outside = await worktree()
    const sid = "session-ledger-symlink"
    const plugin = await hooks(directory)
    const ctx = context(directory, sid)
    await plugin.tool!.register_benchmark.execute({ verify_cmd: "true" }, ctx)

    const target = path.join(outside, "ledger.jsonl")
    await writeFile(target, "", "utf8")
    await symlink(target, ledgerFile(directory, sid), "file")

    const characterized = await plugin.tool!.run_verify.execute({ scope: "characterize" }, ctx)
    expect(metadata(characterized).error).toBeString()
    expect((await readRun(directory, sid))?.characterized).toBeFalse()

    const predicted = await plugin.tool!.predict.execute(
      { hypothesis: "the check passes", predicted_pass_set: ["benchmark"] },
      ctx,
    )
    expect(metadata(predicted).error).toBeString()
    expect((await readRun(directory, sid))?.lastPrediction).toBeNull()
    expect(await readFile(target, "utf8")).toBe("")
  })

  test("refuses a symlinked ad-hoc inventory without changing its target", async () => {
    const directory = await worktree()
    const outside = await worktree()
    const target = path.join(outside, "inventory.md")
    await writeFile(target, "sentinel\n", "utf8")
    await symlink(target, path.join(directory, "ad_hoc_inventory.md"), "file")
    const plugin = await hooks(directory)

    const result = await plugin.tool!.record_ad_hoc.execute(
      { special_case: "branch", anomaly: "input" },
      context(directory, "session-inventory-symlink"),
    )

    expect(metadata(result).error).toBeString()
    expect(await readFile(target, "utf8")).toBe("sentinel\n")
  })
})
