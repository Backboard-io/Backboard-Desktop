import { Box, Text, useInput } from "ink";
import type React from "react";
import { BackboardMascot } from "./components/BackboardMascot.tsx";
import { theme } from "./theme/theme.ts";
import type { WelcomeScreenProps } from "./WelcomeScreen.types.ts";

export function WelcomeScreen({
	cwd,
	model,
	mcpServerCount,
	onContinue,
}: WelcomeScreenProps): React.ReactElement {
	useInput((input, key) => {
		if (key.ctrl && input === "c") return;
		onContinue();
	});

	return (
		<Box flexDirection="column" borderStyle="round" borderColor={theme.border}>
			<Titlebar />
			<Box
				flexDirection="column"
				alignItems="center"
				justifyContent="center"
				paddingX={4}
				paddingY={2}
			>
				<Box flexDirection="column" marginBottom={1}>
					<BackboardMascot />
				</Box>
				<Text color={theme.text} bold>
					Welcome to Backboard CLI
				</Text>
				<Text color={theme.subtle}>
					Agents, MCP tools, and multi-model routing for AI work that ships.
				</Text>
				<Box marginTop={1}>
					<Text color={theme.accentBright}>
						loading welcome sequence... done{" "}
					</Text>
					<Text color={theme.success}>✓</Text>
				</Box>
				<Box marginTop={1}>
					<Text color={theme.accentBright}>press any key to continue </Text>
					<Text
						color={theme.inputBackground}
						backgroundColor={theme.accentBright}
					>
						{" "}
					</Text>
				</Box>
			</Box>
			<Box paddingX={1} paddingY={0}>
				<Text color={theme.success} bold>
					ready
				</Text>
				<Text color={theme.subtle}> · </Text>
				<Text color={theme.subtle}>model: {model}</Text>
				<Text color={theme.subtle}> · </Text>
				<Text color={theme.subtle}>
					{mcpServerCount} MCP server{mcpServerCount === 1 ? "" : "s"}
				</Text>
				<Text color={theme.subtle}> · </Text>
				<Text color={theme.subtle}>{cwd}</Text>
			</Box>
		</Box>
	);
}

function Titlebar(): React.ReactElement {
	return (
		<Box paddingX={1}>
			<Text color={theme.error}>● </Text>
			<Text color={theme.warning}>● </Text>
			<Text color={theme.success}>●</Text>
			<Text color={theme.subtle}> backboard · zsh · 120×34</Text>
		</Box>
	);
}
