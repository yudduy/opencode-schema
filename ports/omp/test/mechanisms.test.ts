import { describe, expect, test } from "bun:test";
import {
	BASELINE_REQUIRED_REASON,
	baselineGatePredicate,
	buildReplayReport,
	combineSurprises,
	compareVerificationResults,
	deriveRunState,
	detectObservationSurprise,
	detectSurprise,
	evaluateAssertions,
	obviouslyInvokesVerifier,
	type Prediction,
	parseVerificationOutput,
	parseWorldModelOutput,
	type RunState,
	type TaskRegistration,
	verificationGatePredicate,
	type WorldModelRegistration,
	worldModelGatePredicate,
} from "../mechanisms";

const task: TaskRegistration = {
	version: 1,
	verify_cmd: "./verify.sh",
	score_cmd: "./score.sh",
	budget: 2,
};

const worldModel: WorldModelRegistration = {
	version: 1,
	path: "world-model.py",
};

function prediction(assertions: Prediction["assertions"]): Prediction {
	return { hypothesis: "typed claim", assertions, ts: 1 };
}

function run(overrides: Partial<RunState> = {}): RunState {
	return {
		task,
		baselineRecorded: false,
		verificationsUsed: 0,
		openPrediction: null,
		...overrides,
	};
}

describe("evaluateAssertions", () => {
	test("a satisfied assertion is not a refutation", () => {
		const failed = evaluateAssertions(prediction([{ metric: "score", op: ">=", value: 0.8 }]), {
			pass: true,
			failing: [],
			score: 0.9,
		});
		expect(failed).toEqual([]);
	});

	test("a violated assertion reports the observed value", () => {
		const failed = evaluateAssertions(prediction([{ metric: "score", op: ">=", value: 0.8 }]), {
			pass: true,
			failing: [],
			score: 0.42,
		});
		expect(failed).toHaveLength(1);
		expect(failed[0]?.observed).toBe(0.42);
	});

	test("a missing metric is unfalsified", () => {
		const failed = evaluateAssertions(prediction([{ metric: "score", op: ">=", value: 0.8 }]), {
			pass: true,
			failing: [],
		});
		expect(failed).toEqual([]);
	});

	test("tolerance, boolean pass, and failing_count match the reference semantics", () => {
		expect(
			evaluateAssertions(prediction([{ metric: "score", op: "==", value: 1, tol: 0.01 }]), {
				pass: true,
				failing: [],
				score: 1.005,
			}),
		).toEqual([]);
		expect(
			evaluateAssertions(prediction([{ metric: "pass", op: "==", value: true }]), {
				pass: false,
				failing: ["FAIL one"],
			}),
		).toHaveLength(1);
		expect(
			evaluateAssertions(prediction([{ metric: "failing_count", op: "<=", value: 0 }]), {
				pass: false,
				failing: ["FAIL one"],
			}),
		).toHaveLength(1);
	});
});

describe("detectSurprise", () => {
	test("a refuted assertion produces an observed-value annotation", () => {
		const surprise = detectSurprise(prediction([{ metric: "score", op: ">=", value: 0.8 }]), {
			pass: true,
			failing: [],
			score: 0.42,
		});
		expect(surprise).toEqual({
			kind: "assertion_failed",
			detail: "Predicted score >= 0.8, observed 0.42",
		});
	});

	test("a satisfied or unfalsified assertion produces no surprise", () => {
		const scored = prediction([{ metric: "score", op: ">=", value: 0.8 }]);
		expect(detectSurprise(scored, { pass: true, failing: [], score: 0.9 })).toBeNull();
		expect(detectSurprise(scored, { pass: true, failing: [] })).toBeNull();
	});

	test("a full observation mismatch produces the same assertion_failed treatment", () => {
		expect(
			detectObservationSurprise({ pass: true, failing: [], score: 0.9 }, { pass: true, failing: [], score: 0.42 }),
		).toEqual({
			kind: "assertion_failed",
			detail: "World model predicted score 0.9, observed 0.42",
		});
	});

	test("world-model and scalar surprises remain complementary", () => {
		const observation = detectObservationSurprise(
			{ pass: false, failing: ["FAIL predicted"] },
			{ pass: true, failing: [], score: 0.42 },
		);
		const scalar = detectSurprise(prediction([{ metric: "score", op: ">=", value: 0.8 }]), {
			pass: true,
			failing: [],
			score: 0.42,
		});
		expect(combineSurprises(observation, scalar)?.detail).toContain("World model predicted pass");
		expect(combineSurprises(observation, scalar)?.detail).toContain("Predicted score >= 0.8");
	});
});

describe("world-model replay", () => {
	test("exact full observations reproduce, while any field mismatch is red", () => {
		const actual = { pass: false, failing: ["FAIL alpha"], score: 0.5 };
		expect(compareVerificationResults(actual, actual)).toEqual({ reproduces: true, diff: [] });

		const report = buildReplayReport([
			{ step: 1, predicted: actual, actual },
			{
				step: 2,
				predicted: { pass: false, failing: ["FAIL beta"], score: 0.5 },
				actual,
			},
		]);
		expect(report).toMatchObject({ green: false, reproduced: 1, total: 2 });
		expect(report.rows[1]).toMatchObject({
			reproduces: false,
			diff: [{ field: "failing", predicted: ["FAIL beta"], actual: ["FAIL alpha"] }],
		});
	});

	test("empty history is green so the first verification has a legal path", () => {
		expect(buildReplayReport([])).toEqual({
			green: true,
			reproduced: 0,
			total: 0,
			rows: [],
		});
	});

	test("the full gate blocks red replay and allows green, but remains opt-in", () => {
		const red = buildReplayReport([
			{
				step: 1,
				predicted: { pass: false, failing: ["FAIL wrong"] },
				actual: { pass: true, failing: [] },
			},
		]);
		expect(worldModelGatePredicate("full", worldModel, red)?.reason).toContain("0/1 reproduced");
		expect(worldModelGatePredicate("full", worldModel, buildReplayReport([]))).toBeNull();
		expect(worldModelGatePredicate("full", null, red)).toBeNull();
		expect(worldModelGatePredicate("baseline", worldModel, red)).toBeNull();
	});
});

