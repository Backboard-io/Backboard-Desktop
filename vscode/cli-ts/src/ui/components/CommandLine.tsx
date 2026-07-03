import { Box, Text } from "ink";
import type React from "react";
import { theme } from "../theme/theme.ts";
import type { CommandLineProps } from "./TerminalComponents.types.ts";

export function CommandLine({
	value = "",
	placeholder = "Type something...",
	state = "default",
}: CommandLineProps): React.ReactElement {
	const submitted = state === "submitted";
	const typing = state === "typing";
	const text = value || placeholder;
	return (
		<Box>
			<Text color={submitted ? theme.subtle : theme.accentBright}>▌ </Text>
			<Text color={value ? theme.text : theme.subtle}>{text}</Text>
			{typing ? <Text inverse> </Text> : null}
		</Box>
	);
}
