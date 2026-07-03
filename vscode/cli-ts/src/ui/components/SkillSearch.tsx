import { Box, Text } from "ink";
import type React from "react";
import { theme } from "../theme/theme.ts";
import type {
	PickerItemState,
	SkillSearchProps,
} from "./TerminalComponents.types.ts";

const BORDER_COLOR: Record<PickerItemState, string> = {
	default: theme.border,
	hover: theme.accentBright,
	error: theme.error,
	disabled: theme.subtleDecoration,
};

export function SkillSearch({
	value = "",
	state = "default",
}: SkillSearchProps): React.ReactElement {
	return (
		<Box borderStyle="single" borderColor={BORDER_COLOR[state]} paddingX={1}>
			<Text color={state === "disabled" ? theme.subtle : theme.text}>
				{value || "Search skills..."}
			</Text>
			{state === "hover" ? <Text inverse> </Text> : null}
		</Box>
	);
}
