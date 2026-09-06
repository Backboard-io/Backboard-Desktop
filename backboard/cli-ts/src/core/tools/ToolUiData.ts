/**
 * Compact, JSON-safe data that the desktop client may persist and use for
 * native tool-call presentation. This is intentionally narrower than each
 * tool's model-facing input/output: large file bodies, screenshots, and typed
 * text must never be copied wholesale into chat metadata.
 */

export const BACKBOARD_TOOL_KINDS = [
	"read",
	"grep",
	"glob",
	"fetchUrl",
	"webSearch",
	"todo",
	"computer",
	"browser",
	"findSkill",
	"findMcp",
] as const;

export type BackboardToolKind = (typeof BACKBOARD_TOOL_KINDS)[number];

export interface BackboardToolUiData {
	kind: BackboardToolKind;
	input?: Record<string, unknown>;
	result?: Record<string, unknown>;
}

const MAX_PATH_CHARS = 4_096;
const MAX_URL_CHARS = 4_096;
const MAX_QUERY_CHARS = 2_000;
const MAX_PREVIEW_CHARS = 12_000;
const MAX_PREVIEW_LINES = 80;
const MAX_GLOB_ITEMS = 100;
const MAX_GLOB_PATTERN_ITEMS = 32;
const MAX_ACTIONS = 20;
const MAX_RESULT_ITEMS = 20;
const MAX_TOOL_NAMES = 100;

/** Build the safe input half emitted with pending/start lifecycle events. */
export function backboardToolUiInput(
	toolName: string,
	input: unknown,
): BackboardToolUiData | undefined {
	const kind = backboardToolKind(toolName);
	if (!kind) return undefined;
	const safeInput = safeToolInput(kind, input);
	return {
		kind,
		...(safeInput ? { input: safeInput } : {}),
	};
}

/** Build the bounded input/result payload emitted with `tool:result`. */
export function backboardToolUiResult(
	toolName: string,
	input: unknown,
	result: unknown,
): BackboardToolUiData | undefined {
	const kind = backboardToolKind(toolName);
	if (!kind) return undefined;
	const safeInput = safeToolInput(kind, input);
	const safeResult = safeToolResult(kind, result);
	return {
		kind,
		...(safeInput ? { input: safeInput } : {}),
		...(safeResult ? { result: safeResult } : {}),
	};
}

export function isBackboardToolKind(
	value: unknown,
): value is BackboardToolKind {
	return (
		typeof value === "string" &&
		(BACKBOARD_TOOL_KINDS as readonly string[]).includes(value)
	);
}

function backboardToolKind(toolName: string): BackboardToolKind | undefined {
	switch (toolName.replace(/[_-]/g, "").toLowerCase()) {
		case "read":
			return "read";
		case "grep":
			return "grep";
		case "glob":
			return "glob";
		case "fetchurl":
			return "fetchUrl";
		case "websearch":
			return "webSearch";
		case "todowrite":
			return "todo";
		case "computer":
			return "computer";
		case "browser":
			return "browser";
		case "findskill":
			return "findSkill";
		case "findmcp":
			return "findMcp";
		default:
			return undefined;
	}
}

