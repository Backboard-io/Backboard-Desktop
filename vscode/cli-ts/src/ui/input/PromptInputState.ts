import { assertNever } from "../../utils/assert.ts";
import {
	completeSlashCommandInput,
	type SlashCommandSuggestion,
} from "../commands/index.ts";
import {
	deletePromptInputBeforeCursorOnLine,
	deletePromptInputCharacterAtCursor,
	deletePromptInputCharacterBeforeCursor,
	deletePromptInputWordBeforeCursor,
	emptyPromptInputEdit,
	insertPromptInputText,
	movePromptInputCursorDown,
	movePromptInputCursorLeft,
	movePromptInputCursorRight,
	movePromptInputCursorToLineEnd,
	movePromptInputCursorToLineStart,
	movePromptInputCursorUp,
	movePromptInputCursorWordLeft,
	movePromptInputCursorWordRight,
	replaceBackslashBeforeCursorWithNewline,
} from "./PromptInputEditing.ts";
import {
	nextPromptHistory,
	previousPromptHistory,
	recordPromptHistory,
	shouldRecallPromptHistoryOnUp,
} from "./PromptInputHistory.ts";
import type { PromptInputKeyAction } from "./PromptInputKeyRouter.types.ts";
import {
	createPromptInputPastePreview,
	type PromptInputPastePreviews,
	preservePromptInputPastePreview,
	resolvePromptInputSubmitValue,
} from "./PromptInputPastePreview.ts";
import type {
	PromptHistoryState,
	PromptInputEdit,
	PromptInputMoveDirection,
	PromptSubmitIntent,
} from "./types.ts";

export interface PromptInputState {
	edit: PromptInputEdit;
	history: PromptHistoryState;
	pastePreviews: PromptInputPastePreviews;
	selectedIndex: number;
}

export interface PromptInputActionContext {
	action: PromptInputKeyAction;
	selectedSuggestion: SlashCommandSuggestion | undefined;
	suggestionsLength: number;
}

export type PromptInputActionEffect =
	| { kind: "none" }
	| { kind: "submit"; intent: PromptSubmitIntent; value: string };

export interface PromptInputActionResult {
	state: PromptInputState;
	effect: PromptInputActionEffect;
}

export function applyPromptInputPaste(
	state: PromptInputState,
	text: string,
): PromptInputState {
	const preview = createPromptInputPastePreview(text);
	if (preview) {
		const edit = insertPromptInputText(state.edit, preview.label);
		return {
			...state,
			edit,
			pastePreviews: [
				...preservePromptInputPastePreview(edit.value, state.pastePreviews),
				preview,
			],
			selectedIndex: 0,
		};
	}

	const edit = insertPromptInputText(state.edit, text);
	return {
		...state,
		edit,
		pastePreviews: preservePromptInputPastePreview(
			edit.value,
			state.pastePreviews,
		),
		selectedIndex: 0,
	};
}

