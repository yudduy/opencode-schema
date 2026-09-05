import { afterEach, expect, test } from "bun:test"
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises"
import { existsSync } from "node:fs"
import { request as httpRequest } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import {
  captureCandidateSnapshot,
  createRunState,
  resolveCandidateSnapshot,
  runFile,
  worldModelFile,
  writeRun,
  writeWorldModel,
} from "../state.ts"
import {
  executeWorldModel,
  WORLD_MODEL_BROKER_URL_ENV,
  type WorldModelProcessRunner,
} from "../world-model.ts"
import {
  startWorldModelBroker,
  type WorldModelBroker,
} from "../world-model-broker.ts"

const sandboxAvailable =
  (process.platform === "darwin" &&
    existsSync("/usr/bin/sandbox-exec")) ||
  (process.platform === "linux" && existsSync("/usr/bin/bwrap"))
const temporaryDirectories: string[] = []
const brokers: WorldModelBroker[] = []
const networkServers: Array<ReturnType<typeof Bun.serve>> = []

afterEach(async () => {
  await Promise.all(brokers.splice(0).map((broker) => broker.close()))
  await Promise.all(
    networkServers.splice(0).map((server) => server.stop(true)),
  )
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
  )
})

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
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

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await Bun.sleep(50)
  }
  return predicate()
}

async function processIsActive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0)
    if (process.platform === "linux") {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8")
      return stat.split(" ")[2] !== "Z"
    }
    return true
  } catch {
    return false
  }
}

async function processOutput(command: string[], cwd: string): Promise<{
  stdout: string
  stderr: string
  exitCode: number
}> {
  const child = Bun.spawn(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, exitCode }
}

async function isolatedPostStatus(
  url: string,
  body: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      url,
      {
        method: "POST",
        agent: false,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (response) => {
        response.resume()
        response.once("end", () => resolve(response.statusCode ?? 0))
      },
    )
    request.once("error", reject)
    request.end(body)
  })
}

