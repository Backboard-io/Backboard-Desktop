/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { h } from '../../../../../../../base/browser/dom.js';
import { createPixelSpinner } from '../../../../../../../base/browser/ui/pixelSpinner/pixelSpinner.js';
import { isMarkdownString, MarkdownString } from '../../../../../../../base/common/htmlContent.js';
import { IConfigurationService } from '../../../../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../../../../platform/instantiation/common/instantiation.js';
import { ChatConfiguration } from '../../../../common/constants.js';
import { migrateLegacyTerminalToolSpecificData } from '../../../../common/chat.js';
import { IChatToolInvocation, IChatToolInvocationSerialized, ToolConfirmKind, type IChatMarkdownContent, type IChatTerminalToolInvocationData, type ILegacyChatTerminalToolInvocationData } from '../../../../common/chatService/chatService.js';
import { ChatTreeItem, IChatCodeBlockInfo, IChatWidgetService } from '../../../chat.js';
import { ChatQueryTitlePart } from '../chatConfirmationWidget.js';
import { IChatContentPartRenderContext } from '../chatContentParts.js';
import { ChatMarkdownContentPart, type IChatMarkdownContentPartOptions } from '../chatMarkdownContentPart.js';
import { ChatProgressSubPart } from '../chatProgressContentPart.js';
import { ChatResourceGroupWidget } from '../chatResourceGroupWidget.js';
import { IChatCollapsibleIODataPart } from '../chatToolInputOutputContentPart.js';
import { BaseChatToolInvocationSubPart } from './chatToolInvocationSubPart.js';
import { extractImagesFromToolInvocationOutputDetails } from '../../../../common/chatImageExtraction.js';
import { TerminalToolAutoExpand } from './terminalToolAutoExpand.js';
import { ChatCollapsibleContentPart } from '../chatCollapsibleContentPart.js';
import { IChatRendererContent } from '../../../../common/model/chatViewModel.js';
import '../media/chatTerminalToolProgressPart.css';
import type { ICodeBlockRenderOptions } from '../codeBlockPart.js';
import { Action, IAction } from '../../../../../../../base/common/actions.js';
import { ActionBar } from '../../../../../../../base/browser/ui/actionbar/actionbar.js';
import { timeout } from '../../../../../../../base/common/async.js';
import { IAhpTerminalCommandSource, IChatTerminalToolProgressPart, ITerminalChatService, ITerminalConfigurationService, ITerminalEditorService, ITerminalGroupService, ITerminalInstance, ITerminalService } from '../../../../../terminal/browser/terminal.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable, type IDisposable } from '../../../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../../../base/common/event.js';
import { autorun } from '../../../../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../../../../base/common/themables.js';
import { DecorationSelector, getTerminalCommandDecorationState, getTerminalCommandDecorationTooltip } from '../../../../../terminal/browser/xterm/decorationStyles.js';
import * as dom from '../../../../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../../../../base/browser/keyboardEvent.js';
import { KeyCode } from '../../../../../../../base/common/keyCodes.js';
import { DomScrollableElement } from '../../../../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { ScrollbarVisibility } from '../../../../../../../base/common/scrollable.js';
import { localize } from '../../../../../../../nls.js';
import { ITerminalCommand, TerminalCapability, type ICommandDetectionCapability } from '../../../../../../../platform/terminal/common/capabilities/capabilities.js';
import { IMarkdownRenderer } from '../../../../../../../platform/markdown/browser/markdownRenderer.js';
import { IHoverService } from '../../../../../../../platform/hover/browser/hover.js';
import { URI } from '../../../../../../../base/common/uri.js';
import { stripIcons } from '../../../../../../../base/common/iconLabels.js';
import { IAccessibleViewService } from '../../../../../../../platform/accessibility/browser/accessibleView.js';
import { IContextKey, IContextKeyService } from '../../../../../../../platform/contextkey/common/contextkey.js';
import { AccessibilityVerbositySettingId } from '../../../../../accessibility/browser/accessibilityConfiguration.js';
import { ChatContextKeys } from '../../../../common/actions/chatContextKeys.js';
import { EditorPool } from '../chatContentCodePools.js';
import { DetachedTerminalCommandMirror, DetachedTerminalSnapshotMirror, getTerminalColumnCountForWidth, getTerminalSnapshotLineCount } from '../../../../../terminal/browser/chatTerminalCommandMirror.js';
import { TerminalLocation } from '../../../../../../../platform/terminal/common/terminal.js';
import { Codicon } from '../../../../../../../base/common/codicons.js';
import { TerminalContribCommandId } from '../../../../../terminal/terminalContribExports.js';
import { ITelemetryService } from '../../../../../../../platform/telemetry/common/telemetry.js';
import { isNumber } from '../../../../../../../base/common/types.js';
import { removeAnsiEscapeCodes } from '../../../../../../../base/common/strings.js';
import type { Color } from '../../../../../../../base/common/color.js';
import { PANEL_BACKGROUND } from '../../../../../../common/theme.js';
import { editorBackground } from '../../../../../../../platform/theme/common/colorRegistry.js';
import { IThemeService, type IColorTheme } from '../../../../../../../platform/theme/common/themeService.js';
import { CommandsRegistry } from '../../../../../../../platform/commands/common/commands.js';

/**
 * Minimum number of rows to display in the terminal output view.
 */
const MIN_OUTPUT_ROWS = 1;

/** Minimum height of a one-line terminal status such as "No output". */
const MIN_EMPTY_OUTPUT_HEIGHT = 34;

/**
 * Maximum number of rows to display in the terminal output view before scrolling.
 */
const MAX_OUTPUT_ROWS = 14;

/**
 * Maximum number of retries when waiting for terminal output to appear.
 */
const MAX_OUTPUT_POLL_RETRIES = 10;

/**
 * Delay between retries when polling for terminal output (in milliseconds).
 */
const OUTPUT_POLL_DELAY_MS = 100;

/**
 * Minimum number of data events that indicate real output (vs shell integration sequences).
 */
const MIN_DATA_EVENTS_FOR_REAL_OUTPUT = 2;

/**
 * Remembers whether a tool invocation was last expanded so state survives virtualization re-renders.
 */
const expandedStateByInvocation = new WeakMap<IChatToolInvocation | IChatToolInvocationSerialized, boolean>();
const userToggledOutputByInvocation = new WeakSet<IChatToolInvocation | IChatToolInvocationSerialized>();

function isBackboardCursorTranscript(container: HTMLElement): boolean {
	return container.closest('.backboard-cursor-transcript') !== null
		|| (container.closest('.part.auxiliarybar') !== null && container.closest('.backboard-chat-controls') !== null);
}

const COMPACT_TERMINAL_PREVIEW_LINES = 4;
const COMPACT_TERMINAL_PREVIEW_LINE_LENGTH = 160;

export interface ICollapsedTerminalOutputPreview {
	readonly text: string;
	readonly overflowing: boolean;
}

export function getTerminalInitialExpandedState(storedExpanded: boolean | undefined, useCursorTranscriptPresentation: boolean, isComplete: boolean, hasError: boolean): boolean {
	if (storedExpanded !== undefined) {
		return storedExpanded;
	}
	// The transcript shell starts commands closed and lets TerminalToolAutoExpand
	// reveal only meaningful, long-running output. Other chat presentations keep
	// the existing behavior of opening an active command immediately.
	return hasError || (!useCursorTranscriptPresentation && !isComplete);
}

/** Choose the label text without reintroducing a provider's abbreviated summary. */
export function getTerminalCollapsibleLabel(compactCommand: string, fullCommand: string, useCursorTranscriptPresentation: boolean): string {
	return useCursorTranscriptPresentation ? fullCommand : compactCommand;
}

function removeEchoedTerminalCommand(lines: string[], commandText: string | undefined): void {
	const command = commandText?.trim() ?? '';
	if (!command) {
		return;
	}

	// This is a compatibility cleanup for the old CLI-TS framing only. An echo
	// can be removed safely when it is the first content line, or immediately
	// follows the leading `Success` marker, and the prompt contains the exact
	// command. Prompt-looking text later in stdout is real output.
	const firstContentIndex = lines.findIndex(line => !!line.trim());
	if (firstContentIndex < 0) {
		return;
	}
	const successIndex = lines[firstContentIndex].trim() === 'Success' ? firstContentIndex : undefined;
	let promptIndex = successIndex === undefined ? firstContentIndex : firstContentIndex + 1;
	while (promptIndex < lines.length && !lines[promptIndex].trim()) {
		promptIndex++;
	}
	const promptMatch = /^\s*[$%❯]\s+(.+)$/.exec(lines[promptIndex] ?? '');
	if (promptMatch?.[1].trim() === command) {
		lines.splice(promptIndex, 1);
		if (successIndex !== undefined) {
			lines.splice(successIndex, 1);
		}
	}
}

export function getCollapsedTerminalOutputPreview(output: string | undefined, commandText?: string): ICollapsedTerminalOutputPreview | undefined {
	const lines = removeAnsiEscapeCodes(output ?? '').split(/\r?\n/);
	removeEchoedTerminalCommand(lines, commandText);
	while (lines.length && !lines[0].trim()) {
		lines.shift();
	}
	while (lines.length && !lines[lines.length - 1].trim()) {
		lines.pop();
	}
	if (!lines.length) {
		return undefined;
	}

	let overflowing = lines.length > COMPACT_TERMINAL_PREVIEW_LINES;
	const visibleLines = lines.slice(0, COMPACT_TERMINAL_PREVIEW_LINES).map(line => {
		const trimmedLine = line.trimEnd();
		if (trimmedLine.length <= COMPACT_TERMINAL_PREVIEW_LINE_LENGTH) {
			return trimmedLine;
		}
		overflowing = true;
		return `${trimmedLine.slice(0, COMPACT_TERMINAL_PREVIEW_LINE_LENGTH - 1)}…`;
	});
	return { text: visibleLines.join('\n'), overflowing };
}


export function getTerminalOutputViewportHeight(contentHeight: number, maxHeight: number, useCursorTranscriptPresentation: boolean): string {
	// Fit short output to its content, keeping transcript scrollback bounded
	// once the output reaches the maximum viewport height.
	const clampedHeight = Math.min(contentHeight, maxHeight);
	return useCursorTranscriptPresentation || clampedHeight < maxHeight ? `${clampedHeight}px` : '';
}

export function calculateTerminalOutputContentHeight(
	lineCount: number,
	rowHeight: number,
	padding: number,
	isEmptyState: boolean,
	emptyStateHeight: number = MIN_EMPTY_OUTPUT_HEIGHT,
): number {
	// Add buffer to prevent bottom cropping from xterm pixel rounding and scrollbar space
	const BUFFER_PX = padding === 0 && !isEmptyState ? 0 : Math.ceil(rowHeight * 0.5);
	const terminalHeight = (Math.max(lineCount, MIN_OUTPUT_ROWS) * rowHeight) + padding + BUFFER_PX;
	return isEmptyState ? Math.max(terminalHeight, MIN_EMPTY_OUTPUT_HEIGHT, emptyStateHeight) : terminalHeight;
}

export function getTerminalWheelScrollLines(deltaY: number, deltaMode: number, rowHeight: number): number {
	if (!deltaY) {
		return 0;
	}
	const direction = Math.sign(deltaY);
	const magnitude = deltaMode === 1
		? Math.ceil(Math.abs(deltaY))
		: deltaMode === 2
			? MAX_OUTPUT_ROWS
			: Math.max(1, Math.ceil(Math.abs(deltaY) / Math.max(rowHeight, 1)));
	return direction * magnitude;
}

export function shouldAutoExpandTerminalFailure(autoExpandFailures: boolean, exitCode: number | undefined, userToggledOutput: boolean): boolean {
	return autoExpandFailures && !userToggledOutput && exitCode !== undefined && exitCode !== 0;
}

/**
 * Whether a finished command should fold its output back up. Output that was
 * auto-expanded while the command streamed collapses once it completes unless
 * the user chose a disclosure state themselves or failure auto-expansion is on
 * and the command failed.
 */
export function shouldAutoCollapseTerminalOnCompletion(autoExpandFailures: boolean, exitCode: number | undefined, userToggledOutput: boolean): boolean {
	return exitCode !== undefined && !userToggledOutput && !shouldAutoExpandTerminalFailure(autoExpandFailures, exitCode, userToggledOutput);
}

export function shouldRenderStoredTerminalOutputFirst(hasStoredOutput: boolean, commandIsComplete: boolean): boolean {
	return hasStoredOutput && commandIsComplete;
}

