import type {
  FrontierCandidate,
  ParsedLedgerRow,
  SurpriseAnnotation,
  VerificationActual,
  WorldModelRegistration,
} from "./state.ts"

export type ObservationDiff = {
  field: "pass" | "failing" | "score"
  predicted: boolean | string[] | number | null
  actual: boolean | string[] | number | null
}

export type ReplayPrediction = {
  step: number
  actual: VerificationActual
  predicted?: VerificationActual
  error?: string
}

export type ReplayComparisonRow = {
  step: number
  actual: VerificationActual
  predicted: VerificationActual | null
  reproduces: boolean
  diff: ObservationDiff[]
  error?: string
}

export type ReplayReport = {
  green: boolean
  reproduced: number
  total: number
  rows: ReplayComparisonRow[]
}

export type WorldModelGateDecision = {
  block: true
  reason: string
}

export type FrontierPrediction = {
  id: string
  contentHash: string
  predicted: VerificationActual
}

export type ScoredFrontierCandidate = FrontierCandidate & {
  predicted: VerificationActual
  evaluated: boolean
}

export type CandidateDedupDecision = {
  block: true
  allEvaluated: boolean
  reason: string
}

export type ModeledFrontierGateDecision = {
  block: true
  error: "candidate_required" | "candidate_unknown"
  allEvaluated: boolean
  reason: string
}

export type RankedExperiment = ScoredFrontierCandidate & {
  informationScore: number
  reason: string
}

export const MODELED_FRONTIER_REQUIRED_REASON =
  "A declared world model gates official full verification to bytes registered by propose: propose candidates first, then score_frontier, then spend on one of them with run_verify({scope:'full', candidate:'<id>'})."

function comparePredictedOutcome(
  left: ScoredFrontierCandidate,
  right: ScoredFrontierCandidate,
): number {
  const leftScore = left.predicted.score
  const rightScore = right.predicted.score
  if (leftScore !== undefined && rightScore !== undefined && leftScore !== rightScore) {
    return rightScore - leftScore
  }
  if (leftScore !== undefined && rightScore === undefined) return -1
  if (leftScore === undefined && rightScore !== undefined) return 1
  if (left.predicted.pass !== right.predicted.pass) {
    return left.predicted.pass ? -1 : 1
  }
  if (left.predicted.failing.length !== right.predicted.failing.length) {
    return left.predicted.failing.length - right.predicted.failing.length
  }
  return left.id.localeCompare(right.id)
}

/** Purely merge model observations into the frontier and order by predicted outcome. */
export function scoreFrontier(
  candidates: readonly FrontierCandidate[],
  predictions: readonly FrontierPrediction[],
  evaluatedHashes: readonly string[] = [],
): ScoredFrontierCandidate[] {
  const evaluated = new Set(evaluatedHashes)
  const byCandidate = new Map(
    predictions.map((prediction) => [
      `${prediction.id}\0${prediction.contentHash}`,
      prediction.predicted,
    ]),
  )

  return candidates
    .map((candidate): ScoredFrontierCandidate => {
      const predicted = byCandidate.get(`${candidate.id}\0${candidate.contentHash}`)
      if (!predicted) {
        throw new Error(
          `World model produced no prediction for candidate '${candidate.id}' at ${candidate.contentHash}.`,
        )
      }
      return {
        ...candidate,
        predicted,
        evaluated: evaluated.has(candidate.contentHash),
      }
    })
    .sort(comparePredictedOutcome)
}

/** Pure content-hash gate for official evaluations. */
export function fullCandidateDedupGate(
  contentHash: string,
  evaluatedHashes: readonly string[],
  frontierHashes: readonly string[],
): CandidateDedupDecision | null {
  const evaluated = new Set(evaluatedHashes)
  if (!evaluated.has(contentHash)) return null

  const uniqueFrontier = [...new Set(frontierHashes)]
  const allEvaluated =
    uniqueFrontier.length > 0 &&
    uniqueFrontier.every((candidateHash) => evaluated.has(candidateHash))
  return {
    block: true,
    allEvaluated,
    reason: allEvaluated
      ? "Every proposed candidate byte sequence was already officially evaluated. Propose new ones with propose(...), then score_frontier, then spend on one of them."
      : "These candidate bytes were already officially evaluated. Choose an unseen candidate from next_experiment(); identical bytes never earn a second official spend.",
  }
}