test.skipIf(!sandboxAvailable)(
  "the explicit broker preserves predictor isolation and rejects unsafe snapshots",
  async () => {
    const workspace = await temporaryDirectory(
      "schema-world-model-broker-workspace-",
    )
    const outside = await temporaryDirectory(
      "schema-world-model-broker-outside-",
    )
    const liveAnswer = path.join(workspace, "answer.txt")
    const outsideSecret = path.join(outside, "secret.txt")
    await writeFile(liveAnswer, "snapshot\n", "utf8")
    await writeFile(outsideSecret, "held-out-canary\n", "utf8")

    let networkHits = 0
    const networkServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        networkHits += 1
        return new Response("reachable")
      },
    })
    networkServers.push(networkServer)
    const model = `#!/usr/bin/env python3
import json
import pathlib
import socket
import sys
import threading

def hidden(filename):
    try:
        pathlib.Path(filename).read_bytes()
        return False
    except OSError:
        return True

candidate = pathlib.Path(sys.argv[1])
thread_ran = []
thread = threading.Thread(target=lambda: thread_ran.append(True))
thread.start()
thread.join()
snapshot = (candidate / "answer.txt").read_text().strip()
live_hidden = hidden(${JSON.stringify(liveAnswer)})
outside_hidden = hidden(${JSON.stringify(outsideSecret)})
try:
    (candidate / "model-write").write_text("write")
    write_blocked = False
except OSError:
    write_blocked = True
probe = socket.socket()
probe.settimeout(1)
try:
    probe.connect(("127.0.0.1", ${networkServer.port}))
    network_blocked = False
except OSError:
    network_blocked = True
finally:
    probe.close()
passed = (
    thread_ran == [True]
    and snapshot == "snapshot"
    and live_hidden
    and outside_hidden
    and write_blocked
    and network_blocked
)
result = {"pass": passed, "failing": []}
if not passed:
    result["failing"] = ["FAIL broker sandbox boundary"]
print(json.dumps(result))
`
    await executable(workspace, "world-model.sh", model)
    const sessionID = "broker-boundary"
    await writeRun(
      workspace,
      sessionID,
      createRunState({ verify_cmd: "./verify.sh" }),
    )
    await writeWorldModel(workspace, sessionID, {
      version: 1,
      path: "world-model.sh",
    })
    const reference = await captureCandidateSnapshot(workspace, sessionID)
    const candidate = await resolveCandidateSnapshot(
      workspace,
      sessionID,
      reference,
    )
    const brokerCandidate = path.posix.join(
      ".schema",
      sessionID,
      reference,
    )
    await writeFile(liveAnswer, "live\n", "utf8")

    const privateDir = await temporaryDirectory(
      "schema-world-model-broker-private-",
    )
    const broker = await startWorldModelBroker({ workspace, privateDir })
    brokers.push(broker)
    let localRunnerCalled = false
    const localRunner: WorldModelProcessRunner = async () => {
      localRunnerCalled = true
      throw new Error("nested local sandbox must not run")
    }
    expect(
      await executeWorldModel(
        workspace,
        { version: 1, path: "world-model.sh" },
        [],
        candidate,
        undefined,
        localRunner,
        { [WORLD_MODEL_BROKER_URL_ENV]: broker.url },
      ),
    ).toEqual({ pass: true, failing: [] })
    expect(localRunnerCalled).toBeFalse()
    expect(networkHits).toBe(0)
    expect(existsSync(path.join(candidate, "model-write"))).toBeFalse()

    const pinnedModel = `#!/usr/bin/env python3
import json
import pathlib
import sys
import time

time.sleep(1)
snapshot = pathlib.Path(sys.argv[1], "answer.txt").read_text().strip()
print(json.dumps({"pass": snapshot == "snapshot", "failing": []}))
`
    await executable(workspace, "world-model.sh", pinnedModel)
    const pinnedPrediction = executeWorldModel(
      workspace,
      { version: 1, path: "world-model.sh" },
      [],
      candidate,
      undefined,
      localRunner,
      { [WORLD_MODEL_BROKER_URL_ENV]: broker.url },
    )
    expect(
      await waitUntil(
        () =>
          !existsSync(path.join(workspace, "world-model.sh")) &&
          !existsSync(candidate),
        5_000,
      ),
    ).toBeTrue()
    await executable(
      workspace,
      "world-model.sh",
      '#!/usr/bin/env python3\nprint(\'{"pass":false,"failing":[]}\')\n',
    )
    await mkdir(candidate, { recursive: true })
    await writeFile(path.join(candidate, "answer.txt"), "raced\n", "utf8")
    expect(await pinnedPrediction).toEqual({ pass: true, failing: [] })
    expect(await readFile(path.join(workspace, "world-model.sh"), "utf8")).toBe(
      pinnedModel,
    )
    expect(await readFile(path.join(candidate, "answer.txt"), "utf8")).toBe(
      "snapshot\n",
    )

    if (process.platform === "darwin") {
      const control = await temporaryDirectory(
        "schema-world-model-broker-seatbelt-",
      )
      const helper = path.join(control, "execute.ts")
      const worldModelModule = pathToFileURL(
        path.resolve(import.meta.dir, "../world-model.ts"),
      ).href
      await writeFile(
        helper,
        `import { executeWorldModel } from ${JSON.stringify(worldModelModule)}

const [, , workspace, candidate] = process.argv
try {
  const result = await executeWorldModel(
    workspace,
    { version: 1, path: "world-model.sh" },
    ["./verify.sh"],
    candidate,
  )
  console.log(JSON.stringify(result))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
`,
        "utf8",
      )
      const outerProfile = [
        "(version 1)",
        "(allow default)",
        `(deny file-write* (subpath ${JSON.stringify(path.join(control, "nonexistent"))}))`,
      ].join("\n")
      const sandboxedCommand = [
        "/usr/bin/sandbox-exec",
        "-p",
        outerProfile,
        process.execPath,
        helper,
        workspace,
        candidate,
      ]
      const absent = await processOutput(
        [
          "/usr/bin/env",
          "-u",
          WORLD_MODEL_BROKER_URL_ENV,
          ...sandboxedCommand,
        ],
        workspace,
      )
      expect(absent.exitCode).not.toBe(0)
      expect(absent.stderr).toContain(
        "sandbox-exec: sandbox_apply: Operation not permitted",
      )

      const explicit = await processOutput(
        [
          "/usr/bin/env",
          `${WORLD_MODEL_BROKER_URL_ENV}=${broker.url}`,
          ...sandboxedCommand,
        ],
        workspace,
      )
      expect(explicit.exitCode).toBe(0)
      expect(JSON.parse(explicit.stdout)).toEqual({
        pass: true,
        failing: [],
      })
      expect(networkHits).toBe(0)
    }

    for (const stateFile of [
      runFile(workspace, sessionID),
      worldModelFile(workspace, sessionID),
    ]) {
      const backup = `${stateFile}.backup`
      await rename(stateFile, backup)
      try {
        const errors: string[] = []
        for (const target of [
          outsideSecret,
          path.join(outside, "missing-state"),
        ]) {
          await symlink(target, stateFile)
          const unsafeState = await fetch(broker.url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "execute",
              candidate: brokerCandidate,
            }),
          })
          expect(unsafeState.status).toBe(400)
          errors.push(await unsafeState.text())
          await unlink(stateFile)
        }
        expect(errors[0]).toBe(errors[1])
        expect(errors[0]).toContain(
          "rejected unsafe execution state",
        )
        expect(errors[0]).not.toContain("held-out-canary")
      } finally {
        await unlink(stateFile).catch(() => {})
        await rename(backup, stateFile)
      }
    }

    const schemaDirectory = path.dirname(
      path.dirname(runFile(workspace, sessionID)),
    )
    const unsafeSession = path.join(schemaDirectory, "probe")
    const sessionErrors: string[] = []
    for (const target of [
      outside,
      path.join(outside, "missing-session"),
    ]) {
      await symlink(target, unsafeSession)
      const response = await fetch(broker.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "execute",
          candidate:
            ".schema/probe/candidates/00000000-0000-4000-8000-000000000000",
        }),
      })
      expect(response.status).toBe(400)
      sessionErrors.push(await response.text())
      await unlink(unsafeSession)
    }
    expect(sessionErrors[0]).toBe(sessionErrors[1])

    await writeWorldModel(workspace, sessionID, {
      version: 1,
      path: "escape/secret.txt",
    })
    const escape = path.join(workspace, "escape")
    const modelPathErrors: string[] = []
    for (const target of [
      outside,
      path.join(outside, "missing-model-parent"),
    ]) {
      await symlink(target, escape)
      const response = await fetch(broker.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "execute",
          candidate: brokerCandidate,
        }),
      })
      expect(response.status).toBe(400)
      modelPathErrors.push(await response.text())
      await unlink(escape)
    }
    expect(modelPathErrors[0]).toBe(modelPathErrors[1])
    await writeWorldModel(workspace, sessionID, {
      version: 1,
      path: "world-model.sh",
    })

    await executable(
      workspace,
      "world-model.sh",
      '#!/usr/bin/env python3\nimport json\nimport os\n\ntry:\n    os.fork()\nexcept OSError:\n    print(json.dumps({"pass": True, "failing": []}))\n',
    )
    await expect(
      executeWorldModel(
        workspace,
        { version: 1, path: "world-model.sh" },
        [],
        candidate,
        undefined,
        localRunner,
        { [WORLD_MODEL_BROKER_URL_ENV]: broker.url },
      ),
    ).rejects.toThrow(
      "world models must be a single process and may not spawn subprocesses",
    )

    await executable(
      workspace,
      "world-model.sh",
      '#!/usr/bin/env python3\nimport sys\n\nsys.stdout.write("x" * 1100000)\n',
    )
    await expect(
      executeWorldModel(
        workspace,
        { version: 1, path: "world-model.sh" },
        [],
        candidate,
        undefined,
        localRunner,
        { [WORLD_MODEL_BROKER_URL_ENV]: broker.url },
      ),
    ).rejects.toThrow("1 MB combined output limit")
    const liveProbe = await fetch(broker.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "probe" }),
    })
    expect(liveProbe.status).toBe(200)

    const traversal = await fetch(broker.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "execute",
        candidate: "../outside",
      }),
    })
    expect(traversal.status).toBe(400)

    await writeFile(
      path.join(workspace, "world-model.sh"),
      "#!/bin/sh\n./verify.sh\n",
      "utf8",
    )
    const verifierBypass = await fetch(broker.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "execute",
        candidate: brokerCandidate,
      }),
    })
    expect(verifierBypass.status).toBe(400)
    expect(await verifierBypass.text()).toContain(
      "directly references a registered verification command",
    )

    const outsideLink = path.join(candidate, "outside-link")
    const unsafeLinkErrors: string[] = []
    for (const target of [
      outsideSecret,
      path.join(outside, "missing-secret"),
    ]) {
      await symlink(target, outsideLink)
      const unsafeLink = await fetch(broker.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "execute",
          candidate: brokerCandidate,
        }),
      })
      expect(unsafeLink.status).toBe(400)
      unsafeLinkErrors.push(await unsafeLink.text())
      await unlink(outsideLink)
    }
    expect(unsafeLinkErrors[0]).toBe(unsafeLinkErrors[1])
    expect(unsafeLinkErrors[0]).not.toContain("held-out-canary")

    let deep = candidate
    for (let depth = 0; depth < 66; depth += 1) {
      deep = path.join(deep, "nested")
      await mkdir(deep)
    }
    const oversizedSnapshot = await fetch(broker.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "execute",
        candidate: brokerCandidate,
      }),
    })
    expect(oversizedSnapshot.status).toBe(400)
    expect(await oversizedSnapshot.text()).toContain(
      "rejected unsafe execution state",
    )
  },
)

