import { Box, Text } from "ink";
import type React from "react";
import type {
	MemoryMode,
	ThinkingConfig,
	ThinkingIntent,
} from "../../config/defaults.ts";
import type { UsageInfo } from "../../core/bus/events.ts";
import type { RunStatus } from "../../state/AppState.ts";
import { useTerminalSize } from "../hooks/TerminalSizeContext.tsx";
import { useTheme } from "../theme/ThemeProvider.tsx";
import { theme } from "../theme/theme.ts";
import { compactPathLabel, shellPathLabel } from "../utils/pathLabels.ts";

const STATUS_BAR_DEFAULT_COLUMNS = 80;
const STATUS_BAR_SEPARATOR = " · ";
const STATUS_BAR_MIN_PATH_WIDTH = 5;

interface Props {
	status: RunStatus;
	model: string;
	thinking: ThinkingConfig | ThinkingIntent | null | undefined;
	memory: MemoryMode;
	usage: UsageInfo;
	cwd: string;
}

export function StatusBar({
	status,
	model,
	thinking,
	memory,
	usage,
	cwd,
}: Props): React.ReactElement {
	const tokens = usage.totalTokens ?? 0;
	const thinkingAmount = formatThinkingAmount(thinking);
	const memoryAmount = formatMemoryAmount(memory);
	const label = statusLabel(status);
	const { columns } = useTerminalSize();
	const uiTheme = useTheme();
	const segments = statusBarSegments({
		columns,
		status: label,
		model,
		path: shellPathLabel(cwd),
		thinking: thinkingAmount ?? undefined,
		memory: memoryAmount ?? undefined,
		tokens: tokens > 0 ? `${tokens} tokens` : undefined,
	});
	const [primary, ...rest] = segments;
	return (
		<Box marginTop={1}>
			<Text color={statusColor(status)} bold>
				{label}
			</Text>
			{primary !== undefined ? (
				<>
					<Text color={uiTheme.readableSecondaryText}>
						{STATUS_BAR_SEPARATOR}
					</Text>
					<Text color={uiTheme.readableSecondaryText}>{primary}</Text>
				</>
			) : null}
			{rest.length > 0 ? (
				<Text color={uiTheme.readableSecondaryText}>
					{STATUS_BAR_SEPARATOR}
					{rest.join(STATUS_BAR_SEPARATOR)}
				</Text>
			) : null}
		</Box>
	);
}

export function formatMemoryAmount(memory: MemoryMode): string | null {
	if (memory === "off") return null;
	return `memory ${memory}`;
}

export function formatThinkingAmount(
	thinking: ThinkingConfig | ThinkingIntent | null | undefined,
): string | null {
	if (!thinking || Object.keys(thinking).length === 0) return null;
	if ("kind" in thinking) {
		if (thinking.kind === "default") return "provider default";
		if (thinking.kind === "budget") return `${thinking.tokens} tokens`;
		if (thinking.kind === "dynamic") return "dynamic";
		return thinking.level === "max" ? "xhigh" : thinking.level;
	}
	if ("effort" in thinking) {
		return thinking.effort === "max" ? "xhigh" : thinking.effort;
	}
	if ("budget_tokens" in thinking) return `${thinking.budget_tokens} tokens`;
	if ("max_tokens" in thinking) return `${thinking.max_tokens} tokens`;
	return null;
}

export function statusBarSegments({
	columns,
	status,
	model,
	path,
	thinking,
	memory,
	tokens,
}: {
	columns: number;
	status: string;
	model: string;
	path: string;
	thinking?: string;
	memory?: string;
	tokens?: string;
}): string[] {
	const terminalColumns =
		Number.isFinite(columns) && columns > 0
			? Math.floor(columns)
			: STATUS_BAR_DEFAULT_COLUMNS;
	const candidates = [
		[model, thinking, memory, tokens, path],
		[model, thinking, memory, path],
		[model, memory, path],
		[model, path],
		[path],
	].map((candidate) =>
		candidate.filter(
			(segment): segment is string =>
				typeof segment === "string" && segment.length > 0,
		),
	);

	for (const candidate of candidates) {
		const fitted = fitStatusBarPath(status, candidate, terminalColumns);
		if (statusBarWidth(status, fitted) <= terminalColumns) return fitted;
	}

	return [];
}

function fitStatusBarPath(
	status: string,
	segments: string[],
	availableWidth: number,
): string[] {
	const pathIndex = segments.length - 1;
	const path = segments[pathIndex];
	if (!path) return segments;

	let pathWidth = path.length;
	while (pathWidth >= STATUS_BAR_MIN_PATH_WIDTH) {
		const candidate = [...segments];
		candidate[pathIndex] = compactPathLabel(path, pathWidth);
		if (statusBarWidth(status, candidate) <= availableWidth) return candidate;
		pathWidth -= 1;
	}

	return [
		...segments.slice(0, pathIndex),
		compactPathLabel(path, STATUS_BAR_MIN_PATH_WIDTH),
	];
}

function statusBarWidth(status: string, segments: readonly string[]): number {
	if (segments.length === 0) return status.length;
	const segmentWidth = segments.reduce(
		(total, segment) => total + segment.length,
		0,
	);
	return (
		status.length + STATUS_BAR_SEPARATOR.length * segments.length + segmentWidth
	);
}

function statusLabel(status: RunStatus): string {
	switch (status) {
		case "running":
			return "running";
		case "cancelled":
			return "cancelled";
		default:
			return "ready";
	}
}

function statusColor(status: RunStatus): string {
	switch (status) {
		case "running":
			return theme.warning;
		case "cancelled":
			return theme.error;
		default:
			return theme.success;
	}
}
