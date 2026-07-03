import type React from "react";
import type { MemoryMode } from "../../config/defaults.ts";
import { Picker, type PickerTab } from "./Picker.tsx";

export interface MemoryChoice {
	label: string;
	mode: MemoryMode;
	description: string;
}

const MEMORY_CHOICES: readonly MemoryChoice[] = [
	{
		label: "Off",
		mode: "off",
		description: "Use only the current thread",
	},
	{
		label: "Auto",
		mode: "auto",
		description: "Save and retrieve assistant memories",
	},
	{
		label: "Readonly",
		mode: "readonly",
		description: "Retrieve memories without saving new ones",
	},
];

interface Props {
	onSelect: (choice: MemoryChoice) => void | Promise<void>;
	onCancel: () => void;
}

export function MemorySelector({
	onSelect,
	onCancel,
}: Props): React.ReactElement {
	return (
		<Picker
			title="Select Memory"
			tabs={memoryTabs()}
			onSelect={onSelect}
			onCancel={onCancel}
			emptyLabel="No memory options."
			showSearch={false}
		/>
	);
}

export function memoryChoices(): readonly MemoryChoice[] {
	return MEMORY_CHOICES;
}

function memoryTabs(): PickerTab<MemoryChoice>[] {
	return [
		{
			id: "memory",
			label: "Memory",
			items: MEMORY_CHOICES.map((choice) => ({
				id: choice.mode,
				name: choice.label,
				description: choice.description,
				value: choice,
			})),
		},
	];
}
