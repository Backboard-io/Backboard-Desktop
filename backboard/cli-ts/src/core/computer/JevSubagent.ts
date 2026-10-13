import type { EventBus } from "../bus/EventBus.ts";
import type { JevTaskResult, JevTaskStep } from "./ComputerTypes.ts";

/**
 * Presents a computer-use run as a sub-agent of the tool call that started it.
 * A host keys a sub-agent on the parent tool-call id alone, so emitting the
 * same events a spawned worker does is enough for it to show a named agent with
 * each action nested beneath it, running and then done.
 *
 * Nothing here thinks: it only reports what the loop's brain decided.
 */
export class JevSubagent {
	private readonly started = new Set<number>();
	private readonly childSessionId = `jev_${Date.now().toString(36)}`;
	private ended = false;

	constructor(
		private readonly bus: EventBus,
		private readonly parentToolCallId: string,
	) {}

	/** `brain` is the model id, as in `openrouter/deepseek/deepseek-v4.1-flash`. */
	start(brain: string, appName: string, goal: string): void {
		this.bus.emit({
			type: "agent:child_start",
			agentName: `${brainLabel(brain)} · ${appName}`,
			agentToolCallId: this.parentToolCallId,
			childSessionId: this.childSessionId,
			prompt: goal,
		});
	}

	/** Before the action is carried out, so the row shows as running. */
	stepStarted(step: JevTaskStep): void {
		if (this.started.has(step.step)) return;
		this.started.add(step.step);
		this.bus.emit({
			type: "agent:child_tool_start",
			agentToolCallId: this.parentToolCallId,
			call: {
				id: this.childId(step),
				name: "Computer",
				inputSummary: describeStep(step),
				status: "running",
			},
		});
	}

	/** After the action, or straight away for a step that acts on nothing. */
	stepFinished(step: JevTaskStep, failed = false): void {
		this.stepStarted(step);
		this.bus.emit({
			type: "agent:child_tool_result",
			agentToolCallId: this.parentToolCallId,
			childToolCallId: this.childId(step),
			status: failed ? "error" : "done",
		});
	}

	end(status: "completed" | "failed" | "cancelled"): void {
		if (this.ended) return;
		this.ended = true;
		this.bus.emit({
			type: "agent:child_end",
			agentToolCallId: this.parentToolCallId,
			status,
		});
	}

	/**
	 * Closes with the agent's own account of how it went. Only a genuine failure
	 * ends the turn as failed: a host shows that as an unexplained error banner,
	 * which is the wrong reading of "I stalled, handing this back".
	 */
	endWith(result: JevTaskResult): void {
		const last = result.steps.at(-1);
		// A step that was announced but whose action threw never got its result.
		if (last && result.outcome === "failed") this.stepFinished(last, true);
		this.say([result.summary, result.error].filter(Boolean).join(" "));
		this.end(result.outcome === "failed" ? "failed" : "completed");
	}

	private say(text: string): void {
		if (!text || this.ended) return;
		this.bus.emit({
			type: "agent:child_event",
			agentToolCallId: this.parentToolCallId,
			event: {
				type: "assistant:message",
				turnId: this.childSessionId,
				messageId: `${this.parentToolCallId}:jev:report`,
				text,
			},
		});
	}

	private childId(step: JevTaskStep): string {
		return `${this.parentToolCallId}:jev:${step.step}`;
	}
}

/** `deepseek-v4.1-flash` for a routed model id, `Jev` for Jev. */
function brainLabel(brain: string): string {
	return brain === "jev" ? "Jev" : (brain.split("/").at(-1) ?? brain);
}

/** One line per action: `CLICK AXButton "Search"`, `TYPE_TEXT … "Justin Bieber" + Return`. */
export function describeStep(step: JevTaskStep): string {
	return [
		step.operation,
		step.target,
		step.text ? JSON.stringify(step.text) : "",
		step.submitted ? "+ Return" : "",
	]
		.filter(Boolean)
		.join(" ");
}