export function resolveStoredTerminalOutputLineCount(text: string | undefined, storedLineCount: number | undefined, lastRenderedLineCount: number | undefined): number {
	return getTerminalSnapshotLineCount(text ?? '', Math.max(storedLineCount ?? 0, lastRenderedLineCount ?? 0));
}

// --- Command registrations for terminal tool progress toolbar ---

CommandsRegistry.registerCommand(TerminalContribCommandId.FocusChatInstanceAction, async (_accessor: unknown, progressPart?: IChatTerminalToolProgressPart) => {
	await progressPart?.focusTerminal();
});

CommandsRegistry.registerCommand(TerminalContribCommandId.ContinueInBackground, async (_accessor: unknown, progressPart?: IChatTerminalToolProgressPart) => {
	progressPart?.continueInBackground();
});

CommandsRegistry.registerCommand(TerminalContribCommandId.ToggleChatTerminalOutput, async (_accessor: unknown, progressPart?: IChatTerminalToolProgressPart) => {
	await progressPart?.toggleOutputFromAction();
});

/**
 * Options for configuring a terminal command decoration.
 */
interface ITerminalCommandDecorationOptions {
	/**
	 * The terminal data associated with the tool invocation.
	 */
	readonly terminalData: IChatTerminalToolInvocationData;

	/**
	 * Returns the HTML element representing the command block in the terminal output.
	 * May return `undefined` if the command block is not currently rendered.
	 * Called when attaching the decoration to the command block container.
	 */
	getCommandBlock(): HTMLElement | undefined;

	/**
	 * Returns the HTML element representing the icon for the command, if any.
	 * May return `undefined` if no icon is present.
	 * Used to determine where to insert the decoration relative to the icon.
	 */
	getIconElement(): HTMLElement | undefined;

	/**
	 * Returns the resolved terminal command associated with this decoration, if available.
	 * May return `undefined` if the command has not been resolved yet.
	 * Used to access command metadata for the decoration.
	 */
	getResolvedCommand(): ITerminalCommand | undefined;

	/**
	 * Returns whether the tool invocation is currently running.
	 */
	getIsRunning(): boolean;
}

class TerminalCommandDecoration extends Disposable {
	private readonly _element: HTMLElement;
	private _hoverRegistered = false;

	constructor(
		private readonly _options: ITerminalCommandDecorationOptions,
		@IHoverService private readonly _hoverService: IHoverService
	) {
		super();
		const decorationElements = h('span.chat-terminal-command-decoration@decoration', { role: 'img', tabIndex: 0 });
		this._element = decorationElements.decoration;
		createPixelSpinner(this._element);
		this._attachElementToContainer();
	}

	private _attachElementToContainer(): void {
		const container = this._options.getCommandBlock();
		if (!container) {
			return;
		}

		const decoration = this._element;
		if (!decoration.isConnected || decoration.parentElement !== container) {
			const icon = this._options.getIconElement();
			if (icon && icon.parentElement === container) {
				icon.insertAdjacentElement('afterend', decoration);
			} else {
				container.insertBefore(decoration, container.firstElementChild ?? null);
			}
		}

		if (!this._hoverRegistered) {
			this._hoverRegistered = true;
			this._register(this._hoverService.setupDelayedHover(decoration, () => ({
				content: this._getHoverText()
			})));
		}
	}

	private _getHoverText(): string {
		const command = this._options.getResolvedCommand();
		const storedState = this._options.terminalData.terminalCommandState;
		return getTerminalCommandDecorationTooltip(command, storedState) || '';
	}

	public update(command?: ITerminalCommand): void {
		this._attachElementToContainer();
		const decoration = this._element;
		const resolvedCommand = command ?? this._options.getResolvedCommand();
		this._apply(decoration, resolvedCommand);
	}

	private _apply(decoration: HTMLElement, command: ITerminalCommand | undefined): void {
		const terminalData = this._options.terminalData;
		let storedState = terminalData.terminalCommandState;

		if (command) {
			const existingState = terminalData.terminalCommandState ?? {};
			terminalData.terminalCommandState = {
				...existingState,
				exitCode: command.exitCode,
				timestamp: command.timestamp ?? existingState.timestamp,
				duration: command.duration ?? existingState.duration
			};
			storedState = terminalData.terminalCommandState;
		} else if (!storedState) {
			const now = Date.now();
			terminalData.terminalCommandState = { exitCode: undefined, timestamp: now };
			storedState = terminalData.terminalCommandState;
		}

		const decorationState = getTerminalCommandDecorationState(command, storedState);
		const tooltip = getTerminalCommandDecorationTooltip(command, storedState);

		const isRunning = this._options.getIsRunning();

		decoration.className = `chat-terminal-command-decoration ${DecorationSelector.CommandDecoration}`;
		if (isRunning) {
			const nonIconClasses = decorationState.classNames.filter(c => c !== DecorationSelector.Codicon && !c.startsWith('codicon-'));
			decoration.classList.add('chat-terminal-running-spinner', ...nonIconClasses);
		} else {
			decoration.classList.add(DecorationSelector.Codicon, ...decorationState.classNames, ...ThemeIcon.asClassNameArray(decorationState.icon));
		}
		const isInteractive = !decoration.classList.contains(DecorationSelector.Default);
		decoration.tabIndex = isInteractive ? 0 : -1;
		if (isInteractive) {
			decoration.removeAttribute('aria-disabled');
		} else {
			decoration.setAttribute('aria-disabled', 'true');
		}
		const hoverText = tooltip || decorationState.hoverMessage;
		if (hoverText) {
			decoration.setAttribute('aria-label', hoverText);
		} else {
			decoration.removeAttribute('aria-label');
		}
	}

}

/**
 * A chat content part that displays terminal tool invocation progress.
 *
 * This component shows:
 * - The command being executed with syntax highlighting
 * - A status decoration indicating success/failure/running state
 * - Expandable terminal output with live streaming support
 * - Actions to focus the terminal, show/hide output, and continue in background
 *
 * The component supports two rendering modes:
 * - Standard mode: Shows full progress with status indicators
 * - Collapsible wrapper mode: For thinking containers with simplified UI
 *
 * Output auto-expansion behavior:
 * - Long-running commands with output auto-expand after a short delay
 * - Fast commands that complete quickly don't auto-expand (prevents flickering)
 * - Completed commands auto-collapse if output was auto-expanded, whether they
 *   succeeded or failed
 * - Failed commands can opt in to auto-expanding via `chat.tools.autoExpandFailures`
 */
export class ChatTerminalToolProgressPart extends BaseChatToolInvocationSubPart implements IChatTerminalToolProgressPart {
	public readonly domNode: HTMLElement;

	private readonly _titleElement: HTMLElement;
	private readonly _outputView: ChatTerminalToolOutputSection;
	private readonly _terminalOutputContextKey: IContextKey<boolean>;
	private _terminalSessionRegistration: IDisposable | undefined;
	private readonly _elementIndex: number;
	private readonly _contentIndex: number;
	private readonly _sessionResource: URI;

	// Toolbar state that drives action visibility (replaces context keys to avoid
	// accumulating listeners on the shared IContextKeyService when many parts exist)
	private _toolbarHasInstance = false;
	private _toolbarCanContinueInBackground = false;
	private _toolbarHasOutput = false;
	private _toolbarIsHiddenTerminal = false;
	private _toolbarOutputExpanded = false;
	private _actionBar: ActionBar | undefined;
	private readonly _actionBarActions = new DisposableStore();

	private readonly _terminalData: IChatTerminalToolInvocationData;
	private _terminalCommandUri: URI | undefined;
	private readonly _commandText: string;
	private readonly _isSerializedInvocation: boolean;
	private _terminalInstance: ITerminalInstance | undefined;
	private readonly _decoration: TerminalCommandDecoration;
	private _userToggledOutput: boolean = false;
	private _isInThinkingContainer: boolean = false;
	private _usesCollapsibleWrapper: boolean = false;
	private _thinkingCollapsibleWrapper: ChatTerminalThinkingCollapsibleWrapper | undefined;
	private readonly _useCursorTranscriptPresentation: boolean;
	private _collapsedOutputPreviewElement: HTMLElement | undefined;
	private readonly _terminalContentElement: HTMLElement;

	private markdownPart: ChatMarkdownContentPart | undefined;
	public get codeblocks(): IChatCodeBlockInfo[] {
		return this.markdownPart?.codeblocks ?? [];
	}

	public get elementIndex(): number {
		return this._elementIndex;
	}

	public get contentIndex(): number {
		return this._contentIndex;
	}