export function applyPromptInputAction(
	state: PromptInputState,
	context: PromptInputActionContext,
): PromptInputActionResult {
	const { action, selectedSuggestion, suggestionsLength } = context;
	switch (action.kind) {
		case "completeSuggestion": {
			const completed = completeSlashCommandInput(
				state.edit.value,
				selectedSuggestion,
			);
			return withoutEffect({
				...state,
				edit: { value: completed, cursorOffset: completed.length },
				pastePreviews: [],
				selectedIndex: 0,
			});
		}
		case "submit": {
			const submitted = resolvePromptInputSubmitValue(
				state.edit.value,
				state.pastePreviews,
				selectedSuggestion?.command,
			);
			if (!submitted) return withoutEffect(state);
			return {
				state: {
					...state,
					edit: emptyPromptInputEdit(),
					history: recordPromptHistory(state.history, submitted),
					pastePreviews: [],
					selectedIndex: 0,
				},
				effect: { kind: "submit", intent: action.intent, value: submitted },
			};
		}
		case "insertNewline":
			return updateEdit(state, insertPromptInputText(state.edit, "\n"));
		case "backslashEnterNewline":
			return updateEdit(
				state,
				replaceBackslashBeforeCursorWithNewline(state.edit),
			);
		case "moveCursor":
			return updateEdit(
				state,
				movePromptInputCursorOverPastePreview(
					movePromptInputCursor(action.direction)(state.edit),
					state.pastePreviews,
					action.direction,
				),
				{
					resetSelection: false,
				},
			);
		case "historyOrMoveUp":
			return applyPromptInputHistoryOrMoveUp(state, suggestionsLength);
		case "historyOrMoveDown":
			return applyPromptInputHistoryOrMoveDown(state, suggestionsLength);
		case "deletePreviousWord":
			return updateEdit(state, deletePromptInputWordBeforeCursor(state.edit));
		case "deleteBeforeCursorOnLine":
			return updateEdit(state, deletePromptInputBeforeCursorOnLine(state.edit));
		case "deletePreviousCharacter":
			return updateEdit(
				state,
				deletePromptInputCharacterBeforeCursorOverPastePreview(
					state.edit,
					state.pastePreviews,
				),
			);
		case "deleteNextCharacter":
			return updateEdit(
				state,
				deletePromptInputCharacterAtCursorOverPastePreview(
					state.edit,
					state.pastePreviews,
				),
			);
		case "slashCompletion":
			return updateEdit(
				state,
				insertPromptInputTextOutsidePastePreview(
					state.edit,
					"/",
					state.pastePreviews,
				),
			);
		case "insertText":
			return updateEdit(
				state,
				insertPromptInputTextOutsidePastePreview(
					state.edit,
					action.text,
					state.pastePreviews,
				),
			);
		case "ignore":
			return withoutEffect(state);
		default:
			assertNever(action);
	}
}

function applyPromptInputHistoryOrMoveUp(
	state: PromptInputState,
	suggestionsLength: number,
): PromptInputActionResult {
	if (
		shouldRecallPromptHistoryOnUp(
			state.history,
			state.edit,
			suggestionsLength > 0,
		)
	) {
		const next = previousPromptHistory(state.history, state.edit.value);
		return withoutEffect({
			...state,
			edit: promptInputEditFromValue(next.value),
			history: next.history,
			pastePreviews: [],
			selectedIndex: 0,
		});
	}
	if (suggestionsLength > 0) {
		return withoutEffect({
			...state,
			selectedIndex:
				(state.selectedIndex - 1 + suggestionsLength) % suggestionsLength,
		});
	}
	return updateEdit(state, movePromptInputCursorUp(state.edit), {
		resetSelection: false,
	});
}

function applyPromptInputHistoryOrMoveDown(
	state: PromptInputState,
	suggestionsLength: number,
): PromptInputActionResult {
	if (state.history.index !== null) {
		const next = nextPromptHistory(state.history);
		return withoutEffect({
			...state,
			edit: promptInputEditFromValue(next.value),
			history: next.history,
			pastePreviews: [],
			selectedIndex: 0,
		});
	}
	if (suggestionsLength > 0) {
		return withoutEffect({
			...state,
			selectedIndex: (state.selectedIndex + 1) % suggestionsLength,
		});
	}
	return updateEdit(state, movePromptInputCursorDown(state.edit), {
		resetSelection: false,
	});
}

function updateEdit(
	state: PromptInputState,
	edit: PromptInputEdit,
	options: { resetSelection?: boolean } = {},
): PromptInputActionResult {
	const selectedIndex =
		options.resetSelection === false ? state.selectedIndex : 0;
	if (edit === state.edit && selectedIndex === state.selectedIndex) {
		return withoutEffect(state);
	}
	return withoutEffect({
		...state,
		edit,
		selectedIndex,
	});
}

function insertPromptInputTextOutsidePastePreview(
	edit: PromptInputEdit,
	text: string,
	previews: PromptInputPastePreviews,
): PromptInputEdit {
	if (findPastePreviewRangeAtOffset(edit, previews, edit.cursorOffset)) {
		return edit;
	}
	return insertPromptInputText(edit, text);
}

