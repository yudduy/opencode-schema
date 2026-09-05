import { afterEach, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { $ } from "bun"
import type {
  PluginInput,
  ToolContext,
  ToolResult,
} from "@opencode-ai/plugin"
import { server } from "../index.ts"
import { readCandidateArtifact } from "../frontier.ts"
import {
  appendLedger,
  captureCandidateSnapshot,
  isVerificationLedgerRow,
  ledgerFile,
  readLedger,
  readRun,
  readWorldModel,
  resolveCandidateSnapshot,
} from "../state.ts"
import { executeWorldModel } from "../world-model.ts"

const temporaryDirectories: string[] = []
const sandboxAvailable =
  (process.platform === "darwin" &&
    existsSync("/usr/bin/sandbox-exec")) ||
  (process.platform === "linux" && existsSync("/usr/bin/bwrap"))

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
  )
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "schema-world-model-integration-"),
  )
  temporaryDirectories.push(directory)
  return directory
}

function context(directory: string, sessionID: string): ToolContext {
  return {
    sessionID,
    messageID: "message-world-model-test",
    agent: "schema",
    directory,
    worktree: directory,
    abort: new AbortController().signal,
    metadata() {},
    async ask() {},
  }
}

function metadata(result: ToolResult): Record<string, any> {
  if (typeof result === "string") {
    throw new Error(`Expected structured tool result, received ${result}`)
  }
  return result.metadata ?? {}
}

async function hooks(
  directory: string,
  shell: PluginInput["$"] = $,
) {
  return server({
    $: shell,
    worktree: directory,
    directory,
    client: {},
  } as unknown as PluginInput)
}

async function executable(
  directory: string,
  filename: string,
  contents: string,
): Promise<void> {
  const destination = path.join(directory, filename)
  await writeFile(destination, contents, "utf8")
  await chmod(destination, 0o755)
}

const verifyScript = `#!/bin/sh
printf 'verify\\n' >> verify-marker
if [ "$(cat "$PWD/candidate.txt")" = "bad" ]; then
  printf 'FAIL candidate\\n'
  exit 1
fi
`

const wrongModel = `#!/bin/sh
printf '%s\\n' '{"pass":true,"failing":[]}'
`

const correctedModel = `#!/usr/bin/env python3
import json
import pathlib
import sys

value = (pathlib.Path(sys.argv[1]) / "candidate.txt").read_text().strip()
result = {"pass": True, "failing": []}
if value == "bad":
    result = {"pass": False, "failing": ["FAIL candidate"]}
print(json.dumps(result))
`

const novelMismatchModel = `#!/usr/bin/env python3
import json
import pathlib
import sys

value = (pathlib.Path(sys.argv[1]) / "candidate.txt").read_text().strip()
if value == "good":
    result = {"pass": True, "failing": []}
else:
    result = {"pass": False, "failing": ["FAIL candidate"]}
print(json.dumps(result))
`

const frontierVerifyScript = `#!/bin/sh
WORKSPACE="$PWD"
value=$(cat "$WORKSPACE/program.py")
printf '%s\\n' "$value" >> verify-marker
case "$value" in
  base)
    printf 'FAIL base\\n'
    exit 1
    ;;
  boundary-fail)
    printf 'FAIL boundary\\n'
    exit 1
    ;;
esac
`

const frontierScoreScript = `#!/bin/sh
WORKSPACE="$PWD"
case "$(cat "$WORKSPACE/program.py")" in
  boundary-fail) printf 'SCORE: 0.49\\n' ;;
  boundary-pass) printf 'SCORE: 0.51\\n' ;;
  confident) printf 'SCORE: 0.99\\n' ;;
  novel) printf 'SCORE: 0.80\\n' ;;
  *) printf 'SCORE: 0.10\\n' ;;
esac
`

const frontierModel = `#!/usr/bin/env python3
import json
import pathlib
import sys

value = (pathlib.Path(sys.argv[1]) / "program.py").read_text().strip()
results = {
    "base": {"pass": False, "failing": ["FAIL base"]},
    "boundary-fail": {
        "pass": False,
        "failing": ["FAIL boundary"],
        "score": 0.49,
    },
    "boundary-pass": {"pass": True, "failing": [], "score": 0.51},
    "confident": {"pass": True, "failing": [], "score": 0.99},
    "novel": {"pass": True, "failing": [], "score": 0.8},
}
result = results.get(
    value,
    {"pass": False, "failing": ["FAIL unknown"]},
)
print(json.dumps(result))
`