/** Hard gate from a declared world model to an immutable proposed candidate. */
export function modeledFrontierGatePredicate(
  scope: "characterize" | "targeted" | "full",
  worldModel: WorldModelRegistration | null,
  candidateId: string | undefined,
  frontier: readonly FrontierCandidate[],
  evaluatedHashes: readonly string[] = [],
): ModeledFrontierGateDecision | null {
  if (scope !== "full" || !worldModel) return null
  if (
    candidateId &&
    frontier.some((candidate) => candidate.id === candidateId)
  ) {
    return null
  }

  const frontierHashes = frontier.map((candidate) => candidate.contentHash)
  const firstCandidate = frontier[0]
  const exhaustion = firstCandidate
    ? fullCandidateDedupGate(
        firstCandidate.contentHash,
        evaluatedHashes,
        frontierHashes,
      )
    : null
  const allEvaluated = exhaustion?.allEvaluated === true
  const unknownCandidate = candidateId
    ? `Candidate '${candidateId}' did not come from propose. `
    : ""

  return {
    block: true,
    error: candidateId ? "candidate_unknown" : "candidate_required",
    allEvaluated,
    reason: allEvaluated
      ? `${unknownCandidate}${exhaustion.reason}`
      : `${unknownCandidate}${MODELED_FRONTIER_REQUIRED_REASON}`,
  }
}

export function distinctOfficialCandidateCount(
  ledger: readonly ParsedLedgerRow[],
): number {
  return new Set(
    ledger.flatMap((row) =>
      row.scope === "full" && typeof row.contentHash === "string"
        ? [row.contentHash]
        : [],
    ),
  ).size
}

function failingSetDistance(left: readonly string[], right: readonly string[]): number {
  const leftSet = new Set(left)
  const rightSet = new Set(right)
  const union = new Set([...leftSet, ...rightSet])
  if (union.size === 0) return 0
  let shared = 0
  for (const failure of leftSet) {
    if (rightSet.has(failure)) shared += 1
  }
  return 1 - shared / union.size
}

function observationDistance(
  left: VerificationActual,
  right: VerificationActual,
  scoreRange: number,
): number {
  const components = [
    left.pass === right.pass ? 0 : 1,
    failingSetDistance(left.failing, right.failing),
  ]
  if (left.score !== undefined && right.score !== undefined) {
    components.push(Math.min(1, Math.abs(left.score - right.score) / scoreRange))
  }
  return components.reduce((sum, value) => sum + value, 0) / components.length
}

function inferredBoundary(
  frontier: readonly ScoredFrontierCandidate[],
): number | null {
  let closest:
    | { distance: number; boundary: number }
    | undefined
  for (let left = 0; left < frontier.length; left += 1) {
    const leftPrediction = frontier[left].predicted
    if (leftPrediction.score === undefined) continue
    for (let right = left + 1; right < frontier.length; right += 1) {
      const rightPrediction = frontier[right].predicted
      if (
        rightPrediction.score === undefined ||
        leftPrediction.pass === rightPrediction.pass
      ) {
        continue
      }
      const distance = Math.abs(leftPrediction.score - rightPrediction.score)
      if (!closest || distance < closest.distance) {
        closest = {
          distance,
          boundary: (leftPrediction.score + rightPrediction.score) / 2,
        }
      }
    }
  }
  return closest?.boundary ?? null
}

/**
 * Rank unseen candidates by model disagreement or inferred boundary proximity.
 *
 * An empty result is intentionally advisory rather than a gate: propose(...)
 * remains available, so an empty or fully evaluated frontier cannot deadlock.
 */
