import { Box, Text, useInput } from "ink";
import type React from "react";
import { APP_DISPLAY_NAME } from "../../config/branding.ts";
import type { LoadedHook } from "../../core/hooks/index.ts";
import { useTheme } from "../theme/ThemeProvider.tsx";
import { theme } from "../theme/theme.ts";
import { withStableKeys } from "./HookShared.tsx";

interface Props {
	hook: LoadedHook;
	onCancel: () => void;
}

export function HookDetails({ hook, onCancel }: Props): React.ReactElement {
	const uiTheme = useTheme();
	useInput((_input, key) => {
		if (key.escape || key.return) onCancel();
	});

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
				<Text color={theme.accentBright} bold>
					Hook details
				</Text>
				<Box marginTop={1} flexDirection="column">
					<DetailLine label="Event" value={hook.event} />
					<DetailLine label="Matcher" value={hook.matcher ?? "*"} />
					<DetailLine label="Source" value={sourceLabel(hook)} subtle />
				</Box>
				<Box marginTop={1}>
					<Text color={theme.subtle}>Command:</Text>
				</Box>
				<Box flexDirection="column" marginTop={1} marginLeft={2}>
					{commandLines(hook.hook.command).map((line) => (
						<Text key={line.key} color={theme.text}>
							{line.item}
						</Text>
					))}
				</Box>
				<Box marginTop={1}>
					<Text color={theme.subtle}>
						To modify or remove this hook, edit hooks.json directly or ask{" "}
						{APP_DISPLAY_NAME}.
					</Text>
				</Box>
				<Box marginTop={1}>
					<Text color={theme.subtle}>Esc to go back</Text>
				</Box>
			</Box>
		</Box>
	);
}

function DetailLine({
	label,
	value,
	subtle = false,
}: {
	label: string;
	value: string;
	subtle?: boolean;
}): React.ReactElement {
	return (
		<Box>
			<Text color={theme.text} bold>
				{`${label}:`.padEnd(10)}
			</Text>
			<Text color={subtle ? theme.subtle : theme.text}>{value}</Text>
		</Box>
	);
}

function sourceLabel(hook: LoadedHook): string {
	return `${hook.source.kind} hooks (${hook.source.path})`;
}

function commandLines(command: string): Array<{ key: string; item: string }> {
	return withStableKeys(command.split("\n"), (line) => line);
}
