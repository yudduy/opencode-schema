type AssertionOperator = ">=" | "<=" | ">" | "<" | "==" | "!=";

export type Assertion =
	| {
			metric: "score" | "failing_count";
			op: AssertionOperator;
			value: number;
			tol?: number;
	  }
	| {
			metric: "pass";
			op: AssertionOperator;
			value: boolean;
			tol?: number;
	  };

export type Prediction = {
	hypothesis: string;
	assertions: Assertion[];
	ts: number;
};

export type VerificationActual = {
	pass: boolean;
	failing: string[];
	score?: number;
};

export type WorldModelRegistration = {
	version: 1;
	path: string;
};

export type SurpriseAnnotation = {
	kind: "assertion_failed";
	detail: string;
};

export type VerificationScope = "baseline" | "full";

export type TaskRegistration = {
	version: 1;
	verify_cmd: string;
	score_cmd?: string;
	budget: number;
};

export type PredictionLedgerRow = {
	ts: number;
	step: number;
	scope: "predict";
	prediction: Prediction;
};

export type VerificationLedgerRow = {
	ts: number;
	step: number;
	scope: VerificationScope;
	candidate?: string;
	prediction?: Prediction;
	predicted?: VerificationActual;
	actual: VerificationActual;
	cost: 1;
	surprise?: SurpriseAnnotation;
};

export type LedgerRow = PredictionLedgerRow | VerificationLedgerRow;
export type LedgerRowInput = Omit<PredictionLedgerRow, "step"> | Omit<VerificationLedgerRow, "step">;

export type RunState = {
	task: TaskRegistration;
	baselineRecorded: boolean;
	verificationsUsed: number;
	openPrediction: Prediction | null;
};

export type GateDecision = {
	block: true;
	reason: string;
};

export type ObservationDiff = {
	field: "pass" | "failing" | "score";
	predicted: boolean | string[] | number | null;
	actual: boolean | string[] | number | null;
};

export type ReplayPrediction = {
	step: number;
	actual: VerificationActual;
	predicted?: VerificationActual;
	error?: string;
};

export type ReplayComparisonRow = {
	step: number;
	actual: VerificationActual;
	predicted: VerificationActual | null;
	reproduces: boolean;
	diff: ObservationDiff[];
	error?: string;
};

export type ReplayReport = {
	green: boolean;
	reproduced: number;
	total: number;
	rows: ReplayComparisonRow[];
};

/**
 * OMP exposes only a tool name to tool_call handlers, not the tool's approval
 * tier. Keep this list narrow: missing one mutation path is cheaper than blocking
 * an unknown read-only tool and burning the wall clock. `python` and `notebook`
 * are retained as compatibility aliases; OMP v17 names those capabilities
 * `eval`, while `ast_edit` is its other direct source mutation path.
 */
export const MUTATING_TOOL_NAMES: ReadonlySet<string> = new Set([
	"ast_edit",
	"bash",
	"edit",
	"eval",
	"notebook",
	"python",
	"task",
	"write",
]);

export const BASELINE_REQUIRED_REASON =
	"Baseline required before mutations: run run_verify({scope:'baseline'}) on the unmodified task.";

export function baselineGatePredicate(run: RunState | null, toolName: string): GateDecision | null {
	if (!MUTATING_TOOL_NAMES.has(toolName)) return null;
	// Registration opts a session into the harness. Blocking without a run would
	// make a globally installed extension interfere with unrelated OMP sessions.
	if (!run || run.baselineRecorded) return null;
	return { block: true, reason: BASELINE_REQUIRED_REASON };
}

/**
 * Baseline is the one prediction-free exception: it anchors the unmodified
 * program before there is evidence to predict from. It is still a real, charged,
 * scored evaluation. Making it one-shot prevents `baseline` from becoming a
 * repeatable escape from the typed-prediction gate.
 */
export function verificationGatePredicate(run: RunState | null, scope: VerificationScope): GateDecision | null {
	if (!run) {
		return { block: true, reason: "Register the task with register_task before verification." };
	}
	if (run.verificationsUsed >= run.task.budget) {
		return {
			block: true,
			reason: `Verification budget exhausted (${run.verificationsUsed}/${run.task.budget}).`,
		};
	}
	if (scope === "baseline") {
		return run.baselineRecorded
			? { block: true, reason: "Baseline already recorded; use scope 'full' for later evaluations." }
			: null;
	}
	if (!run.baselineRecorded) {
		return { block: true, reason: BASELINE_REQUIRED_REASON };
	}
	if (!run.openPrediction) {
		return {
			block: true,
			reason: "A full verification requires an open typed prediction. Call predict first.",
		};
	}
	return null;
}

