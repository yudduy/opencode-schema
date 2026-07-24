import type { PluginInput } from "@opencode-ai/plugin"

export const VERIFY_TIMEOUT_MS = 600_000

export type CommandOutput = {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
}

export type ParsedVerification = {
  pass: boolean
  failing: string[]
  score?: number
}

const timeoutScript = String.raw`
command=$1
seconds=$2
set -m
bash -lc "$command" &
child=$!
set +m
deadline=$((SECONDS + seconds))

while kill -0 "$child" 2>/dev/null; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    kill -TERM -- "-$child" 2>/dev/null || kill -TERM "$child" 2>/dev/null || true
    sleep 0.1
    kill -KILL -- "-$child" 2>/dev/null || kill -KILL "$child" 2>/dev/null || true
    wait "$child" 2>/dev/null || true
    exit 124
  fi
  sleep 0.05
done

wait "$child"
status=$?
if kill -0 -- "-$child" 2>/dev/null; then
  kill -TERM -- "-$child" 2>/dev/null || true
  sleep 0.1
  kill -KILL -- "-$child" 2>/dev/null || true
fi
exit "$status"
`

export async function runBenchmarkCommand(
  shell: PluginInput["$"],
  worktree: string,
  command: string,
  timeoutMs = VERIFY_TIMEOUT_MS,
): Promise<CommandOutput> {
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1_000))
  const output = await shell`bash -c ${timeoutScript} schema-verify ${command} ${seconds}`
    .cwd(worktree)
    .quiet()
    .nothrow()

  return {
    exitCode: output.exitCode,
    stdout: output.stdout.toString(),
    stderr: output.stderr.toString(),
    timedOut: output.exitCode === 124,
  }
}

function parseLastScore(output: string): number | undefined {
  const pattern = /score[^+\-\d]*(?<value>[+\-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+\-]?\d+)?)/gi
  let score: number | undefined
  for (const match of output.matchAll(pattern)) {
    const value = Number(match.groups?.value)
    if (Number.isFinite(value)) score = value
  }
  return score
}

export function parseVerifyOutput(
  exitCode: number,
  stdout: string,
  stderr = "",
  scoreOutput = "",
): ParsedVerification {
  // \b keeps "fail" inside words/paths (e.g. a repo named "ecdsafail") from
  // reading as a failure marker; zero-count summaries ("0 failed", "0 fail")
  // appear on fully green cargo/bun runs and are not failures either.
  const failing = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /\bFAIL|✗|\bnot ok\b/i.test(line) && !/\b0\s+fail/i.test(line))
  const score = parseLastScore(scoreOutput)

  return {
    pass: exitCode === 0,
    failing,
    ...(score === undefined ? {} : { score }),
  }
}
