import type { ProviderEvent, ProviderToolCall } from "./backboard/types.ts";

interface ToolDelta {
	index?: number;
	id?: string;
	function?: { name?: string; arguments?: string };
}

interface PendingCall {
	id?: string;
	name: string;
	args: string;
	announced: boolean;
}

/** OpenAI-compatible indexed argument deltas. Real IDs are immutable once received. */
export class ToolCallDeltaAccumulator {
	private readonly pending = new Map<number, PendingCall>();
	private readonly prefix = `provider_stream_${nextAccumulatorId++}`;
	private readonly knownNames: ReadonlySet<string>;
	private failure: string | undefined;

	constructor(names: readonly string[]) {
		this.knownNames = new Set(names);
	}

	get size(): number {
		return this.pending.size;
	}

	add(deltas: readonly ToolDelta[]): ProviderEvent[] {
		const events: ProviderEvent[] = [];
		for (const delta of deltas) {
			let index = delta.index;
			if (index === undefined) {
				const matching = delta.id
					? [...this.pending].find(([, call]) => call.id === delta.id)?.[0]
					: undefined;
				if (matching !== undefined) index = matching;
				else if (deltas.length === 1 && this.pending.size <= 1)
					index = this.pending.keys().next().value ?? 0;
				else {
					this.failure = "ambiguous tool delta without an index";
					break;
				}
			}
			if (!Number.isInteger(index) || index < 0) {
				this.failure = "invalid tool-call index";
				break;
			}
			const current = this.pending.get(index) ?? {
				name: "",
				args: "",
				announced: false,
			};
			if (delta.id) {
				if (current.id && current.id !== delta.id) {
					this.failure = "tool-call index changed its real ID";
					break;
				}
				if (
					[...this.pending].some(
						([other, call]) => other !== index && call.id === delta.id,
					)
				) {
					this.failure = "one tool ID appeared at multiple indices";
					break;
				}
				current.id = delta.id;
			}
			if (delta.function?.name) {
				const fragment = delta.function.name;
				// Some gateways repeat a complete name. Never deduplicate argument
				// bytes: repeated JSON fragments can be semantically meaningful.
				if (fragment !== current.name || !this.knownNames.has(fragment))
					current.name += fragment;
			}
			current.args += delta.function?.arguments ?? "";
			this.pending.set(index, current);
			if (!current.announced && this.knownNames.has(current.name)) {
				current.announced = true;
				events.push({
					kind: "tool_started",
					id: current.id ?? `${this.prefix}_${index}`,
					name: current.name,
				});
			}
		}
		if (this.failure)
			return [
				{
					kind: "failed",
					error: `Tool protocol error: ${this.failure}`,
					retryable: false,
				},
			];
		return events;
	}

	finish(): { calls: ProviderToolCall[] } | { error: string } {
		if (this.failure) return { error: `Tool protocol error: ${this.failure}` };
		const calls: ProviderToolCall[] = [];
		for (const [, pending] of [...this.pending].sort(([a], [b]) => a - b)) {
			if (!pending.id || !pending.name)
				return {
					error:
						"Tool protocol error: final call is missing its real ID or name",
				};
			let input: unknown;
			try {
				input = JSON.parse(pending.args || "{}");
			} catch {
				return {
					error: "Tool protocol error: final call arguments are not valid JSON",
				};
			}
			calls.push({ id: pending.id, name: pending.name, input });
		}
		return { calls };
	}
}

let nextAccumulatorId = 0;
