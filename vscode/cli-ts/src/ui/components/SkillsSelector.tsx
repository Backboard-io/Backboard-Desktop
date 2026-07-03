import type React from "react";
import type {
	SkillPickerItem,
	SkillPickerTab,
} from "../../core/skills/SkillController.ts";
import { Picker, type PickerTab } from "./Picker.tsx";

interface Props {
	tabs: SkillPickerTab[];
	onSelect: (
		item: SkillPickerItem,
		signal: AbortSignal,
	) => Promise<void> | void;
	onCancel: () => void;
}

export function SkillsSelector({
	tabs,
	onSelect,
	onCancel,
}: Props): React.ReactElement {
	const installedCount = installedSkillCount(tabs);
	return (
		<Picker
			title={`Skills (${installedCount} installed)`}
			tabs={orderSkillTabs(tabs).map(toPickerTab)}
			onSelect={onSelect}
			onCancel={onCancel}
			emptyLabel="No skills in this source."
			selectingLabel="Importing selected skill"
		/>
	);
}

function emptyLabelFor(id: SkillPickerTab["id"]): string {
	switch (id) {
		case "repo":
			return "No project skills. Create .agents/skills/<name>/SKILL.md";
		case "personal":
			return "No personal skills. Create ~/.agents/skills/<name>/SKILL.md";
		case "skills-sh":
			return "No remote skills found.";
	}
}

function toPickerTab(tab: SkillPickerTab): PickerTab<SkillPickerItem> {
	return {
		id: tab.id,
		label: tab.label,
		error: tab.error,
		emptyLabel: emptyLabelFor(tab.id),
		items: tab.items.map((item) => ({
			id: `${item.source}:${item.id}`,
			name: `/${item.name}`,
			badge: item.active
				? "active"
				: item.installs
					? item.installs
					: sourceLabel(item.source),
			description: item.description,
			detail: item.detail,
			value: item,
		})),
	};
}

export function installedSkillCount(tabs: readonly SkillPickerTab[]): number {
	const installed = new Set<string>();
	for (const tab of tabs) {
		if (tab.id === "skills-sh") continue;
		for (const item of tab.items) {
			installed.add(`${item.source}:${item.id}`);
		}
	}
	return installed.size;
}

export function orderSkillTabs(
	tabs: readonly SkillPickerTab[],
): SkillPickerTab[] {
	const remote = tabs.find((tab) => tab.id === "skills-sh");
	const installed = tabs.filter((tab) => tab.id !== "skills-sh");
	if (installedSkillCount(tabs) === 0 && remote) {
		return [remote, ...installed];
	}
	return remote ? [...installed, remote] : installed;
}

function sourceLabel(source: SkillPickerItem["source"]): string {
	switch (source) {
		case "repo":
			return "custom";
		case "personal":
			return "personal";
		case "skills-sh":
			return "remote";
	}
}
