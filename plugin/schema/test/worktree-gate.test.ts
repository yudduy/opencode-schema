import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { $ } from "bun"
import type { PluginInput } from "@opencode-ai/plugin"
import { executorFanoutPredicate, server } from "../index.ts"
import { createRunState, writeRun } from "../state.ts"

const worktrees: string[] = []

afterEach(async () => {
  await Promise.all(worktrees.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function worktree(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "schema-worktree-gate-"))
  worktrees.push(directory)
  return directory
}

async function controller(directory: string) {
  return server({
    $,
    worktree: directory,
    directory,
    client: {},
  } as unknown as PluginInput)
}

describe("executorFanoutPredicate", () => {
  test("adds worktree to executor fanout and preserves other arguments", () => {
    const args = { subagent_type: "executor", description: "x" }

    const decision = executorFanoutPredicate("task", args)

    expect(decision).toEqual({
      rewrite: { subagent_type: "executor", description: "x", worktree: true },
    })
    expect(decision?.rewrite).not.toHaveProperty("background")
    expect(args).not.toHaveProperty("worktree")
  })

  test("supports the alternate executor subagent keys", () => {
    expect(executorFanoutPredicate("task", { agent: "executor" })).toEqual({
      rewrite: { agent: "executor", worktree: true },
    })
    expect(executorFanoutPredicate("task", { agentType: "executor" })).toEqual({
      rewrite: { agentType: "executor", worktree: true },
    })
  })

  test("does nothing when worktree is already true", () => {
    expect(
      executorFanoutPredicate("task", { subagent_type: "executor", worktree: true }),
    ).toBeNull()
  })

  test("does nothing for other subagents", () => {
    expect(executorFanoutPredicate("task", { subagent_type: "general" })).toBeNull()
  })

  test("does nothing for non-task tools", () => {
    expect(executorFanoutPredicate("spawn_agent", { subagent_type: "executor" })).toBeNull()
  })

  test("defensively ignores malformed arguments", () => {
    expect(executorFanoutPredicate("task", null)).toBeNull()
    expect(executorFanoutPredicate("task", "executor")).toBeNull()
  })
})

describe("executor worktree hook", () => {
  test("rewrites a characterized executor task call", async () => {
    const directory = await worktree()
    const sid = "session-executor"
    const run = createRunState({ verify_cmd: "true" })
    run.characterized = true
    await writeRun(directory, sid, run)
    const plugin = await controller(directory)
    const output = {
      args: { subagent_type: "executor", description: "x" } as Record<string, unknown>,
    }

    await plugin["tool.execute.before"]!(
      { tool: "task", sessionID: sid, callID: "call-executor" },
      output,
    )

    expect(output.args.worktree).toBeTrue()
    expect(output.args).toEqual({
      subagent_type: "executor",
      description: "x",
      worktree: true,
    })
  })

  test("leaves a characterized general task call untouched", async () => {
    const directory = await worktree()
    const sid = "session-general"
    const run = createRunState({ verify_cmd: "true" })
    run.characterized = true
    await writeRun(directory, sid, run)
    const plugin = await controller(directory)
    const args = { subagent_type: "general", description: "x" }
    const output = { args }

    await plugin["tool.execute.before"]!(
      { tool: "task", sessionID: sid, callID: "call-general" },
      output,
    )

    expect(output.args).toBe(args)
  })

  test("leaves a denied pre-characterization executor task call untouched", async () => {
    const directory = await worktree()
    const sid = "session-denied"
    await writeRun(directory, sid, createRunState({ verify_cmd: "true" }))
    const plugin = await controller(directory)
    const args = { subagent_type: "executor", description: "x" }
    const output: { args: unknown; status?: "deny"; reason?: string } = { args }

    await plugin["tool.execute.before"]!(
      { tool: "task", sessionID: sid, callID: "call-denied" },
      output,
    )

    expect(output.status).toBe("deny")
    expect(output.args).toBe(args)
    expect(output.args).not.toHaveProperty("worktree")
  })
})