test.skipIf(!sandboxAvailable)(
  "a verifier infrastructure error still reports and persists the live overlay",
  async () => {
    const directory = await temporaryDirectory()
    const sessionID = "frontier-verifier-error"
    const throwingShell = (() => {
      throw new Error("verifier unavailable")
    }) as unknown as PluginInput["$"]
    const plugin = await hooks(directory, throwingShell)
    const ctx = context(directory, sessionID)
    await writeFile(path.join(directory, "program.py"), "base\n", "utf8")
    await writeFile(path.join(directory, "candidate.py"), "novel\n", "utf8")
    await writeFile(
      path.join(directory, "verify.sh"),
      '#!/bin/sh\ncat "$PWD/program.py"\n',
      "utf8",
    )
    await executable(directory, "world-model.sh", frontierModel)

    await plugin.tool!.register_benchmark.execute(
      { verify_cmd: "./verify.sh" },
      ctx,
    )
    await plugin.tool!.set_world_model.execute(
      { path: "world-model.sh" },
      ctx,
    )
    await plugin.tool!.propose.execute(
      {
        candidates: [
          {
            id: "novel",
            path: "candidate.py",
            rationale: "exercise verifier error bookkeeping",
          },
        ],
      },
      ctx,
    )

    const failed = metadata(
      await plugin.tool!.run_verify.execute(
        { scope: "full", candidate: "novel" },
        ctx,
      ),
    )
    expect(failed).toMatchObject({
      error: "verifier unavailable",
      cost: 0,
      verifyActionsUsed: 0,
      candidateId: "novel",
      liveCandidate: {
        id: "novel",
        targetPath: "program.py",
        matchesSelected: true,
      },
      previousLive: {
        preservedAt: expect.stringContaining(
          `.schema/${sessionID}/artifacts/`,
        ),
      },
    })
    expect((await readRun(directory, sessionID))?.liveCandidate).toMatchObject({
      id: "novel",
      matchesSelected: true,
    })
    expect(await readLedger(directory, sessionID)).toEqual([])
    expect(await readFile(path.join(directory, "program.py"), "utf8")).toBe(
      "novel\n",
    )
  },
)

test.skipIf(!sandboxAvailable)(
  "real tools deny unproposed bytes, then allow one proposed candidate",
  async () => {
    const directory = await temporaryDirectory()
    const sessionID = "modeled-frontier-gate"
    const plugin = await hooks(directory)
    const ctx = context(directory, sessionID)

    await writeFile(path.join(directory, "program.py"), "base\n", "utf8")
    await writeFile(
      path.join(directory, "candidate-novel.py"),
      "novel\n",
      "utf8",
    )
    await executable(directory, "verify.sh", frontierVerifyScript)
    await executable(directory, "score.sh", frontierScoreScript)
    await executable(directory, "world-model.sh", frontierModel)

    await plugin.tool!.register_benchmark.execute(
      {
        verify_cmd: "./verify.sh",
        score_cmd: "./score.sh",
        verify_action_budget: 2,
      },
      ctx,
    )
    await plugin.tool!.set_world_model.execute(
      { path: "world-model.sh" },
      ctx,
    )

    const denied = metadata(
      await plugin.tool!.run_verify.execute({ scope: "full" }, ctx),
    )
    expect(denied).toMatchObject({
      error: "candidate_required",
      allEvaluated: false,
      cost: 0,
      verifyActionsUsed: 0,
    })
    expect(denied.message).toContain(
      "propose candidates first, then score_frontier, then spend on one of them",
    )
    expect(await readLedger(directory, sessionID)).toEqual([])
    expect(existsSync(path.join(directory, "verify-marker"))).toBeFalse()

    await plugin.tool!.propose.execute(
      {
        candidates: [
          {
            id: "novel",
            path: "candidate-novel.py",
            rationale: "exercise the modeled-frontier spend gate",
          },
        ],
      },
      ctx,
    )
    expect(
      metadata(await plugin.tool!.score_frontier.execute({}, ctx)),
    ).toMatchObject({
      cost: 0,
      verifyActionsUsed: 0,
    })

    const allowed = metadata(
      await plugin.tool!.run_verify.execute(
        { scope: "full", candidate: "novel" },
        ctx,
      ),
    )
    expect(allowed).toMatchObject({
      pass: true,
      candidateId: "novel",
      verifyActionsUsed: 1,
      distinctCandidatesOfficiallyEvaluated: 1,
    })

    const exhausted = metadata(
      await plugin.tool!.run_verify.execute({ scope: "full" }, ctx),
    )
    expect(exhausted).toMatchObject({
      error: "candidate_required",
      allEvaluated: true,
      cost: 0,
      verifyActionsUsed: 1,
    })
    expect(exhausted.message).toContain("Propose new ones")
    expect(await readLedger(directory, sessionID)).toHaveLength(1)

    const rawLedger = await readFile(
      ledgerFile(directory, sessionID),
      "utf8",
    )
    console.log(
      "MODELED_FRONTIER_GATE_SEQUENCE",
      JSON.stringify({
        denied: denied.error,
        proposed: "novel",
        scoredForFree: true,
        allowed: allowed.candidateId,
        allEvaluated: exhausted.allEvaluated,
      }),
    )
    console.log("MODELED_FRONTIER_GATE_LEDGER")
    console.log(rawLedger.trim())
  },
)

