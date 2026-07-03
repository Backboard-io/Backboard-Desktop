import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import type React from "react";
import { useState } from "react";
import { theme } from "../theme/theme.ts";
import { Spinner } from "./Spinner.tsx";

export interface McpArgumentField {
	name: string;
	description?: string;
	required: boolean;
}

interface Props {
	title: string;
	fields: McpArgumentField[];
	onSubmit: (
		values: Record<string, string>,
		signal: AbortSignal,
	) => Promise<void> | void;
	onCancel: () => void;
}

export function McpArgumentInput({
	title,
	fields,
	onSubmit,
	onCancel,
}: Props): React.ReactElement {
	const [values, setValues] = useState<Record<string, string>>({});
	const [fieldIndex, setFieldIndex] = useState(0);
	const [error, setError] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const [abortController, setAbortController] =
		useState<AbortController | null>(null);
	const field = fields[fieldIndex] ?? null;

	useInput((_input, key) => {
		if (submitting) {
			if (key.escape) abortController?.abort();
			return;
		}
		if (key.escape) {
			if (error) {
				setError(null);
				return;
			}
			onCancel();
			return;
		}
		if (key.upArrow) {
			setFieldIndex((index) => Math.max(0, index - 1));
			setError(null);
			return;
		}
		if (key.downArrow) {
			setFieldIndex((index) => Math.min(fields.length - 1, index + 1));
			setError(null);
		}
	});

	const submit = (): void => {
		if (submitting) return;
		const missing = fields.find(
			(candidate) => candidate.required && !values[candidate.name]?.trim(),
		);
		if (missing) {
			setFieldIndex(fields.indexOf(missing));
			setError(`${missing.name} is required.`);
			return;
		}
		const payload = Object.fromEntries(
			Object.entries(values)
				.map(([key, value]) => [key, value.trim()] as const)
				.filter(([, value]) => value.length > 0),
		);
		const controller = new AbortController();
		setSubmitting(true);
		setAbortController(controller);
		setError(null);
		Promise.resolve(onSubmit(payload, controller.signal))
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
		<Box
			flexDirection="column"
			marginTop={1}
			borderStyle="round"
			borderColor={theme.accent}
			paddingX={1}
		>
			<Text color={theme.accent} bold>
				{title}
			</Text>
			{fields.map((candidate, index) => {
				const selected = index === fieldIndex;
				const label = `${candidate.name}${candidate.required ? " *" : ""}`;
				return (
					<Text
						key={candidate.name}
						color={selected ? theme.accentBright : theme.subtle}
						bold={selected}
					>
						{selected ? "❯ " : "  "}
						{label}
						{values[candidate.name]?.trim()
							? ` = ${values[candidate.name]?.trim()}`
							: ""}
					</Text>
				);
			})}
			{field ? (
				<>
					{field.description ? (
						<Text color={theme.subtle}>{field.description}</Text>
					) : null}
					<Box>
						<Text color={theme.subtle}>{field.name}: </Text>
						<TextInput
							key={field.name}
							value={values[field.name] ?? ""}
							onChange={(value) => {
								setValues((current) => ({ ...current, [field.name]: value }));
								setError(null);
							}}
							onSubmit={submit}
							placeholder={field.required ? "required" : "optional"}
							focus
						/>
					</Box>
				</>
			) : null}
			{error ? <Text color={theme.error}>{error}</Text> : null}
			<Text color={theme.subtle}>↑/↓ fields · Enter submit · Esc cancel</Text>
			{submitting ? <Spinner label="Loading MCP item" /> : null}
		</Box>
	);
}
