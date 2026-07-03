/**
 * How the permission gate treats tool calls that are not read-only.
 *
 * - `default`: every non-read-only tool call emits `permission:request` and
 *   waits for an external `approve`/`deny` decision.
 * - `autoApprove`: all tool calls run without asking.
 * - `autopilot`: like `autoApprove`, but signals the host chose fully
 *   autonomous iteration; the gate itself behaves identically.
 */
export type PermissionPolicy = "default" | "autoApprove" | "autopilot";

export type PermissionDecision = "approve" | "deny";

export interface PermissionGateRequest {
	toolCallId: string;
	name: string;
	inputSummary: string;
}

export interface PermissionGateDecision {
	decision: PermissionDecision;
	reason?: string;
}
