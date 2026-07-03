import { Box, Text, useInput } from "ink";
import type React from "react";
import { useMemo, useState } from "react";
import type {
	HookEventName,
	HookEventSummary,
	HookManagerSnapshot,
	LoadedHook,
} from "../../core/hooks/index.ts";
import { useTheme } from "../theme/ThemeProvider.tsx";
import { theme } from "../theme/theme.ts";
import { hookHelpLines } from "./HookShared.tsx";

export type HookEventSelection = {
	type: "matcher";
	event: HookEventName;
	matcher: string;
	hooks: LoadedHook[];
};

interface Props {
	event: HookEventSummary;
	snapshot: HookManagerSnapshot;
	onSelect: (selection: HookEventSelection) => void;
	onAddHook: (event: HookEventName) => void;
	onCancel: () => void;
}

interface HookEventItem {
	id: string;
	matcher: string;
	hooks: LoadedHook[];
}

type HookEventRowItem =
	| { kind: "add"; id: string }
	| { kind: "matcher"; id: string; item: HookEventItem };

export function HookEventSelector({
	event,
	snapshot,
	onSelect,
	onAddHook,
	onCancel,
}: Props): React.ReactElement {
	const uiTheme = useTheme();
	const matchers = useMemo(
		() => hookEventItems(event, snapshot),
		[event, snapshot],
	);
	const rows = useMemo<HookEventRowItem[]>(
		() => [
			{ kind: "add", id: "add-top" },
			...matchers.map((item) => ({
				kind: "matcher" as const,
				id: item.id,
				item,
			})),
		],
		[matchers],
	);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const safeIndex = Math.min(selectedIndex, Math.max(0, rows.length - 1));
	const selected = rows[safeIndex];

	useInput((input, key) => {
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
			const matcherIndex = Number(input) - 1;
			if (matcherIndex < matchers.length) setSelectedIndex(matcherIndex + 1);
			return;
		}
		if (key.return && selected) {
			if (selected.kind === "add") {
				onAddHook(event.event);
				return;
			}
			onSelect({
				type: "matcher",
				event: event.event,
				matcher: selected.item.matcher,
				hooks: selected.item.hooks,
			});
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
					{event.event} - {matcherLabel(event.event)}
				</Text>
				<Box marginTop={1}>
					<HookEventHelp event={event.event} />
				</Box>
				<Box flexDirection="column" marginTop={1}>
					{rows.map((row, index) =>
						row.kind === "add" ? (
							<AddHookRow key={row.id} selected={index === safeIndex} />
						) : (
							<HookEventRow
								key={row.id}
								matcherNumber={matcherDisplayNumber(rows, index)}
								item={row.item}
								selected={index === safeIndex}
							/>
						),
					)}
				</Box>
				<Box marginTop={1}>
					<Text color={theme.subtle}>Enter to confirm · Esc to cancel</Text>
				</Box>
			</Box>
		</Box>
	);
}

function matcherDisplayNumber(
	rows: readonly HookEventRowItem[],
	index: number,
): number {
	return (
		rows.slice(0, index).filter((row) => row.kind === "matcher").length + 1
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

function HookEventRow({
	matcherNumber,
	item,
	selected,
}: {
	matcherNumber: number;
	item: HookEventItem;
	selected: boolean;
}): React.ReactElement {
	const hookLabel = item.hooks.length === 1 ? "hook" : "hooks";
	return (
		<Box>
			<Text color={selected ? theme.accentBright : theme.subtle}>
				{selected ? "› " : "  "}
				{`${matcherNumber}.`.padStart(3)}{" "}
			</Text>
			<Text color={selected ? theme.accentBright : theme.text} bold={selected}>
				{item.matcher}
			</Text>
			<Text color={selected ? theme.accentBright : theme.subtle}>
				{"  "}
				{item.hooks.length} {hookLabel}
			</Text>
		</Box>
	);
}

function hookEventItems(
	event: HookEventSummary,
	snapshot: HookManagerSnapshot,
): HookEventItem[] {
	const groups = new Map<string, LoadedHook[]>();
	for (const hook of snapshot.hooks) {
		if (hook.event !== event.event) continue;
		const matcher = hook.matcher ?? "*";
		groups.set(matcher, [...(groups.get(matcher) ?? []), hook]);
	}

	const matchers = [...groups.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([matcher, hooks]) => ({
			id: `matcher:${matcher}`,
			matcher,
			hooks,
		}));
	return matchers;
}

function matcherLabel(event: HookEventName): string {
	switch (event) {
		case "PreToolUse":
		case "PostToolUse":
			return "Tool Matchers";
		case "SessionStart":
			return "Session Matchers";
		case "UserPromptSubmit":
			return "Prompt Matchers";
		case "Stop":
		case "SessionEnd":
			return "Triggers";
	}
}

function HookEventHelp({
	event,
}: {
	event: HookEventName;
}): React.ReactElement {
	const lines = hookHelpLines(event);
	return (
		<Box flexDirection="column">
			{lines.map((line) => (
				<Text key={line} color={theme.subtle}>
					{line}
				</Text>
			))}
		</Box>
	);
}