	constructor(
		toolInvocation: IChatToolInvocation | IChatToolInvocationSerialized,
		terminalData: IChatTerminalToolInvocationData | ILegacyChatTerminalToolInvocationData,
		context: IChatContentPartRenderContext,
		renderer: IMarkdownRenderer,
		editorPool: EditorPool,
		currentWidthDelegate: () => number,
		codeBlockStartIndex: number,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ITerminalChatService private readonly _terminalChatService: ITerminalChatService,
		@ITerminalService private readonly _terminalService: ITerminalService,
		@IContextKeyService private readonly _contextKeyService: IContextKeyService,
		@IChatWidgetService private readonly _chatWidgetService: IChatWidgetService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ITerminalEditorService private readonly _terminalEditorService: ITerminalEditorService,
		@ITerminalGroupService private readonly _terminalGroupService: ITerminalGroupService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
	) {
		super(toolInvocation);

		this._elementIndex = context.elementIndex;
		this._contentIndex = context.contentIndex;
		this._sessionResource = context.element.sessionResource;
		this._useCursorTranscriptPresentation = isBackboardCursorTranscript(context.container);

		terminalData = migrateLegacyTerminalToolSpecificData(terminalData);
		this._terminalData = terminalData;
		this._terminalCommandUri = terminalData.terminalCommandUri ? URI.revive(terminalData.terminalCommandUri) : undefined;
		this._isSerializedInvocation = (toolInvocation.kind === 'toolInvocationSerialized');

		const elements = h('.chat-terminal-content-part@container', [
			h('.chat-terminal-content-title@title', [
				h('.chat-terminal-command-block@commandBlock')
			]),
			h('.chat-terminal-content-message@message')
		]);
		this._titleElement = elements.title;
		this._terminalContentElement = elements.container;

		// `forDisplay` is intentionally compact and may already contain a literal
		// ellipsis (not a CSS truncation). Retain the effective command so the
		// Cursor transcript can reveal every character that was submitted to the
		// shell, while other terminal presentations can keep their compact label.
		const command = (terminalData.commandLine.userEdited ?? terminalData.commandLine.toolEdited ?? terminalData.commandLine.original).trimStart();
		const compactCommand = (terminalData.presentationOverrides?.commandLine ?? terminalData.commandLine.forDisplay ?? command).trimStart();
		this._commandText = command;
		this._terminalOutputContextKey = ChatContextKeys.inChatTerminalToolOutput.bindTo(this._contextKeyService);

		this._decoration = this._register(this._instantiationService.createInstance(TerminalCommandDecoration, {
			terminalData: this._terminalData,
			getCommandBlock: () => elements.commandBlock,
			getIconElement: () => undefined,
			getResolvedCommand: () => this._getResolvedCommand(),
			getIsRunning: () => this._isInvocationRunning()
		}));

		// Use presentationOverrides for display if available (e.g., extracted Python code with syntax highlighting)
		const displayCommand = terminalData.presentationOverrides?.commandLine ?? command;
		const displayLanguage = terminalData.presentationOverrides?.language ?? terminalData.language;
		const titlePart = this._register(_instantiationService.createInstance(
			ChatQueryTitlePart,
			elements.commandBlock,
			new MarkdownString([
				`\`\`\`${displayLanguage}`,
				`${displayCommand.replaceAll('```', '\\`\\`\\`')}`,
				`\`\`\``
			].join('\n'), { supportThemeIcons: true }),
			undefined,
		));
		this._register(titlePart.onDidChangeHeight(() => {
			this._decoration.update();
		}));

		this._outputView = this._register(this._instantiationService.createInstance(
			ChatTerminalToolOutputSection,
			() => this._ensureTerminalInstance(),
			() => this._getResolvedCommand(),
			() => this._terminalData.terminalCommandOutput,
			() => this._commandText,
			() => this._terminalData.terminalTheme,
			!!this._terminalData.terminalToolSessionId,
			() => this._terminalData.terminalCommandState?.exitCode !== undefined
				|| (IChatToolInvocation.isComplete(toolInvocation)
					&& this._terminalData.isBackground !== true
					&& this._terminalData.didContinueInBackground !== true),
			this._useCursorTranscriptPresentation,
		));
		// Every terminal row must have something to reveal. Display-only commands
		// can briefly (or, for old history, permanently) lack a stored snapshot;
		// keeping the output section mounted makes the disclosure deterministic and
		// lets it explain that state instead of appearing to ignore the click.
		this._ensureOutputViewMounted();
		this._register(this._outputView.onDidFocus(() => this._handleOutputFocus()));
		this._register(this._outputView.onDidBlur(e => this._handleOutputBlur(e)));
		this._register(toDisposable(() => this._handleDispose()));

		// Use a lightweight ActionBar instead of MenuWorkbenchToolBar to avoid
		// accumulating listeners on the shared IContextKeyService when many
		// terminal tool progress parts exist concurrently (fixes listener LEAK).
		const actionBarEl = h('.chat-terminal-action-bar@actionBar');
		elements.title.append(actionBarEl.root);
		this._actionBar = this._register(new ActionBar(actionBarEl.actionBar));
		this._register(this._actionBarActions);
		let didInitializeTerminalActions = false;
		const initializeTerminalActionsOnce = () => {
			if (didInitializeTerminalActions || this._store.isDisposed) {
				return;
			}
			didInitializeTerminalActions = true;
			this._initializeTerminalActions();
		};
		initializeTerminalActionsOnce();
		this._terminalService.whenConnected.then(() => {
			initializeTerminalActionsOnce();
		});

		// Listen for continue in background — updates toolbar to auto-hide the action
		const terminalToolSessionId = this._terminalData.terminalToolSessionId;
		if (terminalToolSessionId) {
			this._register(this._terminalChatService.onDidContinueInBackground(sessionId => {
				if (sessionId === terminalToolSessionId) {
					this._terminalData.didContinueInBackground = true;
					this._toolbarCanContinueInBackground = false;
					this._updateToolbarActions();
				}
			}));
		}
		let pastTenseMessage: string | undefined;
		if (toolInvocation.pastTenseMessage) {
			pastTenseMessage = `${typeof toolInvocation.pastTenseMessage === 'string' ? toolInvocation.pastTenseMessage : toolInvocation.pastTenseMessage.value}`;
		}
		const markdownContent = new MarkdownString(pastTenseMessage, {
			supportThemeIcons: true,
			isTrusted: isMarkdownString(toolInvocation.pastTenseMessage) ? toolInvocation.pastTenseMessage.isTrusted : false,
		});
		const chatMarkdownContent: IChatMarkdownContent = {
			kind: 'markdownContent',
			content: markdownContent,
		};

		const codeBlockRenderOptions: ICodeBlockRenderOptions = {
			hideToolbar: true,
			reserveWidth: 19,
			verticalPadding: 5,
			editorOptions: {
				wordWrap: 'on'
			}
		};

		const markdownOptions: IChatMarkdownContentPartOptions = {
			codeBlockRenderOptions,
			accessibilityOptions: pastTenseMessage ? {
				statusMessage: localize('terminalToolCommand', '{0}', stripIcons(pastTenseMessage))
			} : undefined
		};

		this.markdownPart = this._register(_instantiationService.createInstance(ChatMarkdownContentPart, chatMarkdownContent, context, editorPool, false, codeBlockStartIndex, renderer, {}, currentWidthDelegate(), markdownOptions));

		elements.message.append(this.markdownPart.domNode);
		const progressPart = this._register(_instantiationService.createInstance(ChatProgressSubPart, elements.container, this.getIcon(), terminalData.autoApproveInfo));
		progressPart.domNode.classList.add('chat-terminal-progress-row');
		this._decoration.update();
		if (toolInvocation.kind === 'toolInvocation') {
			this._register(autorun(reader => {
				toolInvocation.state.read(reader);
				this._decoration.update();
			}));
		}

		// Keep thinking-container semantics separate from wrapper semantics.
		const terminalToolsInThinking = this._configurationService.getValue<boolean>(ChatConfiguration.TerminalToolsInThinking);
		const isSimpleTerminal = this._configurationService.getValue<boolean>(ChatConfiguration.SimpleTerminalCollapsible);
		const requiresConfirmation = toolInvocation.kind === 'toolInvocation' && IChatToolInvocation.getConfirmationMessages(toolInvocation);
		this._isInThinkingContainer = terminalToolsInThinking && !requiresConfirmation;
		this._usesCollapsibleWrapper = this._isInThinkingContainer || isSimpleTerminal;

		if (this._usesCollapsibleWrapper) {
			const collapsibleLabel = getTerminalCollapsibleLabel(compactCommand, command, this._useCursorTranscriptPresentation);
			this.domNode = this._createCollapsibleWrapper(progressPart.domNode, collapsibleLabel, command, toolInvocation, context);
		} else {
			this.domNode = progressPart.domNode;
		}

		this._renderImagePills(toolInvocation, context, elements.container);

		// Only auto-expand in thinking containers if there's actual output to show
		const hasStoredOutput = !!terminalData.terminalCommandOutput;
		const shouldExpandOutput = this._thinkingCollapsibleWrapper
			? this._thinkingCollapsibleWrapper.expanded.get()
			: expandedStateByInvocation.get(toolInvocation) || (this._isInThinkingContainer && IChatToolInvocation.isComplete(toolInvocation) && hasStoredOutput);
		if (shouldExpandOutput) {
			void this._toggleOutput(true);
		}
		this._register(this._terminalChatService.registerProgressPart(this));
	}

	/**
	 * Renders image attachment pills below the terminal output when the tool
	 * result contains image data parts. For collapsible wrappers, the single
	 * widget is reparented between inside/outside based on expanded state.
	 */
	private _renderImagePills(toolInvocation: IChatToolInvocation | IChatToolInvocationSerialized, context: IChatContentPartRenderContext, innerContainer: HTMLElement): void {
		const renderImages = () => {
			const extracted = extractImagesFromToolInvocationOutputDetails(toolInvocation, context.element.sessionResource);
			const imageParts: IChatCollapsibleIODataPart[] = extracted.map(img => ({
				kind: 'data',
				value: img.data.buffer,
				mimeType: img.mimeType,
				uri: img.uri,
			}));
			if (imageParts.length === 0) {
				return;
			}

			const widget = this._register(this._instantiationService.createInstance(ChatResourceGroupWidget, imageParts));

			if (this._thinkingCollapsibleWrapper) {
				// Reparent the single widget between inner (expanded) and outer (collapsed)
				const wrapper = this._thinkingCollapsibleWrapper;
				const placeWidget = (expanded: boolean) => {
					if (expanded) {
						innerContainer.appendChild(widget.domNode);
					} else {
						wrapper.domNode.appendChild(widget.domNode);
					}
				};
				placeWidget(wrapper.expanded.get());
				this._register(autorun(reader => {
					placeWidget(wrapper.expanded.read(reader));
				}));
			} else {
				innerContainer.appendChild(widget.domNode);
			}
		};

		if (toolInvocation.kind === 'toolInvocationSerialized') {
			renderImages();
		} else {
			this._register(autorun(reader => {
				const state = toolInvocation.state.read(reader);
				if (state.type === IChatToolInvocation.StateKind.Completed) {
					renderImages();
				}
			}));
		}
	}

	private _createCollapsibleWrapper(contentElement: HTMLElement, compactCommandText: string, fullCommandText: string, toolInvocation: IChatToolInvocation | IChatToolInvocationSerialized, context: IChatContentPartRenderContext): HTMLElement {
		// A background terminal may have its tool invocation marked complete (the
		// tool returned) while the terminal command is still running. Detect this
		// so the wrapper shows "Running … in background" instead of "Ran …".
		const toolInvocationComplete = IChatToolInvocation.isComplete(toolInvocation);
		const commandHasNotFinished = this._terminalData.terminalCommandState?.exitCode === undefined;
		const isRunningInBackground = toolInvocationComplete && commandHasNotFinished
			&& (this._terminalData.isBackground === true || this._terminalData.didContinueInBackground === true);
		const isComplete = toolInvocationComplete && !isRunningInBackground;
		const confirmationOutcome = IChatToolInvocation.executionConfirmedOrDenied(toolInvocation);
		const isSkipped = confirmationOutcome?.type === ToolConfirmKind.Skipped;
		// Pre-1.104 serialized invocations used `undefined` for an unknown approval
		// state. Only classify a serialized denial when it was explicitly persisted.
		const isDenied = confirmationOutcome?.type === ToolConfirmKind.Denied
			&& (toolInvocation.kind === 'toolInvocation' || toolInvocation.isConfirmed !== undefined);
		const autoExpandFailures = this._configurationService.getValue<boolean>(ChatConfiguration.AutoExpandToolFailures);
		const commandFailed = this._terminalData.terminalCommandState?.exitCode !== undefined && this._terminalData.terminalCommandState.exitCode !== 0;
		const hasError = autoExpandFailures && commandFailed;
		const storedExpanded = expandedStateByInvocation.get(toolInvocation);
		const initialExpanded = getTerminalInitialExpandedState(storedExpanded, this._useCursorTranscriptPresentation, isComplete, hasError);

		const wrapper = this._register(this._instantiationService.createInstance(
			ChatTerminalThinkingCollapsibleWrapper,
			compactCommandText,
			fullCommandText,
			this._terminalData.commandLine.isSandboxWrapped === true,
			contentElement,
			context,
			initialExpanded,
			isComplete,
			isSkipped,
			isDenied,
			isRunningInBackground,
			commandFailed,
			() => this.focusTerminal(),
			() => this._markOutputUserToggled(),
		));
		this._thinkingCollapsibleWrapper = wrapper;
		if (isComplete || this._terminalData.terminalCommandOutput) {
			this._updateCollapsedOutputPreview();
		}

		// Sync terminal output expansion with the collapsible wrapper.
		// Skip the initial run — initial state is handled separately.
		let isFirstRun = true;
		this._register(autorun(r => {
			const expanded = wrapper.expanded.read(r);
			if (isFirstRun) {
				isFirstRun = false;
				return;
			}
			this._toggleOutput(expanded);
		}));

		return wrapper.domNode;
	}

	public expandCollapsibleWrapper(): void {
		this._thinkingCollapsibleWrapper?.expand();
	}

	private _requestAutoExpandOutput(): void {
		if (this._usesCollapsibleWrapper && this._thinkingCollapsibleWrapper && !this._thinkingCollapsibleWrapper.expanded.get()) {
			// Expanding the wrapper drives the output toggle through its autorun. Do
			// not start a second concurrent xterm/snapshot hydration here.
			this._thinkingCollapsibleWrapper.expand();
			return;
		}
		void this._toggleOutput(true);
	}

	public markCollapsibleWrapperComplete(output?: string, exitCode?: number): void {
		if (output !== undefined) {
			this._terminalData.terminalCommandOutput = {
				...this._terminalData.terminalCommandOutput,
				text: output,
				lineCount: undefined,
			};
			this._ensureOutputViewMounted();
		}
		if (exitCode !== undefined) {
			this._terminalData.terminalCommandState = {
				...this._terminalData.terminalCommandState,
				exitCode,
			};
		}
		this._thinkingCollapsibleWrapper?.markComplete(exitCode !== undefined && exitCode !== 0);
		this._updateCollapsedOutputPreview(output);
	}

	private _ensureOutputViewMounted(): void {
		if (!this._outputView.domNode.parentElement) {
			this._terminalContentElement.append(this._outputView.domNode);
		}
	}

	private _updateCollapsedOutputPreview(output?: string): void {
		if (!this._useCursorTranscriptPresentation || !this._thinkingCollapsibleWrapper) {
			return;
		}
		const outputPreview = getCollapsedTerminalOutputPreview(output ?? this._terminalData.terminalCommandOutput?.text, this._commandText);
		if (!outputPreview) {
			this._collapsedOutputPreviewElement?.remove();
			return;
		}
		this._collapsedOutputPreviewElement ??= dom.$('.chat-terminal-collapsed-output-preview');
		this._collapsedOutputPreviewElement.textContent = outputPreview.text;
		this._collapsedOutputPreviewElement.classList.toggle('chat-terminal-collapsed-output-preview-overflowing', outputPreview.overflowing);
		this._thinkingCollapsibleWrapper.domNode.appendChild(this._collapsedOutputPreviewElement);
	}