test.skipIf(!sandboxAvailable)(
  "the broker and active predictor exit when the broker parent dies",
  async () => {
    const workspace = await temporaryDirectory(
      "schema-world-model-broker-parent-workspace-",
    )
    const control = await temporaryDirectory(
      "schema-world-model-broker-parent-control-",
    )
    const readyFile = path.join(control, "ready")
    const privateDir = path.join(control, "private")
    const pidFile = path.join(control, "pid")
    const logFile = path.join(control, "broker.log")
    const brokerScript = path.resolve(
      import.meta.dir,
      "../world-model-broker.ts",
    )
    await mkdir(privateDir)
    await executable(
      workspace,
      "world-model.sh",
      '#!/usr/bin/env python3\nimport time\n\ntime.sleep(30)\n',
    )
    const sessionID = "broker-parent-death"
    await writeRun(
      workspace,
      sessionID,
      createRunState({ verify_cmd: "./verify.sh" }),
    )
    await writeWorldModel(workspace, sessionID, {
      version: 1,
      path: "world-model.sh",
    })
    const reference = await captureCandidateSnapshot(
      workspace,
      sessionID,
    )
    const brokerCandidate = path.posix.join(
      ".schema",
      sessionID,
      reference,
    )
    const launch = `
"$1" "$2" --workspace "$3" --private-dir "$4" --ready-file "$5" --parent-pid "$$" >"$6" 2>&1 &
broker_pid=$!
printf '%s\\n' "$broker_pid" > "$7"
wait "$broker_pid"
`
    const parent = Bun.spawn(
      [
        "/bin/sh",
        "-c",
        launch,
        "broker-parent",
        process.execPath,
        brokerScript,
        workspace,
        privateDir,
        readyFile,
        logFile,
        pidFile,
      ],
      {
        detached: true,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      },
    )

    let brokerPid = 0
    let activeRequest: Promise<string> | undefined
    try {
      const started = await waitUntil(
        () => existsSync(readyFile) && existsSync(pidFile),
        10_000,
      )
      if (!started) {
        const log = existsSync(logFile)
          ? await readFile(logFile, "utf8")
          : "(no broker log)"
        throw new Error(`Broker did not become ready: ${log}`)
      }
      brokerPid = Number((await readFile(pidFile, "utf8")).trim())
      expect(Number.isInteger(brokerPid)).toBeTrue()
      process.kill(brokerPid, 0)

      const brokerURL = (await readFile(readyFile, "utf8")).trim()
      activeRequest = fetch(brokerURL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "execute",
          candidate: brokerCandidate,
        }),
      })
        .then((response) => response.text())
        .catch(() => "")
      await Bun.sleep(100)
      parent.kill("SIGKILL")
      await parent.exited
      const stopped = await waitUntil(
        async () =>
          !(await processIsActive(brokerPid)) &&
          !existsSync(readyFile),
        5_000,
      )
      expect(stopped).toBeTrue()
      expect(existsSync(readyFile)).toBeFalse()
      await activeRequest
    } finally {
      if (parent.exitCode === null) parent.kill("SIGKILL")
      if (brokerPid > 0) {
        try {
          process.kill(brokerPid, "SIGKILL")
        } catch {
          // Already reaped after observing parent death.
        }
      }
    }
  },
  15_000,
)

