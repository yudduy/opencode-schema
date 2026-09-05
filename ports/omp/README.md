# Schema Harness for OMP

A self-contained [oh-my-pi](https://github.com/can1357/oh-my-pi) extension with three
problem-agnostic mechanisms:

- a charged, scored baseline of the unmodified task before mutation tools are allowed;
- typed predictions whose assertions are evaluated against the next scored result;
- an executable world model that must replay every recorded verification before it earns
  another full evaluation.

OMP's TTSR and advisor already cover course correction and review, so this extension
stays focused on measurement and prediction.

## Load

Install the development dependencies once:

```sh
cd ports/omp
bun install
```

Load the directory explicitly:

```sh
omp --extension /absolute/path/to/opencode-schema/ports/omp
```

The package manifest points OMP at `index.ts`. The five extension tools are marked
essential so they remain reachable while the pre-baseline mutation gate blocks
`write`.

## Use

1. Register the task and total official-evaluation budget:

   ```text
   register_task({verify_cmd:"./verify.sh", score_cmd:"./score.sh", budget:4})
   ```

2. To opt in, declare the world model before the first verification. Empty replay is
   green (`0/0`), so this cannot deadlock the baseline:

   ```text
   set_world_model({path:"world-model.py"})
   replay_verify({})
   ```

3. Bank the unmodified task:

   ```text
   run_verify({scope:"baseline"})
   ```

   Baseline is a real evaluation: it runs both declared commands and consumes one
   budget unit. It is the sole prediction-free verification and may run only once.

4. If opted in, replay the now-recorded baseline:

   ```text
   replay_verify({})
   ```

5. Before each later scored run, record at least one typed claim:

   ```text
   predict({
     hypothesis:"The change improves the score",
     assertions:[{metric:"score", op:">=", value:0.8}]
   })
   run_verify({scope:"full"})
   ```

When a world model is declared, `run_verify({scope:"full"})` recomputes replay before
spending. Red replay denies the run without changing the budget. Correct the executable
and call `replay_verify()` again; editing the model and replaying are always legal after
the baseline. `set_world_model` refuses a late opt-in when existing verification rows
lack snapshots, before persisting anything: continue that session without a model or
start a new session and declare before baseline. Ordinary sessions that never opt in
take no snapshots and retain the original verification path.

`score_cmd` is optional. When omitted, `score` is absent, so score assertions are
unfalsified rather than false. `pass` comes from the `verify_cmd` exit status;
failure lines are extracted from `FAIL`, `✗`, and `not ok` output. The final numeric
value following `score` in `score_cmd` output is recorded.

## World-model contract

`set_world_model({path})` accepts a path relative to the working tree. The target must
be one self-contained, regular, non-symlink file with its executable bit set. A shebang
makes any language whose runtime is installed on the sandbox's system path usable; live
sidecar modules in the working tree are deliberately unavailable. The extension invokes
the model directly as a command with exactly one argument:

```text
world-model.py <candidate-snapshot-directory>
```

The candidate directory is a recorded filesystem snapshot captured immediately before
the corresponding real verification after world-model opt-in. Regular files and modes
are copied (using copy-on-write clones where the filesystem supports them); in-tree
symlinks are pinned inside the snapshot, while dangling, cyclic, control-state, and
external symlinks are rejected. It contains the working tree except the root `.git` and
`.schema` control directories. The model must use that argument rather than the mutable
live tree so the same historical candidate can be replayed later.

Stdout must contain exactly one JSON object and no extra fields:

```json
{"pass":true,"failing":[],"score":0.85}
```

`pass` is boolean, `failing` is an ordered array of strings, and optional `score` is a
finite number. Stderr may contain diagnostics. A nonzero exit, timeout, or malformed
stdout is a replay failure and prevents a current prediction from spending budget.

The executable runs with a clean environment inside an offline, read-only OS sandbox:
macOS uses `/usr/bin/sandbox-exec`; Linux requires `/usr/bin/bwrap`. Declaration probes
the sandbox and fails closed when it cannot start. Network, host IPC, persistent writes,
the user's home directory, the mutable working tree, and the live `.schema` ledger are
unavailable. The read-only view contains only system runtime files, the current model
executable, and the selected candidate. The model's contract is therefore pure and
offline: derive stdout only from the candidate and do not launch either registered
command. Declaration and every later execution reject obvious direct textual invocation
of `verify_cmd` or `score_cmd`. That source check catches accidental or direct
delegation; it is deliberately not presented as proof against an adversarial obfuscated
binary.

Replay compares the complete normalized observation exactly: `pass`, ordered `failing`
lines, and both the value and presence of `score`. Its result contains each row's
predicted value, actual value, reproduction flag, compact field diff, and the headline
`reproduced: n/m`. Empty history is green (`0/0`): every observation seen so far is
reproduced, and this gives the first verification a legal bootstrap path.

Replay is free because it runs only the model against saved candidates: it never invokes
`verify_cmd` or `score_cmd`, appends no charged ledger row, and consumes no budget.

When a model is declared, each new verification row records `candidate`, `predicted`,
and `actual`. An observation mismatch produces the existing
`kind: "assertion_failed"` surprise; a scalar typed-assertion failure is preserved in
the same annotation when both occur.

State is stored per OMP session at:

```text
<working-tree>/.schema/<session-id>/run.json
<working-tree>/.schema/<session-id>/world-model.json
<working-tree>/.schema/<session-id>/ledger.jsonl
<working-tree>/.schema/<session-id>/candidates/<snapshot-id>/
```

Gate A starts after `register_task` so a globally installed extension does not affect
unrelated OMP sessions. It blocks OMP's known local mutation paths: `edit`, `ast_edit`,
`write`, `bash`, `eval`, and `task` (plus the `python` and `notebook` compatibility
aliases). Unknown tools remain allowed because OMP's `tool_call` API does not expose a
tool's mutation/approval tier.

## Check

```sh
bun test
bun run check
```
