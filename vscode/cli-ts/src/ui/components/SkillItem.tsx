import { Box, Text } from "ink";
import type React from "react";
import { theme } from "../theme/theme.ts";
import type {
	SkillItemAction,
	SkillItemProps,
} from "./TerminalComponents.types.ts";

const ACTION_LABEL: Record<SkillItemAction, string> = {
	add: "Add",
	edit: "Edit",
	delete: "Delete",
};

const ACTION_COLOR: Record<SkillItemAction, string> = {
	add: theme.success,
	edit: theme.accentBright,
	delete: theme.error,
};

export function SkillItem({
	name,
	description,
	action = "add",
	state = "default",
}: SkillItemProps): React.ReactElement {
	const selected = state === "hover";
	const disabled = state === "disabled";
	const errored = state === "error";
	return (
		<Box>
			<Text color={selected ? theme.accentBright : theme.subtle}>
				{selected ? "❯ " : "  "}
			</Text>
			<Text
				color={errored ? theme.error : disabled ? theme.subtle : theme.text}
				bold={selected}
			>
				{name}
			</Text>
			<Text color={theme.subtle}> · {description}</Text>
			<Text color={disabled ? theme.subtle : ACTION_COLOR[action]} bold>
				{" "}
				{ACTION_LABEL[action]}
			</Text>
		</Box>
	);
}