	private async _initializeTerminalActions(): Promise<void> {
		if (this._store.isDisposed) {
			return;
		}
		const terminalToolSessionId = this._terminalData.terminalToolSessionId;
		if (!terminalToolSessionId) {
			this._updateToolbarContextKeys();
			return;
		}

		const attachInstance = async (instance: ITerminalInstance | undefined) => {
			if (this._store.isDisposed) {
				return;
			}
			if (!instance) {
				if (this._isSerializedInvocation) {
					this._clearCommandAssociation();
				}
				this._updateToolbarContextKeys(undefined, terminalToolSessionId);
				return;
			}
			const isNewInstance = this._terminalInstance !== instance;
			if (isNewInstance) {
				this._terminalInstance = instance;
				this._registerInstanceListener(instance);
			}
			this._updateToolbarContextKeys(instance, terminalToolSessionId);
		};

		const initialInstance = await this._terminalChatService.getTerminalInstanceByToolSessionId(terminalToolSessionId);
		await attachInstance(initialInstance);

		if (!initialInstance) {
			this._updateToolbarContextKeys(undefined, terminalToolSessionId);
		}

		if (this._store.isDisposed) {
			return;
		}

		if (!this._terminalSessionRegistration) {
			const listener = this._terminalChatService.onDidRegisterTerminalInstanceWithToolSession(async instance => {
				const registeredInstance = await this._terminalChatService.getTerminalInstanceByToolSessionId(terminalToolSessionId);
				if (instance !== registeredInstance) {
					return;
				}
				this._terminalSessionRegistration?.dispose();
				this._terminalSessionRegistration = undefined;
				await attachInstance(instance);
			});
			this._terminalSessionRegistration = this._store.add(listener);
		}
	}

	/**
	 * Updates the scoped context keys that drive toolbar action visibility.
	 * The ActionBar is rebuilt with the correct set of visible actions.
	 */
	private _updateToolbarContextKeys(terminalInstance?: ITerminalInstance, terminalToolSessionId?: string): void {
		if (this._store.isDisposed) {
			return;
		}
		const resolvedCommand = this._getResolvedCommand(terminalInstance);

		// Focus terminal action
		this._toolbarHasInstance = !!terminalInstance;
		if (terminalInstance && terminalToolSessionId) {
			this._toolbarIsHiddenTerminal = this._terminalChatService.isBackgroundTerminal(terminalToolSessionId);
		} else {
			this._toolbarIsHiddenTerminal = false;
		}

		// Continue in background action
		if (terminalInstance && terminalToolSessionId && !this._terminalData.isBackground && !this._terminalData.didContinueInBackground) {
			const isStillRunning = resolvedCommand?.exitCode === undefined && this._terminalData.terminalCommandState?.exitCode === undefined;
			this._toolbarCanContinueInBackground = isStillRunning;
		} else {
			this._toolbarCanContinueInBackground = false;
		}

		// Show output action (only when NOT using collapsible wrapper)
		if (!this._usesCollapsibleWrapper) {
			const hasSnapshot = !!this._terminalData.terminalCommandOutput;
			const hasOutput = !!resolvedCommand || hasSnapshot;
			this._toolbarHasOutput = hasOutput;

			// Auto-expand on first detection of failed output
			if (hasOutput && !this._outputView.isExpanded) {
				const autoExpandFailures = this._configurationService.getValue<boolean>(ChatConfiguration.AutoExpandToolFailures);
				const exitCode = resolvedCommand?.exitCode ?? this._terminalData.terminalCommandState?.exitCode;
				if (exitCode !== undefined && exitCode !== 0 && autoExpandFailures) {
					this._toggleOutput(true);
				}
			}
		}

		this._updateToolbarActions();
		this._decoration.update(resolvedCommand);
	}

	/**
	 * Rebuilds the ActionBar actions based on current toolbar state.
	 */
	private _updateToolbarActions(): void {
		if (!this._actionBar || this._store.isDisposed) {
			return;
		}
		this._actionBar.clear();
		this._actionBarActions.clear();
		const actions: IAction[] = [];
		if (this._toolbarCanContinueInBackground) {
			const action = new Action(
				TerminalContribCommandId.ContinueInBackground,
				localize('continueInBackground', 'Continue in Background'),
				ThemeIcon.asClassName(Codicon.debugContinue),
				true,
				() => this.continueInBackground()
			);
			this._actionBarActions.add(action);
			actions.push(action);
		}
		if (this._toolbarHasInstance) {
			const focusLabel = this._toolbarIsHiddenTerminal
				? localize('showTerminal', 'Show and Focus Terminal')
				: localize('focusTerminal', 'Focus Terminal');
			const action = new Action(
				TerminalContribCommandId.FocusChatInstanceAction,
				focusLabel,
				ThemeIcon.asClassName(Codicon.openInProduct),
				true,
				() => this.focusTerminal()
			);
			this._actionBarActions.add(action);
			actions.push(action);
		}
		if (this._toolbarHasOutput && !this._usesCollapsibleWrapper) {
			const toggleIcon = this._toolbarOutputExpanded ? Codicon.chevronDown : Codicon.chevronRight;
			const toggleLabel = this._toolbarOutputExpanded
				? localize('hideTerminalOutput', 'Hide Output')
				: localize('showTerminalOutput', 'Show Output');
			const action = new Action(
				TerminalContribCommandId.ToggleChatTerminalOutput,
				toggleLabel,
				ThemeIcon.asClassName(toggleIcon),
				true,
				() => this.toggleOutputFromAction()
			);
			this._actionBarActions.add(action);
			actions.push(action);
		}
		this._actionBar.push(actions, { icon: true, label: false });
	}

	private _getResolvedCommand(instance?: ITerminalInstance): ITerminalCommand | undefined {
		const target = instance ?? this._terminalInstance;
		if (!target) {
			return undefined;
		}
		return this._resolveCommand(target);
	}

	private _isInvocationRunning(): boolean {
		const commandExitCode = this._getResolvedCommand()?.exitCode;
		if (commandExitCode !== undefined) {
			return false;
		}
		const storedExitCode = this._terminalData.terminalCommandState?.exitCode;
		if (storedExitCode !== undefined) {
			return false;
		}
		if (!IChatToolInvocation.isComplete(this.toolInvocation)) {
			return true;
		}
		return this._terminalData.isBackground === true || this._terminalData.didContinueInBackground === true;
	}

	private _clearCommandAssociation(options?: { clearPersistentData?: boolean }): void {
		this._terminalCommandUri = undefined;
		if (options?.clearPersistentData) {
			if (this._terminalData.terminalCommandUri) {
				delete this._terminalData.terminalCommandUri;
			}
			if (this._terminalData.terminalToolSessionId) {
				delete this._terminalData.terminalToolSessionId;
			}
		}
		this._decoration.update();
	}

	/**
	 * Determines whether the terminal output should auto-expand.
	 * Returns false if already expanded, user has manually toggled, component is disposed,
	 * or if the invocation was previously expanded (to preserve state across re-renders).
	 */
	private _shouldAutoExpand(): boolean {
		return !this._outputView.isExpanded &&
			!this._hasUserToggledOutput() &&
			!this._store.isDisposed &&
			!expandedStateByInvocation.get(this.toolInvocation);
	}

	/**
	 * Registers event listeners on the terminal instance to track command execution,
	 * manage auto-expansion of output, and handle command completion.
	 *
	 * This method sets up:
	 * - Command detection listeners for tracking command lifecycle
	 * - Auto-expand logic based on command output and duration
	 * - Instance disposal handling to clean up actions and state
	 */
	private _registerInstanceListener(terminalInstance: ITerminalInstance): void {
		const commandDetectionListener = this._register(new MutableDisposable<IDisposable>());
		const tryResolveCommand = async (): Promise<ITerminalCommand | undefined> => {
			const resolvedCommand = this._resolveCommand(terminalInstance);
			this._updateToolbarContextKeys(terminalInstance, this._terminalData.terminalToolSessionId);
			return resolvedCommand;
		};

		const attachCommandDetection = async (commandDetection: ICommandDetectionCapability | undefined) => {
			commandDetectionListener.clear();
			if (!commandDetection) {
				// Try AHP command source as fallback
				const ahpSource = this._terminalData.terminalToolSessionId
					? this._terminalChatService.getAhpCommandSource(this._terminalData.terminalToolSessionId)
					: undefined;
				if (ahpSource) {
					this._attachAhpCommandSource(terminalInstance, ahpSource, commandDetectionListener);
				}
				await tryResolveCommand();
				return;
			}

			const store = new DisposableStore();
			let receivedDataCount = 0;

			const hasRealOutput = (): boolean => {
				// Check for snapshot output
				if (this._terminalData.terminalCommandOutput?.text?.trim()) {
					return true;
				}
				// Check for live output (cursor moved past executed marker)
				const command = this._getResolvedCommand(terminalInstance);
				if (!command?.executedMarker || terminalInstance.isDisposed) {
					return false;
				}
				const buffer = terminalInstance.xterm?.raw.buffer.active;
				if (!buffer) {
					return false;
				}
				const cursorLine = buffer.baseY + buffer.cursorY;
				if (cursorLine > command.executedMarker.line) {
					return true;
				}
				// If we've received many data events, treat it as real output even if cursor
				// hasn't moved past the marker (e.g., progress bars updating on same line)
				// Shell integration sequences fire a couple times per command (PromptStart, CommandStart,
				// CommandExecuted), so we need a small threshold to filter those out
				return receivedDataCount > MIN_DATA_EVENTS_FOR_REAL_OUTPUT;
			};

			// Use the extracted auto-expand logic
			const autoExpand = store.add(new TerminalToolAutoExpand({
				onCommandExecuted: Event.map(commandDetection.onCommandExecuted, () => undefined),
				onCommandFinished: Event.map(commandDetection.onCommandFinished, () => undefined),
				onWillData: terminalInstance.onWillData,
				shouldAutoExpand: () => this._shouldAutoExpand(),
				hasRealOutput,
			}));
			store.add(autoExpand.onDidRequestExpand(() => {
				this._requestAutoExpandOutput();
			}));

			// Track data events to help hasRealOutput detect progress-style output
			store.add(terminalInstance.onWillData(() => {
				receivedDataCount++;
			}));

			store.add(commandDetection.onCommandExecuted(() => {
				this._updateToolbarContextKeys(terminalInstance, this._terminalData.terminalToolSessionId);
			}));

			store.add(commandDetection.onCommandFinished(() => {
				this._updateToolbarContextKeys(terminalInstance, this._terminalData.terminalToolSessionId);
				const resolvedCommand = this._getResolvedCommand(terminalInstance);

				this._handleCommandCompletion(resolvedCommand);

				if (resolvedCommand?.endMarker) {
					commandDetectionListener.clear();
				}
			}));
			commandDetectionListener.value = store;

			const resolvedImmediately = await tryResolveCommand();
			if (resolvedImmediately?.endMarker) {
				commandDetectionListener.clear();
				this._handleCommandCompletion(resolvedImmediately);
				return;
			}
		};

		attachCommandDetection(terminalInstance.capabilities.get(TerminalCapability.CommandDetection));
		this._register(terminalInstance.capabilities.onDidAddCommandDetectionCapability(cd => attachCommandDetection(cd)));

		const instanceListener = this._register(terminalInstance.onDisposed(() => {
			if (this._terminalInstance === terminalInstance) {
				this._terminalInstance = undefined;
			}
			this._clearCommandAssociation({ clearPersistentData: true });
			commandDetectionListener.clear();
			this._updateToolbarContextKeys(undefined, this._terminalData.terminalToolSessionId);
			instanceListener.dispose();
		}));
	}

