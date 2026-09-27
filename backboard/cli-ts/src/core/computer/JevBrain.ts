import type {
	SystemOneQuestion,
	SystemOneRequest,
	SystemOneResult,
} from "../../providers/backboard/types.ts";
import {
	type ComputerBrain,
	type ComputerMove,
	type ComputerTurn,
	describeElement,
	elementIds,
	type JevElement,
	OPERATIONS,
	type Operation,
	RULES,
} from "./JevUseLoop.ts";

/** Asks Jev one bounded question set. Backed by `AgentClient.systemOne`. */
export type JevDecider = (
	request: SystemOneRequest,
	options: { signal: AbortSignal },
) => Promise<SystemOneResult>;

/**
 * The agent acts on Jev's top choice unless that choice is barely ahead of
 * noise. Jev's "confidence" is concentration, not correctness: on real Spotify
 * it split 0.51 / 0.49 between clicking the suggestion and pressing Return,
 * both right, and a 0.4 confidence floor threw the run away.
 */
const MIN_OPERATION_PROBABILITY = 0.3;
const MIN_TARGET_PROBABILITY = 0.15;
/**
 * Asked only "what next?", Jev keeps acting: it toggled a switch back off after
 * the goal was met. A completion probability from the same request is checked
 * first so a finished task is never acted on again.
 */
const COMPLETE_THRESHOLD = 0.6;

/**
 * TypeSafe Jev through Backboard's System One route. Jev never writes text: it
 * picks an operation and a target from lists, and the loop's writer model
 * composes anything to be typed.
 */
export class JevBrain implements ComputerBrain {
	readonly name = "jev";

	constructor(private readonly decide: JevDecider) {}

	/**
	 * One request, several independent heads: which operation, and the best
	 * target for each operation that takes one. Only the head matching the chosen
	 * operation is used, so a target can never be paired with the wrong verb.
	 */
	async next(turn: ComputerTurn, signal: AbortSignal): Promise<ComputerMove> {
		const ids = elementIds(turn);
		const questions: Record<string, SystemOneQuestion> = {
			complete: {
				type: "noul",
				instructions:
					"Does the screen show that the whole goal has already been achieved, with nothing left to do?",
			},
			operation: {
				type: "choice",
				instructions: `${RULES}\nWhich single operation makes the most progress right now?`,
				criteria: Object.fromEntries(
					turn.offered.map((operation) => [operation, OPERATIONS[operation]]),
				),
			},
		};
		if (ids.draw.size) questions.draw_target = targetQuestion("DRAW", ids.draw);
		if (ids.click.size) {
			questions.click_target = targetQuestion("CLICK", ids.click);
		}
		if (ids.type.size) {
			questions.type_target = targetQuestion("TYPE_TEXT", ids.type);
		}

		const result = await this.decide(
			{
				state: {
					goal: turn.goal,
					window: turn.window,
					controls: [...turn.clickable, ...turn.editable, ...turn.canvases]
						.map(describeElement)
						.join("\n"),
					visible_text: turn.visibleText,
					recent_actions: JSON.stringify(turn.recentActions),
				},
				questions,
			},
			{ signal },
		);

		const operation = choiceOf(result, "operation", turn.offered);
		const complete = result.answers.complete;
		const move: ComputerMove = {
			unsure: operation.probability < MIN_OPERATION_PROBABILITY,
			operation: operation.choice as Operation,
			confidence: operation.confidence,
			complete: complete?.type === "noul" ? complete.noul : 0,
		};
		const head =
			move.operation === "CLICK"
				? { name: "click_target", ids: ids.click }
				: move.operation === "TYPE_TEXT"
					? { name: "type_target", ids: ids.type }
					: move.operation === "DRAW"
						? { name: "draw_target", ids: ids.draw }
						: undefined;
		if (head) {
			const target = choiceOf(result, head.name, [...head.ids.keys()]);
			move.target = head.ids.get(target.choice);
			move.confidence = Math.min(move.confidence, target.confidence);
			move.unsure ||= target.probability < MIN_TARGET_PROBABILITY;
		}
		if (move.complete >= COMPLETE_THRESHOLD) {
			move.operation = "DONE";
			move.unsure = false;
		}
		return move;
	}
}

function targetQuestion(
	operation: Operation,
	ids: Map<string, JevElement>,
): SystemOneQuestion {
	return {
		type: "choice",
		instructions: `${RULES}\nChoose the best target if the next operation is ${operation}. Another question decides the operation; this one only picks its target. Do not choose a field that already holds the requested value.`,
		criteria: Object.fromEntries(
			[...ids].map(([id, element]) => [id, describeElement(element)]),
		),
	};
}

/** The answer is only trusted as an index into the list that was sent. */
function choiceOf(
	result: SystemOneResult,
	name: string,
	allowed: readonly string[],
): { choice: string; confidence: number; probability: number } {
	const answer = result.answers[name];
	if (answer?.type !== "choice") {
		throw new Error(`Jev returned no ${name} choice.`);
	}
	if (!allowed.includes(answer.choice)) {
		throw new Error(`Jev selected an unknown ${name}: ${answer.choice}`);
	}
	const probability =
		answer.probabilities[answer.choice] ?? (allowed.length === 1 ? 1 : 0);
	if (!Number.isFinite(probability) || probability < 0 || probability > 1)
		throw new Error(`Jev returned an invalid ${name} probability.`);
	return {
		choice: answer.choice,
		confidence: answer.confidence,
		// Absent probabilities mean a single-option question: nothing to doubt.
		probability,
	};
}
