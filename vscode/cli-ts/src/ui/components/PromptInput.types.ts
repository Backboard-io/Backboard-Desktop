import type { Command } from "../commands/index.ts";
import type {
	PromptHistoryState,
	PromptSubmitIntent,
	QueuedPromptItem,
} from "../input/types.ts";

export type {
	PromptHistoryState,
	PromptInputCursorPosition,
	PromptInputEdit,
	PromptSubmitIntent,
	QueuedPromptItem,
} from "../input/types.ts";

export interface PromptInputProps {
	disabled?: boolean;
	busy?: boolean;
	queuedPrompts?: readonly QueuedPromptItem[];
	skillCommands?: readonly string[];
	allowCommand?: (type: Command["type"]) => boolean;
	promptHistory?: PromptHistoryState;
	onPromptHistoryChange?: (history: PromptHistoryState) => void;
	onSubmit: (value: string, intent: PromptSubmitIntent) => void;
}
