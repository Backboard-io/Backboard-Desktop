import { Box, Text, useInput } from "ink";
import type React from "react";
import { useState } from "react";
import type { HookEventName, LoadedHook } from "../../core/hooks/index.ts";
import { useTheme } from "../theme/ThemeProvider.tsx";
import { theme } from "../theme/theme.ts";
import { hookHelpLines, withStableKeys } from "./HookShared.tsx";
import { Spinner } from "./Spinner.tsx";

interface Props {
	event: HookEventName;
	matcher: string;
	hooks: LoadedHook[];
	onSelect: (hook: LoadedHook) => void;
	onAddHook: (event: HookEventName, matcher: string) => void;
	onDelete?: (hook: LoadedHook) => Promise<void>;
	onCancel: () => void;
}

type HookMatcherRow =
	| { kind: "add"; id: string }
	| { kind: "hook"; id: string; hook: LoadedHook; number: number };

export function HookMatcherSelector({
	event,
	matcher,
	hooks,
	onSelect,
	onAddHook,
	onDelete,
	onCancel,
}: Props): React.ReactElement {
	const uiTheme = useTheme();
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const [deleteError, setDeleteError] = useState<string | null>(null);
	const [deleting, setDeleting] = useState(false);
	const keyed = withStableKeys(hooks, hookKey);
	const rows: HookMatcherRow[] = [
		{ kind: "add", id: "add-top" },
		...keyed.map((entry, index) => ({
			kind: "hook" as const,
			id: entry.key,
			hook: entry.item,
			number: index + 1,
		})),
	];
	const safeSelectedIndex = Math.min(
		selectedIndex,
		Math.max(0, rows.length - 1),
	);
	const selectedRow = rows[safeSelectedIndex];
	const selectedHook =
		selectedRow?.kind === "hook" ? selectedRow.hook : undefined;

	useInput((input, key) => {
		if (deleting) return;
		if (confirmingDelete) {
			if (input.toLowerCase() === "y") {
				if (selectedHook && onDelete) {
					setDeleting(true);
					setDeleteError(null);
					onDelete(selectedHook)
						.catch((err) =>
							setDeleteError(err instanceof Error ? err.message : String(err)),
						)
						.finally(() => {
							setDeleting(false);
							setConfirmingDelete(false);
						});
				} else {
					setConfirmingDelete(false);
				}
				return;
			}
			if (key.escape || input.toLowerCase() === "n") {
				setConfirmingDelete(false);
				setDeleteError(null);
				return;
			}
			return;
		}
		if (key.escape || input.toLowerCase() === "q") {
			onCancel();
			return;
		}
		if (key.upArrow) {
			setSelectedIndex((index) => (index <= 0 ? rows.length - 1 : index - 1));
			return;
		}
		if (key.downArrow) {
			setSelectedIndex((index) => (index >= rows.length - 1 ? 0 : index + 1));
			return;
		}
		if (/^[1-9]$/.test(input)) {
			const hookIndex = Number(input) - 1;
			if (hookIndex < hooks.length) setSelectedIndex(hookIndex + 1);
			return;
		}
		if (input.toLowerCase() === "d") {
			if (onDelete && selectedHook) {
				setDeleteError(null);
				setConfirmingDelete(true);
			}
			return;
		}
		if (key.return && selectedRow) {
			if (selectedRow.kind === "add") {
				onAddHook(event, matcher);
				return;
			}
			onSelect(selectedRow.hook);
		}
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
					{event} - Matcher: {matcher}
				</Text>
				<Box marginTop={1}>
					<HookHelp event={event} />
				</Box>
				<Box flexDirection="column">
					{rows.map((row, index) =>
						row.kind === "add" ? (
							<AddHookRow key={row.id} selected={index === safeSelectedIndex} />
						) : (
							<HookRow
								key={row.id}
								hook={row.hook}
								number={row.number}
								selected={index === safeSelectedIndex}
							/>
						),
					)}
				</Box>
				{deleteError ? <Text color={theme.error}>{deleteError}</Text> : null}
				{confirmingDelete ? (
					<Box marginTop={1}>
						<Text color={theme.error}>
							{selectedHook?.source.kind === "project"
								? "Delete this project hook (shared)? y / n"
								: "Delete this personal hook? y / n"}
						</Text>
					</Box>
				) : null}
				{deleting ? <Spinner label="Removing hook" /> : null}
				<Box marginTop={1}>
					<Text color={theme.subtle}>
						Enter view/add · d delete (personal) · Esc back
					</Text>
				</Box>
			</Box>
		</Box>
	);
}

function AddHookRow({ selected }: { selected: boolean }): React.ReactElement {
	return (
		<Box>
			<Text color={selected ? theme.accentBright : theme.subtle}>
				{selected ? "› " : "  "}
			</Text>
			<Text
				color={selected ? theme.accentBright : theme.accent}
				bold={selected}
			>
				+ Add new hook
			</Text>
		</Box>
	);
}

function HookRow({
	hook,
	number,
	selected,
}: {
	hook: LoadedHook;
	number: number;
	selected: boolean;
}): React.ReactElement {
	const commandLabel = `[command] ${hook.hook.command}`;
	return (
		<Box>
			<Text color={selected ? theme.accentBright : theme.subtle}>
				{selected ? "› " : "  "}
				{`${number}.`.padStart(3)}{" "}
			</Text>
			<Text color={selected ? theme.accentBright : theme.text} bold={selected}>
				{commandLabel}
			</Text>
			<Text color={selected ? theme.accentBright : theme.subtle}>
				{"  "}
				{sourceLabel(hook)}
			</Text>
		</Box>
	);
}

function HookHelp({ event }: { event: HookEventName }): React.ReactElement {
	return (
		<Box flexDirection="column" marginBottom={1}>
			{hookHelpLines(event).map((line) => (
				<Text key={line} color={theme.subtle}>
					{line}
				</Text>
			))}
		</Box>
	);
}

function sourceLabel(hook: LoadedHook): string {
	return hook.source.kind === "user" ? "(personal)" : "(project)";
}

function hookKey(hook: LoadedHook): string {
	return [
		hook.source.kind,
		hook.source.path,
		hook.event,
		hook.matcher ?? "*",
		hook.hash,
		hook.hook.command,
	].join(":");
}