	/**
	 * Sets up listeners using an {@link IAhpTerminalCommandSource} when no local
	 * `ICommandDetectionCapability` is available. Provides auto-expand, toolbar
	 * context key updates, and command completion handling.
	 */
	private _attachAhpCommandSource(
		terminalInstance: ITerminalInstance,
		ahpSource: IAhpTerminalCommandSource,
		commandDetectionListener: MutableDisposable<IDisposable>,
	): void {
		const store = new DisposableStore();

		const hasRealOutput = (): boolean => {
			// For AHP terminals, shell integration sequences are stripped server-side.
			// Real output is simply whether the command has non-empty output.
			const command = this._getResolvedCommand(terminalInstance);
			if (command?.hasOutput()) {
				return true;
			}
			return !!this._terminalData.terminalCommandOutput?.text?.trim();
		};

		const autoExpand = store.add(new TerminalToolAutoExpand({
			onCommandExecuted: Event.map(ahpSource.onCommandExecuted, () => undefined),
			onCommandFinished: Event.map(ahpSource.onCommandFinished, () => undefined),
			onWillData: terminalInstance.onWillData,
			shouldAutoExpand: () => this._shouldAutoExpand(),
			hasRealOutput,
		}));
		store.add(autoExpand.onDidRequestExpand(() => {
			this._requestAutoExpandOutput();
		}));

		store.add(ahpSource.onCommandExecuted(cmd => {
			// Set terminalCommandId on tool invocation data for future lookups
			if (!this._terminalData.terminalCommandId && cmd.id) {
				this._terminalData.terminalCommandId = cmd.id;
				this._updateToolbarContextKeys(terminalInstance, this._terminalData.terminalToolSessionId);
			}
		}));

		store.add(ahpSource.onCommandFinished(cmd => {
			if (this._terminalData.terminalCommandId === cmd.id) {
				this._updateToolbarContextKeys(terminalInstance, this._terminalData.terminalToolSessionId);
				const resolvedCommand = this._getResolvedCommand(terminalInstance);
				this._handleCommandCompletion(resolvedCommand);
			}
		}));

		commandDetectionListener.value = store;

		// Check if the command was already resolved (e.g. during content replay)
		const resolvedCommand = this._resolveCommand(terminalInstance);
		if (resolvedCommand?.endMarker) {
			this._handleCommandCompletion(resolvedCommand);
		}
	}

	/**
	 * Handles the completion of a terminal command by updating the UI state.
	 * This includes marking the collapsible wrapper as complete and folding
	 * auto-expanded output back up. Failed commands only stay (or become)
	 * expanded when `chat.tools.autoExpandFailures` is enabled; otherwise they
	 * collapse exactly like successful ones so the user's disclosure choice is
	 * the only thing that keeps a card open.
	 *
	 * @param resolvedCommand The completed terminal command with exit code information.
	 */
	private _handleCommandCompletion(resolvedCommand: ITerminalCommand | undefined): void {
		// Update title to show completion state
		this.markCollapsibleWrapperComplete(resolvedCommand?.getOutput(), resolvedCommand?.exitCode);

		const autoExpandFailures = this._configurationService.getValue<boolean>(ChatConfiguration.AutoExpandToolFailures);
		const exitCode = resolvedCommand?.exitCode;
		const userToggledOutput = this._hasUserToggledOutput();

		// Fold auto-expanded output back up on completion
		if (shouldAutoCollapseTerminalOnCompletion(autoExpandFailures, exitCode, userToggledOutput)) {
			if (this._thinkingCollapsibleWrapper) {
				this._thinkingCollapsibleWrapper.collapse();
				expandedStateByInvocation.set(this.toolInvocation, false);
			} else if (this._outputView.isExpanded) {
				void this._toggleOutput(false);
			}
		}

		// Keep outer wrapper expanded on error for visibility (opt-in)
		if (shouldAutoExpandTerminalFailure(autoExpandFailures, exitCode, userToggledOutput) && this._thinkingCollapsibleWrapper) {
			this.expandCollapsibleWrapper();
		}
	}

	private async _toggleOutput(expanded: boolean): Promise<boolean> {
		const didChange = await this._outputView.toggle(expanded);
		const isExpanded = this._outputView.isExpanded;
		this._titleElement.classList.toggle('chat-terminal-content-title-no-bottom-radius', isExpanded);
		this._toolbarOutputExpanded = isExpanded;
		this._updateToolbarActions();
		if (didChange) {
			expandedStateByInvocation.set(this.toolInvocation, isExpanded);
		}
		return didChange;
	}

	private async _ensureTerminalInstance(): Promise<ITerminalInstance | undefined> {
		if (this._terminalInstance?.isDisposed) {
			this._terminalInstance = undefined;
		}
		if (!this._terminalInstance && this._terminalData.terminalToolSessionId) {
			this._terminalInstance = await this._terminalChatService.getTerminalInstanceByToolSessionId(this._terminalData.terminalToolSessionId);
			if (this._terminalInstance?.isDisposed) {
				this._terminalInstance = undefined;
			}
		}
		return this._terminalInstance;
	}

	private _handleOutputFocus(): void {
		this._terminalOutputContextKey.set(true);
		this._terminalChatService.setFocusedProgressPart(this);
		this._outputView.updateAriaLabel();
	}

	private _handleOutputBlur(event: FocusEvent): void {
		const nextTarget = event.relatedTarget as HTMLElement | null;
		if (this._outputView.containsElement(nextTarget)) {
			return;
		}
		this._terminalOutputContextKey.reset();
		this._terminalChatService.clearFocusedProgressPart(this);
	}

	private _handleDispose(): void {
		this._terminalOutputContextKey.reset();
		this._terminalChatService.clearFocusedProgressPart(this);
	}

	public getCommandAndOutputAsText(): string | undefined {
		return this._outputView.getCommandAndOutputAsText();
	}

	public focusOutput(): void {
		this._outputView.focus();
	}

	private _focusChatInput(): void {
		const widget = this._chatWidgetService.getWidgetBySessionResource(this._sessionResource);
		widget?.focusInput();
	}

	public async focusTerminal(): Promise<void> {
		const instance = await this._ensureTerminalInstance();

		type FocusChatInstanceTelemetryEvent = {
			target: 'instance' | 'commandUri' | 'none';
			location: 'panel' | 'editor';
		};

		type FocusChatInstanceTelemetryClassification = {
			owner: 'meganrogge';
			comment: 'Track usage of the focus chat terminal action.';
			target: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Whether focusing targeted an existing instance or opened a command URI.' };
			location: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Location of the terminal instance when focusing.' };
		};

		let target: FocusChatInstanceTelemetryEvent['target'] = 'none';
		let location: FocusChatInstanceTelemetryEvent['location'] = 'panel';
		if (instance) {
			target = 'instance';
			location = instance.target === TerminalLocation.Editor ? 'editor' : 'panel';
		} else if (this._terminalCommandUri) {
			target = 'commandUri';
		}
		this._telemetryService.publicLog2<FocusChatInstanceTelemetryEvent, FocusChatInstanceTelemetryClassification>('terminal/chatFocusInstance', { target, location });

		if (instance) {
			this._terminalService.setActiveInstance(instance);
			if (instance.target === TerminalLocation.Editor) {
				this._terminalEditorService.openEditor(instance);
			} else {
				await this._terminalGroupService.showPanel(true);
			}
			this._terminalService.setActiveInstance(instance);
			await instance.focusWhenReady(true);
			const command = this._getResolvedCommand(instance);
			if (command) {
				instance.xterm?.markTracker.revealCommand(command);
			}
			return;
		}

		if (this._terminalCommandUri) {
			this._terminalService.openResource(this._terminalCommandUri);
		}
	}

	public continueInBackground(): void {
		const sessionId = this._terminalData.terminalToolSessionId;
		if (sessionId) {
			this._terminalChatService.continueInBackground(sessionId);
		}
	}

	public async toggleOutputFromAction(): Promise<void> {
		this._markOutputUserToggled();

		type ToggleChatTerminalOutputTelemetryEvent = {
			previousExpanded: boolean;
		};
		type ToggleChatTerminalOutputTelemetryClassification = {
			owner: 'meganrogge';
			comment: 'Track usage of the toggle chat terminal output action.';
			previousExpanded: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Whether the terminal output was expanded before the toggle.' };
		};
		this._telemetryService.publicLog2<ToggleChatTerminalOutputTelemetryEvent, ToggleChatTerminalOutputTelemetryClassification>('terminal/chatToggleOutput', {
			previousExpanded: this._outputView.isExpanded
		});

		if (!this._outputView.isExpanded) {
			await this._toggleOutput(true);
			return;
		}
		await this._toggleOutput(false);
	}

	public async toggleOutputFromKeyboard(): Promise<void> {
		this._markOutputUserToggled();
		if (!this._outputView.isExpanded) {
			await this._toggleOutput(true);
			this.focusOutput();
			return;
		}
		await this._collapseOutputAndFocusInput();
	}

	private async _collapseOutputAndFocusInput(): Promise<void> {
		if (this._outputView.isExpanded) {
			await this._toggleOutput(false);
		}
		this._focusChatInput();
	}

	private _markOutputUserToggled(): void {
		this._userToggledOutput = true;
		userToggledOutputByInvocation.add(this.toolInvocation);
	}

	private _hasUserToggledOutput(): boolean {
		return this._userToggledOutput || userToggledOutputByInvocation.has(this.toolInvocation);
	}

	private _resolveCommand(instance: ITerminalInstance): ITerminalCommand | undefined {
		if (instance.isDisposed) {
			return undefined;
		}

		const targetId = this._terminalData.terminalCommandId;

		// Try local shell integration command detection first
		const commandDetection = instance.capabilities.get(TerminalCapability.CommandDetection);
		if (commandDetection && targetId) {
			const commands = commandDetection.commands;
			if (commands && commands.length > 0) {
				const fromHistory = commands.find(c => c.id === targetId);
				if (fromHistory) {
					return fromHistory;
				}
			}

			const executing = commandDetection.executingCommandObject;
			if (executing && executing.id === targetId) {
				return executing;
			}
		}

		// Fall back to AHP command source
		const sessionId = this._terminalData.terminalToolSessionId;
		if (sessionId) {
			const ahpSource = this._terminalChatService.getAhpCommandSource(sessionId);
			if (ahpSource) {
				if (targetId) {
					return ahpSource.getCommandById(targetId);
				}
				// No specific command ID — return executing or most recent
				return ahpSource.executingCommandObject ?? ahpSource.commands[ahpSource.commands.length - 1];
			}
		}

		return undefined;
	}
}

/**
 * A component that displays terminal command output in an expandable/collapsible section.
 *
 * This component supports two modes of displaying output:
 * - **Live output**: Mirrors the output from a running terminal instance in real-time,
 *   supporting streaming updates, scroll-lock behavior, and user input forwarding.
 * - **Snapshot output**: Displays a static snapshot of previously captured terminal output,
 *   useful for serialized/restored chat sessions.
 *
 * Features:
 * - Automatic height calculation based on line count (min/max row limits)
 * - Scroll-lock behavior: stays at bottom during streaming, respects user scroll position
 * - Accessibility: proper ARIA labels and accessible view support
 * - Theme-aware background color that adapts to panel vs editor context
 */
class ChatTerminalToolOutputSection extends Disposable {
	public readonly domNode: HTMLElement;

	public get isExpanded(): boolean {
		return this.domNode.classList.contains('expanded');
	}

	private readonly _outputBody: HTMLElement;
	private _scrollableContainer: DomScrollableElement | undefined;
	private _isAtBottom: boolean = true;
	private _isProgrammaticScroll: boolean = false;
	private _mirror: DetachedTerminalCommandMirror | undefined;
	private _snapshotMirror: DetachedTerminalSnapshotMirror | undefined;
	private readonly _liveMirrorDisposables = this._register(new MutableDisposable<DisposableStore>());
	private readonly _snapshotMirrorDisposables = this._register(new MutableDisposable<DisposableStore>());
	private readonly _contentContainer: HTMLElement;
	private readonly _terminalContainer: HTMLElement;
	private readonly _emptyElement: HTMLElement;
	private _lastRenderedLineCount: number | undefined;
	private readonly _mirrorBackgroundColorProvider: ((theme: IColorTheme) => Color | undefined) | undefined;
	private _shouldBeExpanded = false;
	private _pendingOutputRelayout: IDisposable | undefined;
	private _mirrorsReadyForResize = false;

	private readonly _onDidFocusEmitter = this._register(new Emitter<void>());
	public get onDidFocus() { return this._onDidFocusEmitter.event; }
	private readonly _onDidBlurEmitter = this._register(new Emitter<FocusEvent>());
	public get onDidBlur() { return this._onDidBlurEmitter.event; }

