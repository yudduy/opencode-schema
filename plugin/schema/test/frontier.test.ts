import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { inferCanonicalTargetPath } from "../frontier.ts"
import {
  distinctOfficialCandidateCount,
  fullCandidateDedupGate,
  modeledFrontierGatePredicate,
  rankNextExperiments,
  scoreFrontier,
  type FrontierPrediction,
} from "../mechanisms.ts"
import type {
  FrontierCandidate,
  ParsedLedgerRow,
  VerificationActual,
} from "../state.ts"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "schema-frontier-"))
  temporaryDirectories.push(directory)
  return directory
}

function candidate(
  id: string,
  contentHash: string,
  predicted?: VerificationActual,
): FrontierCandidate {
  return {
    id,
    path: `candidates/${id}.py`,
    rationale: `${id} rationale`,
    contentHash,
    artifact: `artifacts/${contentHash.replace("sha256:", "")}`,
    proposedAt: 1,
    ...(predicted ? { predicted, predictedAt: 2 } : {}),
  }
}

function prediction(
  value: FrontierCandidate,
  predicted: VerificationActual,
): FrontierPrediction {
  return {
    id: value.id,
    contentHash: value.contentHash,
    predicted,
  }
}

describe("modeled-frontier spend gate", () => {
  const worldModel = { version: 1 as const, path: "world-model.sh" }

  test("blocks full runs until the selected id came from propose", () => {
    const proposed = candidate("proposed", "sha256:proposed")
    const missing = modeledFrontierGatePredicate(
      "full",
      worldModel,
      undefined,
      [],
    )
    const unknown = modeledFrontierGatePredicate(
      "full",
      worldModel,
      "unproposed",
      [proposed],
    )

    expect(missing).toMatchObject({
      block: true,
      error: "candidate_required",
      allEvaluated: false,
    })
    expect(missing?.reason).toContain(
      "propose candidates first, then score_frontier, then spend on one of them",
    )
    expect(unknown).toMatchObject({
      block: true,
      error: "candidate_unknown",
      allEvaluated: false,
    })
    expect(unknown?.reason).toContain("did not come from propose")
    expect(
      modeledFrontierGatePredicate(
        "full",
        worldModel,
        proposed.id,
        [proposed],
      ),
    ).toBeNull()
  })

  test("is strictly opt-in and leaves the no-model path untouched", () => {
    const proposed = candidate("proposed", "sha256:proposed")

    expect(
      modeledFrontierGatePredicate(
        "full",
        null,
        undefined,
        [],
      ),
    ).toBeNull()
    expect(
      modeledFrontierGatePredicate(
        "full",
        null,
        "unproposed",
        [proposed],
      ),
    ).toBeNull()
    expect(
      modeledFrontierGatePredicate(
        "targeted",
        worldModel,
        undefined,
        [],
      ),
    ).toBeNull()
  })

  test("reuses allEvaluated to direct a spent frontier back to propose", () => {
    const proposed = candidate("spent", "sha256:spent")
    const decision = modeledFrontierGatePredicate(
      "full",
      worldModel,
      undefined,
      [proposed],
      [proposed.contentHash],
    )

    expect(decision).toMatchObject({
      block: true,
      error: "candidate_required",
      allEvaluated: true,
    })
    expect(decision?.reason).toContain("Propose new ones")
    expect(decision?.reason).toContain("score_frontier")
  })
})

describe("frontier scoring and official dedup", () => {
  test("pure scoring orders predicted outcomes without charging state", () => {
    const low = candidate("low", "sha256:low")
    const high = candidate("high", "sha256:high")
    const scored = scoreFrontier(
      [low, high],
      [
        prediction(low, { pass: false, failing: ["FAIL low"], score: 0.2 }),
        prediction(high, { pass: true, failing: [], score: 0.9 }),
      ],
      ["sha256:low"],
    )

    expect(scored.map(({ id }) => id)).toEqual(["high", "low"])
    expect(scored.map(({ evaluated }) => evaluated)).toEqual([false, true])
  })

  test("dedup keys on bytes across ids and paths, while new bytes remain legal", () => {
    expect(
      fullCandidateDedupGate(
        "sha256:same",
        ["sha256:same"],
        ["sha256:same"],
      ),
    ).toMatchObject({ block: true, allEvaluated: true })
    expect(
      fullCandidateDedupGate(
        "sha256:same",
        ["sha256:same"],
        ["sha256:same"],
      )?.reason,
    ).toContain("propose")
    expect(
      fullCandidateDedupGate(
        "sha256:new",
        ["sha256:same"],
        ["sha256:same", "sha256:new"],
      ),
    ).toBeNull()
  })

  test("ledger exposes the cumulative distinct official candidate metric", () => {
    const ledger = [
      {
        ts: 1,
        step: 1,
        scope: "characterize",
        actual: { pass: true, failing: [] },
        cost: 0,
      },
      {
        ts: 2,
        step: 2,
        scope: "full",
        contentHash: "sha256:a",
        actual: { pass: true, failing: [] },
        cost: 1,
      },
      {
        ts: 3,
        step: 3,
        scope: "full",
        contentHash: "sha256:a",
        actual: { pass: true, failing: [] },
        cost: 1,
      },
      {
        ts: 4,
        step: 4,
        scope: "full",
        contentHash: "sha256:b",
        actual: { pass: true, failing: [] },
        cost: 1,
      },
    ] as ParsedLedgerRow[]

    expect(distinctOfficialCandidateCount(ledger)).toBe(2)
  })
})

