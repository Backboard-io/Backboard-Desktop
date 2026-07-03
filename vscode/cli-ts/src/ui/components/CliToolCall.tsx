import { Box, Text } from "ink";
import type React from "react";
import { theme } from "../theme/theme.ts";
import { DEFAULT_TOOL_OUTPUT_PREVIEW } from "./TerminalComponents.constants.ts";
import type { CliToolCallProps } from "./TerminalComponents.types.ts";

export function CliToolCall({
	name,
	inputSummary,
	outputPreview = DEFAULT_TOOL_OUTPUT_PREVIEW,
	state = "collapsed",
}: CliToolCallProps): React.ReactElement {
	return (
		<Box flexDirection="column" paddingX={1}>
			<Box>
				<Text color={theme.text} bold>
					Called
				</Text>
				<Text color={theme.subtle}> · </Text>
				<Text color={theme.accentBright}>{name}</Text>
			</Box>
			<Box paddingLeft={2}>
				<Text color={theme.subtle}>└ </Text>
				<Text color={theme.accentBright}>{inputSummary}</Text>
			</Box>
			{state === "expanded" ? (
				<Box flexDirection="column" paddingLeft={4}>
					{outputPreview.map((line) => (
						<Text key={line} color={theme.subtle}>
							{line}
						</Text>
					))}
				</Box>
			) : null}
		</Box>
	);
}
