import { Box, Text } from "ink";
import type React from "react";
import { theme } from "../theme/theme.ts";
import { SkillSearch } from "./SkillSearch.tsx";
import { DEFAULT_MODEL_ITEMS } from "./TerminalComponents.constants.ts";
import type { ModelSelectionTerminalProps } from "./TerminalComponents.types.ts";
import { TerminalFrame } from "./TerminalFrame.tsx";

export function ModelSelectionTerminal({
	mode = "empty",
	models = DEFAULT_MODEL_ITEMS,
}: ModelSelectionTerminalProps): React.ReactElement {
	const query = queryForMode(mode);
	const submitted = mode === "submitted";
	const noResults = mode === "noResults";
	const visible = noResults
		? []
		: models.filter((model) =>
				model.toLowerCase().includes(query.toLowerCase()),
			);

	return (
		<TerminalFrame
			title="Model Selection"
			model={submitted ? "openai/gpt-5.5" : "gpt-5.5 high fast"}
			cwd="~/Projects/backboard-cli"
		>
			<Box flexDirection="column" paddingX={1}>
				<Text color={theme.accentBright} bold>
					Select model
				</Text>
				<SkillSearch value={query} state={submitted ? "disabled" : "hover"} />
				<Box marginTop={1} flexDirection="column">
					{visible.length === 0 ? (
						<Text color={theme.subtle}>No models match this search.</Text>
					) : (
						visible.map((model, index) => (
							<Text
								key={model}
								color={index === 0 ? theme.accentBright : theme.text}
								bold={index === 0}
							>
								{index === 0 ? "❯ " : "  "}
								{model}
							</Text>
						))
					)}
				</Box>
				<Text color={theme.subtle}>
					{submitted
						? "Model selected."
						: "type to search · ↑/↓ choose · Enter select · Esc cancel"}
				</Text>
			</Box>
		</TerminalFrame>
	);
}

function queryForMode(mode: ModelSelectionTerminalProps["mode"]): string {
	if (mode === "modelQuery") return "gpt";
	if (mode === "providerQuery") return "openai";
	if (mode === "noResults") return "not-a-model";
	if (mode === "submitted") return "openai/gpt-5.5";
	return "";
}
