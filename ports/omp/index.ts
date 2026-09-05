import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
	type Assertion,
	baselineGatePredicate,
	buildReplayReport,
	combineSurprises,
	deriveRunState,
	detectObservationSurprise,
	detectSurprise,
	MUTATING_TOOL_NAMES,
	type Prediction,
	parseVerificationOutput,
	type ReplayReport,
	type TaskRegistration,
	type VerificationActual,
	type VerificationScope,
	verificationGatePredicate,
	type WorldModelRegistration,
	worldModelGatePredicate,
} from "./mechanisms";
import {
	appendLedger,
	captureCandidateSnapshot,
	readLedger,
	readRegistration,
	readWorldModel,
	resolveCandidateSnapshot,
	withSessionLock,
	writeRegistration,
	writeWorldModel,
} from "./state";
import { assertWorldModelSandboxAvailable, executeWorldModel, validateWorldModelExecutable } from "./world-model";

export * from "./mechanisms";
export { readLedger, readRegistration, readWorldModel, sessionStateDirectory } from "./state";

const VERIFY_TIMEOUT_MS = 600_000;
export const ASSERTION_REQUIRED_MESSAGE =
	"At least one typed assertion is required: prose-only predictions cannot be machine-refuted.";

function sessionContext(ctx: ExtensionContext): { worktree: string; sessionId: string; lockKey: string } {
	const worktree = ctx.sessionManager.getCwd();
	const sessionId = ctx.sessionManager.getSessionId();
	return { worktree, sessionId, lockKey: `${worktree}\0${sessionId}` };
}

function jsonResult(payload: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
		details: payload,
	};
}

function registrationsEqual(left: TaskRegistration, right: TaskRegistration): boolean {
	return left.verify_cmd === right.verify_cmd && left.score_cmd === right.score_cmd && left.budget === right.budget;
}

function registeredVerificationCommands(task: TaskRegistration): string[] {
	return [task.verify_cmd, ...(task.score_cmd ? [task.score_cmd] : [])];
}

