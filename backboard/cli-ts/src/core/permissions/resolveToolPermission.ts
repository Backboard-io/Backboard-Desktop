import { measurePerformance } from "../performance/PerformanceTiming.ts";
import type { Tool } from "../tools/Tool.ts";
import { throwIfAborted } from "../tools/ToolAbort.ts";
import type { ToolContext } from "../tools/ToolContext.ts";
import { decidePermission } from "./PermissionEngine.ts";
import { promptForPermission, suggestRule } from "./PermissionPrompter.ts";
import { parseRule } from "./PermissionRules.ts";
import { appendAllowRules } from "./settings.ts";
import type { PermissionContext } from "./types.ts";

export interface GateResult {
	allowed: boolean;
	denialReason?: string;
}

export interface ToolPermissionRequest {
	tool: Tool;
	input: unknown;
}

const promptTails = new WeakMap<PermissionContext, Promise<void>>();

async function waitForPromptTurn(
	previous: Promise<void>,
	signal: AbortSignal,
): Promise<void> {
	if (signal.aborted) throwIfAborted(signal);
	await new Promise<void>((resolve, reject) => {
		const abort = () => reject(new Error("aborted"));
		signal.addEventListener("abort", abort, { once: true });
		previous.then(
			() => {
				signal.removeEventListener("abort", abort);
				resolve();
			},
			(error) => {
				signal.removeEventListener("abort", abort);
				reject(error);
			},
		);
	});
}

async function withPromptLock<T>(
	pctx: PermissionContext,
	signal: AbortSignal,
	run: () => Promise<T>,
): Promise<T> {
	const previous = promptTails.get(pctx) ?? Promise.resolve();
	let release = (): void => {};
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	const tail = previous.then(() => current);
	promptTails.set(pctx, tail);
	try {
		await waitForPromptTurn(previous, signal);
		throwIfAborted(signal);
		return await run();
	} finally {
		release();
		void tail.then(() => {
			if (promptTails.get(pctx) === tail) promptTails.delete(pctx);
		});
	}
}

/**
 * Resolves a tool call against the permission system. Called by
 * ToolInvocationRunner between pre-tool hooks and execution. Absent
 * ctx.permissions = gate disabled (tests, legacy call sites).
 */
export async function resolveToolPermission(
	tool: Tool,
	input: unknown,
	ctx: ToolContext,
): Promise<GateResult> {
	return (
		(await resolveToolPermissions([{ tool, input }], ctx))[0] ?? {
			allowed: true,
		}
	);
}

/**
 * Resolves one scheduler execution batch through a single permission prompt.
 * Decisions stay per call: configured allow/deny rules are evaluated
 * independently, and an "always" response persists every exact suggested
 * rule rather than broadening the batch into one aggregate grant.
 */
