import { Box, Text } from "ink";
import type React from "react";
import { theme } from "../theme/theme.ts";
import type { CliPromptInputProps } from "./TerminalComponents.types.ts";

export function CliPromptInput({
	value = "",
	placeholder = "Explain this codebase",
	state = "empty",
}: CliPromptInputProps): React.ReactElement {
	const submitted = state === "submitted";
	const active = state === "active";
	const label = value || placeholder;
	return (
		<Box>
			<Text color={submitted ? theme.subtle : theme.accentBright}>▌ </Text>
			<Text color={value || active || submitted ? theme.text : theme.subtle}>
				{label}
			</Text>
			{submitted ? null : active ? (
				<Text inverse> </Text>
			) : (
				<Text backgroundColor={theme.subtleDecoration}> </Text>
			)}
		</Box>
	);
}