function movePromptInputCursorOverPastePreview(
	edit: PromptInputEdit,
	previews: PromptInputPastePreviews,
	direction: PromptInputMoveDirection,
): PromptInputEdit {
	const range = findPastePreviewRangeAtOffset(
		edit,
		previews,
		edit.cursorOffset,
	);
	if (!range) return edit;
	if (direction === "right" || direction === "wordRight") {
		return { ...edit, cursorOffset: range.end };
	}
	if (direction === "left" || direction === "wordLeft") {
		return { ...edit, cursorOffset: range.start };
	}
	const distanceToStart = edit.cursorOffset - range.start;
	const distanceToEnd = range.end - edit.cursorOffset;
	return {
		...edit,
		cursorOffset: distanceToStart <= distanceToEnd ? range.start : range.end,
	};
}

function deletePromptInputCharacterBeforeCursorOverPastePreview(
	edit: PromptInputEdit,
	previews: PromptInputPastePreviews,
): PromptInputEdit {
	const range = findPastePreviewRangeBeforeOffset(
		edit,
		previews,
		edit.cursorOffset,
	);
	if (range) return deletePastePreviewRange(edit, range);
	return deletePromptInputCharacterBeforeCursor(edit);
}

function deletePromptInputCharacterAtCursorOverPastePreview(
	edit: PromptInputEdit,
	previews: PromptInputPastePreviews,
): PromptInputEdit {
	const range = findPastePreviewRangeAfterOffset(
		edit,
		previews,
		edit.cursorOffset,
	);
	if (range) return deletePastePreviewRange(edit, range);
	return deletePromptInputCharacterAtCursor(edit);
}

function deletePastePreviewRange(
	edit: PromptInputEdit,
	range: { start: number; end: number },
): PromptInputEdit {
	return {
		value: edit.value.slice(0, range.start) + edit.value.slice(range.end),
		cursorOffset: range.start,
	};
}

function findPastePreviewRangeAtOffset(
	edit: PromptInputEdit,
	previews: PromptInputPastePreviews,
	offset: number,
): { start: number; end: number } | null {
	return findPastePreviewRange(edit, previews, (range) => {
		return range.start < offset && offset < range.end;
	});
}

function findPastePreviewRangeBeforeOffset(
	edit: PromptInputEdit,
	previews: PromptInputPastePreviews,
	offset: number,
): { start: number; end: number } | null {
	return findPastePreviewRange(edit, previews, (range) => {
		return range.start < offset && offset <= range.end;
	});
}

function findPastePreviewRangeAfterOffset(
	edit: PromptInputEdit,
	previews: PromptInputPastePreviews,
	offset: number,
): { start: number; end: number } | null {
	return findPastePreviewRange(edit, previews, (range) => {
		return range.start <= offset && offset < range.end;
	});
}

function findPastePreviewRange(
	edit: PromptInputEdit,
	previews: PromptInputPastePreviews,
	matches: (range: { start: number; end: number }) => boolean,
): { start: number; end: number } | null {
	for (const preview of previews) {
		let start = edit.value.indexOf(preview.label);
		while (start !== -1) {
			const range = { start, end: start + preview.label.length };
			if (matches(range)) return range;
			start = edit.value.indexOf(preview.label, range.end);
		}
	}
	return null;
}

function withoutEffect(state: PromptInputState): PromptInputActionResult {
	return { state, effect: { kind: "none" } };
}

function promptInputEditFromValue(value: string): PromptInputEdit {
	return { value, cursorOffset: value.length };
}

function movePromptInputCursor(direction: PromptInputMoveDirection) {
	switch (direction) {
		case "left":
			return movePromptInputCursorLeft;
		case "right":
			return movePromptInputCursorRight;
		case "lineStart":
			return movePromptInputCursorToLineStart;
		case "lineEnd":
			return movePromptInputCursorToLineEnd;
		case "up":
			return movePromptInputCursorUp;
		case "down":
			return movePromptInputCursorDown;
		case "wordLeft":
			return movePromptInputCursorWordLeft;
		case "wordRight":
			return movePromptInputCursorWordRight;
		default:
			assertNever(direction);
	}
}