function safeToolInput(
	kind: BackboardToolKind,
	input: unknown,
): Record<string, unknown> | undefined {
	const value = asRecord(input);
	if (!value) return undefined;
	switch (kind) {
		case "read":
			return compact({
				file_path: text(value.file_path, MAX_PATH_CHARS),
				offset: integer(value.offset, 0),
				limit: integer(value.limit, 1),
			});
		case "grep":
			return compact({
				pattern: text(value.pattern, MAX_QUERY_CHARS),
				path: text(value.path, MAX_PATH_CHARS),
				glob: text(value.glob, 512),
				fixed_string: boolean(value.fixed_string),
				ignore_case: boolean(value.ignore_case),
				type: text(value.type, 128),
				context_before: integer(value.context_before, 0),
				context_after: integer(value.context_after, 0),
				context: integer(value.context, 0),
				line_numbers: boolean(value.line_numbers),
				multiline: boolean(value.multiline),
				output_mode:
					value.output_mode === "content" || value.output_mode === "file_paths"
						? value.output_mode
						: undefined,
				head_limit: integer(value.head_limit, 1),
			});
		case "glob":
			return compact({
				pattern: text(value.pattern, 512),
				patterns: stringArray(value.patterns, MAX_GLOB_PATTERN_ITEMS, 512),
				path: text(value.path, MAX_PATH_CHARS),
				excludePatterns: stringArray(
					value.excludePatterns,
					MAX_GLOB_PATTERN_ITEMS,
					512,
				),
			});
		case "fetchUrl":
			return compact({ url: text(value.url, MAX_URL_CHARS) });
		case "webSearch":
			return compact({
				query: text(value.query, MAX_QUERY_CHARS),
				max_results: integer(value.max_results, 1, 20),
			});
		case "todo":
			return compact({ todos: todoItems(value.todos) });
		case "computer":
			return actionQueueInput(value, "computer");
		case "browser":
			return actionQueueInput(value, "browser");
		case "findSkill":
			return compact({
				task: text(value.task, MAX_QUERY_CHARS),
				skill: text(value.skill, 256),
			});
		case "findMcp":
			return compact({
				task: text(value.task, MAX_QUERY_CHARS),
				server: text(value.server, 256),
			});
	}
}

function safeToolResult(
	kind: BackboardToolKind,
	result: unknown,
): Record<string, unknown> | undefined {
	const value = asRecord(result);
	if (!value) return undefined;
	switch (kind) {
		case "read":
			return readResult(value);
		case "grep": {
			const preview = previewText(value.matches);
			return compact({
				matches: preview.value,
				matchCount: integer(value.matchCount, 0),
				matchCountUnit: text(value.matchCountUnit, 32),
				...searchMetadata(value),
				uiTruncated: preview.truncated || undefined,
				previewTruncated: preview.truncated || undefined,
			});
		}
		case "glob": {
			const source = Array.isArray(value.files) ? value.files : [];
			const files = stringArray(source, MAX_GLOB_ITEMS, MAX_PATH_CHARS) ?? [];
			const uiTruncated =
				source.length > files.length ||
				source.some(
					(item) => typeof item === "string" && item.length > MAX_PATH_CHARS,
				);
			return compact({
				files,
				count: integer(value.count, 0) ?? source.length,
				...searchMetadata(value),
				uiTruncated: uiTruncated || undefined,
				previewTruncated: uiTruncated || undefined,
			});
		}
		case "fetchUrl": {
			const preview = previewText(value.text);
			return compact({
				url: text(value.url, MAX_URL_CHARS),
				status: integer(value.status, 0, 999),
				text: preview.value,
				uiTruncated: preview.truncated || undefined,
				previewTruncated: preview.truncated || undefined,
			});
		}
		case "webSearch": {
			const results = searchResults(value.results);
			return compact({
				query: text(value.query, MAX_QUERY_CHARS),
				results,
				uiTruncated: searchResultsTruncated(value.results) || undefined,
			});
		}
		case "todo": {
			const todos = todoItems(value.todos);
			return compact({
				count: integer(value.count, 0),
				todos,
				uiTruncated: todoItemsTruncated(value.todos) || undefined,
			});
		}
		case "computer":
			return queueResult(value, "computer");
		case "browser":
			return queueResult(value, "browser");
		case "findSkill":
			return compact({
				task: text(value.task, MAX_QUERY_CHARS),
				activated: text(value.activated, 256),
				downloaded: text(value.downloaded, 512),
				source:
					value.source === "local" || value.source === "remote"
						? value.source
						: undefined,
				candidates: skillCandidates(value.candidates),
				uiTruncated:
					(Array.isArray(value.candidates) && value.candidates.length > 5) ||
					undefined,
			});
		case "findMcp":
			return compact({
				task: text(value.task, MAX_QUERY_CHARS),
				added: text(value.added, 256),
				toolNames: stringArray(value.toolNames, MAX_TOOL_NAMES, 256),
				candidates: mcpCandidates(value.candidates),
				uiTruncated:
					(Array.isArray(value.toolNames) &&
						value.toolNames.length > MAX_TOOL_NAMES) ||
					(Array.isArray(value.candidates) && value.candidates.length > 6) ||
					undefined,
			});
	}
}