test.skipIf(!sandboxAvailable)(
  "the broker keeps requests open beyond Bun's default idle timeout",
  async () => {
    const workspace = await temporaryDirectory(
      "schema-world-model-broker-idle-workspace-",
    )
    await executable(
      workspace,
      "world-model.sh",
      '#!/usr/bin/env python3\nimport json\nimport time\n\ntime.sleep(11)\nprint(json.dumps({"pass": True, "failing": []}))\n',
    )
    const sessionID = "broker-idle"
    await writeRun(
      workspace,
      sessionID,
      createRunState({ verify_cmd: "./verify.sh" }),
    )
    await writeWorldModel(workspace, sessionID, {
      version: 1,
      path: "world-model.sh",
    })
    const reference = await captureCandidateSnapshot(workspace, sessionID)
    const candidate = await resolveCandidateSnapshot(
      workspace,
      sessionID,
      reference,
    )
    const privateDir = await temporaryDirectory(
      "schema-world-model-broker-idle-private-",
    )
    const broker = await startWorldModelBroker({ workspace, privateDir })
    brokers.push(broker)

    const prediction = executeWorldModel(
      workspace,
      { version: 1, path: "world-model.sh" },
      ["./verify.sh"],
      candidate,
      undefined,
      async () => {
        throw new Error("nested local sandbox must not run")
      },
      { [WORLD_MODEL_BROKER_URL_ENV]: broker.url },
    )
    await Bun.sleep(100)
    const concurrentStatus = await isolatedPostStatus(
      broker.url,
      JSON.stringify({ action: "probe" }),
    )
    expect(concurrentStatus).toBe(429)
    expect(await prediction).toEqual({ pass: true, failing: [] })
  },
  40_000,
)
