import { describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { $ } from "bun"
import type { ToolContext, ToolResult } from "@opencode-ai/plugin"
import { server } from "../index.ts"
import { readRun } from "../state.ts"

/** MAP-Elites over an agent-declared behaviour space.
 *
 * Motivation is measured, not theoretical: across three tasks the harness evaluated
 * 5.5-7 distinct programs where a plain agent evaluated 12-16, and it lost wherever
 * exploration mattered. Following a single champion is the failure mode; keeping the
 * best candidate per niche and sampling across niches is the standard fix, and it is
 * where the largest published scaffold effects come from. */

async function worktree(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "schema-archive-"))
  await $`git init -q`.cwd(directory).quiet()
  return directory
}

function context(directory: string, sessionID: string): ToolContext {
  return { sessionID, messageID: "m", agent: "schema", directory, worktree: directory } as ToolContext
}

async function hooks(directory: string) {
  return await server({ worktree: directory, directory, $ } as never)
}

function meta(result: ToolResult): Record<string, unknown> {
  return typeof result === "string" ? {} : (result.metadata ?? {})
}

async function setup(sid: string) {
  const directory = await worktree()
  const plugin = await hooks(directory)
  const ctx = context(directory, sid)
  await plugin.tool!.register_benchmark.execute(
    { verify_cmd: "echo 'score: 1.0'", score_cmd: "echo 'score: 1.0'" },
    ctx,
  )
  await plugin.tool!.run_verify.execute({ scope: "characterize" }, ctx)
  return { directory, plugin, ctx }
}

const NICHES = [
  { id: "greedy", description: "greedy construction" },
  { id: "annealing", description: "stochastic refinement" },
]

describe("archive", () => {
  test("keeps the best candidate per niche, not the best overall", async () => {
    const { directory, plugin, ctx } = await setup("s-archive-elites")
    await plugin.tool!.declare_niches.execute({ niches: NICHES }, ctx)

    await plugin.tool!.record_candidate.execute(
      { niche: "greedy", score: 0.9, summary: "strong greedy" },
      ctx,
    )
    // Globally worse, but it is the only thing in its region — exactly the candidate
    // a champion-following search discards, and the kind breakthroughs are built on.
    await plugin.tool!.record_candidate.execute(
      { niche: "annealing", score: 0.2, summary: "weak but different" },
      ctx,
    )

    const archive = (await readRun(directory, "s-archive-elites"))!.archive
    expect(Object.keys(archive).sort()).toEqual(["annealing", "greedy"])
    expect(archive.annealing.score).toBe(0.2)
  })

  test("a worse candidate does not displace its niche's elite", async () => {
    const { directory, plugin, ctx } = await setup("s-archive-keep")
    await plugin.tool!.declare_niches.execute({ niches: NICHES }, ctx)
    await plugin.tool!.record_candidate.execute({ niche: "greedy", score: 0.9, summary: "a" }, ctx)
    await plugin.tool!.record_candidate.execute({ niche: "greedy", score: 0.4, summary: "b" }, ctx)
    expect((await readRun(directory, "s-archive-keep"))!.archive.greedy.score).toBe(0.9)
  })

  test("an undeclared niche is rejected", async () => {
    const { plugin, ctx } = await setup("s-archive-unknown")
    await plugin.tool!.declare_niches.execute({ niches: NICHES }, ctx)
    const result = await plugin.tool!.record_candidate.execute(
      { niche: "invented", score: 1, summary: "x" },
      ctx,
    )
    expect(String(typeof result === "string" ? result : result.output)).toContain("not a declared niche")
  })
})

describe("diversity gate", () => {
  async function predictThen(plugin: any, ctx: ToolContext, niche?: string) {
    await plugin.tool!.predict.execute(
      { hypothesis: "h", predicted_pass_set: [], assertions: [{ metric: "pass", op: "==", value: true }] },
      ctx,
    )
    return plugin.tool!.run_verify.execute({ scope: "full", ...(niche ? { niche } : {}) }, ctx)
  }

  test("an expensive run must name its niche once a space is declared", async () => {
    const { plugin, ctx } = await setup("s-gate-required")
    await plugin.tool!.declare_niches.execute({ niches: NICHES }, ctx)
    expect(meta(await predictThen(plugin, ctx))).toMatchObject({ error: "niche_required" })
  })

  test("blocks a second consecutive spend on an explored niche while another is untried", async () => {
    const { plugin, ctx } = await setup("s-gate-blocks")
    await plugin.tool!.declare_niches.execute({ niches: NICHES }, ctx)
    await plugin.tool!.record_candidate.execute({ niche: "greedy", score: 0.9, summary: "a" }, ctx)

    await predictThen(plugin, ctx, "greedy")
    const second = await predictThen(plugin, ctx, "greedy")
    expect(meta(second)).toMatchObject({ error: "diversity_gate" })
    expect((meta(second) as any).unexplored).toContain("annealing")
  })

  test("the untried niche is always reachable — the gate redirects, never deadlocks", async () => {
    const { plugin, ctx } = await setup("s-gate-escape")
    await plugin.tool!.declare_niches.execute({ niches: NICHES }, ctx)
    await plugin.tool!.record_candidate.execute({ niche: "greedy", score: 0.9, summary: "a" }, ctx)
    await predictThen(plugin, ctx, "greedy")
    expect(meta(await predictThen(plugin, ctx, "annealing"))).not.toMatchObject({
      error: "diversity_gate",
    })
  })

  test("silent when every niche has been tried — coverage, not a quota", async () => {
    const { plugin, ctx } = await setup("s-gate-covered")
    await plugin.tool!.declare_niches.execute({ niches: NICHES }, ctx)
    await plugin.tool!.record_candidate.execute({ niche: "greedy", score: 0.9, summary: "a" }, ctx)
    await plugin.tool!.record_candidate.execute({ niche: "annealing", score: 0.3, summary: "b" }, ctx)
    await predictThen(plugin, ctx, "greedy")
    expect(meta(await predictThen(plugin, ctx, "greedy"))).not.toMatchObject({
      error: "diversity_gate",
    })
  })

  test("no declared space means no gate — the archive is opt-in", async () => {
    const { plugin, ctx } = await setup("s-gate-optin")
    expect(meta(await predictThen(plugin, ctx))).not.toMatchObject({ error: "niche_required" })
  })
})
