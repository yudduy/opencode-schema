import { describe, expect, test } from "bun:test"
import { CHARACTERIZE_REASON, editGatePredicate } from "../index.ts"
import { createRunState } from "../state.ts"

describe("editGatePredicate", () => {
  test("denies every built-in mutation and execution tool before characterization", () => {
    const run = createRunState()
    const gated = [
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
    ]

    for (const toolName of gated) {
      expect(editGatePredicate(run, toolName)).toEqual({
        status: "deny",
        reason: CHARACTERIZE_REASON,
      })
    }
  })

  test("allows edit after characterization", () => {
    const run = createRunState()
    run.characterized = true
    expect(editGatePredicate(run, "edit")).toBeNull()
  })

  test("is a no-op without run.json", () => {
    expect(editGatePredicate(null, "edit")).toBeNull()
  })

  test("does not gate read-only or schema tools", () => {
    const run = createRunState()
    const allowed = [
      "read",
      "grep",
      "glob",
      "ls",
      "lsp",
      "repo_overview",
      "schema_register_benchmark",
      "schema_run_verify",
      "schema_predict",
      "schema_record_ad_hoc",
    ]

    for (const toolName of allowed) {
      expect(editGatePredicate(run, toolName)).toBeNull()
    }
  })
})