	constructor(
		private readonly _ensureTerminalInstance: () => Promise<ITerminalInstance | undefined>,
		private readonly _resolveCommand: () => ITerminalCommand | undefined,
		private readonly _getTerminalCommandOutput: () => IChatTerminalToolInvocationData['terminalCommandOutput'] | undefined,
		private readonly _getCommandText: () => string,
		private readonly _getStoredTheme: () => IChatTerminalToolInvocationData['terminalTheme'] | undefined,
		private readonly _hasTerminalSession: boolean,
		private readonly _isCommandComplete: () => boolean,
		private readonly _useCursorTranscriptPresentation: boolean,
		@IAccessibleViewService private readonly _accessibleViewService: IAccessibleViewService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ITerminalConfigurationService private readonly _terminalConfigurationService: ITerminalConfigurationService,
		@IThemeService private readonly _themeService: IThemeService,
		@IContextKeyService private readonly _contextKeyService: IContextKeyService
	) {
		super();

		const containerElements = h('.chat-terminal-output-container@container', [
			h('.chat-terminal-output-body@body', [
				h('.chat-terminal-output-content@content', [
					h('.chat-terminal-output-terminal@terminal'),
					h('.chat-terminal-output-empty@empty')
				])
			])
		]);
		this.domNode = containerElements.container;
		this.domNode.classList.add('collapsed');
		this._outputBody = containerElements.body;
		this._contentContainer = containerElements.content;
		this._terminalContainer = containerElements.terminal;
		this._mirrorBackgroundColorProvider = this._useCursorTranscriptPresentation
			? theme => {
				const isInEditor = ChatContextKeys.inChatEditor.getValue(this._contextKeyService);
				return theme.getColor(isInEditor ? editorBackground : PANEL_BACKGROUND) ?? theme.getColor(editorBackground);
			}
			: undefined;

		this._emptyElement = containerElements.empty;
		this._contentContainer.appendChild(this._emptyElement);

		this._register(toDisposable(() => this._pendingOutputRelayout?.dispose()));
	}

	public async toggle(expanded: boolean): Promise<boolean> {
		try {
			this._shouldBeExpanded = expanded;
			const currentlyExpanded = this.isExpanded;
			if (expanded === currentlyExpanded) {
				if (expanded) {
					await this._updateTerminalContent();
				} else {
					// A collapse can arrive while asynchronous expansion is attaching xterm.
					// The CSS state is already collapsed, but pending mirror work still needs
					// to be invalidated.
					this._disposeRenderedTerminalContent();
				}
				return false;
			}

			if (!expanded) {
				this._setExpanded(false);
				this._isAtBottom = true;
				// Detached xterm mirrors subscribe to the source terminal and continue
				// processing output even when CSS hides the section. Release the mirror,
				// its xterm instance, and all per-render listeners while collapsed. The
				// authoritative live command or persisted snapshot is rendered afresh on
				// the next expansion.
				this._disposeRenderedTerminalContent();
				return true;
			}

			if (!this._scrollableContainer) {
				await this._createScrollableContainer();
			}
			if (this._store.isDisposed || !this._shouldBeExpanded) {
				return false;
			}
			await this._updateTerminalContent();
			if (this._store.isDisposed || !this._shouldBeExpanded) {
				this._disposeRenderedTerminalContent();
				return false;
			}

			// Only now show the expanded state (after content is ready)
			this._setExpanded(true);
			this._layoutOutput();
			this._scrollOutputToBottom();
			this._scheduleOutputRelayout();
			return true;
		} catch (error) {
			// Catch all exceptions to prevent "Terminal output could not be opened" error
			// Log the error for debugging but don't propagate it
			console.error('[TerminalToggle] Unexpected error:', error);
			return false;
		}
	}

	public focus(): void {
		this._scrollableContainer?.getDomNode().focus();
	}

	public containsElement(element: HTMLElement | null): boolean {
		return !!element && this.domNode.contains(element);
	}

	public updateAriaLabel(): void {
		if (!this._scrollableContainer) {
			return;
		}
		const command = this._resolveCommand();
		const commandText = command?.command ?? this._getCommandText();
		if (!commandText) {
			return;
		}
		const ariaLabel = localize('chatTerminalOutputAriaLabel', 'Terminal output for {0}', commandText);
		const scrollableDomNode = this._scrollableContainer.getDomNode();
		scrollableDomNode.setAttribute('role', 'region');
		const accessibleViewHint = this._accessibleViewService.getOpenAriaHint(AccessibilityVerbositySettingId.TerminalChatOutput);
		const label = accessibleViewHint
			? ariaLabel + ', ' + accessibleViewHint
			: ariaLabel;
		scrollableDomNode.setAttribute('aria-label', label);
	}

	public getCommandAndOutputAsText(): string | undefined {
		const command = this._resolveCommand();
		const commandText = command?.command ?? this._getCommandText();
		if (!commandText) {
			return undefined;
		}
		const commandHeader = localize('chatTerminalOutputAccessibleViewHeader', 'Command: {0}', commandText);
		if (command) {
			const rawOutput = command.getOutput();
			if (!rawOutput || rawOutput.trim().length === 0) {
				return `${commandHeader}\n${localize('chat.terminalOutputEmpty', 'No output')}`;
			}
			const lines = rawOutput.split('\n');
			return `${commandHeader}\n${lines.join('\n').trimEnd()}`;
		}

		const snapshot = this._getTerminalCommandOutput();
		if (!snapshot) {
			return `${commandHeader}\n${localize('chatTerminalOutputUnavailable', 'Command output is no longer available.')}`;
		}
		const plain = removeAnsiEscapeCodes((snapshot.text ?? ''));
		if (!plain.trim().length) {
			return `${commandHeader}\n${localize('chat.terminalOutputEmpty', 'No output')}`;
		}
		let outputText = plain.trimEnd();
		if (snapshot.truncated) {
			outputText += `\n${localize('chatTerminalOutputTruncated', 'Output truncated.')}`;
		}
		return `${commandHeader}\n${outputText}`;
	}

	private _setExpanded(expanded: boolean): void {
		this.domNode.classList.toggle('expanded', expanded);
		this.domNode.classList.toggle('collapsed', !expanded);
		if (!expanded) {
			this.domNode.style.removeProperty('height');
		}
	}

	private async _createScrollableContainer(): Promise<void> {
		this._scrollableContainer = this._register(new DomScrollableElement(this._outputBody, {
			vertical: this._useCursorTranscriptPresentation ? ScrollbarVisibility.Auto : ScrollbarVisibility.Hidden,
			horizontal: this._useCursorTranscriptPresentation ? ScrollbarVisibility.Auto : ScrollbarVisibility.Hidden,
			handleMouseWheel: true
		}));
		const scrollableDomNode = this._scrollableContainer.getDomNode();
		scrollableDomNode.tabIndex = 0;
		this.domNode.appendChild(scrollableDomNode);
		this.updateAriaLabel();

		// Collapsed terminal rows do not need observation. Create this only after
		// output is first expanded, avoiding hundreds of idle ResizeObservers in a
		// long transcript.
		const resizeObserver = this._register(new dom.DisposableResizeObserver('ChatTerminalToolProgressPart.handleResize', () => this._handleResize()));
		this._register(resizeObserver.observe(this.domNode));
		this._register(dom.addDisposableListener(this.domNode, dom.EventType.FOCUS_IN, () => this._onDidFocusEmitter.fire()));
		this._register(dom.addDisposableListener(this.domNode, dom.EventType.FOCUS_OUT, event => this._onDidBlurEmitter.fire(event)));
		this._applyBackgroundColor();
		this._register(this._themeService.onDidColorThemeChange(() => this._applyBackgroundColor()));

		// Standard chat keeps its transient horizontal scrollbar. Cursor transcript
		// cards keep both axes discoverable whenever output actually overflows.
		if (!this._useCursorTranscriptPresentation) {
			this._register(dom.addDisposableListener(this.domNode, dom.EventType.MOUSE_ENTER, () => {
				this._scrollableContainer?.updateOptions({ horizontal: ScrollbarVisibility.Auto });
			}));
			this._register(dom.addDisposableListener(this.domNode, dom.EventType.MOUSE_LEAVE, () => {
				this._scrollableContainer?.updateOptions({ horizontal: ScrollbarVisibility.Hidden });
			}));
			this._register(dom.addDisposableListener(this.domNode, dom.EventType.FOCUS_IN, () => {
				this._scrollableContainer?.updateOptions({ horizontal: ScrollbarVisibility.Auto });
			}));
			this._register(dom.addDisposableListener(this.domNode, dom.EventType.FOCUS_OUT, () => {
				this._scrollableContainer?.updateOptions({ horizontal: ScrollbarVisibility.Hidden });
			}));
		}

		// Track scroll state to enable scroll lock behavior (only for user scrolls)
		this._register(this._scrollableContainer.onScroll(() => {
			if (this._isProgrammaticScroll) {
				return;
			}
			this._isAtBottom = this._computeIsAtBottom();
		}));
		// The terminal's bounded viewport owns output scrolling. Capture wheel
		// gestures so the chat does not move while the user reads terminal history.
		this._register(dom.addDisposableListener(this.domNode, dom.EventType.MOUSE_WHEEL, event => {
			// Always prevent scrolling the chat list when mouse is over terminal output
			if (this.isExpanded) {
				event.preventDefault();
				event.stopPropagation();
			}

			// Try to scroll the terminal if we have delta
			if (!this.isExpanded || !event.deltaY || event.ctrlKey || event.metaKey || event.shiftKey) {
				return;
			}
			const lines = getTerminalWheelScrollLines(event.deltaY, event.deltaMode, this._computeRowHeightPx());
			const didScroll = this._mirror?.scrollByLines(lines) ?? this._snapshotMirror?.scrollByLines(lines) ?? false;
			if (didScroll) {
				this._isAtBottom = this._computeIsAtBottom();
			}
		}, { capture: true, passive: false }));
	}

	private async _updateTerminalContent(): Promise<void> {
		if (this._store.isDisposed || !this._shouldBeExpanded) {
			return;
		}
		const snapshot = this._getTerminalCommandOutput();
		// A completed restored command already has authoritative persisted output.
		// Render it immediately instead of waiting for an obsolete terminal session
		// to reconnect; running commands still prefer the live interactive mirror.
		if (shouldRenderStoredTerminalOutputFirst(!!snapshot, this._isCommandComplete())) {
			this._disposeLiveMirror();
			await this._renderSnapshotOutput(snapshot!);
			return;
		}

		const liveTerminalInstance = await this._resolveLiveTerminal();
		const command = liveTerminalInstance ? this._resolveCommand() : undefined;

		if (liveTerminalInstance && command) {
			const handled = await this._renderLiveOutput(liveTerminalInstance, command);
			if (handled) {
				return;
			}
		}

		this._disposeLiveMirror();

		if (snapshot) {
			await this._renderSnapshotOutput(snapshot);
			return;
		}

		if (!this._hasTerminalSession) {
			this._showEmptyMessage(this._isCommandComplete()
				? localize('chat.terminalOutputEmpty', 'No output')
				: localize('chat.terminalOutputWaiting', 'Waiting for terminal output…'));
			this._layoutOutput(1);
			return;
		}

		this._renderUnavailableMessage(liveTerminalInstance);
	}