function readResult(value: Record<string, unknown>): Record<string, unknown> {
	if (value.contentType === "image") {
		return compact({
			filePath: text(value.filePath, MAX_PATH_CHARS),
			contentType: "image",
			mimeType: text(value.mimeType, 128),
			sizeBytes: integer(value.sizeBytes, 0),
		});
	}
	const preview = previewText(value.content);
	return compact({
		filePath: text(value.filePath, MAX_PATH_CHARS),
		content: preview.value,
		totalLines: integer(value.totalLines, 0),
		truncated: boolean(value.truncated),
		uiTruncated: preview.truncated || undefined,
		previewTruncated: preview.truncated || undefined,
	});
}

function actionQueueInput(
	value: Record<string, unknown>,
	kind: "computer" | "browser",
): Record<string, unknown> {
	const source = Array.isArray(value.actions) ? value.actions : [];
	return compact({
		actions: source
			.slice(0, MAX_ACTIONS)
			.map((action) => safeAction(action, kind))
			.filter((action): action is Record<string, unknown> => !!action),
		defaultDelayMs: integer(value.defaultDelayMs, 0, 60_000),
		stopOnError: boolean(value.stopOnError),
		uiTruncated: source.length > MAX_ACTIONS || undefined,
	});
}

function safeAction(
	action: unknown,
	kind: "computer" | "browser",
): Record<string, unknown> | undefined {
	const value = asRecord(action);
	if (!value || typeof value.action !== "string") return undefined;
	const name = value.action;
	if (name === "screenshot") return { action: name };
	if (name === "click") {
		return compact({
			action: name,
			target: target(value.target),
			button:
				value.button === "left" ||
				value.button === "right" ||
				value.button === "middle"
					? value.button
					: undefined,
		});
	}
	if (name === "type") {
		return compact({
			action: name,
			textLength: typeof value.text === "string" ? value.text.length : 0,
			mode:
				kind === "browser" && (value.mode === "insert" || value.mode === "keys")
					? value.mode
					: undefined,
		});
	}
	if (name === "key") {
		const key = asRecord(value.key);
		return compact({
			action: name,
			key:
				kind === "computer"
					? compact({
							key: text(key?.key, 128),
							modifiers: modifiers(key?.modifiers),
						})
					: text(value.key, 128),
			modifiers: kind === "browser" ? modifiers(value.modifiers) : undefined,
			holdMs: kind === "browser" ? integer(value.holdMs, 0, 10_000) : undefined,
			phase:
				kind === "browser" &&
				(value.phase === "down" ||
					value.phase === "up" ||
					value.phase === "press")
					? value.phase
					: undefined,
		});
	}
	if (name === "wait") {
		return compact({
			action: name,
			durationMs: integer(value.durationMs, 0, 60_000),
		});
	}
	if (kind === "computer" && name === "openApp") {
		return compact({ action: name, appName: text(value.appName, 256) });
	}
	if (kind === "browser" && name === "navigate") {
		return compact({ action: name, url: text(value.url, MAX_URL_CHARS) });
	}
	if (kind === "browser" && name === "scroll") {
		return compact({
			action: name,
			target: target(value.target),
			deltaX: finiteNumber(value.deltaX),
			deltaY: finiteNumber(value.deltaY),
		});
	}
	if (kind === "browser" && name === "drag") {
		return compact({
			action: name,
			from: target(value.from),
			to: target(value.to),
			durationMs: integer(value.durationMs, 0, 10_000),
		});
	}
	return undefined;
}

