import { Box, Text } from "ink";
import type React from "react";
import { theme } from "../theme/theme.ts";
import type {
	TerminalFrameProps,
	TerminalFrameStatus,
} from "./TerminalComponents.types.ts";

const STATUS_COLOR: Record<TerminalFrameStatus, string> = {
	ready: theme.success,
	thinking: theme.warning,
	error: theme.error,
};

export function TerminalFrame({
	title = "backboard · zsh · 120×34",
	status = "ready",
	model,
	cwd,
	children,
}: TerminalFrameProps): React.ReactElement {
	return (
		<Box flexDirection="column" borderStyle="round" borderColor={theme.border}>
			<Box paddingX={1}>
				<Text color={theme.error}>● </Text>
				<Text color={theme.warning}>● </Text>
				<Text color={theme.success}>●</Text>
				<Text color={theme.subtle}> {title}</Text>
			</Box>
			<Box flexDirection="column">{children}</Box>
			<Box paddingX={1}>
				<Text color={STATUS_COLOR[status]} bold>
					{status}
				</Text>
				<Text color={theme.subtle}> · </Text>
				<Text color={theme.subtle}>{model}</Text>
				<Text color={theme.subtle}> · </Text>
				<Text color={theme.subtle}>{cwd}</Text>
			</Box>
		</Box>
	);
}
