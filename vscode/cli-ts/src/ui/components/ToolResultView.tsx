import { Box, Text } from "ink";
import type React from "react";
import type { ToolResultDetailLine } from "../../core/tools/ToolResultDetail.ts";
import { useTerminalSize } from "../hooks/TerminalSizeContext.tsx";
import { useTheme } from "../theme/ThemeProvider.tsx";
import { theme } from "../theme/theme.ts";

const RESULT_PREFIX = "  └ ";
const RESULT_DETAIL_INDENT = RESULT_PREFIX.length;
const DIFF_DETAIL_MAX_WIDTH = 96;
const DIFF_DETAIL_TERMINAL_PADDING = 14;
const DIFF_ADDED_BACKGROUND = "#1f3a24";
const DIFF_REMOVED_BACKGROUND = "#4a2528";

interface Props {
	status: "pending" | "running" | "done" | "error";
	title?: string;
	detail?: string;
	detailLines?: ToolResultDetailLine[];
	error?: string;
}

export function ToolResultView({
	status,
	title,
	detail,
	detailLines,
	error,
}: Props): React.ReactElement | null {
	const uiTheme = useTheme();
	const { columns } = useTerminalSize();
	const plainDetailLines = detail ? stableDetailLines(detail) : [];
	const diffWidth = diffDetailBlockWidth(columns);
	if (status === "error") {
		return (
			<Text color={theme.toolError}>
				{RESULT_PREFIX}
				{error ?? "failed"}
			</Text>
		);
	}
	if (status === "done" && (title || detail || detailLines?.length)) {
		return (
			<Box flexDirection="column">
				{title ? (
					<Text color={theme.subtle}>
						{RESULT_PREFIX}
						{title}
					</Text>
				) : null}
				{detailLines?.length ? (
					<Box
						marginLeft={RESULT_DETAIL_INDENT}
						flexDirection="column"
						alignSelf="stretch"
						width={diffWidth}
					>
						{detailLines.map((line) => {
							const backgroundColor =
								line.kind === "added"
									? DIFF_ADDED_BACKGROUND
									: line.kind === "removed"
										? DIFF_REMOVED_BACKGROUND
										: line.highlighted
											? uiTheme.highlightBackground
											: undefined;
							const color = backgroundColor ? theme.text : theme.subtle;
							return (
								<Box
									key={line.key}
									backgroundColor={backgroundColor}
									alignSelf="stretch"
									width={diffWidth}
								>
									<Text color={color}>
										{fitDetailLine(line.displayValue, diffWidth)}
									</Text>
								</Box>
							);
						})}
					</Box>
				) : null}
				{plainDetailLines.length > 0 ? (
					<Box marginLeft={RESULT_DETAIL_INDENT} flexDirection="column">
						{plainDetailLines.map((line) => (
							<Text key={line.key} color={theme.subtle}>
								{line.value}
							</Text>
						))}
					</Box>
				) : null}
			</Box>
		);
	}
	return null;
}

function stableDetailLines(
	detail: string,
): Array<{ key: string; value: string }> {
	const seen = new Map<string, number>();
	return detail.split("\n").map((value) => {
		const count = seen.get(value) ?? 0;
		seen.set(value, count + 1);
		return { key: `${value}:${count}`, value };
	});
}

export function diffDetailBlockWidth(columns: number): number {
	const terminalColumns =
		Number.isFinite(columns) && columns > 0 ? Math.floor(columns) : 80;
	const available = Math.max(
		24,
		terminalColumns - DIFF_DETAIL_TERMINAL_PADDING,
	);
	return Math.min(DIFF_DETAIL_MAX_WIDTH, available);
}

function fitDetailLine(value: string, width: number): string {
	if (value.length > width) {
		return width <= 1 ? "…" : `${value.slice(0, width - 1)}…`;
	}
	return value.padEnd(width, " ");
}
