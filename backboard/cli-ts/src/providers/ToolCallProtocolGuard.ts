import { canonicalToolName } from "../core/tools/names.ts";
import { canonicalToolInput } from "../core/tools/ToolCallIdentity.ts";
import type { ProviderEvent } from "./backboard/types.ts";

/** Per-attempt guard. No argument-shape inference and no automatic retry of protocol failures. */
export class ToolCallProtocolGuard {
	private readonly names = new Map<string, string>();
	private finalSignature: string | undefined;
	private failure: string | undefined;

	accept(event: ProviderEvent): ProviderEvent {
		if (this.failure) return { kind: "failed", error: this.failure };
		const calls =
			event.kind === "tool_ready"
				? [event.call]
				: event.kind === "requires_action"
					? event.calls
					: [];
		const identities = new Map<string, string>();
		const uniqueCalls = [];
		for (const call of calls) {
			if (!call.id || !call.name)
				return this.fail("a call is missing its ID or name");
			const name = canonicalToolName(call.name);
			const identity = canonicalToolInput({ name, input: call.input });
			const existing = identities.get(call.id);
			if (existing !== undefined) {
				if (existing !== identity)
					return this.fail(
						"duplicate call ID in final list has conflicting name or arguments",
					);
				// Repeated delivery of one invocation is not another invocation.
				continue;
			}
			identities.set(call.id, identity);
			uniqueCalls.push(call);
			const previous = this.names.get(call.id);
			if (previous && previous !== name)
				return this.fail(
					`call ${call.id} changed tool name from ${previous} to ${name}`,
				);
			this.names.set(call.id, name);
		}
		if (event.kind === "requires_action") {
			event = { ...event, calls: uniqueCalls };
			const signature = canonicalToolInput(
				event.calls.map((call) => ({
					id: call.id,
					name: canonicalToolName(call.name),
					input: call.input,
				})),
			);
			if (this.finalSignature && this.finalSignature !== signature)
				return this.fail("the finalized call list changed");
			this.finalSignature = signature;
		}
		return event;
	}

	private fail(detail: string): ProviderEvent {
		this.failure = `Tool protocol error: ${detail}. No final tool batch was executed. Retry with consistent call IDs, names, and arguments.`;
		return { kind: "failed", error: this.failure, retryable: false };
	}
}
