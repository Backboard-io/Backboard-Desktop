import { shortId } from "../../utils/id.ts";
import type { EventBus } from "../bus/EventBus.ts";
import type {
	PermissionGateDecision,
	PermissionGateRequest,
	PermissionPolicy,
} from "./ToolPermissionGateTypes.ts";

/**
 * Interactive approval gate for non-read-only tool calls, used by serve mode.
 *
 * With the `default` policy each gated call emits a `permission:request` event
 * and blocks until the host answers through `respond()` (driven by the serve
 * control channel). `autoApprove` and `autopilot` short-circuit to approval so
 * the gate is inert unless the host asked for confirmation. The interactive
 * CLI does not construct a gate at all, which keeps standalone behavior
 * unchanged.
 */
export class ToolPermissionGate {
	private policy: PermissionPolicy;
	private readonly pending = new Map<
		string,
		(decision: PermissionGateDecision) => void
	>();

	constructor(
		private readonly bus: EventBus,
		policy: PermissionPolicy = "default",
	) {
		this.policy = policy;
	}

	get currentPolicy(): PermissionPolicy {
		return this.policy;
	}

	setPolicy(policy: PermissionPolicy): void {
		this.policy = policy;
	}

	/**
	 * Requests approval for one tool call. Resolves immediately under
	 * `autoApprove`/`autopilot`; otherwise emits `permission:request` and waits
	 * for `respond()` or abort.
	 */
	request(
		request: PermissionGateRequest,
		signal: AbortSignal,
	): Promise<PermissionGateDecision> {
		if (this.policy !== "default") {
			return Promise.resolve({ decision: "approve" });
		}

		const id = shortId("perm");
		// Park the resolver before emitting so a listener that answers
		// synchronously from the emit still finds the pending request.
		const decision = new Promise<PermissionGateDecision>((resolve, reject) => {
			this.pending.set(id, resolve);
			signal.addEventListener(
				"abort",
				() => {
					if (this.pending.delete(id)) reject(new Error("aborted"));
				},
				{ once: true },
			);
		});
		this.bus.emit({
			type: "permission:request",
			request: { id, ...request },
		});
		return decision;
	}

	/** Resolves a pending permission request raised by `request()`. */
	respond(id: string, decision: PermissionGateDecision): boolean {
		const resolve = this.pending.get(id);
		if (!resolve) return false;
		this.pending.delete(id);
		this.bus.emit({
			type: "permission:response",
			response: { id, decision: decision.decision, reason: decision.reason },
		});
		resolve(decision);
		return true;
	}

	/** Drops all outstanding requests, e.g. on turn cancellation. */
	clear(): void {
		this.pending.clear();
	}
}