describe("world-model contract", () => {
	test("strict JSON output uses the parsed verifier-result shape", () => {
		expect(parseWorldModelOutput('{"pass":true,"failing":[],"score":0.75}\n')).toEqual({
			pass: true,
			failing: [],
			score: 0.75,
		});
		expect(() => parseWorldModelOutput('{"pass":true,"failing":[],"extra":1}')).toThrow("unexpected field");
		expect(() => parseWorldModelOutput("not json")).toThrow("must be one JSON");
	});

	test("an obvious predictor delegation to the real verifier is rejected", () => {
		expect(obviouslyInvokesVerifier("#!/bin/sh\nexec ./verify.sh\n", "./verify.sh")).toBeTrue();
		expect(obviouslyInvokesVerifier('#!/bin/sh\nexec "$1/verify.sh"\n', "./verify.sh")).toBeTrue();
		expect(obviouslyInvokesVerifier("#!/bin/sh\nbash ./verify.sh\n", "./verify.sh")).toBeTrue();
		expect(obviouslyInvokesVerifier('subprocess.run(["bun", "test"], cwd=sys.argv[1])', "bun test")).toBeTrue();
		expect(obviouslyInvokesVerifier('os.execv("./verify", ["./verify"])', "./verify")).toBeTrue();
		expect(obviouslyInvokesVerifier('child_process.execFile("./verify")', "./verify")).toBeTrue();
		expect(obviouslyInvokesVerifier(`#!/bin/sh\necho '{"pass":true,"failing":[]}'\n`, "./verify.sh")).toBeFalse();
	});
});

describe("gates", () => {
	test("Gate A blocks known mutators before baseline, then allows them", () => {
		expect(baselineGatePredicate(run(), "edit")).toEqual({
			block: true,
			reason: BASELINE_REQUIRED_REASON,
		});
		expect(baselineGatePredicate(run({ baselineRecorded: true }), "edit")).toBeNull();
		expect(baselineGatePredicate(run(), "read")).toBeNull();
		expect(baselineGatePredicate(null, "edit")).toBeNull();
	});

	test("Gate A includes the real OMP execution and AST mutation names", () => {
		expect(baselineGatePredicate(run(), "eval")).not.toBeNull();
		expect(baselineGatePredicate(run(), "ast_edit")).not.toBeNull();
	});

	test("Gate B exempts the one baseline, then blocks and allows full verification on prediction", () => {
		expect(verificationGatePredicate(run(), "baseline")).toBeNull();
		expect(verificationGatePredicate(run({ baselineRecorded: true }), "baseline")?.reason).toContain(
			"already recorded",
		);
		expect(verificationGatePredicate(run({ baselineRecorded: true }), "full")?.reason).toContain(
			"requires an open typed prediction",
		);
		expect(
			verificationGatePredicate(
				run({
					baselineRecorded: true,
					openPrediction: prediction([{ metric: "pass", op: "==", value: true }]),
				}),
				"full",
			),
		).toBeNull();
	});

	test("Gate B enforces the shared baseline and full budget", () => {
		const exhausted = run({ baselineRecorded: true, verificationsUsed: 2 });
		expect(verificationGatePredicate(exhausted, "full")?.reason).toContain("exhausted (2/2)");
	});
});

describe("deriveRunState", () => {
	test("every verification costs one and resolves the open prediction", () => {
		const open = prediction([{ metric: "pass", op: "==", value: true }]);
		const state = deriveRunState(task, [
			{
				ts: 1,
				step: 1,
				scope: "baseline",
				actual: { pass: true, failing: [], score: 0.5 },
				cost: 1,
			},
			{ ts: 2, step: 2, scope: "predict", prediction: open },
			{
				ts: 3,
				step: 3,
				scope: "full",
				prediction: open,
				actual: { pass: true, failing: [], score: 0.6 },
				cost: 1,
			},
		]);
		expect(state).toMatchObject({
			baselineRecorded: true,
			verificationsUsed: 2,
			openPrediction: null,
		});
	});
});

describe("parseVerificationOutput", () => {
	test("exit zero passes and ignores zero-failure summaries", () => {
		expect(parseVerificationOutput(0, "42 passed; 0 failed\n")).toEqual({
			pass: true,
			failing: [],
		});
	});

	test("nonzero exit fails and extracts failure lines from stdout and stderr", () => {
		expect(parseVerificationOutput(1, "ok\nFAIL alpha", "not ok 2\nignored")).toEqual({
			pass: false,
			failing: ["FAIL alpha", "not ok 2"],
		});
	});

	test("the last score from score output is extracted", () => {
		expect(parseVerificationOutput(0, "ok", "", "score 0.5\nSCORE: 0.75")).toEqual({
			pass: true,
			failing: [],
			score: 0.75,
		});
	});
});
