import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import type React from "react";
import { useState } from "react";
import { useTheme } from "../theme/ThemeProvider.tsx";
import { theme } from "../theme/theme.ts";
import { Spinner } from "./Spinner.tsx";

interface Props {
	onSubmit: (input: string, signal?: AbortSignal) => Promise<void> | void;
	onCancel: () => void;
}

export function ManualMcpInput({
	onSubmit,
	onCancel,
}: Props): React.ReactElement {
	const uiTheme = useTheme();
	const [value, setValue] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const [abortController, setAbortController] =
		useState<AbortController | null>(null);

	useInput((_input, key) => {
		if (submitting) {
			if (key.escape) abortController?.abort();
			return;
		}
		if (key.escape) onCancel();
	});

	const submit = (): void => {
		if (submitting) return;
		const trimmed = value.trim();
		if (!trimmed) {
			setError("Enter an MCP server URL or command.");
			return;
		}
		const controller = new AbortController();
		setSubmitting(true);
		setAbortController(controller);
		setError(null);
		Promise.resolve(onSubmit(trimmed, controller.signal))
			.catch((err) => {
				if (controller.signal.aborted) return;
				setError(err instanceof Error ? err.message : String(err));
			})
			.finally(() => {
				setAbortController((current) =>
					current === controller ? null : current,
				);
				setSubmitting(false);
			});
	};

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
						Add MCP server manually
					</Text>
				</Box>
				<Text color={theme.subtle}>
					Enter name=https://host/mcp or name=npx -y package
				</Text>
				<Box>
					<Text color={theme.subtle}>Server: </Text>
					<TextInput
						value={value}
						onChange={(next) => {
							setValue(next);
							setError(null);
						}}
						onSubmit={submit}
						placeholder="linear=https://mcp.example.com/mcp"
						focus
					/>
				</Box>
				{error ? <Text color={theme.error}>{error}</Text> : null}
				<Text color={theme.subtle}>Enter add · Esc cancel</Text>
				{submitting ? <Spinner label="Adding MCP server" /> : null}
			</Box>
		</Box>
	);
}
