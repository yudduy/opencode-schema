# opencode-schema

A **schema-mode** harness for [opencode](https://opencode.ai): a primary agent that operates like a physicist of the codebase — build an executable world model, predict before verifying, and spend expensive checks only when the model predicts success — enforced by a local plugin and supervised by an event-triggered, action-grounded reviewer.

It is plugin + config only. It does **not** patch opencode core.

## What's in the box

| Piece | Role |
|---|---|
| `agent/schema.md` | **Primary agent** — physicist mode: characterize before editing, predict then verify, drive down expensive-verifications-per-solve. Fans work out to isolated executors and selects among them. |
| `agent/executor.md` | **Worker subagent** — applies exactly one specified proposal in an isolated git worktree, scores it, reports back. No initiative. |
| `agent/reviewer.md` | **Action reviewer** — a read-only subagent (structurally `edit`/`bash`/`task` denied) that judges the *action stream* against the world model and prediction discipline, and returns a short course-correction. |
| `plugin/schema/` | The enforcement plugin (TypeScript, Bun). |

## What the plugin enforces

- **Characterize-before-edit gate.** Mutating tools are denied until a baseline characterization run is recorded — you cannot edit code you have not first captured the behavior of.
- **Predict-before-spend + hard budget.** An expensive full verification requires a recorded prediction and is denied once the full-run budget is spent (both are exact channels, so they hard-gate).
- **Synchronous surprise detection.** Every verification row is annotated at write time when reality contradicts the prediction — a predicted-pass check that failed, or an unpredicted check that newly broke.
- **Action ledger.** Every mutating tool call is logged (secret-scrubbed digests) with risky-intent labels (`rm -rf`, force-push, grader edits, …).
- **Event-triggered review.** On a surprise, a failed full run, a risky intent, or a stall, the idle controller dispatches the reviewer over the action stream and prepends its course-correction to the next turn. Reviews are deduplicated, rate-limited, capped, and fail open.

Everything the harness records lands under `.schema/<sessionID>/` in the working tree: `run.json`, `ledger.jsonl`, `actions.jsonl`, `reviews.jsonl`.

## Install

Requires [opencode](https://opencode.ai) and [Bun](https://bun.sh). Python 3.11+ is not needed.

```bash
git clone https://github.com/yudduy/opencode-schema
cd opencode-schema
./install.sh          # symlinks agents + plugin into ~/.config/opencode, installs plugin deps
```

Then register the plugin in `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["./plugin/schema"]
}
```

Start a session on the `schema` agent and register your benchmark:

```
schema_register_benchmark verify_cmd="<your test/scorer command>" verify_action_budget=12
```

The agent's own system prompt (`agent/schema.md`) documents the loop it runs.

## Design

`plugin/schema/SPEC.md` is the literal build spec for the plugin; `plugin/schema/README.md` covers how it composes with opencode's own autonomy layers. Run the tests with `cd plugin/schema && bun test` (108 tests) and `bunx tsc --noEmit`.

## License

MIT — see [LICENSE](LICENSE).
