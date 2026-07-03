import { Box, Text } from "ink";
import type React from "react";
import { theme } from "../theme/theme.ts";
import {
	DEFAULT_RESPONSE_HIGHLIGHT,
	DEFAULT_RESPONSE_LINES,
} from "./TerminalComponents.constants.ts";
import type { ResponseBlockProps } from "./TerminalComponents.types.ts";

export function ResponseBlock({
	lines = DEFAULT_RESPONSE_LINES,
	highlight = DEFAULT_RESPONSE_HIGHLIGHT,
}: ResponseBlockProps): React.ReactElement {
	return (
		<Box flexDirection="column" paddingX={1}>
			{lines.slice(0, 1).map((line) => (
				<Text key={line} color={theme.subtle}>
					{line}
				</Text>
			))}
			<Text color={theme.success}>{highlight}</Text>
			{lines.slice(1).map((line) => (
				<Text key={line} color={theme.subtle}>
					{line}
				</Text>
			))}
		</Box>
	);
}