export async function resolveToolPermissions(
	requests: readonly ToolPermissionRequest[],
	ctx: ToolContext,
): Promise<GateResult[]> {
	if (requests.length === 0) return [];
	const pctx = ctx.permissions;
	if (!pctx) return requests.map(() => ({ allowed: true }));

	const results: Array<GateResult | undefined> = requests.map(() => undefined);
	const askIndexes: number[] = [];
	for (let index = 0; index < requests.length; index++) {
		const request = requests[index];
		if (!request) continue;
		const decision = decidePermission(
			request.tool,
			request.input,
			pctx,
			ctx.cwd,
		);
		if (decision.behavior === "allow") {
			results[index] = { allowed: true };
		} else if (decision.behavior === "deny") {
			results[index] = { allowed: false, denialReason: decision.reason };
		} else {
			askIndexes.push(index);
		}
	}
	if (askIndexes.length === 0) return completeResults(results);

	// behavior === "ask"
	if (!pctx.interactive) {
		for (const index of askIndexes) {
			const request = requests[index];
			if (!request) continue;
			results[index] = {
				allowed: false,
				denialReason: `Permission required for ${request.tool.displayName} — permission prompts are unavailable in this context.`,
			};
		}
		return completeResults(results);
	}

	return await measurePerformance(
		ctx.bus,
		"permission_wait",
		{ fileCount: requests.length },
		async () =>
			await withPromptLock(pctx, ctx.signal, async () => {
				// Another batch may have persisted allow rules while this one waited.
				// Re-evaluate every pending call and prompt only for the remainder.
				const remaining: Array<{
					index: number;
					request: ToolPermissionRequest;
					content: string | undefined;
					rule: string;
				}> = [];
				for (const index of askIndexes) {
					const request = requests[index];
					if (!request) continue;
					const decision = decidePermission(
						request.tool,
						request.input,
						pctx,
						ctx.cwd,
					);
					if (decision.behavior === "allow") {
						results[index] = { allowed: true };
						continue;
					}
					if (decision.behavior === "deny") {
						results[index] = {
							allowed: false,
							denialReason: decision.reason,
						};
						continue;
					}
					remaining.push({
						index,
						request,
						content: decision.content,
						rule: suggestRule(
							request.tool.agentName,
							decision.content,
							request.tool.permissionContentIsPaths(
								request.input as Parameters<
									typeof request.tool.permissionContentIsPaths
								>[0],
							),
						),
					});
				}
				if (remaining.length === 0) return completeResults(results);

				const question = permissionQuestion(remaining);
				throwIfAborted(ctx.signal);
				const answer = await promptForPermission(
					question,
					[...new Set(remaining.map((entry) => entry.rule))].join("; "),
					ctx.askUser,
					ctx.signal,
				);

				if (answer === "deny") {
					for (const entry of remaining) {
						results[entry.index] = {
							allowed: false,
							denialReason: "User denied permission for this action.",
						};
					}
					return completeResults(results);
				}
				if (answer === "always") {
					const persistentRules: string[] = [];
					for (const raw of new Set(remaining.map((entry) => entry.rule))) {
						const rule = parseRule(raw, "allow");
						if (rule) {
							pctx.rules.allow.push(rule);
							persistentRules.push(raw);
						}
					}
					appendAllowRules(ctx.cwd, persistentRules);
				}
				for (const entry of remaining) {
					results[entry.index] = { allowed: true };
				}
				return completeResults(results);
			}),
	);
}

function permissionQuestion(
	entries: readonly {
		request: ToolPermissionRequest;
		content: string | undefined;
	}[],
): string {
	if (entries.length === 1) {
		const entry = entries[0];
		if (!entry) return "Allow this action?";
		return singlePermissionQuestion(entry.request, entry.content);
	}
	const lines = entries.map((entry, index) => {
		const summary = entry.request.tool.summarizeInput(
			entry.request.input as Parameters<
				typeof entry.request.tool.summarizeInput
			>[0],
		);
		const detail = summary ?? entry.content;
		const action = detail
			? `${entry.request.tool.displayName}: ${detail}`
			: entry.request.tool.displayName;
		const hint = entry.request.tool.permissionHint(
			entry.request.input as Parameters<
				typeof entry.request.tool.permissionHint
			>[0],
		);
		return `${index + 1}. ${action}${hint ? ` — ${hint}` : ""}`;
	});
	return `Allow these ${entries.length} actions?\n${lines.join("\n")}`;
}

function singlePermissionQuestion(
	request: ToolPermissionRequest,
	content?: string,
): string {
	const summary = request.tool.summarizeInput(
		request.input as Parameters<typeof request.tool.summarizeInput>[0],
	);
	const detail = summary ?? content;
	const base = detail
		? `Allow ${request.tool.displayName}: ${detail}?`
		: `Allow ${request.tool.displayName}?`;
	const hint = request.tool.permissionHint(
		request.input as Parameters<typeof request.tool.permissionHint>[0],
	);
	return hint ? `${base} ${hint}` : base;
}

function completeResults(
	results: readonly (GateResult | undefined)[],
): GateResult[] {
	return results.map(
		(result) =>
			result ?? {
				allowed: false,
				denialReason: "Permission resolution did not produce a decision.",
			},
	);
}