export function worldModelGatePredicate(
	scope: VerificationScope,
	worldModel: WorldModelRegistration | null,
	replay: Pick<ReplayReport, "green" | "reproduced" | "total"> | null,
): GateDecision | null {
	if (scope !== "full" || !worldModel) return null;
	if (replay?.green) return null;

	const headline = replay ? `${replay.reproduced}/${replay.total}` : "not run";
	return {
		block: true,
		reason:
			`World-model replay is red (${headline} reproduced). Correct the declared model, then call replay_verify() again; ` +
			"replay is free and no verification budget was spent. If a row reports a missing candidate snapshot, start a new " +
			"OMP session to rebuild replayable history.",
	};
}

export function deriveRunState(task: TaskRegistration, ledger: LedgerRow[]): RunState {
	let baselineRecorded = false;
	let verificationsUsed = 0;
	let openPrediction: Prediction | null = null;

	for (const row of ledger) {
		if (row.scope === "predict") {
			openPrediction = row.prediction;
			continue;
		}
		verificationsUsed += row.cost;
		if (row.scope === "baseline") baselineRecorded = true;
		// Every observation resolves the one open prediction, including a baseline
		// if a caller happened to predict before anchoring.
		openPrediction = null;
	}

	return { task, baselineRecorded, verificationsUsed, openPrediction };
}

function actualFor(metric: Assertion["metric"], actual: VerificationActual): number | boolean | undefined {
	if (metric === "score") return actual.score;
	if (metric === "pass") return actual.pass;
	return actual.failing.length;
}

function compare(op: Assertion["op"], left: number | boolean, right: number | boolean, tol = 0): boolean {
	// Preserve the reference semantics: when either side is boolean, every
	// operator except != acts as equality.
	if (typeof left === "boolean" || typeof right === "boolean") {
		const leftBoolean = Boolean(left);
		const rightBoolean = Boolean(right);
		return op === "!=" ? leftBoolean !== rightBoolean : leftBoolean === rightBoolean;
	}

	switch (op) {
		case ">=":
			return left >= right - tol;
		case "<=":
			return left <= right + tol;
		case ">":
			return left > right - tol;
		case "<":
			return left < right + tol;
		case "==":
			return Math.abs(left - right) <= tol;
		case "!=":
			return Math.abs(left - right) > tol;
	}
}

/** Evaluate typed claims against an observation, in declaration order. */
export function evaluateAssertions(
	prediction: { assertions?: Assertion[] },
	actual: VerificationActual,
): { assertion: Assertion; observed: number | boolean | undefined }[] {
	const failed: { assertion: Assertion; observed: number | boolean | undefined }[] = [];
	for (const assertion of prediction.assertions ?? []) {
		const observed = actualFor(assertion.metric, actual);
		// A metric the run omitted is unfalsified, not false. Otherwise every
		// unscored run would become detector noise.
		if (observed === undefined) continue;
		if (!compare(assertion.op, observed, assertion.value, assertion.tol ?? 0)) {
			failed.push({ assertion, observed });
		}
	}
	return failed;
}

export function detectSurprise(
	prediction: Prediction | null | undefined,
	actual: VerificationActual,
): SurpriseAnnotation | null {
	if (!prediction) return null;
	const failed = evaluateAssertions(prediction, actual);
	if (failed.length === 0) return null;

	const { assertion, observed } = failed[0]!;
	return {
		kind: "assertion_failed",
		detail:
			`Predicted ${assertion.metric} ${assertion.op} ${assertion.value}, observed ${observed}` +
			(failed.length > 1 ? ` (+${failed.length - 1} more)` : ""),
	};
}

function scoreValue(observation: VerificationActual): number | null {
	return observation.score === undefined ? null : observation.score;
}

/** Compare the complete normalized verifier observation, including failure order and score presence. */
export function compareVerificationResults(
	predicted: VerificationActual,
	actual: VerificationActual,
): { reproduces: boolean; diff: ObservationDiff[] } {
	const diff: ObservationDiff[] = [];
	if (predicted.pass !== actual.pass) {
		diff.push({ field: "pass", predicted: predicted.pass, actual: actual.pass });
	}
	if (
		predicted.failing.length !== actual.failing.length ||
		predicted.failing.some((failure, index) => failure !== actual.failing[index])
	) {
		diff.push({ field: "failing", predicted: predicted.failing, actual: actual.failing });
	}
	const predictedScore = scoreValue(predicted);
	const actualScore = scoreValue(actual);
	if (predictedScore !== actualScore) {
		diff.push({ field: "score", predicted: predictedScore, actual: actualScore });
	}
	return { reproduces: diff.length === 0, diff };
}

function formatObservationValue(value: ObservationDiff["actual"]): string {
	return value === null ? "<absent>" : JSON.stringify(value);
}

export function detectObservationSurprise(
	predicted: VerificationActual,
	actual: VerificationActual,
): SurpriseAnnotation | null {
	const comparison = compareVerificationResults(predicted, actual);
	if (comparison.reproduces) return null;

	const first = comparison.diff[0]!;
	return {
		kind: "assertion_failed",
		detail:
			`World model predicted ${first.field} ${formatObservationValue(first.predicted)}, observed ` +
			`${formatObservationValue(first.actual)}` +
			(comparison.diff.length > 1 ? ` (+${comparison.diff.length - 1} more fields)` : ""),
	};
}

