import { Box, Text } from "ink";
import type React from "react";
import { theme } from "../theme/theme.ts";
import { SkillItem } from "./SkillItem.tsx";
import { SkillSearch } from "./SkillSearch.tsx";
import {
	DEFAULT_MCP_ITEMS,
	DEFAULT_SKILL_ITEMS,
} from "./TerminalComponents.constants.ts";
import type {
	CatalogTerminalMode,
	CatalogTerminalProps,
	SkillItemAction,
	SkillItemProps,
} from "./TerminalComponents.types.ts";
import { TerminalFrame } from "./TerminalFrame.tsx";

const MODE_ACTION: Partial<Record<CatalogTerminalMode, SkillItemAction>> = {
	add: "add",
	edit: "edit",
	delete: "delete",
};

export function CatalogTerminal({
	title,
	search = "",
	mode = "empty",
	items,
}: CatalogTerminalProps): React.ReactElement {
	const defaults = title.toLowerCase().includes("mcp")
		? DEFAULT_MCP_ITEMS
		: DEFAULT_SKILL_ITEMS;
	const catalogItems: readonly SkillItemProps[] =
		items ??
		defaults.map((item) => ({
			...item,
			action: MODE_ACTION[mode] ?? "add",
			state: "default",
		}));
	const activeAction = MODE_ACTION[mode];
	const filtered =
		search.length > 0
			? catalogItems.filter((item) =>
					`${item.name} ${item.description}`
						.toLowerCase()
						.includes(search.toLowerCase()),
				)
			: catalogItems;

	return (
		<TerminalFrame
			title={title}
			model="gpt-5.5 high fast"
			cwd="~/Projects/backboard-cli"
		>
			<Box flexDirection="column" paddingX={1}>
				<Text color={theme.accentBright} bold>
					{title}
				</Text>
				<SkillSearch
					value={mode === "typed" ? search || "review" : search}
					state={mode === "empty" ? "default" : "hover"}
				/>
				<Box marginTop={1} flexDirection="column">
					{filtered.map((item, index) => (
						<SkillItem
							key={item.name}
							{...item}
							action={activeAction ?? item.action}
							state={index === 0 && mode !== "empty" ? "hover" : item.state}
						/>
					))}
				</Box>
				<Text color={theme.subtle}>
					{footerText(activeAction, filtered.length)}
				</Text>
			</Box>
		</TerminalFrame>
	);
}

function footerText(
	action: SkillItemAction | undefined,
	count: number,
): string {
	if (count === 0) return "No matching items.";
	if (action === "delete") return "↑/↓ choose · Enter delete · Esc cancel";
	if (action === "edit") return "↑/↓ choose · Enter edit · Esc cancel";
	return "type to search · ↑/↓ choose · Enter add · Esc cancel";
}
