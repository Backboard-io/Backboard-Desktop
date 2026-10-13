import { isAbsolute, relative, resolve } from "node:path";
import type { Tool } from "../tools/Tool.ts";
import { findMatch, type PermissionRule } from "./PermissionRules.ts";
import type { PermissionContext } from "./types.ts";

export type EngineDecision =
	| { behavior: "allow"; reason: string }
	| { behavior: "deny"; reason: string }
	| { behavior: "ask"; content?: string };

function normalizedPathRules(
	rules: PermissionRule[],
	cwd: string,
): PermissionRule[] {
	return rules.map((rule) => {
		if (!rule.pattern || rule.pattern.startsWith("=")) return rule;
		return { ...rule, pattern: resolve(cwd, rule.pattern) };
	});
}

/**
 * The permission pipeline. First match wins:
 * deny rule → ask rule → tool verdict → read-only → bypass → allow rule → ask.
 * Deny/ask rules sit above the bypass gate on purpose: no mode can skip them.
 *
 * Manual mode prompts for reads too, but only where a human can answer: a
 * sub-agent or headless run has no prompt, so an "ask" there is a hard denial.
 * Those keep the read-only shortcut instead of failing every Read and Grep.
 */
export function decidePermission(
	tool: Tool,
	input: unknown,
	pctx: PermissionContext,
	cwd: string,
): EngineDecision {
	const content = tool.permissionContent(input);
	const rawPaths = tool.permissionPaths(input);
	const executionPaths = rawPaths?.map((path) => resolve(cwd, path));
	const paths = executionPaths?.map((path) =>
		pctx.mapPathForRules ? pctx.mapPathForRules(path) : path,
	);
	const ruleCwd = pctx.ruleCwd ?? cwd;
	const contentCandidates = permissionContentCandidates(
		tool,
		input,
		content,
		rawPaths,
		paths,
		ruleCwd,
	);
	const denyRules = paths
		? normalizedPathRules(pctx.rules.deny, ruleCwd)
		: pctx.rules.deny;
	const askRules = paths
		? normalizedPathRules(pctx.rules.ask, ruleCwd)
		: pctx.rules.ask;
	const allowRules = paths
		? normalizedPathRules(pctx.rules.allow, ruleCwd)
		: pctx.rules.allow;
	const name = tool.agentName;
	const strictManual = pctx.mode === "manual" && pctx.interactive;

	const denyRule = findFirstMatch(denyRules, name, contentCandidates, paths);
	if (denyRule) {
		return {
			behavior: "deny",
			reason: `Denied by permission rule "${denyRule.raw}"`,
		};
	}

	const askRule = findFirstMatch(askRules, name, contentCandidates, paths);
	if (askRule) {
		return content === undefined
			? { behavior: "ask" }
			: { behavior: "ask", content };
	}

	const verdict = tool.checkPermissions(input, {
		mode: pctx.mode,
		cwd,
		interactive: pctx.interactive,
	});
	if (verdict) return verdict;

	if (!strictManual && tool.isReadOnly(input)) {
		return { behavior: "allow", reason: "read-only tool" };
	}

	if (pctx.mode === "bypass") {
		return { behavior: "allow", reason: "bypass mode" };
	}

	const allowRule = findFirstMatch(
		allowRules,
		name,
		contentCandidates,
		paths,
		true,
	);
	if (allowRule) {
		return {
			behavior: "allow",
			reason: `Allowed by permission rule "${allowRule.raw}"`,
		};
	}

	return content === undefined
		? { behavior: "ask" }
		: { behavior: "ask", content };
}

function findFirstMatch(
	rules: PermissionRule[],
	toolName: string,
	contents: readonly (string | undefined)[],
	paths?: readonly string[],
	requireAllPaths = false,
): PermissionRule | null {
	for (const content of contents) {
		const match = findMatch(rules, toolName, content, paths, requireAllPaths);
		if (match) return match;
	}
	return null;
}

/**
 * Exact path rules retain both the model-facing spelling and the coordinator
 * identity. This lets relative grants keep working in a hidden worktree while
 * absolute deny/ask rules still protect their original coordinator files.
 */
function permissionContentCandidates(
	tool: Tool,
	input: unknown,
	content: string | undefined,
	rawPaths: readonly string[] | undefined,
	mappedPaths: readonly string[] | undefined,
	ruleCwd: string,
): Array<string | undefined> {
	const candidates = new Set<string | undefined>([content]);
	if (
		!rawPaths?.length ||
		!mappedPaths?.length ||
		!tool.permissionContentIsPaths(
			input as Parameters<typeof tool.permissionContentIsPaths>[0],
		)
	) {
		return [...candidates];
	}
	const preserveRelative = rawPaths.map((path, index) =>
		isAbsolute(path) ? (mappedPaths[index] ?? path) : path,
	);
	const coordinatorRelative = mappedPaths.map((path) =>
		relative(ruleCwd, path),
	);
	const encoded =
		rawPaths.length === 1 && content === rawPaths[0]
			? (paths: readonly string[]) => paths[0]
			: encodePathList;
	candidates.add(encoded(preserveRelative));
	candidates.add(encoded(mappedPaths));
	candidates.add(encoded(coordinatorRelative));
	return [...candidates];
}

function encodePathList(paths: readonly string[]): string {
	return paths
		.map((path) => path.replaceAll("\\", "\\\\").replaceAll(" ", "\\ "))
		.join(" ");
}
