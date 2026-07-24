# Schema mode plugin

Schema mode is a local opencode server plugin that enforces characterization before edits, records predictions and verification results in a per-session ledger, limits expensive full checks, and resumes idle `schema` agents with evidence-driven guidance.

## Register

Add the npm-style local package spec to the `plugin` array in your opencode configuration:

```json
{
  "plugin": [
    "@local/opencode-schema@file:'$HOME'/.config/opencode/plugin/schema"
  ]
}
```

Keep generated session state local by adding `.schema/` to the target repository's untracked `.git/info/exclude` (or another local gitignore); the plugin does not modify tracked ignore files.

## Compatibility with the fork's autonomy layers

All state is keyed per session (`.schema/<sessionID>/`), so the controller composes with gajesh's built-ins rather than replacing them:

- **`/goal` (GoalDriver)** — while a goal is active, the goal loop owns clean-turn continuation. GoalDriver declines errored assistant turns by design, so this controller owns recoverable-error retries and policy-wall handling even with an active goal. Generic errors resume immediately after a clean stretch, then back off from 5 seconds exponentially to a 5-minute cap. Goal activity is tracked through `goal.updated` events; there is no SDK goal getter, so after a server restart the map is empty until the next goal event — worst case is one redundant, queued clean-turn continuation prompt.
- **User aborts** — `esc` produces `MessageAbortedError`; the controller treats it as a deliberate pause, leaves the run active, and never auto-resumes that idle transition. A later manual user message naturally continues the run.
- **Provider policy walls** — deterministic content-filter refusals such as OpenAI `cyber_policy` receive bounded higher-level reframe prompts; the third consecutive refusal (`POLICY_BLOCK_STOP_AT = 3`) sets terminal status `blocked` instead of hammering the filter. Reframe the work or run the schema agent on a model whose provider policy covers the authorized task.
- **Stalls and endings** — after three no-evidence idles, every later no-evidence idle sends another stall nudge instead of terminating. Run-ending states are `solved`, `budget_limited`, `blocked`, and `stalled` through the `MAX_IDLE_CYCLES = 500` lifetime runaway valve.
- **Subagents / teams / batch** — child sessions (`parentID` set) are never resumed, mirroring GoalDriver's top-level-only rule. Teammates and spawned tasks in the same worktree carry no `run.json`, so the edit gate does not apply to them; only the lead session is disciplined. Batch worktrees get independent `.schema/` state.
- **`/metaagent` (reasoning reviewer)** — fully orthogonal: it injects `<reasoning_review>` messages inside the step loop and calls no gated tools.
