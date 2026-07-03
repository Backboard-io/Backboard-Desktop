import { Box, Text } from "ink";
import type React from "react";
import { theme } from "../theme/theme.ts";
import type {
	CliStatusFooterProps,
	CliStatusFooterState,
} from "./TerminalComponents.types.ts";

const STATUS_COLOR: Record<CliStatusFooterState, string> = {
	ready: theme.success,
	thinking: theme.warning,
	error: theme.error,
};

export function CliStatusFooter({
	status = "ready",
	model,
	cwd,
}: CliStatusFooterProps): React.ReactElement {
	return (
		<Box paddingX={1}>
			<Text color={STATUS_COLOR[status]} bold>
				{status}
			</Text>
			<Text color={theme.subtle}> · </Text>
			<Text color={theme.subtle}>{model}</Text>
			<Text color={theme.subtle}> · </Text>
			<Text color={theme.subtle}>{cwd}</Text>
		</Box>
	);
}