	private async _renderLiveOutput(liveTerminalInstance: ITerminalInstance, command: ITerminalCommand): Promise<boolean> {
		if (this._mirror) {
			return true;
		}
		this._disposeSnapshotMirror();
		await liveTerminalInstance.xtermReadyPromise;
		// Another concurrent expand may have won while xterm was becoming ready.
		// Reuse its mirror instead of allocating a second detached terminal.
		if (this._mirror) {
			return true;
		}
		if (this._store.isDisposed || !this._shouldBeExpanded || liveTerminalInstance.isDisposed || !liveTerminalInstance.xterm) {
			this._disposeLiveMirror();
			return false;
		}
		const mirrorDisposables = new DisposableStore();
		this._liveMirrorDisposables.value = mirrorDisposables;
		const mirror = mirrorDisposables.add(this._instantiationService.createInstance(DetachedTerminalCommandMirror, liveTerminalInstance.xterm, command, this._mirrorBackgroundColorProvider));
		this._mirror = mirror;
		// The opening placeholder hides the terminal node. Reveal it before attach
		// so xterm can measure and accept focus/input as a normal live terminal.
		this._hideEmptyMessage();
		mirrorDisposables.add(mirror.onDidUpdate(result => {
			// Hide empty message as soon as we get output
			if (result.lineCount && result.lineCount > 0) {
				this._hideEmptyMessage();
			}
			if (result.lineCount !== undefined) {
				this._lastRenderedLineCount = result.lineCount;
			}
			this._scheduleOutputRelayout();
		}));
		mirrorDisposables.add(mirror.onDidScroll(() => {
			if (!this._isProgrammaticScroll) {
				this._isAtBottom = this._computeIsAtBottom();
			}
		}));
		// Forward input from the mirror terminal to the live terminal instance
		mirrorDisposables.add(mirror.onDidInput(data => {
			if (!liveTerminalInstance.isDisposed) {
				liveTerminalInstance.sendText(data, false);
			}
		}));
		await mirror.attach(this._terminalContainer);
		if (this._store.isDisposed || !this._shouldBeExpanded || this._mirror !== mirror) {
			return true;
		}
		let result = await mirror.renderCommand();
		if (this._store.isDisposed || !this._shouldBeExpanded || this._mirror !== mirror) {
			return true;
		}
		// Mark mirrors as ready for resize after successful render
		this._mirrorsReadyForResize = true;
		// Only show "No output" message if:
		// 1. Command has finished (has endMarker), AND
		// 2. There's no output after retrying
		// If command is still running, don't show the message - output may come later
		let commandFinished = !!command.endMarker;
		let hasOutput = result && result.lineCount && result.lineCount > 0;

		// If we got no output, poll until either output appears or command finishes
		// This handles cases where:
		// 1. Command is running but executedMarker isn't set yet (renderCommand returns undefined)
		// 2. Command finished quickly but buffer isn't ready yet
		if (!hasOutput) {
			for (let retry = 0; retry < MAX_OUTPUT_POLL_RETRIES && !hasOutput; retry++) {
				await timeout(OUTPUT_POLL_DELAY_MS);
				if (this._store.isDisposed || !this._shouldBeExpanded || this._mirror !== mirror) {
					return true;
				}
				result = await mirror.renderCommand();
				hasOutput = result && result.lineCount && result.lineCount > 0;
				commandFinished = !!command.endMarker;
				// Stop polling if command finished (we'll show "no output" or output)
				if (commandFinished) {
					break;
				}
			}
		}

		if (!hasOutput) {
			if (commandFinished) {
				this._showEmptyMessage(localize('chat.terminalOutputEmpty', 'No output'));
			} else {
				this._showEmptyMessage(localize('chat.terminalOutputWaiting', 'Waiting for terminal output…'));
			}
		} else {
			this._hideEmptyMessage();
		}
		this._layoutOutput(result?.lineCount ?? 0);
		return true;
	}

	private async _renderSnapshotOutput(snapshot: NonNullable<IChatTerminalToolInvocationData['terminalCommandOutput']>): Promise<void> {
		if (this._snapshotMirror) {
			// Restored snapshots can persist a stale explicit zero. Do not let that
			// overwrite the non-zero count established when the mirror first rendered;
			// otherwise a collapse/re-expand cycle produces a zero-height viewport.
			this._layoutOutput(resolveStoredTerminalOutputLineCount(snapshot.text, snapshot.lineCount, this._lastRenderedLineCount));
			return;
		}
		if (this._store.isDisposed || !this._shouldBeExpanded) {
			return;
		}
		this._disposeLiveMirror();
		dom.clearNode(this._terminalContainer);
		const mirrorDisposables = new DisposableStore();
		this._snapshotMirrorDisposables.value = mirrorDisposables;
		const mirror = mirrorDisposables.add(this._instantiationService.createInstance(DetachedTerminalSnapshotMirror, snapshot, this._getStoredTheme, this._mirrorBackgroundColorProvider));
		this._snapshotMirror = mirror;
		this._hideEmptyMessage();
		mirrorDisposables.add(mirror.onDidScroll(() => {
			if (!this._isProgrammaticScroll) {
				this._isAtBottom = this._computeIsAtBottom();
			}
		}));
		await mirror.attach(this._terminalContainer);
		if (this._store.isDisposed || !this._shouldBeExpanded || this._snapshotMirror !== mirror) {
			return;
		}
		mirror.setOutput(snapshot);
		const result = await mirror.render();
		if (this._store.isDisposed || !this._shouldBeExpanded || this._snapshotMirror !== mirror) {
			return;
		}
		// Mark mirrors as ready for resize after successful render
		this._mirrorsReadyForResize = true;
		const hasText = !!snapshot.text && snapshot.text.length > 0;
		if (hasText) {
			this._hideEmptyMessage();
		} else {
			this._showEmptyMessage(localize('chat.terminalOutputEmpty', 'No output'));
		}
		const lineCount = result?.lineCount ?? resolveStoredTerminalOutputLineCount(snapshot.text, snapshot.lineCount, this._lastRenderedLineCount);
		this._layoutOutput(lineCount);
	}

	private _renderUnavailableMessage(liveTerminalInstance: ITerminalInstance | undefined): void {
		dom.clearNode(this._terminalContainer);
		if (!liveTerminalInstance) {
			this._showEmptyMessage(localize('chat.terminalOutputTerminalMissing', 'Terminal is no longer available.'));
		} else {
			this._showEmptyMessage(localize('chat.terminalOutputCommandMissing', 'Command information is not available.'));
		}
		this._layoutOutput(1);
	}

	private async _resolveLiveTerminal(): Promise<ITerminalInstance | undefined> {
		const instance = await this._ensureTerminalInstance();
		return instance && !instance.isDisposed ? instance : undefined;
	}

	private _showEmptyMessage(message: string): void {
		this._emptyElement.textContent = message;
		this._terminalContainer.classList.add('chat-terminal-output-terminal-no-output');
		this.domNode.classList.add('chat-terminal-output-container-no-output');
	}

	private _hideEmptyMessage(): void {
		this._emptyElement.textContent = '';
		this._terminalContainer.classList.remove('chat-terminal-output-terminal-no-output');
		this.domNode.classList.remove('chat-terminal-output-container-no-output');
	}

	private _disposeLiveMirror(): void {
		this._liveMirrorDisposables.clear();
		this._mirror = undefined;
		this._mirrorsReadyForResize = false;
	}

	private _disposeSnapshotMirror(): void {
		this._snapshotMirrorDisposables.clear();
		this._snapshotMirror = undefined;
		this._mirrorsReadyForResize = false;
	}

	private _disposeRenderedTerminalContent(): void {
		this._pendingOutputRelayout?.dispose();
		this._pendingOutputRelayout = undefined;
		this._disposeLiveMirror();
		this._disposeSnapshotMirror();
		dom.clearNode(this._terminalContainer);
	}

	private _scheduleOutputRelayout(): void {
		if (this._pendingOutputRelayout) {
			return;
		}
		this._pendingOutputRelayout = dom.scheduleAtNextAnimationFrame(dom.getActiveWindow(), () => {
			this._pendingOutputRelayout = undefined;
			if (this._store.isDisposed || !this.isExpanded) {
				return;
			}
			this._layoutOutput();
			if (this._isAtBottom) {
				this._scrollOutputToBottom();
			}
		});
	}

	private _handleResize(): void {
		if (!this._scrollableContainer || !this.isExpanded) {
			return;
		}
		this._layoutOutput();
		this._scrollOutputToBottom();
	}

	private _layoutOutput(lineCount?: number): void {
		try {
			if (!this._scrollableContainer) {
				return;
			}

			if (lineCount !== undefined) {
				this._lastRenderedLineCount = lineCount;
			} else {
				lineCount = this._lastRenderedLineCount;
			}

			this._scrollableContainer.scanDomNode();
			if (!this.isExpanded) {
				return;
			}

			// Try to resize mirrors to fit card width - completely isolated and non-blocking
			// This is a best-effort enhancement that should never interfere with normal operation
			if (this._mirrorsReadyForResize && (this._mirror || this._snapshotMirror)) {
				// Use setImmediate/setTimeout to ensure this runs after current execution
				// and doesn't block or interfere with the layout flow
				setTimeout(() => {
					try {
						if (this._store.isDisposed || !this.isExpanded) {
							return;
						}
						this._safeResizeMirrors();
					} catch {
						// Silently ignore any errors in deferred resize
					}
				}, 0);
			}

			if (lineCount === undefined) {
				return;
			}

			this._applyOutputViewportHeight(lineCount);
			this._scrollableContainer.scanDomNode();
		} catch (error) {
			// Log error but don't throw - layout should never fail
			console.error('[LayoutOutput] Unexpected error:', error);
		}
	}

	private _safeResizeMirrors(): void {
		// This method is guaranteed to never throw an exception
		try {
			// Early exit if not ready
			if (!this._mirrorsReadyForResize) {
				return;
			}

			// Check if we have any mirrors to resize
			if (!this._mirror && !this._snapshotMirror) {
				return;
			}

			// Check if output body exists
			if (!this._outputBody) {
				return;
			}

			// Check if element is connected to DOM (safely)
			let isConnected = true;
			try {
				if (typeof this._outputBody.isConnected === 'boolean') {
					isConnected = this._outputBody.isConnected;
				}
			} catch {
				// isConnected might not be available in all environments
			}
			if (!isConnected) {
				return;
			}

			// Get client width safely
			const clientWidth = this._outputBody.clientWidth;
			if (!clientWidth || clientWidth <= 0) {
				return;
			}

			// Calculate available width
			const padding = this._getOutputHorizontalPadding();
			const availableWidth = clientWidth - padding;
			if (availableWidth <= 0) {
				return;
			}

			// Get font metrics
			const window = dom.getActiveWindow();
			const font = this._terminalConfigurationService.getFont(window);
			const hasCharWidth = isNumber(font.charWidth) && font.charWidth > 0;
			const hasFontSize = isNumber(font.fontSize) && font.fontSize > 0;
			const charWidth = (hasCharWidth ? font.charWidth : (hasFontSize ? font.fontSize * 0.6 : 1)) ?? 1;

			if (!charWidth || charWidth <= 0) {
				return;
			}

			// Calculate columns
			const columns = getTerminalColumnCountForWidth(availableWidth, charWidth);

			const requestedRows = this._useCursorTranscriptPresentation
				? Math.min(Math.max(this._lastRenderedLineCount ?? MIN_OUTPUT_ROWS, MIN_OUTPUT_ROWS), MAX_OUTPUT_ROWS)
				: undefined;
			let renderedRows = 0;

			// Resize live mirror if it exists
			if (this._mirror) {
				try {
					renderedRows = Math.max(renderedRows, this._mirror.resizeToColumns(columns, requestedRows) ?? 0);
				} catch {
					// Silently ignore individual mirror resize failures
				}
			}

			// Resize snapshot mirror if it exists
			if (this._snapshotMirror) {
				try {
					renderedRows = Math.max(renderedRows, this._snapshotMirror.resizeToColumns(columns, requestedRows) ?? 0);
				} catch {
					// Silently ignore individual mirror resize failures
				}
			}

			// Resizing to the card width can create additional wrapped rows. Record
			// them so the bounded viewport and its xterm scrollback stay in sync.
			if (this._useCursorTranscriptPresentation && renderedRows > (this._lastRenderedLineCount ?? 0)) {
				this._lastRenderedLineCount = renderedRows;
				this._applyOutputViewportHeight(renderedRows);
				this._scrollableContainer?.scanDomNode();
			}
		} catch {
			// Absolute last resort - silently ignore any errors
			// This ensures the method never throws
		}
	}

	private _applyOutputViewportHeight(lineCount: number): void {
		if (!this._scrollableContainer) {
			return;
		}
		const scrollableDomNode = this._scrollableContainer.getDomNode();
		const rowHeight = this._computeRowHeightPx();
		const padding = this._getOutputPadding();
		// Add buffer to max height to match the buffer in content height calculation
		const BUFFER_PX = Math.ceil(rowHeight * 0.5);
		const maxHeight = rowHeight * MAX_OUTPUT_ROWS + padding + BUFFER_PX;
		const contentHeight = this._getOutputContentHeight(lineCount, rowHeight, padding);
		const viewportHeight = getTerminalOutputViewportHeight(contentHeight, maxHeight, this._useCursorTranscriptPresentation);
		scrollableDomNode.style.height = viewportHeight;
		this.domNode.style.removeProperty('height');
	}

	private _getOutputHorizontalPadding(): number {
		if (!this._outputBody || !this._outputBody.isConnected) {
			return 0;
		}
		const style = dom.getComputedStyle(this._outputBody);
		if (!style) {
			return 0;
		}
		const paddingLeft = Number.parseFloat(style.paddingLeft || '0');
		const paddingRight = Number.parseFloat(style.paddingRight || '0');
		return paddingLeft + paddingRight;
	}

