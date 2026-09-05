import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import {
  buildReplayReport,
  combineSurprises,
  compareVerificationResults,
  detectObservationSurprise,
  obviouslyInvokesVerifier,
  parseWorldModelOutput,
  worldModelGatePredicate,
} from "../mechanisms.ts"
import {
  assertWorldModelSandboxAvailable,
  macosWorldModelProfile,
  offlineWorldModelInvocation,
  runWorldModelProcess,
  WORLD_MODEL_BROKER_URL_ENV,
  type WorldModelBrokerClient,
  type WorldModelProcessRunner,
} from "../world-model.ts"

const worldModel = { version: 1 as const, path: "world-model.sh" }

describe("world-model replay mechanisms", () => {
  test("exact observations reproduce and any field mismatch is red", () => {
    const actual = {
      pass: false,
      failing: ["FAIL alpha", "FAIL beta"],
      score: 0.5,
    }
    expect(compareVerificationResults(actual, actual)).toEqual({
      reproduces: true,
      diff: [],
    })

    const report = buildReplayReport([
      { step: 1, actual, predicted: actual },
      {
        step: 2,
        actual,
        predicted: {
          pass: false,
          failing: ["FAIL beta", "FAIL alpha"],
          score: 0.5,
        },
      },
      {
        step: 3,
        actual: { pass: true, failing: [] },
        predicted: { pass: true, failing: [], score: 0 },
      },
    ])

    expect(report).toMatchObject({
      green: false,
      reproduced: 1,
      total: 3,
    })
    expect(report.rows[1].diff).toEqual([
      {
        field: "failing",
        predicted: ["FAIL beta", "FAIL alpha"],
        actual: ["FAIL alpha", "FAIL beta"],
      },
    ])
    expect(report.rows[2].diff).toEqual([
      { field: "score", predicted: 0, actual: null },
    ])
  })

  test("empty history is green so the first modeled verification is legal", () => {
    const report = buildReplayReport([])
    expect(report).toEqual({
      green: true,
      reproduced: 0,
      total: 0,
      rows: [],
    })
    expect(worldModelGatePredicate("full", worldModel, report)).toBeNull()
  })

  test("the full gate blocks red replay, allows green, and remains opt-in", () => {
    const red = buildReplayReport([
      {
        step: 1,
        actual: { pass: true, failing: [] },
        predicted: { pass: false, failing: ["FAIL wrong"] },
      },
    ])
    const blocked = worldModelGatePredicate("full", worldModel, red)
    expect(blocked?.reason).toContain("0/1 reproduced")
    expect(blocked?.reason).toContain("replay is free")
    expect(blocked?.reason).toContain("Correct the declared model")
    expect(worldModelGatePredicate("targeted", worldModel, red)).toBeNull()
    expect(worldModelGatePredicate("full", null, red)).toBeNull()
  })

  test("observation and scalar surprises remain complementary", () => {
    const observation = detectObservationSurprise(
      { pass: false, failing: ["FAIL predicted"] },
      { pass: true, failing: [], score: 0.42 },
    )
    expect(observation).toEqual({
      kind: "assertion_failed",
      detail:
        "World model predicted pass false, observed true (+2 more fields)",
    })

    const combined = combineSurprises(observation, {
      kind: "assertion_failed",
      detail: "Predicted score >= 0.8, observed 0.42",
    })
    expect(combined?.detail).toContain("World model predicted pass")
    expect(combined?.detail).toContain("Predicted score >= 0.8")
  })
})

describe("world-model contract", () => {
  test("strict JSON output uses the verifier result shape", () => {
    expect(
      parseWorldModelOutput(
        '{"pass":true,"failing":[],"score":0.75}\n',
      ),
    ).toEqual({ pass: true, failing: [], score: 0.75 })
    expect(() =>
      parseWorldModelOutput('{"pass":true,"failing":[],"extra":1}'),
    ).toThrow("unexpected field")
    expect(() => parseWorldModelOutput("not json")).toThrow(
      "must be one JSON",
    )
  })

  test("obvious delegation to registered commands is rejected", () => {
    expect(
      obviouslyInvokesVerifier(
        "#!/bin/sh\nexec ./verify.sh\n",
        "./verify.sh",
      ),
    ).toBeTrue()
    expect(
      obviouslyInvokesVerifier(
        'subprocess.run(["bun", "test"], cwd=sys.argv[1])',
        "bun test",
      ),
    ).toBeTrue()
    expect(
      obviouslyInvokesVerifier(
        `#!/bin/sh\nprintf '%s\\n' '{"pass":true,"failing":[]}'\n`,
        "./verify.sh",
      ),
    ).toBeFalse()
  })
})

