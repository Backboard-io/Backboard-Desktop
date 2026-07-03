import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import type React from "react";
import { useState } from "react";
import type { AskUserRequest } from "../../core/bus/events.ts";
import { useTheme } from "../theme/ThemeProvider.tsx";
import { theme } from "../theme/theme.ts";
import {
	movePickerSelection,
	normalizePickerSelection,
	type PickerSelection,
	resetPickerSelection,
} from "./Picker.tsx";

interface Props {
	request: AskUserRequest;
	onAnswer: (id: string, answer: string) => void;
}

const VISIBLE_OPTIONS = 8;

export function AskUserPrompt({
	request,
	onAnswer,
}: Props): React.ReactElement {
	const uiTheme = useTheme();
	const [selection, setSelection] = useState<PickerSelection>(
		resetPickerSelection(),
	);
	const [answer, setAnswer] = useState("");
	const options = request.options;
	const normalizedSelection = normalizePickerSelection(
		selection,
		options.length,
		VISIBLE_OPTIONS,
	);
	const safeIndex = normalizedSelection.itemIndex;
	const windowStart = normalizedSelection.windowStart;
	const visible = options.slice(windowStart, windowStart + VISIBLE_OPTIONS);
	const selectedOption = options[safeIndex] ?? "";

	useInput((_input, key) => {
		if (options.length === 0) return;
		if (key.upArrow) {
			setSelection((current) =>
				movePickerSelection(current, options.length, "up", VISIBLE_OPTIONS),
			);
			return;
		}
		if (key.downArrow) {
			setSelection((current) =>
				movePickerSelection(current, options.length, "down", VISIBLE_OPTIONS),
			);
		}
	});

	const submitAnswer = (value: string): void => {
		const trimmed = value.trim();
		onAnswer(request.id, trimmed.length > 0 ? trimmed : selectedOption);
	};

	return (
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
					Select Option
				</Text>
			</Box>
			<Box marginBottom={1}>
				<Text color={theme.text}>{request.question}</Text>
			</Box>

			<Box flexDirection="column" marginBottom={1}>
				{windowStart > 0 ? <Text color={theme.subtle}>↑ more</Text> : null}
				{visible.map((option, index) => {
					const absoluteIndex = windowStart + index;
					const selected = absoluteIndex === safeIndex;
					return (
						<Box key={`${option}:${absoluteIndex}`}>
							<Text color={selected ? theme.accentBright : theme.subtle}>
								{selected ? "› " : "  "}
							</Text>
							<Text
								color={selected ? theme.accentBright : theme.text}
								bold={selected}
							>
								{option}
							</Text>
						</Box>
					);
				})}
				{windowStart + VISIBLE_OPTIONS < options.length ? (
					<Text color={theme.subtle}>
						↓ {options.length - windowStart - VISIBLE_OPTIONS} more
					</Text>
				) : null}
				{options.length === 0 ? (
					<Text color={theme.subtle}>No options.</Text>
				) : null}
			</Box>

			<Box>
				<Text color={theme.subtle}>Answer: </Text>
				<TextInput
					value={answer}
					onChange={setAnswer}
					onSubmit={submitAnswer}
					placeholder={selectedOption || "Type an answer"}
					showCursor
					focus
				/>
			</Box>
			<Box marginTop={1}>
				<Text color={theme.subtle}>
					Type an answer or leave blank to use selected · ↑/↓ choose · Enter
					send
				</Text>
			</Box>
		</Box>
	);
}

export function askUserOptionWindowStart(
	selectedIndex: number,
	optionCount: number,
): number {
	return normalizePickerSelection(
		{ itemIndex: selectedIndex, windowStart: 0 },
		optionCount,
		VISIBLE_OPTIONS,
	).windowStart;
}