function errorDetail(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function replayHistory(
	pi: Pick<ExtensionAPI, "exec">,
	session: { worktree: string; sessionId: string },
	task: TaskRegistration,
	worldModel: WorldModelRegistration,
	ledger: Awaited<ReturnType<typeof readLedger>>,
	signal?: AbortSignal,
): Promise<ReplayReport> {
	const predictions = [];
	for (const row of ledger) {
		if (row.scope === "predict") continue;
		if (!row.candidate) {
			predictions.push({
				step: row.step,
				actual: row.actual,
				error: "Candidate snapshot is unavailable for this legacy verification row.",
			});
			continue;
		}
		try {
			const candidate = await resolveCandidateSnapshot(session.worktree, session.sessionId, row.candidate);
			const predicted = await executeWorldModel(
				pi,
				session.worktree,
				worldModel,
				registeredVerificationCommands(task),
				candidate,
				signal,
			);
			predictions.push({ step: row.step, actual: row.actual, predicted });
		} catch (error) {
			predictions.push({ step: row.step, actual: row.actual, error: errorDetail(error) });
		}
	}
	return buildReplayReport(predictions);
}

function replayResult(report: ReplayReport) {
	return {
		reproduced: `${report.reproduced}/${report.total}`,
		green: report.green,
		rows: report.rows,
	};
}

export default function schemaHarnessExtension(pi: ExtensionAPI): void {
	const z = pi.zod;
	const operatorSchema = z.enum([">=", "<=", ">", "<", "==", "!="]);
	const assertionSchema = z.discriminatedUnion("metric", [
		z.object({
			metric: z.literal("score"),
			op: operatorSchema,
			value: z.number(),
			tol: z.number().optional(),
		}),
		z.object({
			metric: z.literal("failing_count"),
			op: operatorSchema,
			value: z.number(),
			tol: z.number().optional(),
		}),
		z.object({
			metric: z.literal("pass"),
			op: operatorSchema,
			value: z.boolean(),
			tol: z.number().optional(),
		}),
	]);

	pi.registerTool({
		name: "register_task",
		label: "Register Task",
		description:
			"Declare this task's verification commands and total scored-evaluation budget. Call this before editing.",
		parameters: z.object({
			verify_cmd: z.string().min(1),
			score_cmd: z.string().min(1).optional(),
			budget: z.number().int().positive(),
		}),
		loadMode: "essential",
		approval: "write",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const session = sessionContext(ctx);
			return withSessionLock(session.lockKey, async () => {
				const registration: TaskRegistration = {
					version: 1,
					verify_cmd: params.verify_cmd,
					...(params.score_cmd === undefined ? {} : { score_cmd: params.score_cmd }),
					budget: params.budget,
				};
				const existing = await readRegistration(session.worktree, session.sessionId);
				const ledger = await readLedger(session.worktree, session.sessionId);

				// Before evidence, correcting a registration is harmless. Afterwards,
				// only an identical retry is allowed; changing commands or budget would
				// launder the baseline or reset the accounting.
				if (existing && ledger.length > 0 && !registrationsEqual(existing, registration)) {
					throw new Error(
						"Task registration is locked after evidence exists. Start a new OMP session to change commands or budget.",
					);
				}
				if (!existing || !registrationsEqual(existing, registration)) {
					await writeRegistration(session.worktree, session.sessionId, registration);
				}

				const state = deriveRunState(registration, ledger);
				return jsonResult({
					registered: true,
					baselineRecorded: state.baselineRecorded,
					budget: {
						used: state.verificationsUsed,
						total: registration.budget,
						remaining: Math.max(0, registration.budget - state.verificationsUsed),
					},
				});
			});
		},
	});

	pi.registerTool({
		name: "set_world_model",
		label: "Set World Model",
		description:
			"Declare an executable offline predictor in the working tree. It receives a candidate snapshot path and prints one JSON verifier result.",
		parameters: z.object({
			path: z.string().min(1),
		}),
		loadMode: "essential",
		approval: "write",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const session = sessionContext(ctx);
			return withSessionLock(session.lockKey, async () => {
				const task = await readRegistration(session.worktree, session.sessionId);
				if (!task) throw new Error("Register the task before declaring a world model.");
				const ledger = await readLedger(session.worktree, session.sessionId);
				const unreplayable = ledger.filter(row => row.scope !== "predict" && !row.candidate);
				if (unreplayable.length > 0) {
					throw new Error(
						`Cannot declare a world model: ${unreplayable.length} existing verification row(s) lack candidate snapshots. ` +
							"Continue this session without a world model, or start a new OMP session and declare it before the baseline.",
					);
				}

				const validated = await validateWorldModelExecutable(
					session.worktree,
					params.path,
					registeredVerificationCommands(task),
				);
				await assertWorldModelSandboxAvailable(pi, session.worktree);
				await writeWorldModel(session.worktree, session.sessionId, validated.registration);

				return jsonResult({
					declared: true,
					worldModel: validated.registration,
					historyRows: ledger.filter(row => row.scope !== "predict").length,
					message: "Run replay_verify() to test the model against every recorded verification.",
				});
			});
		},
	});

	pi.registerTool({
		name: "run_verify",
		label: "Run Verification",
		description:
			"Run a charged scored evaluation. Use baseline exactly once before edits; every later full run requires a prediction.",
		parameters: z.object({
			scope: z.enum(["baseline", "full"]),
		}),
		loadMode: "essential",
		approval: "exec",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const session = sessionContext(ctx);
			return withSessionLock(session.lockKey, async () => {
				const task = await readRegistration(session.worktree, session.sessionId);
				const ledger = await readLedger(session.worktree, session.sessionId);
				const run = task ? deriveRunState(task, ledger) : null;
				const gate = verificationGatePredicate(run, params.scope);
				if (gate) throw new Error(gate.reason);
				if (!run) throw new Error("Register the task before verification.");
				const worldModel = await readWorldModel(session.worktree, session.sessionId);
				if (worldModel && params.scope === "full") {
					const replay = await replayHistory(pi, session, run.task, worldModel, ledger, signal);
					const replayGate = worldModelGatePredicate(params.scope, worldModel, replay);
					if (replayGate) throw new Error(replayGate.reason);
				}

				let candidateReference: string | undefined;
				let predicted: VerificationActual | undefined;
				if (worldModel) {
					try {
						candidateReference = await captureCandidateSnapshot(session.worktree, session.sessionId);
						const candidate = await resolveCandidateSnapshot(
							session.worktree,
							session.sessionId,
							candidateReference,
						);
						predicted = await executeWorldModel(
							pi,
							session.worktree,
							worldModel,
							registeredVerificationCommands(run.task),
							candidate,
							signal,
						);
					} catch (error) {
						throw new Error(
							`World-model preflight failed before evaluation; no budget was spent: ${errorDetail(error)}`,
						);
					}
				}
				const verify = await pi.exec("bash", ["-lc", run.task.verify_cmd], {
					cwd: session.worktree,
					signal,
					timeout: VERIFY_TIMEOUT_MS,
				});
				let scoreOutput = "";
				if (run.task.score_cmd) {
					const score = await pi.exec("bash", ["-lc", run.task.score_cmd], {
						cwd: session.worktree,
						signal,
						timeout: VERIFY_TIMEOUT_MS,
					});
					scoreOutput = `${score.stdout}\n${score.stderr}`;
				}

				const actual = parseVerificationOutput(
					verify.killed ? 124 : verify.code,
					verify.stdout,
					verify.stderr,
					scoreOutput,
				);
				const prediction = run.openPrediction;
				const surprise = combineSurprises(
					predicted ? detectObservationSurprise(predicted, actual) : null,
					detectSurprise(prediction, actual),
				);
				const row = await appendLedger(session.worktree, session.sessionId, {
					ts: Date.now(),
					scope: params.scope as VerificationScope,
					...(candidateReference ? { candidate: candidateReference } : {}),
					...(prediction ? { prediction } : {}),
					...(predicted ? { predicted } : {}),
					actual,
					cost: 1,
					...(surprise ? { surprise } : {}),
				});
				const used = run.verificationsUsed + 1;

				return jsonResult({
					scope: row.scope,
					...(predicted ? { predicted } : {}),
					actual,
					...(surprise ? { surprise } : {}),
					budget: {
						used,
						total: run.task.budget,
						remaining: Math.max(0, run.task.budget - used),
					},
				});
			});
		},
	});

	pi.registerTool({
		name: "replay_verify",
		label: "Replay Verification",
		description:
			"Run the declared world model against every recorded candidate and compare complete predicted observations. Replay is free.",
		parameters: z.object({}),
		loadMode: "essential",
		approval: "exec",
		async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
			const session = sessionContext(ctx);
			return withSessionLock(session.lockKey, async () => {
				const task = await readRegistration(session.worktree, session.sessionId);
				if (!task) throw new Error("Register the task before replay.");
				const worldModel = await readWorldModel(session.worktree, session.sessionId);
				if (!worldModel) throw new Error("Declare a world model with set_world_model before replay.");
				const ledger = await readLedger(session.worktree, session.sessionId);
				const report = await replayHistory(pi, session, task, worldModel, ledger, signal);
				const run = deriveRunState(task, ledger);

				return jsonResult({
					...replayResult(report),
					cost: 0,
					budget: {
						used: run.verificationsUsed,
						total: task.budget,
						remaining: Math.max(0, task.budget - run.verificationsUsed),
					},
				});
			});
		},
	});

	pi.registerTool({
		name: "predict",
		label: "Predict",
		description:
			"Record one falsifiable hypothesis with typed assertions. A verification resolves it; only one may be open.",
		parameters: z.object({
			hypothesis: z.string().min(1),
			assertions: z.array(assertionSchema).min(1, ASSERTION_REQUIRED_MESSAGE),
		}),
		loadMode: "essential",
		approval: "write",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const session = sessionContext(ctx);
			return withSessionLock(session.lockKey, async () => {
				const task = await readRegistration(session.worktree, session.sessionId);
				if (!task) throw new Error("Register the task before recording a prediction.");
				const ledger = await readLedger(session.worktree, session.sessionId);
				const run = deriveRunState(task, ledger);
				if (run.openPrediction) {
					throw new Error(
						`A prediction is already open: "${run.openPrediction.hypothesis.slice(0, 120)}". Run verification before predicting again.`,
					);
				}

				const prediction: Prediction = {
					hypothesis: params.hypothesis,
					assertions: params.assertions as Assertion[],
					ts: Date.now(),
				};
				await appendLedger(session.worktree, session.sessionId, {
					ts: prediction.ts,
					scope: "predict",
					prediction,
				});
				return jsonResult({
					recorded: true,
					prediction,
					message: "Prediction recorded. The next verification will evaluate and resolve it.",
				});
			});
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		// Unknown tools stay allowed by design. OMP does not expose their approval
		// tier, and false-positive blocking spends the wall clock that bound the
		// measured runs.
		if (!MUTATING_TOOL_NAMES.has(event.toolName)) return;
		try {
			const session = sessionContext(ctx);
			const task = await readRegistration(session.worktree, session.sessionId);
			if (!task) return;
			const ledger = await readLedger(session.worktree, session.sessionId);
			const decision = baselineGatePredicate(deriveRunState(task, ledger), event.toolName);
			return decision ?? undefined;
		} catch (error) {
			// Fail OPEN. This hook runs before every mutating tool call in the host,
			// including sessions that never opted into the harness. A gate that cannot
			// read its own state is a broken gate, not grounds for halting the user's
			// work, so surface it and get out of the way.
			console.error("[schema] baseline gate failed open:", error);
			return;
		}
	});
}
