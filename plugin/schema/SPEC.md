# Build spec — opencode `schema` mode plugin (v1)

Implementer: this is a literal build spec. Follow it exactly; verify every opencode API against the source paths cited before using it. Do **not** edit any file under `<opencode-source>/` (the fork core) — this plugin is entirely self-contained under `~/.config/opencode/plugin/schema/`. Language: TypeScript, Bun runtime.

## What this is
The v1 (plugin + config, zero core edits) implementation of "schema mode": a physicist / executable-world-model loop for coding tasks. The agent definition and its system prompt already exist at `~/.config/opencode/agent/schema.md` — read it; it defines the discipline this plugin enforces and the tool names it calls.

## Authoritative opencode contracts (read these; do not guess signatures)
- Plugin type + Hooks interface: `<opencode-source>/packages/plugin/src/index.ts`. A plugin module `export default { server }` where `server: (input: PluginInput, options?) => Promise<Hooks>`. `PluginInput = { client, project, directory, worktree, $, serverUrl, experimental_workspace }`.
- Tool helper + ToolContext: `<opencode-source>/packages/plugin/src/tool.ts`. `tool({ description, args: zodShape, execute(args, ctx) })`; `ctx = { sessionID, messageID, agent, directory, worktree, abort, metadata, ask }`. Tool closures also capture `client`, `$`, `worktree` from `PluginInput`.
- Example built-in plugins to mirror idiom: `<opencode-source>/packages/opencode/src/plugin/*.ts`.
- SDK client shape (for the controller): the `client` is `createOpencodeClient` from `@opencode-ai/sdk`. Use `client.session.get(...)` and `client.session.promptAsync(...)` (verify exact method names + arg shape in the generated SDK, `packages/sdk/.../sdk.gen.ts`, POST `/session/{id}/message`, body includes `{ agent, parts, ... }`). `event` payloads are the `Event` union; `session.idle` is `SessionStatus.Event.Idle` — match on `event.type === "session.idle"` and read `event.properties.sessionID`.

## Files to produce (all under `~/.config/opencode/plugin/schema/`)
- `package.json` — name `@local/opencode-schema`, `type: "module"`, dependency `zod`, peer/dev `@opencode-ai/plugin`. Bun resolves it.
- `index.ts` — default export `{ server }`; wires the four tools + three hooks below.
- `state.ts` — the schema-run state + ledger helpers (file-backed; see below).
- `verify.ts` — runs a benchmark command via `$` in the worktree, parses a result.
- `README.md` — one paragraph + how it's registered.
- `test/` — Bun tests (`bun test`) for state, verify-parse, the gate predicate, and the controller verdict function (pure-function tested; see Acceptance).

## Durable state (file-backed for v1; v2 moves this to the native `Storage` service)
Per session, under `<worktree>/.schema/<sessionID>/`:
- `run.json`: `{ status: "active"|"solved"|"stalled"|"budget_limited", benchmark: { verify_cmd, targeted_cmd?, score_cmd? } | null, characterized: boolean, verifyActionsUsed: number, verifyActionBudget: number (default 12), lastPrediction: {hypothesis, predicted_pass_set, ts} | null, stallCount: number, inflight: boolean }`
- `ledger.jsonl`: append-only rows `{ ts, step, scope, prediction?: object, actual: { pass: boolean, failing: string[], score?: number }, cost: number }`
Agent-authored artifacts (`world_model.md`, `ad_hoc_inventory.md`, `notes.md`) live in the worktree root; the plugin only *reads* them if needed. `record_ad_hoc` appends to `<worktree>/ad_hoc_inventory.md`.
Add `.schema/` to a local gitignore note in the README (don't mutate the target repo's tracked files).

## Tools (names + signatures must match `agent/schema.md`)
1. `register_benchmark({ verify_cmd: string, targeted_cmd?: string, score_cmd?: string, notes?: string })` — write `benchmark` into `run.json`, set `status:"active"`. Idempotent. Return a short confirmation.
2. `run_verify({ scope: "characterize"|"targeted"|"full" })`:
   - resolve command: characterize/full → `verify_cmd`; targeted → `targeted_cmd ?? verify_cmd`.
   - run it via `$` in `worktree` (capture exit code + stdout/stderr; timeout ~600s).
   - parse `{ pass, failing[], score? }` in `verify.ts` (generic: pass = exit 0; failing = best-effort lines matching `FAIL`/`✗`/`not ok`; score = last number after `score`/`SCORE` if `score_cmd` used). Keep parsing pluggable and dumb; do not over-fit.
   - `characterize`: set `characterized:true`.
   - `full`: **require** `run.json.lastPrediction != null`, else return an error telling the model to call `predict` first; increment `verifyActionsUsed`; if `>= verifyActionBudget`, set `status:"budget_limited"` in the returned metadata.
   - append a ledger row (include `prediction: lastPrediction` on `full`); return `{ pass, failing, score?, verifyActionsUsed, budget }`.