test.skipIf(!sandboxAvailable)(
  "real tools propose, score, rank, overlay, dedup, and expose distinct official candidates",
  async () => {
    const directory = await temporaryDirectory()
    const sessionID = "frontier-sequence"
    const plugin = await hooks(directory)
    const ctx = context(directory, sessionID)

    await writeFile(path.join(directory, "program.py"), "base\n", "utf8")
    await writeFile(
      path.join(directory, "candidate-boundary-fail.py"),
      "boundary-fail\n",
      "utf8",
    )
    await writeFile(
      path.join(directory, "candidate-boundary-pass.py"),
      "boundary-pass\n",
      "utf8",
    )
    await writeFile(
      path.join(directory, "candidate-confident.py"),
      "confident\n",
      "utf8",
    )
    await executable(directory, "verify.sh", frontierVerifyScript)
    await executable(directory, "score.sh", frontierScoreScript)
    await executable(directory, "world-model.sh", frontierModel)

    await plugin.tool!.register_benchmark.execute(
      {
        verify_cmd: "./verify.sh",
        score_cmd: "./score.sh",
        verify_action_budget: 8,
      },
      ctx,
    )
    expect(
      metadata(
        await plugin.tool!.set_world_model.execute(
          { path: "world-model.sh" },
          ctx,
        ),
      ),
    ).toMatchObject({ declared: true })
    await plugin.tool!.run_verify.execute({ scope: "characterize" }, ctx)
    expect(
      metadata(await plugin.tool!.replay_verify.execute({}, ctx)),
    ).toMatchObject({ green: true, reproduced: "1/1", cost: 0 })

    const empty = metadata(
      await plugin.tool!.next_experiment.execute({}, ctx),
    )
    expect(empty.ranking).toEqual([])
    expect(empty.message).toContain("propose")

    const proposed = metadata(
      await plugin.tool!.propose.execute(
        {
          candidates: [
            {
              id: "boundary-fail",
              path: "candidate-boundary-fail.py",
              rationale: "probe immediately below the inferred boundary",
            },
            {
              id: "boundary-pass",
              path: "candidate-boundary-pass.py",
              rationale: "probe immediately above the inferred boundary",
            },
            {
              id: "confident",
              path: "candidate-confident.py",
              rationale: "high-score prediction the model already calls",
            },
          ],
        },
        ctx,
      ),
    )
    expect(proposed).toMatchObject({
      frontierSize: 3,
      targetPath: "program.py",
    })

    const ledgerBeforeScoring = await readFile(
      ledgerFile(directory, sessionID),
      "utf8",
    )
    const firstScoring = metadata(
      await plugin.tool!.score_frontier.execute({}, ctx),
    )
    const secondScoring = metadata(
      await plugin.tool!.score_frontier.execute({}, ctx),
    )
    expect(firstScoring).toMatchObject({
      cost: 0,
      verifyActionsUsed: 0,
      remaining: 8,
    })
    expect(secondScoring).toMatchObject({
      cost: 0,
      verifyActionsUsed: 0,
      remaining: 8,
    })
    expect(
      await readFile(ledgerFile(directory, sessionID), "utf8"),
    ).toBe(ledgerBeforeScoring)
    expect((await readRun(directory, sessionID))?.verifyActionsUsed).toBe(0)

    const next = metadata(
      await plugin.tool!.next_experiment.execute({}, ctx),
    )
    const ranking = next.ranking as { id: string; reason: string }[]
    expect(ranking).toHaveLength(3)
    expect(ranking[0].id).not.toBe("confident")
    expect(ranking[0].reason).toMatch(/boundary|disagreement/)

    const firstCandidate = ranking[0].id
    const firstSpend = metadata(
      await plugin.tool!.run_verify.execute(
        { scope: "full", candidate: firstCandidate },
        ctx,
      ),
    )
    const preserved = firstSpend.previousLive as {
      contentHash: string
      artifact: string
      preservedAt: string
    }
    expect(firstSpend).toMatchObject({
      candidateId: firstCandidate,
      verifyActionsUsed: 1,
      distinctCandidatesOfficiallyEvaluated: 1,
      liveCandidate: {
        id: firstCandidate,
        targetPath: "program.py",
        matchesSelected: true,
      },
    })
    expect(preserved.contentHash).toMatch(/^sha256:/)
    expect(preserved.artifact).toMatch(/^artifacts\//)
    expect(preserved.preservedAt).toBe(
      `.schema/${sessionID}/${preserved.artifact}`,
    )
    const selected = (proposed.proposed as {
      id: string
      path: string
      contentHash: string
    }[]).find(({ id }) => id === firstCandidate)!
    expect(await readFile(path.join(directory, "program.py"), "utf8")).toBe(
      await readFile(path.join(directory, selected.path), "utf8"),
    )
    expect(
      (
        await readCandidateArtifact(
          directory,
          sessionID,
          preserved.artifact,
          preserved.contentHash,
        )
      ).toString(),
    ).toBe("base\n")

    const duplicatePath = path.join(directory, "candidate-duplicate.py")
    await writeFile(
      duplicatePath,
      await readFile(path.join(directory, selected.path)),
    )
    const duplicateProposal = metadata(
      await plugin.tool!.propose.execute(
        {
          candidates: [
            {
              id: "same-bytes-alias",
              path: "candidate-duplicate.py",
              rationale: "different id and path, identical bytes",
            },
          ],
        },
        ctx,
      ),
    )
    expect(
      (duplicateProposal.proposed as { contentHash: string }[])[0]
        .contentHash,
    ).toBe(firstSpend.contentHash)

    const ledgerBeforeDuplicate = await readFile(
      ledgerFile(directory, sessionID),
      "utf8",
    )
    const markerBeforeDuplicate = await readFile(
      path.join(directory, "verify-marker"),
      "utf8",
    )
    const liveBeforeDuplicate = await readFile(
      path.join(directory, "program.py"),
      "utf8",
    )
    const duplicate = metadata(
      await plugin.tool!.run_verify.execute(
        { scope: "full", candidate: "same-bytes-alias" },
        ctx,
      ),
    )
    expect(duplicate).toMatchObject({
      error: "candidate_already_evaluated",
      contentHash: firstSpend.contentHash,
      cost: 0,
      verifyActionsUsed: 1,
      distinctCandidatesOfficiallyEvaluated: 1,
    })
    expect(
      await readFile(ledgerFile(directory, sessionID), "utf8"),
    ).toBe(ledgerBeforeDuplicate)
    expect(
      await readFile(path.join(directory, "verify-marker"), "utf8"),
    ).toBe(markerBeforeDuplicate)
    expect(await readFile(path.join(directory, "program.py"), "utf8")).toBe(
      liveBeforeDuplicate,
    )

    await writeFile(
      path.join(directory, "candidate-novel.py"),
      "novel\n",
      "utf8",
    )
    await plugin.tool!.propose.execute(
      {
        candidates: [
          {
            id: "novel",
            path: "candidate-novel.py",
            rationale: "new byte sequence after the duplicate was filtered",
          },
        ],
      },
      ctx,
    )
    const novel = metadata(
      await plugin.tool!.run_verify.execute(
        { scope: "full", candidate: "novel" },
        ctx,
      ),
    )
    expect(novel).toMatchObject({
      candidateId: "novel",
      contentHash: expect.stringMatching(/^sha256:/),
      verifyActionsUsed: 2,
      distinctCandidatesOfficiallyEvaluated: 2,
      liveCandidate: {
        id: "novel",
        matchesSelected: true,
      },
    })
    expect(
      metadata(await plugin.tool!.replay_verify.execute({}, ctx)),
    ).toMatchObject({
      reproduced: "3/3",
      green: true,
      cost: 0,
      verifyActionsUsed: 2,
    })

    const rawLedger = await readFile(
      ledgerFile(directory, sessionID),
      "utf8",
    )
    const official = (await readLedger(directory, sessionID)).filter(
      (row) => row.scope === "full",
    )
    expect(official).toHaveLength(2)
    expect(official[0]).toMatchObject({
      candidateId: firstCandidate,
      contentHash: firstSpend.contentHash,
      targetPath: "program.py",
      distinctCandidatesOfficiallyEvaluated: 1,
      cost: 1,
    })
    expect(official[1]).toMatchObject({
      candidateId: "novel",
      targetPath: "program.py",
      distinctCandidatesOfficiallyEvaluated: 2,
      cost: 1,
    })
    console.log(
      "FRONTIER_INTEGRATION_SEQUENCE",
      JSON.stringify({
        proposed: 3,
        freeScores: 2,
        rankedFirst: firstCandidate,
        firstSpend: firstSpend.verifyActionsUsed,
        duplicateDenied: duplicate.error,
        newCandidateAllowed: novel.candidateId,
        distinctCandidatesOfficiallyEvaluated:
          novel.distinctCandidatesOfficiallyEvaluated,
      }),
    )
    console.log("FRONTIER_INTEGRATION_LEDGER")
    console.log(rawLedger.trim())
  },
)

test.skipIf(!sandboxAvailable)(
  "real tools gate red replay, allow corrected replay, and record observation surprise",
  async () => {
    const directory = await temporaryDirectory()
    const sessionID = "world-model-sequence"
    const plugin = await hooks(directory)
    const ctx = context(directory, sessionID)

    await writeFile(path.join(directory, "candidate.txt"), "bad\n", "utf8")
    await executable(directory, "verify.sh", verifyScript)
    await executable(directory, "world-model.sh", wrongModel)

    await plugin.tool!.register_benchmark.execute(
      {
        verify_cmd: "./verify.sh",
        verify_action_budget: 4,
      },
      ctx,
    )
    expect(
      metadata(
        await plugin.tool!.set_world_model.execute(
          { path: "world-model.sh" },
          ctx,
        ),
      ),
    ).toMatchObject({ declared: true, historyRows: 0 })

    const emptyReplay = metadata(
      await plugin.tool!.replay_verify.execute({}, ctx),
    )
    expect(emptyReplay).toMatchObject({
      reproduced: "0/0",
      green: true,
      cost: 0,
      verifyActionsUsed: 0,
    })

    await plugin.tool!.run_verify.execute(
      { scope: "characterize" },
      ctx,
    )
    const ledgerAfterCharacterize = await readFile(
      ledgerFile(directory, sessionID),
      "utf8",
    )
    const runAfterCharacterize = await readRun(directory, sessionID)
    expect(runAfterCharacterize?.verifyActionsUsed).toBe(0)

    const redReplay = metadata(
      await plugin.tool!.replay_verify.execute({}, ctx),
    )
    expect(redReplay).toMatchObject({
      reproduced: "0/1",
      green: false,
      cost: 0,
      verifyActionsUsed: 0,
    })
    expect(
      metadata(await plugin.tool!.replay_verify.execute({}, ctx)),
    ).toMatchObject({ reproduced: "0/1", cost: 0 })
    expect(
      await readFile(ledgerFile(directory, sessionID), "utf8"),
    ).toBe(ledgerAfterCharacterize)
    expect((await readRun(directory, sessionID))?.verifyActionsUsed).toBe(
      0,
    )

    await writeFile(
      path.join(directory, "candidate.txt"),
      "good\n",
      "utf8",
    )
    await plugin.tool!.propose.execute(
      {
        candidates: [
          {
            id: "good",
            path: "candidate.txt",
            rationale: "candidate used to exercise replay recovery",
          },
        ],
      },
      ctx,
    )
    await plugin.tool!.predict.execute(
      {
        hypothesis: "the current candidate passes",
        predicted_pass_set: [],
        assertions: [
          { metric: "pass", op: "==", value: true },
        ],
      },
      ctx,
    )
    const beforeDenied = await readFile(
      ledgerFile(directory, sessionID),
      "utf8",
    )
    const markerBeforeDenied = await readFile(
      path.join(directory, "verify-marker"),
      "utf8",
    )
    const denied = metadata(
      await plugin.tool!.run_verify.execute(
        { scope: "full", candidate: "good" },
        ctx,
      ),
    )
    expect(denied).toMatchObject({
      error: "world_model_replay_red",
      reproduced: "0/1",
      cost: 0,
      verifyActionsUsed: 0,
    })
    expect(
      await readFile(ledgerFile(directory, sessionID), "utf8"),
    ).toBe(beforeDenied)
    expect(
      await readFile(path.join(directory, "verify-marker"), "utf8"),
    ).toBe(markerBeforeDenied)
    expect(
      (await readRun(directory, sessionID))?.lastPrediction,
    ).not.toBeNull()

    await executable(directory, "world-model.sh", correctedModel)
    const greenReplay = metadata(
      await plugin.tool!.replay_verify.execute({}, ctx),
    )
    expect(greenReplay).toMatchObject({
      reproduced: "1/1",
      green: true,
      cost: 0,
      verifyActionsUsed: 0,
    })

    const allowed = metadata(
      await plugin.tool!.run_verify.execute(
        { scope: "full", candidate: "good" },
        ctx,
      ),
    )
    expect(allowed).toMatchObject({
      pass: true,
      predicted: { pass: true, failing: [] },
      verifyActionsUsed: 1,
    })

    await writeFile(
      path.join(directory, "candidate.txt"),
      "novel\n",
      "utf8",
    )
    await executable(
      directory,
      "world-model.sh",
      novelMismatchModel,
    )
    await plugin.tool!.propose.execute(
      {
        candidates: [
          {
            id: "novel",
            path: "candidate.txt",
            rationale: "candidate used to exercise observation surprise",
          },
        ],
      },
      ctx,
    )
    expect(
      metadata(await plugin.tool!.replay_verify.execute({}, ctx)),
    ).toMatchObject({ reproduced: "2/2", green: true, cost: 0 })
    await plugin.tool!.predict.execute(
      {
        hypothesis: "the novel candidate passes",
        predicted_pass_set: [],
        assertions: [
          { metric: "pass", op: "==", value: true },
        ],
      },
      ctx,
    )
    const mismatch = metadata(
      await plugin.tool!.run_verify.execute(
        { scope: "full", candidate: "novel" },
        ctx,
      ),
    )
    expect(mismatch).toMatchObject({
      pass: true,
      predicted: {
        pass: false,
        failing: ["FAIL candidate"],
      },
      surprise: { kind: "assertion_failed" },
      verifyActionsUsed: 2,
    })
    expect(mismatch.surprise.detail).toContain(
      "World model predicted pass false, observed true",
    )

    const ledger = await readLedger(directory, sessionID)
    expect(ledger.map((row) => row.scope)).toEqual([
      "characterize",
      "predict",
      "full",
      "predict",
      "full",
    ])
    const verificationRows = ledger.filter(isVerificationLedgerRow)
    expect(verificationRows).toHaveLength(3)
    expect(verificationRows[0]).toMatchObject({
      scope: "characterize",
      candidate: expect.any(String),
      predicted: { pass: true, failing: [] },
      actual: { pass: false, failing: ["FAIL candidate"] },
      cost: 0,
      surprise: { kind: "assertion_failed" },
    })
    expect(verificationRows[1]).toMatchObject({
      scope: "full",
      candidate: expect.any(String),
      predicted: { pass: true, failing: [] },
      actual: { pass: true, failing: [] },
      cost: 1,
    })
    expect(verificationRows[2]).toMatchObject({
      scope: "full",
      candidate: expect.any(String),
      predicted: { pass: false, failing: ["FAIL candidate"] },
      actual: { pass: true, failing: [] },
      cost: 1,
      surprise: { kind: "assertion_failed" },
    })

    const rawLedger = await readFile(
      ledgerFile(directory, sessionID),
      "utf8",
    )
    console.log(
      "WORLD_MODEL_SEQUENCE",
      JSON.stringify({
        wrongReplay: redReplay.reproduced,
        denied: denied.error,
        correctedReplay: greenReplay.reproduced,
        allowed: allowed.pass,
      }),
    )
    console.log("WORLD_MODEL_INTEGRATION_LEDGER")
    console.log(rawLedger.trim())
  },
)

test.skipIf(!sandboxAvailable)(
  "the real sandbox exposes snapshots but hides live, outside, and writable state",
  async () => {
    const directory = await temporaryDirectory()
    const outside = await temporaryDirectory()
    const liveAnswer = path.join(directory, "answer.txt")
    const outsideSecret = path.join(outside, "secret.txt")
    await writeFile(liveAnswer, "snapshot\n", "utf8")
    await writeFile(outsideSecret, "outside\n", "utf8")

    const model = `#!/usr/bin/env python3
import json
import pathlib
import sys

def hidden(filename):
    try:
        pathlib.Path(filename).read_bytes()
        return False
    except OSError:
        return True

candidate = pathlib.Path(sys.argv[1])
snapshot = (candidate / "answer.txt").read_text().strip()
live_hidden = hidden(${JSON.stringify(liveAnswer)})
outside_hidden = hidden(${JSON.stringify(outsideSecret)})
try:
    (candidate / "model-write").write_text("write")
    write_blocked = False
except OSError:
    write_blocked = True
passed = (
    snapshot == "snapshot"
    and live_hidden
    and outside_hidden
    and write_blocked
)
result = {"pass": passed, "failing": []}
if not passed:
    result["failing"] = ["FAIL sandbox boundary"]
print(json.dumps(result))
`
    await executable(directory, "world-model.sh", model)
    const reference = await captureCandidateSnapshot(
      directory,
      "sandbox-boundary",
    )
    const candidate = await resolveCandidateSnapshot(
      directory,
      "sandbox-boundary",
      reference,
    )
    await writeFile(liveAnswer, "live\n", "utf8")

    expect(
      await executeWorldModel(
        directory,
        { version: 1, path: "world-model.sh" },
        ["./verify.sh"],
        candidate,
      ),
    ).toEqual({ pass: true, failing: [] })
  },
)

test.skipIf(!sandboxAvailable)(
  "register, characterize, then set_world_model succeeds over saved history",
  async () => {
    const directory = await temporaryDirectory()
    const sessionID = "world-model-late-opt-in"
    const plugin = await hooks(directory)
    const ctx = context(directory, sessionID)
    await executable(directory, "verify.sh", verifyScript)
    await executable(directory, "world-model.sh", correctedModel)
    await writeFile(path.join(directory, "candidate.txt"), "good\n", "utf8")

    await plugin.tool!.register_benchmark.execute(
      { verify_cmd: "./verify.sh" },
      ctx,
    )
    await plugin.tool!.run_verify.execute({ scope: "characterize" }, ctx)

    const [characterization] = (await readLedger(
      directory,
      sessionID,
    )).filter(isVerificationLedgerRow)
    const candidate = characterization?.candidate
    if (!candidate) {
      throw new Error("Characterization did not retain a candidate snapshot")
    }
    expect(
      await readFile(
        path.join(
          await resolveCandidateSnapshot(
            directory,
            sessionID,
            candidate,
          ),
          "candidate.txt",
        ),
        "utf8",
      ),
    ).toBe("good\n")

    expect(
      metadata(
        await plugin.tool!.set_world_model.execute(
          { path: "world-model.sh" },
          ctx,
        ),
      ),
    ).toMatchObject({ declared: true, historyRows: 1 })
    expect(await readWorldModel(directory, sessionID)).toEqual({
      version: 1,
      path: "world-model.sh",
    })
    expect(
      metadata(await plugin.tool!.replay_verify.execute({}, ctx)),
    ).toMatchObject({ reproduced: "1/1", green: true })
  },
)

test("set_world_model surfaces the legacy snapshot guard reason", async () => {
  const directory = await temporaryDirectory()
  const sessionID = "world-model-legacy-row"
  const plugin = await hooks(directory)
  const ctx = context(directory, sessionID)
  await plugin.tool!.register_benchmark.execute(
    { verify_cmd: "./verify.sh" },
    ctx,
  )
  await appendLedger(directory, sessionID, {
    ts: Date.now(),
    scope: "characterize",
    actual: { pass: true, failing: [] },
    cost: 0,
  })

  const result = await plugin.tool!.set_world_model.execute(
    { path: "world-model.sh" },
    ctx,
  )
  if (typeof result === "string") {
    throw new Error(`Expected structured tool result, received ${result}`)
  }
  const reason =
    "Cannot declare a world model: 1 existing verification row(s) lack candidate snapshots. " +
    "These legacy rows cannot be replayed. Continue this session without a world model, or start a new opencode session."
  expect(result.title).toBe(`Schema tool error: ${reason}`)
  expect(result.output).toBe(reason)
  expect(result.metadata?.error).toBe(reason)
  expect(await readWorldModel(directory, sessionID)).toBeNull()
})

test("set_world_model rejects delegation to every registered verifier command", async () => {
  const directory = await temporaryDirectory()
  const sessionID = "world-model-delegation"
  const plugin = await hooks(directory)
  const ctx = context(directory, sessionID)
  await executable(
    directory,
    "world-model.sh",
    "#!/bin/sh\nexec ./targeted.sh\n",
  )

  await plugin.tool!.register_benchmark.execute(
    {
      verify_cmd: "./verify.sh",
      targeted_cmd: "./targeted.sh",
      score_cmd: "./score.sh",
    },
    ctx,
  )
  const result = metadata(
    await plugin.tool!.set_world_model.execute(
      { path: "world-model.sh" },
      ctx,
    ),
  )

  expect(result.error).toContain(
    "directly references a registered verification command",
  )
  expect(await readWorldModel(directory, sessionID)).toBeNull()
})

// A full run charged the metered scorer twice whenever score_cmd named the same
// command as verify_cmd — the common case, since a verify.sh that already prints
// the score has nothing else to name. The ledger recorded one full run while the
// meter recorded two, so the arm ran at half its budget: 8 distinct candidates out
// of K=16. Five experiments reported that as "the harness explores less."
async function countScorerCalls(
  sessionID: string,
  scoreCmd: string,
  extraScript?: string,
): Promise<number> {
  const directory = await temporaryDirectory()
  const ctx = context(directory, sessionID)
  const plugin = await hooks(directory, $)
  const counter = path.join(directory, "invocations")
  await writeFile(path.join(directory, "program.py"), "base\n", "utf8")
  await executable(
    directory,
    "verify.sh",
    `#!/bin/sh\necho v >> ${JSON.stringify(counter)}\necho "score: 1.0"\n`,
  )
  if (extraScript) await executable(directory, "score.sh", extraScript)

  await plugin.tool!.register_benchmark.execute(
    { verify_cmd: "./verify.sh", score_cmd: scoreCmd },
    ctx,
  )
  await plugin.tool!.run_verify.execute({ scope: "characterize" }, ctx)
  // Change the bytes, or the duplicate gate denies the full run before any
  // scorer invocation and the count would be zero for reasons unrelated to this.
  await writeFile(path.join(directory, "program.py"), "edited\n", "utf8")
  await plugin.tool!.predict.execute(
    {
      hypothesis: "the edited program passes",
      assertions: [{ metric: "pass", op: "==", value: true }],
    },
    ctx,
  )
  const before = (await readFile(counter, "utf8")).trim().split("\n").length
  await plugin.tool!.run_verify.execute({ scope: "full" }, ctx)
  const after = (await readFile(counter, "utf8")).trim().split("\n").length
  return after - before
}

test("a full run invokes the scorer once when score_cmd repeats verify_cmd", async () => {
  expect(await countScorerCalls("charge-same", "./verify.sh")).toBe(1)
})

test("a full run still invokes a distinct score_cmd separately", async () => {
  const calls = await countScorerCalls(
    "charge-distinct",
    "./score.sh",
    `#!/bin/sh\necho s >> "$PWD/invocations"\necho "score: 1.0"\n`,
  )
  expect(calls).toBe(2)
})