function queueResult(
	value: Record<string, unknown>,
	kind: "computer" | "browser",
): Record<string, unknown> {
	const source = Array.isArray(value.results) ? value.results : [];
	return compact({
		success: boolean(value.success),
		results: source
			.slice(0, MAX_RESULT_ITEMS)
			.map((item) => actionResult(item, kind))
			.filter((item): item is Record<string, unknown> => !!item),
		uiTruncated:
			source.length > MAX_RESULT_ITEMS ||
			source.some(actionResultUiTruncated) ||
			undefined,
		resultsTruncated: source.length > MAX_RESULT_ITEMS || undefined,
	});
}

function actionResultUiTruncated(item: unknown): boolean {
	const value = asRecord(item);
	if (!value) return false;
	const nestedObservation = asRecord(value.observation);
	return (
		(typeof value.summary === "string" && value.summary.length > 1_000) ||
		(typeof value.error === "string" && value.error.length > 1_000) ||
		(typeof value.screenshotPath === "string" &&
			value.screenshotPath.length > MAX_PATH_CHARS) ||
		(!!nestedObservation && actionResultUiTruncated(nestedObservation))
	);
}

function actionResult(
	item: unknown,
	kind: "computer" | "browser",
): Record<string, unknown> | undefined {
	const value = asRecord(item);
	if (!value) return undefined;
	const isObservation = value.action === "screenshot" && value.success === true;
	if (isObservation) return observation(value, kind);
	return compact({
		success: boolean(value.success),
		action: text(value.action, 64),
		observationId: text(value.observationId, 256),
		verification:
			kind === "computer" &&
			(value.verification === "passed" ||
				value.verification === "failed" ||
				value.verification === "unknown")
				? value.verification
				: undefined,
		summary: text(value.summary, 1_000),
		error: text(value.error, 1_000),
		observation:
			kind === "computer" && asRecord(value.observation)
				? observation(
						asRecord(value.observation) as Record<string, unknown>,
						kind,
					)
				: undefined,
	});
}

function observation(
	value: Record<string, unknown>,
	kind: "computer" | "browser",
): Record<string, unknown> {
	const elements = Array.isArray(value.elements) ? value.elements : [];
	return compact({
		success: true,
		action: "screenshot",
		observationId:
			kind === "computer" ? text(value.observationId, 256) : undefined,
		screenSize: size(value.screenSize),
		imageSize: size(value.imageSize),
		screenshotPath: text(value.screenshotPath, MAX_PATH_CHARS),
		screenshotScale: finiteNumber(value.screenshotScale),
		appName: kind === "computer" ? text(value.appName, 256) : undefined,
		processId: kind === "computer" ? integer(value.processId, 0) : undefined,
		windowTitle: text(value.windowTitle, 512),
		elementCount: elements.length,
		summary: text(value.summary, 1_000),
		imageMediaType: text(value.__image_media_type, 128),
	});
}

function target(value: unknown): Record<string, unknown> | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	const elementId = text(record.elementId, 256);
	if (elementId) return { elementId };
	const x = finiteNumber(record.x);
	const y = finiteNumber(record.y);
	return x !== undefined && y !== undefined ? { x, y } : undefined;
}

function size(value: unknown): Record<string, unknown> | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	const width = finiteNumber(record.width);
	const height = finiteNumber(record.height);
	return width !== undefined && height !== undefined
		? { width, height }
		: undefined;
}

function modifiers(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const allowed = new Set(["meta", "control", "alt", "shift"]);
	const result = value.filter(
		(item): item is string => typeof item === "string" && allowed.has(item),
	);
	return result.length ? result.slice(0, 4) : undefined;
}

function todoItems(value: unknown): Record<string, unknown>[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.slice(0, 50).flatMap((item) => {
		const todo = asRecord(item);
		if (!todo) return [];
		const content = text(todo.content, 500);
		const status =
			todo.status === "pending" ||
			todo.status === "in_progress" ||
			todo.status === "completed"
				? todo.status
				: undefined;
		if (!content || !status) return [];
		return [
			compact({
				id: text(todo.id, 256),
				content,
				status,
			}),
		];
	});
}