export function rankNextExperiments(
  frontier: readonly ScoredFrontierCandidate[],
  evaluatedHashes: readonly string[] = [],
): RankedExperiment[] {
  const evaluated = new Set(evaluatedHashes)
  const uniqueByHash = new Map<string, ScoredFrontierCandidate>()
  for (const candidate of [...frontier].sort((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    if (!uniqueByHash.has(candidate.contentHash)) {
      uniqueByHash.set(candidate.contentHash, candidate)
    }
  }
  const uniqueFrontier = [...uniqueByHash.values()]
  const actionable = uniqueFrontier.filter(
    (candidate) => !candidate.evaluated && !evaluated.has(candidate.contentHash),
  )
  if (actionable.length === 0) return []

  const scores = uniqueFrontier.flatMap((candidate) =>
    candidate.predicted.score === undefined ? [] : [candidate.predicted.score],
  )
  const scoreRange =
    scores.length > 1 ? Math.max(...scores) - Math.min(...scores) || 1 : 1
  const boundary = inferredBoundary(uniqueFrontier)

  return actionable
    .map((candidate): RankedExperiment => {
      const peers = uniqueFrontier.filter(
        (peer) => peer.contentHash !== candidate.contentHash,
      )
      const disagreement =
        peers.length === 0
          ? 0
          : peers.reduce(
              (sum, peer) =>
                sum +
                observationDistance(
                  candidate.predicted,
                  peer.predicted,
                  scoreRange,
                ),
              0,
            ) / peers.length
      const boundaryProximity =
        boundary !== null && candidate.predicted.score !== undefined
          ? Math.max(
              0,
              1 -
                Math.abs(candidate.predicted.score - boundary) / scoreRange,
            )
          : 0
      const informationScore = Math.max(disagreement, boundaryProximity)
      let reason: string
      if (peers.length === 0) {
        reason =
          "Only unseen model-scored candidate; evaluating it expands official coverage."
      } else if (boundaryProximity >= disagreement && boundary !== null) {
        reason =
          `Predicted score ${candidate.predicted.score} is nearest the inferred pass/fail boundary ${boundary}.`
      } else {
        reason =
          `Predicted outcome has ${disagreement.toFixed(3)} mean disagreement with the frontier.`
      }
      return {
        ...candidate,
        informationScore,
        reason,
      }
    })
    .sort(
      (left, right) =>
        right.informationScore - left.informationScore ||
        left.id.localeCompare(right.id),
    )
}

function scoreValue(observation: VerificationActual): number | null {
  return observation.score === undefined ? null : observation.score
}

/** Compare the complete normalized verifier observation, including failure order and score presence. */
export function compareVerificationResults(
  predicted: VerificationActual,
  actual: VerificationActual,
): { reproduces: boolean; diff: ObservationDiff[] } {
  const diff: ObservationDiff[] = []
  if (predicted.pass !== actual.pass) {
    diff.push({ field: "pass", predicted: predicted.pass, actual: actual.pass })
  }
  if (
    predicted.failing.length !== actual.failing.length ||
    predicted.failing.some((failure, index) => failure !== actual.failing[index])
  ) {
    diff.push({ field: "failing", predicted: predicted.failing, actual: actual.failing })
  }
  const predictedScore = scoreValue(predicted)
  const actualScore = scoreValue(actual)
  if (predictedScore !== actualScore) {
    diff.push({ field: "score", predicted: predictedScore, actual: actualScore })
  }
  return { reproduces: diff.length === 0, diff }
}

function formatObservationValue(value: ObservationDiff["actual"]): string {
  return value === null ? "<absent>" : JSON.stringify(value)
}

export function detectObservationSurprise(
  predicted: VerificationActual,
  actual: VerificationActual,
): SurpriseAnnotation | null {
  const comparison = compareVerificationResults(predicted, actual)
  if (comparison.reproduces) return null

  const first = comparison.diff[0]
  return {
    kind: "assertion_failed",
    detail:
      `World model predicted ${first.field} ${formatObservationValue(first.predicted)}, observed ` +
      `${formatObservationValue(first.actual)}` +
      (comparison.diff.length > 1 ? ` (+${comparison.diff.length - 1} more fields)` : ""),
  }
}

export function combineSurprises(
  ...surprises: (SurpriseAnnotation | null | undefined)[]
): SurpriseAnnotation | null {
  const present = surprises.filter(
    (surprise): surprise is SurpriseAnnotation =>
      surprise !== null && surprise !== undefined,
  )
  if (present.length === 0) return null
  if (present.length === 1) return present[0]
  return {
    kind: "assertion_failed",
    detail: present.map((surprise) => surprise.detail).join("; "),
  }
}

/** Pure replay comparison. Empty history is green by vacuous truth. */
export function buildReplayReport(
  predictions: readonly ReplayPrediction[],
): ReplayReport {
  const rows = predictions.map(
    ({ step, actual, predicted, error }): ReplayComparisonRow => {
      if (!predicted) {
        return {
          step,
          actual,
          predicted: null,
          reproduces: false,
          diff: [],
          error: error ?? "World model produced no prediction.",
        }
      }
      const comparison = compareVerificationResults(predicted, actual)
      return {
        step,
        actual,
        predicted,
        reproduces: comparison.reproduces,
        diff: comparison.diff,
        ...(error ? { error } : {}),
      }
    },
  )
  const reproduced = rows.filter((row) => row.reproduces).length
  return {
    green: reproduced === rows.length,
    reproduced,
    total: rows.length,
    rows,
  }
}

export function worldModelGatePredicate(
  scope: "characterize" | "targeted" | "full",
  worldModel: WorldModelRegistration | null,
  replay: Pick<ReplayReport, "green" | "reproduced" | "total"> | null,
): WorldModelGateDecision | null {
  if (scope !== "full" || !worldModel) return null
  if (replay?.green) return null

  const headline = replay ? `${replay.reproduced}/${replay.total}` : "not run"
  return {
    block: true,
    reason:
      `World-model replay is red (${headline} reproduced). Correct the declared model, then call replay_verify() again; ` +
      "replay is free and no verification budget was spent. If a row reports a missing candidate snapshot, start a new " +
      "opencode session to rebuild replayable history.",
  }
}

export function parseWorldModelOutput(stdout: string): VerificationActual {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    throw new Error("World model stdout must be one JSON verifier result.")
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("World model output must be an object.")
  }

  const result = parsed as Record<string, unknown>
  const unexpected = Object.keys(result).filter(
    (key) => key !== "pass" && key !== "failing" && key !== "score",
  )
  if (unexpected.length > 0) {
    throw new Error(`World model output has unexpected field: ${unexpected[0]}.`)
  }
  if (typeof result.pass !== "boolean") {
    throw new Error("World model output field 'pass' must be boolean.")
  }
  if (
    !Array.isArray(result.failing) ||
    result.failing.some((value) => typeof value !== "string")
  ) {
    throw new Error("World model output field 'failing' must be an array of strings.")
  }
  if (
    Object.hasOwn(result, "score") &&
    (typeof result.score !== "number" || !Number.isFinite(result.score))
  ) {
    throw new Error(
      "World model output field 'score' must be a finite number when present.",
    )
  }

  return {
    pass: result.pass,
    failing: result.failing as string[],
    ...(typeof result.score === "number" ? { score: result.score } : {}),
  }
}

/**
 * Reject obvious verifier delegation without pretending this static source
 * check proves a predictor is non-adversarial. Keep the token-order heuristic
 * aligned with the OMP reference, including its conservative short-command
 * false positives.
 */
export function obviouslyInvokesVerifier(
  modelSource: string,
  verifyCmd: string,
): boolean {
  const command = verifyCmd.trim()
  if (!command) return false
  const commandTokens = [
    ...command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g),
  ].map((match) => match[1] ?? match[2] ?? match[3]!)
  const executable = commandTokens[0]
  const invocation =
    /\b(?:bash|cmd|exec(?:File(?:Sync)?|Sync|[lvpe]+)?|fish|popen|powershell|run|sh|spawn|spawnSync|subprocess|system|zsh)\b|`/
  let cursor = 0
  const tokensAppearInOrder = commandTokens.every((token) => {
    const index = modelSource.indexOf(token, cursor)
    if (index < 0) return false
    cursor = index + token.length
    return true
  })
  if (invocation.test(modelSource) && tokensAppearInOrder) return true
  if (
    executable &&
    (executable.includes("/") || executable.includes("\\")) &&
    invocation.test(modelSource) &&
    modelSource.includes(executable.replace(/^.*[/\\]/, ""))
  ) {
    return true
  }

  return modelSource
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/;$/, ""))
    .some((line) => line === command || line === `exec ${command}`)
}
