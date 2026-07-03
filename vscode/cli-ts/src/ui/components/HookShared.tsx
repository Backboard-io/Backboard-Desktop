import { Box, Text } from "ink";
import type React from "react";
import { APP_DISPLAY_NAME } from "../../config/branding.ts";
import type { HookEventName } from "../../core/hooks/index.ts";
import { useTheme } from "../theme/ThemeProvider.tsx";
import { theme } from "../theme/theme.ts";

export function HookPanel({
	title,
	children,
}: {
	title?: string;
	children: React.ReactNode;
}): React.ReactElement {
	const uiTheme = useTheme();
	return (
		<Box flexDirection="column">
			<Box
				flexDirection="column"
				marginTop={1}
				paddingX={2}
				paddingY={1}
				width="100%"
				backgroundColor={uiTheme.inputSurfaceBackground}
			>
				<Box marginBottom={1}>
					<Text color={theme.text} bold>
						Hooks
					</Text>
				</Box>
				{title ? (
					<Text color={theme.accentBright} bold>
						{title}
					</Text>
				) : null}
				{children}
			</Box>
		</Box>
	);
}

// Stable React keys for lists that may contain duplicate values.
export function withStableKeys<T>(
	items: readonly T[],
	keyOf: (item: T) => string,
): Array<{ key: string; item: T }> {
	const seen = new Map<string, number>();
	return items.map((item) => {
		const base = keyOf(item);
		const count = seen.get(base) ?? 0;
		seen.set(base, count + 1);
		return { key: `${base}:${count}`, item };
	});
}

export function hookHelpLines(event: HookEventName): string[] {
	switch (event) {
		case "PreToolUse":
			return [
				'Input to command is JSON with fields "tool_name" and "tool_input".',
				"Exit code 0 - hook passes, tool executes normally",
				"Exit code 2 - block tool execution and show stderr to the model",
				"Other exit codes - show stderr to user only",
			];
		case "PostToolUse":
			return [
				'Input to command is JSON with fields "tool_name", "tool_input", and "tool_response".',
				"Exit code 0 - hook passes, tool output continues",
				"Exit code 2 - replace tool output with stderr for the model",
				"Other exit codes - show stderr to user only",
			];
		case "UserPromptSubmit":
			return [
				'Input to command is JSON with field "prompt".',
				"Exit code 0 - prompt continues normally",
				"Exit code 2 - block the prompt and show stderr",
				"Other exit codes - show stderr to user only",
			];
		case "SessionStart":
			return [
				'Input to command is JSON with field "source".',
				"Exit code 0 - session continues normally",
				"Exit code 2 - show stderr as a hook warning",
				"Other exit codes - show stderr to user only",
			];
		case "Stop":
			return [
				'Input to command is JSON with fields "turn_id" and "status".',
				"Runs when a turn ends (completed, failed, or cancelled).",
				"Exit code 2 - show stderr as a hook warning",
				"Other exit codes - show stderr to user only",
			];
		case "SessionEnd":
			return [
				'Input to command is JSON with field "reason".',
				`Runs when the ${APP_DISPLAY_NAME} session ends.`,
				"Exit code 2 - show stderr as a hook warning",
				"Other exit codes - show stderr to user only",
			];
	}
}
