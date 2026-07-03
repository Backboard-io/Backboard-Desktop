import { Box, Text, useInput } from "ink";
import type React from "react";
import { useMemo, useState } from "react";
import type {
	HookEventName,
	HookEventSummary,
	HookManagerSnapshot,
} from "../../core/hooks/index.ts";
import { useTheme } from "../theme/ThemeProvider.tsx";
import { theme } from "../theme/theme.ts";

export interface HookManagerSelection {
	type: "event";
	event: HookEventSummary;
}

interface Props {
	snapshot: HookManagerSnapshot;
	onSelect: (selection: HookManagerSelection) => void;
	onCancel: () => void;
}

interface HookManagerItem {
	id: string;
	event: HookEventSummary;
}

const EVENT_ORDER: readonly HookEventName[] = [
	"PreToolUse",
	"PostToolUse",
	"UserPromptSubmit",
	"SessionStart",
	"Stop",
	"SessionEnd",
];

export function HookManagerSelector({
	snapshot,
	onSelect,
	onCancel,
}: Props): React.ReactElement {
	const uiTheme = useTheme();
	const items = useMemo(() => hookManagerItems(snapshot), [snapshot]);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const selected =
		items[Math.min(selectedIndex, Math.max(0, items.length - 1))];

	useInput((input, key) => {
		if (key.escape || input.toLowerCase() === "q") {
			onCancel();
			return;
		}
		if (key.upArrow) {
			setSelectedIndex((index) => (index <= 0 ? items.length - 1 : index - 1));
			return;
		}
		if (key.downArrow) {
			setSelectedIndex((index) => (index >= items.length - 1 ? 0 : index + 1));
			return;
		}
		if (/^[1-9]$/.test(input)) {
			const index = Number(input) - 1;
			if (index >= 0 && index < items.length) setSelectedIndex(index);
			return;
		}
		if (key.return && selected) {
			onSelect({ type: "event", event: selected.event });
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
				<Text color={theme.subtle}>
					{snapshot.hooks.length} hook{snapshot.hooks.length === 1 ? "" : "s"}{" "}
					configured
				</Text>
				<Box marginTop={1}>
					<Text color={theme.subtle}>
						Open an event to add or remove personal hooks.
					</Text>
				</Box>
				<Box marginTop={1} flexDirection="column">
					{items.map((item, index) => (
						<HookManagerRow
							key={item.id}
							index={index}
							item={item}
							selected={item === selected}
						/>
					))}
				</Box>
				<Box marginTop={1}>
					<Text color={theme.subtle}>Enter to open · Esc cancel</Text>
				</Box>
			</Box>
		</Box>
	);
}

function HookManagerRow({
	index,
	item,
	selected,
}: {
	index: number;
	item: HookManagerItem;
	selected: boolean;
}): React.ReactElement {
	return (
		<Box>
			<Text color={selected ? theme.accentBright : theme.subtle}>
				{selected ? "› " : "  "}
				{`${index + 1}.`.padStart(3)}{" "}
			</Text>
			<Text color={selected ? theme.accentBright : theme.text} bold={selected}>
				{eventNameLabel(item.event)}
			</Text>
			<Text color={selected ? theme.accentBright : theme.subtle}>
				{" "}
				{item.event.description}
			</Text>
		</Box>
	);
}

function eventNameLabel(event: HookEventSummary): string {
	return event.total > 0 ? `${event.event} (${event.total})` : event.event;
}

function hookManagerItems(snapshot: HookManagerSnapshot): HookManagerItem[] {
	const byEvent = new Map(snapshot.events.map((event) => [event.event, event]));
	// Append events not in EVENT_ORDER so a new event never disappears.
	const ordered = [
		...EVENT_ORDER,
		...snapshot.events
			.map((event) => event.event)
			.filter((name) => !EVENT_ORDER.includes(name)),
	];
	return ordered
		.map((eventName) => byEvent.get(eventName))
		.filter((event): event is HookEventSummary => Boolean(event))
		.map((event) => ({
			id: event.event,
			event,
		}));
}