describe("informative experiment ranking", () => {
  test("boundary candidates rank above a confidently predicted candidate", () => {
    const confident = candidate("confident", "sha256:confident", {
      pass: true,
      failing: [],
      score: 0.99,
    })
    const boundaryPass = candidate("boundary-pass", "sha256:boundary-pass", {
      pass: true,
      failing: [],
      score: 0.51,
    })
    const boundaryFail = candidate("boundary-fail", "sha256:boundary-fail", {
      pass: false,
      failing: ["FAIL boundary"],
      score: 0.49,
    })
    const scored = scoreFrontier(
      [confident, boundaryPass, boundaryFail],
      [confident, boundaryPass, boundaryFail].map((value) =>
        prediction(value, value.predicted!),
      ),
    )
    const ranked = rankNextExperiments(scored)

    expect(ranked[0].id).not.toBe("confident")
    expect(ranked.findIndex(({ id }) => id === "confident")).toBeGreaterThan(0)
    expect(ranked[0].reason).toContain("boundary")
  })

  test("categorical disagreement works without scores and ties are stable", () => {
    const alpha = candidate("alpha", "sha256:alpha", {
      pass: true,
      failing: [],
    })
    const beta = candidate("beta", "sha256:beta", {
      pass: true,
      failing: [],
    })
    const outlier = candidate("outlier", "sha256:outlier", {
      pass: false,
      failing: ["FAIL novel"],
    })
    const candidates = [beta, outlier, alpha]
    const scored = scoreFrontier(
      candidates,
      candidates.map((value) => prediction(value, value.predicted!)),
    )

    expect(rankNextExperiments(scored)[0].id).toBe("outlier")
    expect(
      rankNextExperiments(
        scoreFrontier(
          [beta, alpha],
          [beta, alpha].map((value) => prediction(value, value.predicted!)),
        ),
      ).map(({ id }) => id),
    ).toEqual(["alpha", "beta"])
  })

  test("empty and fully evaluated frontiers return an advisory empty ranking", () => {
    expect(rankNextExperiments([])).toEqual([])
    const only = candidate("only", "sha256:only", {
      pass: true,
      failing: [],
    })
    const scored = scoreFrontier(
      [only],
      [prediction(only, only.predicted!)],
      [only.contentHash],
    )
    expect(rankNextExperiments(scored, [only.contentHash])).toEqual([])
  })
})

describe("canonical verifier target inference", () => {
  test("infers one explicit worktree-rooted target through a wrapper", async () => {
    const directory = await temporaryDirectory()
    await writeFile(path.join(directory, "program.py"), "print('base')\n")
    await writeFile(path.join(directory, "results.json"), "{}\n")
    await writeFile(
      path.join(directory, "verify.sh"),
      [
        "#!/bin/sh",
        'WORKSPACE="$PWD"',
        'python "$WORKSPACE/program.py"',
        "",
      ].join("\n"),
    )

    await expect(
      inferCanonicalTargetPath(
        directory,
        {
          verify_cmd: "./verify.sh",
          score_cmd: 'cat "$PWD/results.json"',
        },
        {},
      ),
    ).resolves.toMatchObject({ relativePath: "program.py" })
  })

  test("fails loudly instead of guessing when inference is empty or ambiguous", async () => {
    const directory = await temporaryDirectory()
    await writeFile(path.join(directory, "a.py"), "print('a')\n")
    await writeFile(path.join(directory, "b.py"), "print('b')\n")
    await writeFile(path.join(directory, "empty.sh"), "#!/bin/sh\ntrue\n")
    await writeFile(
      path.join(directory, "ambiguous.sh"),
      '#!/bin/sh\npython "$PWD/a.py" "$PWD/b.py"\n',
    )

    await expect(
      inferCanonicalTargetPath(directory, { verify_cmd: "./empty.sh" }, {}),
    ).rejects.toThrow("found none")
    await expect(
      inferCanonicalTargetPath(
        directory,
        { verify_cmd: "./ambiguous.sh" },
        {},
      ),
    ).rejects.toThrow("a.py, b.py")
  })

  test("rejects a symlink target", async () => {
    const directory = await temporaryDirectory()
    const outside = await temporaryDirectory()
    await writeFile(path.join(outside, "program.py"), "print('outside')\n")
    await symlink(
      path.join(outside, "program.py"),
      path.join(directory, "program.py"),
    )
    await writeFile(
      path.join(directory, "verify.sh"),
      '#!/bin/sh\npython "$PWD/program.py"\n',
    )

    await expect(
      inferCanonicalTargetPath(directory, { verify_cmd: "./verify.sh" }, {}),
    ).rejects.toThrow("symlink")
  })
})