export function combineSurprises(...surprises: (SurpriseAnnotation | null | undefined)[]): SurpriseAnnotation | null {
	const present = surprises.filter(
		(surprise): surprise is SurpriseAnnotation => surprise !== null && surprise !== undefined,
	);
	if (present.length === 0) return null;
	return {
		kind: "assertion_failed",
		detail: present.map(surprise => surprise.detail).join("; "),
	};
}

/** Pure replay comparison. With no observations, every recorded observation is reproduced vacuously (0/0 green). */
export function buildReplayReport(predictions: readonly ReplayPrediction[]): ReplayReport {
	const rows = predictions.map(({ step, actual, predicted, error }): ReplayComparisonRow => {
		if (!predicted) {
			return {
				step,
				actual,
				predicted: null,
				reproduces: false,
				diff: [],
				error: error ?? "World model produced no prediction.",
			};
		}
		const comparison = compareVerificationResults(predicted, actual);
		return {
			step,
			actual,
			predicted,
			reproduces: comparison.reproduces,
			diff: comparison.diff,
			...(error ? { error } : {}),
		};
	});
	const reproduced = rows.filter(row => row.reproduces).length;
	return {
		green: reproduced === rows.length,
		reproduced,
		total: rows.length,
		rows,
	};
}

export function parseWorldModelOutput(stdout: string): VerificationActual {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		throw new Error("World model stdout must be one JSON verifier result.");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("World model output must be an object.");
	}

	const result = parsed as Record<string, unknown>;
	const unexpected = Object.keys(result).filter(key => key !== "pass" && key !== "failing" && key !== "score");
	if (unexpected.length > 0) {
		throw new Error(`World model output has unexpected field: ${unexpected[0]}.`);
	}
	if (typeof result.pass !== "boolean") {
		throw new Error("World model output field 'pass' must be boolean.");
	}
	if (!Array.isArray(result.failing) || result.failing.some(value => typeof value !== "string")) {
		throw new Error("World model output field 'failing' must be an array of strings.");
	}
	if (Object.hasOwn(result, "score") && (typeof result.score !== "number" || !Number.isFinite(result.score))) {
		throw new Error("World model output field 'score' must be a finite number when present.");
	}

	return {
		pass: result.pass,
		failing: result.failing as string[],
		...(typeof result.score === "number" ? { score: result.score } : {}),
	};
}

/**
 * Reject the obvious integrity failure without pretending this static check is a
 * proof: direct textual use of the registered shell command (or its path-like
 * executable token) means the model can delegate to the real verifier.
 */
export function obviouslyInvokesVerifier(modelSource: string, verifyCmd: string): boolean {
	const command = verifyCmd.trim();
	if (!command) return false;
	const commandTokens = [...command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(
		match => match[1] ?? match[2] ?? match[3]!,
	);
	const executable = commandTokens[0];
	const invocation =
		/\b(?:bash|cmd|exec(?:File(?:Sync)?|Sync|[lvpe]+)?|fish|popen|powershell|run|sh|spawn|spawnSync|subprocess|system|zsh)\b|`/;
	let cursor = 0;
	const tokensAppearInOrder = commandTokens.every(token => {
		const index = modelSource.indexOf(token, cursor);
		if (index < 0) return false;
		cursor = index + token.length;
		return true;
	});
	if (invocation.test(modelSource) && tokensAppearInOrder) return true;
	if (
		executable &&
		(executable.includes("/") || executable.includes("\\")) &&
		invocation.test(modelSource) &&
		modelSource.includes(executable.replace(/^.*[/\\]/, ""))
	) {
		return true;
	}

	return modelSource
		.split(/\r?\n/)
		.map(line => line.trim().replace(/;$/, ""))
		.some(line => line === command || line === `exec ${command}`);
}

function parseLastScore(output: string): number | undefined {
	const pattern = /score[^+\d-]*(?<value>[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)/gi;
	let score: number | undefined;
	for (const match of output.matchAll(pattern)) {
		const value = Number(match.groups?.value);
		if (Number.isFinite(value)) score = value;
	}
	return score;
}

export function parseVerificationOutput(
	exitCode: number,
	stdout: string,
	stderr = "",
	scoreOutput = "",
): VerificationActual {
	const failing = `${stdout}\n${stderr}`
		.split(/\r?\n/)
		.map(line => line.trim())
		.filter(line => /\bFAIL|✗|\bnot ok\b/i.test(line) && !/\b0\s+fail/i.test(line));
	const score = parseLastScore(scoreOutput);

	return {
		pass: exitCode === 0,
		failing,
		...(score === undefined ? {} : { score }),
	};
}