	private _computeIsAtBottom(): boolean {
		const terminalAtBottom = this._mirror?.isAtBottom() ?? this._snapshotMirror?.isAtBottom();
		if (terminalAtBottom !== undefined) {
			return terminalAtBottom;
		}
		if (!this._scrollableContainer) {
			return true;
		}
		const dimensions = this._scrollableContainer.getScrollDimensions();
		const scrollPosition = this._scrollableContainer.getScrollPosition();
		// Consider "at bottom" if within a small threshold to account for rounding
		const threshold = 5;
		return scrollPosition.scrollTop >= dimensions.scrollHeight - dimensions.height - threshold;
	}

	private _scrollOutputToBottom(): void {
		if (!this._scrollableContainer) {
			return;
		}
		this._isProgrammaticScroll = true;
		try {
			this._mirror?.scrollToBottom();
			this._snapshotMirror?.scrollToBottom();
			const dimensions = this._scrollableContainer.getScrollDimensions();
			this._scrollableContainer.setScrollPosition({ scrollTop: dimensions.scrollHeight });
		} finally {
			this._isProgrammaticScroll = false;
		}
	}

	private _getOutputContentHeight(lineCount: number, rowHeight: number, padding: number): number {
		const isEmptyState = this.domNode.classList.contains('chat-terminal-output-container-no-output');
		return calculateTerminalOutputContentHeight(
			lineCount,
			rowHeight,
			padding,
			isEmptyState,
			isEmptyState ? this._getEmptyStateHeight(rowHeight) : 0,
		);
	}

	private _getEmptyStateHeight(rowHeight: number): number {
		const style = dom.getComputedStyle(this._emptyElement);
		const paddingTop = Number.parseFloat(style.paddingTop || '0');
		const paddingBottom = Number.parseFloat(style.paddingBottom || '0');
		const parsedLineHeight = Number.parseFloat(style.lineHeight || '0');
		const lineHeight = Number.isFinite(parsedLineHeight) && parsedLineHeight > 0 ? parsedLineHeight : rowHeight;
		return Math.max(this._emptyElement.scrollHeight, lineHeight + paddingTop + paddingBottom);
	}

	private _getOutputPadding(): number {
		const style = dom.getComputedStyle(this._outputBody);
		const paddingTop = Number.parseFloat(style.paddingTop || '0');
		const paddingBottom = Number.parseFloat(style.paddingBottom || '0');
		return paddingTop + paddingBottom;
	}

	private _computeRowHeightPx(): number {
		const window = dom.getActiveWindow();
		const font = this._terminalConfigurationService.getFont(window);
		const hasCharHeight = isNumber(font.charHeight) && font.charHeight > 0;
		const hasFontSize = isNumber(font.fontSize) && font.fontSize > 0;
		const hasLineHeight = isNumber(font.lineHeight) && font.lineHeight > 0;
		const charHeight = (hasCharHeight ? font.charHeight : (hasFontSize ? font.fontSize : 1)) ?? 1;
		const lineHeight = hasLineHeight ? font.lineHeight : 1;
		const rowHeight = Math.ceil(charHeight * lineHeight);
		return Math.max(rowHeight, 1);
	}

	private _applyBackgroundColor(): void {
		const theme = this._themeService.getColorTheme();
		const isInEditor = ChatContextKeys.inChatEditor.getValue(this._contextKeyService);
		const backgroundColor = theme.getColor(isInEditor ? editorBackground : PANEL_BACKGROUND) ?? theme.getColor(editorBackground);
		if (backgroundColor) {
			this.domNode.style.backgroundColor = backgroundColor.toString();
		}
	}
}

export class ChatTerminalThinkingCollapsibleWrapper extends ChatCollapsibleContentPart {
	private readonly _terminalContentElement: HTMLElement;
	private readonly _compactCommandText: string;
	private readonly _fullCommandText: string;
	private readonly _isSandboxWrapped: boolean;
	private readonly _useCursorTranscriptPresentation: boolean;
	private _isComplete: boolean;
	private readonly _isSkipped: boolean;
	private readonly _isDenied: boolean;
	private _isRunningInBackground: boolean;
	private _hasError: boolean;
	private readonly _onFocusTerminal: (() => void) | undefined;
	private readonly _showLinkDisposables = this._register(new MutableDisposable<DisposableStore>());
	private _showLinkElement: HTMLElement | undefined;

	constructor(
		compactCommandText: string,
		fullCommandText: string,
		isSandboxWrapped: boolean,
		contentElement: HTMLElement,
		context: IChatContentPartRenderContext,
		initialExpanded: boolean,
		isComplete: boolean,
		isSkipped: boolean,
		isDenied: boolean,
		isRunningInBackground: boolean,
		hasError: boolean,
		onFocusTerminal: (() => void) | undefined,
		onDidUserToggle: () => void,
		@IHoverService hoverService: IHoverService,
		@IConfigurationService configurationService: IConfigurationService,
	) {
		const title = isSkipped
			? localize('chat.terminal.skipped.plain', "Skipped {0}", compactCommandText)
			: isDenied
				? localize('chat.terminal.denied.plain', "Denied {0}", compactCommandText)
				: isRunningInBackground
					? localize('chat.terminal.runningInBackground.plain', "Running {0} in background", compactCommandText)
					: hasError
						? localize('chat.terminal.failed.plain', "Failed {0}", compactCommandText)
						: isComplete
							? localize('chat.terminal.ran.plain', "Ran {0}", compactCommandText)
							: localize('chat.terminal.running.plain', "Running {0}", compactCommandText);
		super(title, context, undefined, hoverService, configurationService);

		this._terminalContentElement = contentElement;
		this._compactCommandText = compactCommandText;
		this._fullCommandText = fullCommandText;
		this._isSandboxWrapped = isSandboxWrapped;
		this._useCursorTranscriptPresentation = isBackboardCursorTranscript(context.container);
		this._isComplete = isComplete;
		this._isSkipped = isSkipped;
		this._isDenied = isDenied;
		this._isRunningInBackground = isRunningInBackground;
		this._hasError = hasError;
		this._onFocusTerminal = onFocusTerminal;

		this.domNode.classList.add('chat-terminal-thinking-collapsible');
		if (this._collapseButton) {
			this._register(this._collapseButton.onDidClick(onDidUserToggle));
		}

		if (this._isSkipped) {
			this.icon = Codicon.circleSlash;
		} else if (this._isDenied || this._hasError) {
			this.icon = Codicon.error;
		} else if (this._useCursorTranscriptPresentation) {
			this.icon = Codicon.terminal;
		} else if (isComplete) {
			this.icon = Codicon.check;
		}

		this._setCodeFormattedTitle();
		this._updateShowLink();
		this.setExpanded(initialExpanded);
	}

	private _setCodeFormattedTitle(): void {
		if (!this._collapseButton) {
			return;
		}

		const labelElement = this._collapseButton.labelElement;
		labelElement.classList.toggle('chat-terminal-command-label', this._useCursorTranscriptPresentation);
		labelElement.textContent = '';

		if (this._isSandboxWrapped) {
			const prefixText = this._isSkipped
				? localize('chat.terminal.skippedInSandbox.prefix', "Skipped ")
				: this._isDenied
					? localize('chat.terminal.deniedInSandbox.prefix', "Denied ")
					: this._hasError
						? localize('chat.terminal.failedInSandbox.prefix', "Failed ")
						: this._isComplete
							? localize('chat.terminal.ranInSandbox.prefix', "Ran ")
							: localize('chat.terminal.runningInSandbox.prefix', "Running ");
			const suffixText = this._isRunningInBackground
				? localize('chat.terminal.sandbox.backgroundSuffix', " in sandbox (background)")
				: localize('chat.terminal.sandbox.suffix', " in sandbox");
			labelElement.appendChild(this._createStatusText(prefixText, this._isComplete && !this._hasError));
			this._appendCommandText(labelElement);
			labelElement.appendChild(this._createStatusText(suffixText, false));
			return;
		}

		const prefixText = this._isSkipped
			? localize('chat.terminal.skipped.prefix', "Skipped ")
			: this._isDenied
				? localize('chat.terminal.denied.prefix', "Denied ")
				: this._hasError
					? localize('chat.terminal.failed.prefix', "Failed ")
					: this._isComplete
						? localize('chat.terminal.ran.prefix', "Ran ")
						: localize('chat.terminal.running.prefix', "Running ");
		labelElement.appendChild(this._createStatusText(prefixText, this._isComplete && !this._hasError));
		this._appendCommandText(labelElement);
		if (this._isRunningInBackground) {
			labelElement.appendChild(this._createStatusText(localize('chat.terminal.backgroundSuffix', " in background"), false));
		}
	}

	/**
	 * The status words ("Ran", "Failed", "in sandbox") stay in the accessible
	 * label, but wrapping them lets a transcript hide the neutral "Ran" prefix
	 * and present the row as a prompt line instead.
	 */
	private _createStatusText(text: string, isNeutralCompletion: boolean): HTMLElement {
		const element = document.createElement('span');
		element.className = 'chat-terminal-status-text';
		element.classList.toggle('chat-terminal-status-text-neutral', isNeutralCompletion);
		element.textContent = text;
		return element;
	}

	private _appendCommandText(labelElement: HTMLElement): void {
		const compactCodeElement = document.createElement('code');
		compactCodeElement.className = 'chat-terminal-command-compact';
		compactCodeElement.textContent = this._compactCommandText;
		compactCodeElement.title = this._compactCommandText;
		labelElement.appendChild(compactCodeElement);

		const fullCodeElement = document.createElement('code');
		fullCodeElement.className = 'chat-terminal-command-full';
		fullCodeElement.textContent = this._fullCommandText;
		fullCodeElement.title = this._fullCommandText;
		labelElement.appendChild(fullCodeElement);
	}

	private _updateShowLink(): void {
		this._showLinkElement?.remove();
		this._showLinkElement = undefined;
		this._showLinkDisposables.value = undefined;
		if (!this._isRunningInBackground || !this._onFocusTerminal || !this._collapseButton) {
			return;
		}
		const labelElement = this._collapseButton.labelElement;
		const store = new DisposableStore();
		this._showLinkDisposables.value = store;
		const container = dom.$('span.chat-terminal-show-link-container');
		container.appendChild(document.createTextNode(' \u2014 '));
		const showLink = dom.$('span.chat-terminal-show-link');
		showLink.textContent = localize('chat.terminal.showTerminal', "Show");
		showLink.role = 'button';
		showLink.tabIndex = 0;
		store.add(dom.addDisposableListener(showLink, dom.EventType.CLICK, (e) => {
			dom.EventHelper.stop(e, true);
			this._onFocusTerminal?.();
		}));
		store.add(dom.addDisposableListener(showLink, dom.EventType.KEY_DOWN, (e) => {
			const keyboardEvent = new StandardKeyboardEvent(e);
			if (keyboardEvent.equals(KeyCode.Enter) || keyboardEvent.equals(KeyCode.Space)) {
				dom.EventHelper.stop(e, true);
				this._onFocusTerminal?.();
			}
		}));
		container.appendChild(showLink);
		labelElement.appendChild(container);
		this._showLinkElement = container;
	}

	public markComplete(hasError: boolean): void {
		if (this._isComplete && this._hasError === hasError && !this._isRunningInBackground) {
			return;
		}
		this._isComplete = true;
		this._isRunningInBackground = false;
		this._hasError = hasError;
		this.icon = this._isSkipped
			? Codicon.circleSlash
			: this._isDenied || hasError
				? Codicon.error
				: this._useCursorTranscriptPresentation ? Codicon.terminal : Codicon.check;
		this.setTitle(this._isSkipped
			? localize('chat.terminal.skipped.plain', "Skipped {0}", this._compactCommandText)
			: this._isDenied
				? localize('chat.terminal.denied.plain', "Denied {0}", this._compactCommandText)
				: hasError
					? localize('chat.terminal.failed.plain', "Failed {0}", this._compactCommandText)
					: localize('chat.terminal.ran.plain', "Ran {0}", this._compactCommandText));
		this._setCodeFormattedTitle();
		this._updateShowLink();
	}

	protected override initContent(): HTMLElement {
		const listWrapper = dom.$('.chat-used-context-list.chat-terminal-thinking-content');
		listWrapper.appendChild(this._terminalContentElement);
		return listWrapper;
	}

	public expand(): void {
		this.setExpanded(true);
	}

	public collapse(): void {
		this.setExpanded(false);
	}

	override hasSameContent(_other: IChatRendererContent, _followingContent: IChatRendererContent[], _element: ChatTreeItem): boolean {
		return false;
	}
}