function todoItemsTruncated(value: unknown): boolean {
	if (!Array.isArray(value)) return false;
	return (
		value.length > 50 ||
		value.some((item) => {
			const todo = asRecord(item);
			return (
				(typeof todo?.id === "string" && todo.id.length > 256) ||
				(typeof todo?.content === "string" && todo.content.length > 500)
			);
		})
	);
}

function searchResults(value: unknown): Record<string, unknown>[] {
	if (!Array.isArray(value)) return [];
	return value.slice(0, 20).flatMap((item) => {
		const result = asRecord(item);
		if (!result) return [];
		return [
			compact({
				title: text(result.title, 300),
				url: text(result.url, MAX_URL_CHARS),
				snippet: text(result.snippet, 1_000),
			}),
		];
	});
}

function searchResultsTruncated(value: unknown): boolean {
	if (!Array.isArray(value)) return false;
	return (
		value.length > 20 ||
		value.some((item) => {
			const result = asRecord(item);
			return (
				(typeof result?.title === "string" && result.title.length > 300) ||
				(typeof result?.url === "string" &&
					result.url.length > MAX_URL_CHARS) ||
				(typeof result?.snippet === "string" && result.snippet.length > 1_000)
			);
		})
	);
}

function skillCandidates(value: unknown): Record<string, unknown>[] {
	if (!Array.isArray(value)) return [];
	return value.slice(0, 5).flatMap((item) => {
		const candidate = asRecord(item);
		if (!candidate) return [];
		return [
			compact({
				name: text(candidate.name, 256),
				description: text(candidate.description, 1_000),
				score: finiteNumber(candidate.score),
			}),
		];
	});
}

function mcpCandidates(value: unknown): Record<string, unknown>[] {
	if (!Array.isArray(value)) return [];
	return value.slice(0, 6).flatMap((item) => {
		const candidate = asRecord(item);
		if (!candidate) return [];
		return [
			compact({
				id: text(candidate.id, 256),
				title: text(candidate.title, 256),
				description: text(candidate.description, 1_000),
				score: finiteNumber(candidate.score),
				requiredEnv: stringArray(candidate.requiredEnv, 32, 256) ?? [],
			}),
		];
	});
}

function searchMetadata(
	value: Record<string, unknown>,
): Record<string, unknown> {
	return compact({
		truncated: boolean(value.truncated),
		returnedCount: integer(value.returnedCount, 0),
		countUnit: text(value.countUnit, 32),
		limit: integer(value.limit, 0),
		limitUnit: text(value.limitUnit, 16),
		limitReason:
			value.limitReason === null ? null : text(value.limitReason, 32),
		totalKnown: boolean(value.totalKnown),
		totalCount: integer(value.totalCount, 0),
	});
}

function previewText(value: unknown): { value?: string; truncated: boolean } {
	if (typeof value !== "string") return { truncated: false };
	const lines = value.split("\n");
	let preview = lines.slice(0, MAX_PREVIEW_LINES).join("\n");
	let truncated = lines.length > MAX_PREVIEW_LINES;
	if (preview.length > MAX_PREVIEW_CHARS) {
		preview = preview.slice(0, MAX_PREVIEW_CHARS);
		truncated = true;
	}
	return { value: preview, truncated };
}

function stringArray(
	value: unknown,
	maxItems: number,
	maxChars: number,
): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value
		.slice(0, maxItems)
		.flatMap((item) =>
			typeof item === "string" ? [item.slice(0, maxChars)] : [],
		);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(value).filter(([, item]) => item !== undefined),
	);
}

function text(value: unknown, maxChars: number): string | undefined {
	return typeof value === "string" ? value.slice(0, maxChars) : undefined;
}

function boolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function integer(
	value: unknown,
	min: number,
	max = Number.MAX_SAFE_INTEGER,
): number | undefined {
	return typeof value === "number" &&
		Number.isInteger(value) &&
		value >= min &&
		value <= max
		? value
		: undefined;
}