describe("offline world-model invocation", () => {
  test("macOS exposes runtimes plus only the model and candidate", () => {
    const profile = macosWorldModelProfile(
      "/work/model",
      "/work/history/candidate",
    )
    const invocation = offlineWorldModelInvocation(
      "/work/model",
      "/work/history/candidate",
      "/work",
      "darwin",
    )

    expect(invocation.command).toBe("/usr/bin/sandbox-exec")
    expect(profile).toContain("(deny network*)")
    expect(profile).toContain("(deny file-write*)")
    expect(profile).toContain("(deny process-fork")
    expect(profile).toContain("send-signal SIGKILL")
    expect(profile).toContain('(literal "/work/model")')
    expect(profile).toContain('(subpath "/work/history/candidate")')
    expect(invocation.args.slice(-2)).toEqual([
      "/work/model",
      "/work/history/candidate",
    ])
  })

  test("Linux builds a read-only allowlisted root", () => {
    const invocation = offlineWorldModelInvocation(
      "/work/model",
      "/work/history/candidate",
      "/work",
      "linux",
    )
    expect(invocation.command).toBe("/usr/bin/bwrap")
    expect(invocation.args).toContain("--unshare-all")
    const seccompIndex = invocation.args.indexOf("--seccomp")
    expect(seccompIndex).toBeGreaterThan(-1)
    expect(invocation.args[seccompIndex + 1]).toBe("0")
    expect(invocation.args).toContain("--ro-bind-try")
    expect(invocation.args).toContain("--tmpfs")
    expect(invocation.seccomp?.byteLength).toBeGreaterThan(0)
    expect(invocation.args.slice(-2)).toEqual([
      "/world-model",
      "/candidate",
    ])
    expect(invocation.args.join("\0")).not.toContain("--ro-bind\0/\0/")
  })

  test("unsupported platforms fail closed", () => {
    expect(() =>
      offlineWorldModelInvocation(
        "/work/model",
        "/history/candidate",
        "/work",
        "win32",
      ),
    ).toThrow("unsupported platform")
  })

  test("an explicit broker routes the probe while absence still fails closed", async () => {
    const platform = process.platform === "linux" ? "linux" : "darwin"
    const sandboxCommand =
      platform === "linux" ? "/usr/bin/bwrap" : "/usr/bin/sandbox-exec"
    const localInvocations: string[] = []
    const localRunner: WorldModelProcessRunner = async (invocation) => {
      localInvocations.push(invocation.command)
      return {
        stdout: "",
        stderr: "sandbox-exec: sandbox_apply: Operation not permitted",
        exitCode: 1,
        killed: false,
      }
    }
    const brokerRequests: string[] = []
    const brokerClient: WorldModelBrokerClient = async (_url, request) => {
      brokerRequests.push(request.action)
      return { stdout: "", stderr: "", exitCode: 0, killed: false }
    }

    await expect(
      assertWorldModelSandboxAvailable(
        "/tmp",
        platform,
        localRunner,
        {},
        brokerClient,
      ),
    ).rejects.toThrow(
      "World-model sandbox probe failed: sandbox-exec: sandbox_apply: Operation not permitted.",
    )
    expect(localInvocations).toEqual([sandboxCommand])
    expect(brokerRequests).toEqual([])

    await assertWorldModelSandboxAvailable(
      "/tmp",
      platform,
      localRunner,
      {
        [WORLD_MODEL_BROKER_URL_ENV]:
          "http://127.0.0.1:43210/world-model/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      brokerClient,
    )
    expect(localInvocations).toHaveLength(1)
    expect(brokerRequests).toEqual(["probe"])

    await expect(
      assertWorldModelSandboxAvailable(
        "/tmp",
        platform,
        localRunner,
        { [WORLD_MODEL_BROKER_URL_ENV]: "true" },
        brokerClient,
      ),
    ).rejects.toThrow("must be a tokenized loopback HTTP URL")
    expect(localInvocations).toHaveLength(1)
    expect(brokerRequests).toEqual(["probe"])
  })

  test("the process runner reaps descendants after a successful leader exit", async () => {
    const result = await runWorldModelProcess(
      {
        command: "/bin/sh",
        args: [
          "-c",
          '/bin/sleep 30 </dev/null >/dev/null 2>&1 & child=$!; printf "%s\\n" "$child"',
        ],
      },
      { cwd: process.cwd(), timeoutMs: 5_000 },
    )
    expect(result.exitCode).toBe(0)
    expect(result.killed).toBeFalse()

    const descendant = Number(result.stdout.trim())
    expect(Number.isInteger(descendant)).toBeTrue()
    let alive = true
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        process.kill(descendant, 0)
        if (process.platform === "linux") {
          const stat = await readFile(
            `/proc/${descendant}/stat`,
            "utf8",
          )
          if (stat.split(" ")[2] === "Z") {
            alive = false
            break
          }
        }
        await Bun.sleep(10)
      } catch {
        alive = false
        break
      }
    }
    expect(alive).toBeFalse()
  })

  test("the process runner transfers a sandbox filter through stdin", async () => {
    const filter = new Uint8Array([0, 1, 2, 3, 4, 5])
    const result = await runWorldModelProcess(
      {
        command: process.execPath,
        args: [
          "-e",
          'import { readSync } from "node:fs"; const buffer = Buffer.alloc(32); const chunks = []; for (;;) { const count = readSync(0, buffer, 0, buffer.length, null); if (count === 0) break; chunks.push(Buffer.from(buffer.subarray(0, count))); } console.log(Buffer.concat(chunks).toString("hex"))',
        ],
        seccomp: filter,
      },
      { cwd: process.cwd(), timeoutMs: 5_000 },
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe(Buffer.from(filter).toString("hex"))
  })
})