3. `predict({ hypothesis: string, predicted_pass_set: string[], predicted_side_effects?: string })` — set `run.json.lastPrediction`, append a ledger row `{scope:"predict", prediction}`. Return confirmation.
4. `record_ad_hoc({ special_case: string, anomaly: string, lines_added?: number, checks_greened?: number })` — append a formatted row to `<worktree>/ad_hoc_inventory.md` (create with a header if missing).

## Hooks
A. `tool.execute.before(input:{tool,sessionID,callID}, output)` — the **hard gate**. If `<worktree>/.schema/<sessionID>/run.json` exists (⇒ a schema session that has registered a benchmark) AND `run.json.characterized !== true` AND `input.tool` ∈ {`edit`,`write`,`patch`,`bash`,`shell`} → set `output.status = "deny"`, `output.reason = "Characterize first: run run_verify({scope:'characterize'}) to capture a green baseline before editing (theory before edits)."`. Otherwise no-op. (Do not touch non-schema sessions: if `run.json` is absent, return immediately.)
B. `event(input:{event})` — the **outer controller**. On `event.type === "session.idle"`: let `sid = event.properties.sessionID`. If no `run.json` for `sid`, or `status !== "active"`, or `inflight`, return. Set `inflight:true`. Then compute a verdict from the ledger tail via a **pure exported function** `decideVerdict(run, ledgerTail): {action: "solved"|"surprise"|"stall"|"budget"|"continue", prompt?: string}`:
   - last `full` row `pass:true` ⇒ `solved` (set status solved, do NOT resume).
   - `verifyActionsUsed >= verifyActionBudget` ⇒ `budget` (set status budget_limited, resume once with a budget-limit note, then stop).
   - a `full`/`targeted` row whose `actual` contradicts its recorded `prediction` (a predicted-pass check is failing) ⇒ `surprise` (resume with the repair prompt).
   - N (=3) consecutive idles with no new ledger rows ⇒ `stall` (resume with the refactor prompt; increment stallCount).
   - else ⇒ `continue` (resume with the continuation prompt).
   For any resuming action, call `client.session.promptAsync({ path:{ id: sid }, body:{ agent:"schema", parts:[{ type:"text", text: <prompt> }] } })` (verify exact SDK shape). Clear `inflight` in a `finally`. Swallow errors (log to console, never throw out of the hook). Prompts are short strings defined in `index.ts` (repair / refactor / continuation / budget) — mirror the tone of `agent/schema.md`.
C. `experimental.chat.system.transform(input:{sessionID?,model}, output:{system:string[]})` — if `sessionID` has a `run.json`, push one terse reminder string onto `output.system`: `"<schema_reminder>Predict before you verify. Run the cheapest discriminating check first. Stop and repair the model on any surprise. Never spend a full run on a red prediction.</schema_reminder>"`.

## Constraints
- Zero edits to the opencode fork. Everything self-contained here.
- All fs writes confined to `<worktree>/.schema/` and `<worktree>/ad_hoc_inventory.md`. Use `$`/Bun fs.
- Every hook must be defensive: wrap bodies in try/catch, never throw, never block a non-schema session.
- Keep `decideVerdict`, the verify parser, and the gate predicate as **pure, exported, unit-tested functions**. The IO wrappers around them can stay thin.

## Acceptance (bun test)
1. `decideVerdict` returns the right action for: green-full, budget-exceeded, prediction-contradiction (surprise), 3-idle stall, and default continue.
2. The gate predicate denies `edit` when `characterized:false` and allows it when `characterized:true`; and is a no-op when `run.json` is absent.
3. `run_verify({scope:"full"})` errors when `lastPrediction` is null; succeeds and increments the counter when set.
4. verify parser: exit 0 ⇒ pass with empty failing; a stdout with `FAIL x`/`not ok 3` ⇒ pass:false with those entries.
Do not wire the real end-to-end coding task here (that is a separate step); prove the mechanism with unit tests over the pure functions + a temp-dir integration test of the tools using a trivial `verify_cmd` like `bash -c 'exit 0'` / `exit 1`.
