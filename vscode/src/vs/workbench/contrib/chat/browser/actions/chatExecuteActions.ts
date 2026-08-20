/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { IsOptimusWindowContext } from '../../../../common/contextkeys.js';
import { getErrorMessage } from '../../../../../base/common/errors.js';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { basename } from '../../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { assertType } from '../../../../../base/common/types.js';
import { URI } from '../../../../../base/common/uri.js';
import { ServicesAccessor } from '../../../../../editor/browser/editorExtensions.js';
import { EditorContextKeys } from '../../../../../editor/common/editorContextKeys.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr, IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { FileOperationResult, IFileService, toFileOperationResult } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { getModeNameForTelemetry, buildCustomAgentHandoffsInfo, getHandoffId, IChatMode, IChatModeService, IChatModes } from '../../common/chatModes.js';
import { chatVariableLeader } from '../../common/requestParser/chatParserTypes.js';
import { ChatStopCancellationNoopClassification, ChatStopCancellationNoopEvent, ChatStopCancellationNoopEventName, IChatService } from '../../common/chatService/chatService.js';
import { ChatAgentLocation, ChatConfiguration, ChatModeKind } from '../../common/constants.js';
import { ILanguageModelChatMetadata } from '../../common/languageModels.js';
import { ILanguageModelToolsService } from '../../common/tools/languageModelToolsService.js';
import { isInClaudeAgentsFolder } from '../../common/promptSyntax/config/promptFileLocations.js';
import { IChatSessionsService, localChatSessionType } from '../../common/chatSessionsService.js';
import { IChatWidget, IChatWidgetService } from '../chat.js';
import { getAgentSessionProvider, AgentSessionProviders, AgentSessionTarget } from '../agentSessions/agentSessions.js';
import { getEditingSessionContext } from '../chatEditing/chatEditingActions.js';
import { ctxHasEditorModification, ctxHasRequestInProgress, ctxIsGlobalEditingSession } from '../chatEditing/chatEditingEditorContextKeys.js';
import { ACTION_ID_NEW_CHAT, CHAT_CATEGORY, clearChatSessionPreservingType, handleCurrentEditingSession, handleModeSwitch } from './chatActions.js';
import { CreateRemoteAgentJobAction } from './chatContinueInAction.js';

export interface IVoiceChatExecuteActionContext {
	readonly disableTimeout?: boolean;
}

export interface IChatExecuteActionContext {
	widget?: IChatWidget;
	inputValue?: string;
	voice?: IVoiceChatExecuteActionContext;
}

function resolveChatWidgetFromActionContext(widgetService: IChatWidgetService, context: IChatExecuteActionContext | undefined): IChatWidget | undefined {
	const chatWidgets = widgetService.getWidgetsByLocations(ChatAgentLocation.Chat);
	return context?.widget
		?? widgetService.lastFocusedWidget
		?? chatWidgets[chatWidgets.length - 1];
}

abstract class SubmitAction extends Action2 {
	async run(accessor: ServicesAccessor, ...args: unknown[]) {
		const context = args[0] as IChatExecuteActionContext | undefined;
		const telemetryService = accessor.get(ITelemetryService);
		const widgetService = accessor.get(IChatWidgetService);
		const widget = resolveChatWidgetFromActionContext(widgetService, context);

		// Check if there's a pending delegation target
		const pendingDelegationTarget = widget?.input.pendingDelegationTarget;
		if (pendingDelegationTarget && pendingDelegationTarget !== AgentSessionProviders.Local) {
			return await this.handleDelegation(accessor, widget, pendingDelegationTarget);
		}

		if (widget?.viewModel?.editing) {
			const configurationService = accessor.get(IConfigurationService);
			const dialogService = accessor.get(IDialogService);
			const chatService = accessor.get(IChatService);
			const chatModel = chatService.getSession(widget.viewModel.sessionResource);
			if (!chatModel) {
				return;
			}

			const session = chatModel.editingSession;
			if (!session) {
				return;
			}

			const requestId = widget.viewModel?.editing.id;

			if (requestId) {
				const chatRequests = chatModel.getRequests();
				const itemIndex = chatRequests.findIndex(request => request.id === requestId);
				const editsToUndo = chatRequests.length - itemIndex;

				const requestsToRemove = chatRequests.slice(itemIndex);
				const requestIdsToRemove = new Set(requestsToRemove.map(request => request.id));
				const entriesModifiedInRequestsToRemove = session.entries.get().filter((entry) => requestIdsToRemove.has(entry.lastModifyingRequestId)) ?? [];
				const shouldPrompt = entriesModifiedInRequestsToRemove.length > 0 && configurationService.getValue('chat.editing.confirmEditRequestRemoval') === true;

				let message: string;
				if (editsToUndo === 1) {
					if (entriesModifiedInRequestsToRemove.length === 1) {
						message = localize('chat.removeLast.confirmation.message2', "This will remove your last request and undo the edits made to {0}. Do you want to proceed?", basename(entriesModifiedInRequestsToRemove[0].modifiedURI));
					} else {
						message = localize('chat.removeLast.confirmation.multipleEdits.message', "This will remove your last request and undo edits made to {0} files in your working set. Do you want to proceed?", entriesModifiedInRequestsToRemove.length);
					}
				} else {
					if (entriesModifiedInRequestsToRemove.length === 1) {
						message = localize('chat.remove.confirmation.message2', "This will remove all subsequent requests and undo edits made to {0}. Do you want to proceed?", basename(entriesModifiedInRequestsToRemove[0].modifiedURI));
					} else {
						message = localize('chat.remove.confirmation.multipleEdits.message', "This will remove all subsequent requests and undo edits made to {0} files in your working set. Do you want to proceed?", entriesModifiedInRequestsToRemove.length);
					}
				}

				const confirmation = shouldPrompt
					? await dialogService.confirm({
						title: editsToUndo === 1
							? localize('chat.removeLast.confirmation.title', "Do you want to undo your last edit?")
							: localize('chat.remove.confirmation.title', "Do you want to undo {0} edits?", editsToUndo),
						message: message,
						primaryButton: localize('chat.remove.confirmation.primaryButton', "Yes"),
						checkbox: { label: localize('chat.remove.confirmation.checkbox', "Don't ask again"), checked: false },
						type: 'info'
					})
					: { confirmed: true };

				type EditUndoEvent = {
					editRequestType: string;
					outcome: 'cancelled' | 'applied';
					editsUndoCount: number;
				};

				type EditUndoEventClassification = {
					owner: 'justschen';
					comment: 'Event used to gain insights into when there are pending changes to undo, and whether edited requests are applied or cancelled.';
					editRequestType: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Current entry point for editing a request.' };
					outcome: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Whether the edit was cancelled or applied.' };
					editsUndoCount: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Number of edits that would be undone.'; 'isMeasurement': true };
				};

				if (!confirmation.confirmed) {
					telemetryService.publicLog2<EditUndoEvent, EditUndoEventClassification>('chat.undoEditsConfirmation', {
						editRequestType: configurationService.getValue<string>('chat.editRequests'),
						outcome: 'cancelled',
						editsUndoCount: editsToUndo
					});
					return;
				} else if (editsToUndo > 0) {
					telemetryService.publicLog2<EditUndoEvent, EditUndoEventClassification>('chat.undoEditsConfirmation', {
						editRequestType: configurationService.getValue<string>('chat.editRequests'),
						outcome: 'applied',
						editsUndoCount: editsToUndo
					});
				}

				if (confirmation.checkboxChecked) {
					await configurationService.updateValue('chat.editing.confirmEditRequestRemoval', false);
				}

				// Restore the snapshot to what it was before the request(s) that we deleted
				const snapshotRequestId = chatRequests[itemIndex].id;
				await session.restoreSnapshot(snapshotRequestId, undefined);
			}
		} else if (widget?.viewModel?.model.checkpoint) {
			widget.viewModel.model.setCheckpoint(undefined);
		}
		widget?.acceptInput(context?.inputValue);
	}

	private async handleDelegation(accessor: ServicesAccessor, widget: IChatWidget, delegationTarget: Exclude<AgentSessionTarget, AgentSessionProviders.Local>): Promise<void> {
		const chatSessionsService = accessor.get(IChatSessionsService);

		// Find the contribution for the delegation target
		const contributions = chatSessionsService.getAllChatSessionContributions();
		const targetContribution = contributions.find(contrib => {
			const providerType = getAgentSessionProvider(contrib.type);
			return providerType === delegationTarget || contrib.type === delegationTarget;
		});

		if (!targetContribution) {
			throw new Error(`No contribution found for delegation target: ${delegationTarget}`);
		}

		if (targetContribution.canDelegate === false) {
			throw new Error(`The contribution for delegation target: ${delegationTarget} does not support delegation.`);
		}

		return new CreateRemoteAgentJobAction().run(accessor, targetContribution, widget);
	}
}

const whenNoActiveRequest = ChatContextKeys.hasActiveRequest.negate();
const whenNotInProgress = ChatContextKeys.requestInProgress.negate();

export class ChatSubmitAction extends SubmitAction {
	static readonly ID = 'workbench.action.chat.submit';

	constructor() {
		const menuCondition = ChatContextKeys.chatModeKind.isEqualTo(ChatModeKind.Ask);
		const precondition = ContextKeyExpr.and(
			ChatContextKeys.inputHasSendableContent,
			ContextKeyExpr.or(whenNotInProgress, ChatContextKeys.editingRequestType.isEqualTo(ChatContextKeys.EditingRequestType.Sent)),
			ChatContextKeys.chatSessionOptionsValid,
		);

		super({
			id: ChatSubmitAction.ID,
			title: localize2('interactive.submit.label', "Send"),
			f1: false,
			category: CHAT_CATEGORY,
			icon: Codicon.arrowUp,
			precondition,
			toggled: {
				condition: ChatContextKeys.lockedToCodingAgent,
				icon: Codicon.arrowUp,
				tooltip: localize('sendToAgent', "Send to Agent"),
			},
			keybinding: {
				when: ContextKeyExpr.and(
					ChatContextKeys.inChatInput,
					ChatContextKeys.withinEditSessionDiff.negate(),
				),
				primary: KeyCode.Enter,
				weight: KeybindingWeight.EditorContrib
			},
			menu: [
				{
					id: MenuId.ChatExecute,
					order: 4,
					when: ContextKeyExpr.and(
						whenNoActiveRequest,
						menuCondition,
						ChatContextKeys.withinEditSessionDiff.negate(),
					),
					group: 'navigation',
					alt: {
						id: 'workbench.action.chat.sendToNewChat',
						title: localize2('chat.newChat.label', "Send to New Chat"),
						icon: Codicon.plus
					}
				}, {
					id: MenuId.ChatEditorInlineExecute,
					group: 'navigation',
					order: 4,
					when: ContextKeyExpr.and(
						ContextKeyExpr.or(ctxHasEditorModification.negate(), ChatContextKeys.inputHasText),
						whenNoActiveRequest,
						menuCondition
					),
				}]
		});
	}
}


export const ToggleAgentModeActionId = 'workbench.action.chat.toggleAgentMode';

export interface IToggleChatModeArgs {
	modeId: ChatModeKind | string;
	sessionResource: URI | undefined;
}

type ChatModeChangeClassification = {
	owner: 'digitarald';
	comment: 'Reporting when agent is switched between different modes';
	fromMode?: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The previous agent name' };
	mode?: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The new agent name' };
	requestCount?: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Number of requests in the current chat session'; 'isMeasurement': true };
	storage?: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Source of the target mode (builtin, local, user, extension)' };
	extensionId?: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Extension ID if the target mode is from an extension' };
	toolsCount?: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Number of custom tools in the target mode'; 'isMeasurement': true };
	handoffsCount?: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Number of handoffs in the target mode'; 'isMeasurement': true };
	isClaudeAgent?: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Whether the target mode is a Claude agent file from .claude/agents/' };
};

type ChatModeChangeEvent = {
	fromMode: string;
	mode: string;
	requestCount: number;
	storage?: string;
	extensionId?: string;
	toolsCount?: number;
	handoffsCount?: number;
	isClaudeAgent?: boolean;
};

class ToggleChatModeAction extends Action2 {

	static readonly ID = ToggleAgentModeActionId;

	constructor() {
		super({
			id: ToggleChatModeAction.ID,
			title: localize2('interactive.toggleAgent.label', "Switch to Next Agent"),
			f1: true,
			category: CHAT_CATEGORY,
			precondition: ContextKeyExpr.and(
				ChatContextKeys.enabled,
				ChatContextKeys.requestInProgress.negate())
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]) {
		const commandService = accessor.get(ICommandService);
		const instaService = accessor.get(IInstantiationService);
		const telemetryService = accessor.get(ITelemetryService);
		const chatWidgetService = accessor.get(IChatWidgetService);

		const arg = args.at(0) as IToggleChatModeArgs | undefined;
		let widget: IChatWidget | undefined;
		if (arg?.sessionResource) {
			widget = chatWidgetService.getWidgetBySessionResource(arg.sessionResource);
		} else {
			widget = getEditingSessionContext(accessor, args)?.chatWidget;
		}

		if (!widget) {
			return;
		}

		const chatSession = widget.viewModel?.model;
		const requestCount = chatSession?.getRequests().length ?? 0;
		const modes = widget.input.currentChatModesObs.get();
		const switchToMode = (arg && (modes.findModeById(arg.modeId) || modes.findModeByName(arg.modeId))) ?? this.getNextMode(widget, requestCount, modes);

		const currentMode = widget.input.currentModeObs.get();
		if (switchToMode.id === currentMode.id) {
			return;
		}

		const chatModeCheck = await instaService.invokeFunction(handleModeSwitch, widget.input.currentModeKind, switchToMode.kind, requestCount, widget.viewModel?.model);
		if (!chatModeCheck) {
			return;
		}

		// Send telemetry for mode change
		const storage = switchToMode.source?.storage ?? 'builtin';
		const extensionId = switchToMode.source?.storage === 'extension' ? switchToMode.source.extensionId.value : undefined;
		const toolsCount = switchToMode.customTools?.get()?.length ?? 0;
		const handoffsCount = switchToMode.handOffs?.get()?.length ?? 0;

		const modeUri = switchToMode.uri?.get();
		const isClaudeAgent = modeUri ? isInClaudeAgentsFolder(modeUri) : undefined;

		telemetryService.publicLog2<ChatModeChangeEvent, ChatModeChangeClassification>('chat.modeChange', {
			fromMode: getModeNameForTelemetry(currentMode),
			mode: getModeNameForTelemetry(switchToMode),
			requestCount: requestCount,
			storage,
			extensionId,
			toolsCount,
			handoffsCount,
			isClaudeAgent
		});

		widget.input.setChatMode(switchToMode.id);

		if (chatModeCheck.needToClearSession) {
			await commandService.executeCommand(ACTION_ID_NEW_CHAT);
		}
	}

	private getNextMode(chatWidget: IChatWidget, requestCount: number, modes: IChatModes): IChatMode {
		const flat = [
			...modes.builtin.filter(mode => {
				return mode.kind !== ChatModeKind.Edit || requestCount === 0;
			}),
			...(modes.custom ?? []),
		];

		const curModeIndex = flat.findIndex(mode => mode.id === chatWidget.input.currentModeObs.get().id);
		const newMode = flat[(curModeIndex + 1) % flat.length];
		return newMode;
	}
}

class SwitchToNextModelAction extends Action2 {
	static readonly ID = 'workbench.action.chat.switchToNextModel';

	constructor() {
		super({
			id: SwitchToNextModelAction.ID,
			title: localize2('interactive.switchToNextModel.label', "Switch to Next Model"),
			category: CHAT_CATEGORY,
			f1: true,
			precondition: ChatContextKeys.enabled,
		});
	}

	override run(accessor: ServicesAccessor, ...args: unknown[]): void {
		const widgetService = accessor.get(IChatWidgetService);
		const widget = widgetService.lastFocusedWidget;
		widget?.input.switchToNextModel();
	}
}

class SwitchToNextPinnedModelAction extends Action2 {
	static readonly ID = 'workbench.action.chat.switchToNextPinnedModel';

	constructor() {
		super({
			id: SwitchToNextPinnedModelAction.ID,
			title: localize2('interactive.switchToNextPinnedModel.label', "Switch to Next Pinned Model"),
			category: CHAT_CATEGORY,
			f1: true,
			precondition: ChatContextKeys.enabled,
		});
	}

	override run(accessor: ServicesAccessor, ...args: unknown[]): void {
		const widgetService = accessor.get(IChatWidgetService);
		const widget = widgetService.lastFocusedWidget;
		widget?.input.switchToNextPinnedModel();
	}
}

/** Shared visibility for the model picker and its integrated configuration. */
const MODEL_PICKER_VISIBILITY = ContextKeyExpr.and(
	// Hide the model picker while a delegation (continue in) target is pending
	ChatContextKeys.hasPendingDelegationTarget.negate(),
	ContextKeyExpr.or(
		ChatContextKeys.lockedToCodingAgent.negate(),
		ChatContextKeys.chatSessionHasTargetedModels),
	ContextKeyExpr.or(
		ContextKeyExpr.equals(ChatContextKeys.location.key, ChatAgentLocation.Chat),
		ContextKeyExpr.equals(ChatContextKeys.location.key, ChatAgentLocation.EditorInline),
		ContextKeyExpr.equals(ChatContextKeys.location.key, ChatAgentLocation.Notebook),
		ContextKeyExpr.equals(ChatContextKeys.location.key, ChatAgentLocation.Terminal)),
	// Hide in welcome view when session type is not local
	ContextKeyExpr.or(
		ChatContextKeys.inAgentSessionsWelcome.negate(),
		ChatContextKeys.chatSessionHasTargetedModels,
		ChatContextKeys.agentSessionType.isEqualTo(AgentSessionProviders.Local))
);

export class OpenModelPickerAction extends Action2 {
	static readonly ID = 'workbench.action.chat.openModelPicker';

	constructor() {
			super({
			id: OpenModelPickerAction.ID,
			title: localize2('interactive.openModelPicker.label', "Open Model Picker"),
			category: CHAT_CATEGORY,
			f1: false,
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.Period,
				weight: KeybindingWeight.WorkbenchContrib,
				when: ChatContextKeys.inChatInput
			},
			menu: {
				id: MenuId.ChatInput,
				order: -0.9,
				group: 'navigation',
				when: MODEL_PICKER_VISIBILITY
			}
		});
	}

	override async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		const context = args[0] as IChatExecuteActionContext | undefined;
		const widgetService = accessor.get(IChatWidgetService);
		const widget = resolveChatWidgetFromActionContext(widgetService, context);
		if (widget) {
			await widgetService.reveal(widget);
			widget.input.openModelPicker();
		}
	}
}

interface IBackboardConfigJson {
	readonly env?: unknown;
	readonly api_url?: unknown;
	readonly api_key?: unknown;
	readonly apiKey?: unknown;
	readonly backboard_api_key?: unknown;
	readonly personal_api_key?: unknown;
	readonly env_keys?: unknown;
	readonly oauth?: unknown;
	readonly assistant_id?: unknown;
}

interface IBackboardComposerMicState {
	readonly widget: IChatWidget;
	readonly socket: WebSocket;
	readonly stream: MediaStream;
	readonly audioContext: AudioContext;
	readonly source: MediaStreamAudioSourceNode;
	readonly processor: ScriptProcessorNode;
	readonly silentOutput: GainNode;
	readonly initialInput: string;
	readonly threadId: string;
	readonly apiUrl: string;
	readonly authHeaders: Record<string, string>;
	readonly finalTranscript: Promise<string>;
	readonly resolveFinal: (value: string) => void;
	readonly rejectFinal: (error: Error) => void;
	readonly setRecording: (value: boolean) => void;
	lastTranscript: string;
	stopping: boolean;
}

let backboardComposerMicState: IBackboardComposerMicState | undefined;
let backboardComposerMicStarting = false;

export class ToggleBackboardComposerMicrophoneAction extends Action2 {
	static readonly ID = 'workbench.action.chat.toggleBackboardComposerMicrophone';

	constructor() {
		super({
			id: ToggleBackboardComposerMicrophoneAction.ID,
			title: localize2('interactive.backboardMicrophone.label', "Backboard Microphone"),
			tooltip: localize('interactive.backboardMicrophone.tooltip', "Listen and insert transcript"),
			category: CHAT_CATEGORY,
			icon: Codicon.mic,
			f1: false,
			toggled: ChatContextKeys.backboardMicrophoneRecording,
			menu: {
				id: MenuId.ChatExecute,
				order: 3.8,
				group: 'navigation',
				when: ChatContextKeys.inQuickChat.negate()
			}
		});
	}

	override async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		const context = args[0] as IChatExecuteActionContext | undefined;
		const widgetService = accessor.get(IChatWidgetService);
		const notificationService = accessor.get(INotificationService);
		const fileService = accessor.get(IFileService);
		const pathService = accessor.get(IPathService);
		const configurationService = accessor.get(IConfigurationService);
		const contextKeyService = accessor.get(IContextKeyService);
		const recordingKey = ChatContextKeys.backboardMicrophoneRecording.bindTo(contextKeyService);
		const widget = resolveChatWidgetFromActionContext(widgetService, context);
		if (!widget) {
			return;
		}

		if (backboardComposerMicState) {
			try {
				await stopBackboardRealtimeTranscription(backboardComposerMicState);
			} catch (error) {
				notificationService.error(localize('interactive.backboardMicrophone.failed', "Backboard transcription failed: {0}", getErrorMessage(error)));
			}
			return;
		}
		if (backboardComposerMicStarting) {
			return;
		}

		const win = widget.inputEditor.getDomNode()?.ownerDocument.defaultView;
		if (!win?.navigator.mediaDevices?.getUserMedia || typeof win.AudioContext === 'undefined' || typeof win.WebSocket === 'undefined') {
			notificationService.error(localize('interactive.backboardMicrophone.unsupported', "Microphone recording is not available in this window."));
			return;
		}

		try {
			backboardComposerMicStarting = true;
			backboardComposerMicState = await startBackboardRealtimeTranscription(
				widget,
				win,
				fileService,
				pathService,
				configurationService,
				value => recordingKey.set(value),
			);
			recordingKey.set(true);
		} catch (error) {
			backboardComposerMicState = undefined;
			recordingKey.set(false);
			notificationService.error(localize('interactive.backboardMicrophone.startFailed', "Could not start microphone: {0}", getErrorMessage(error)));
		} finally {
			backboardComposerMicStarting = false;
		}
	}
}

export class OpenChatThinkingPickerAction extends Action2 {
	static readonly ID = 'workbench.action.chat.openThinkingPicker';

	constructor() {
		super({
			id: OpenChatThinkingPickerAction.ID,
			title: localize2('interactive.openThinkingPicker.label', "Open Thinking Level Picker"),
			tooltip: localize('setThinkingLevel', "Set Thinking Level"),
			category: CHAT_CATEGORY,
			f1: false
		});
	}

	override async run(): Promise<void> {
		// The custom action view item owns the dropdown.
	}
}

export class OpenBackboardComposerOptionsAction extends Action2 {
	static readonly ID = 'workbench.action.chat.openBackboardComposerOptions';

	constructor() {
		super({
			id: OpenBackboardComposerOptionsAction.ID,
			title: localize2('interactive.backboardComposerOptions.label', "Backboard Options"),
			tooltip: localize('interactive.backboardComposerOptions.tooltip', "Open composer options"),
			category: CHAT_CATEGORY,
			icon: Codicon.settingsGear,
			f1: false
		});
	}

	override async run(): Promise<void> {
		// The custom action view item owns the dropdown so it can call the
		// current widget's existing picker methods directly.
	}
}

export class BackboardUsageMetricsAction extends Action2 {
	static readonly ID = 'workbench.action.chat.backboardUsageMetrics';

	constructor() {
		super({
			id: BackboardUsageMetricsAction.ID,
			title: localize2('interactive.backboardUsageMetrics.label', "Backboard Usage"),
			tooltip: localize('interactive.backboardUsageMetrics.tooltip', "Show model, token, and speed metrics"),
			category: CHAT_CATEGORY,
			icon: Codicon.dashboard,
			f1: false
		});
	}

	override async run(): Promise<void> {
		// Hover-only status action. The view item renders live metrics.
	}
}

async function startBackboardRealtimeTranscription(
	widget: IChatWidget,
	win: Window & typeof globalThis,
	fileService: IFileService,
	pathService: IPathService,
	configurationService: IConfigurationService,
	setRecording: (value: boolean) => void,
): Promise<IBackboardComposerMicState> {
	const config = await readBackboardComposerConfig(fileService, pathService);
	const authHeaders = backboardComposerAuthHeaders(config);
	const apiKey = backboardComposerApiKey(config);
	if (!authHeaders || !apiKey) {
		throw new Error(localize('interactive.backboardMicrophone.noCredentials', "Realtime voice requires a Backboard API key in ~/.backboard_ide/config.json."));
	}
	const apiUrl = backboardComposerApiUrl(config, configurationService);
	const assistantId = await resolveBackboardComposerAssistantId(config, apiUrl, authHeaders);
	const threadId = await createBackboardComposerVoiceThread(apiUrl, assistantId, authHeaders);
	const socketUrl = new URL(`${apiUrl}/threads/messages`);
	socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:';
	socketUrl.searchParams.set('api_key', apiKey);
	const socket = new win.WebSocket(socketUrl.toString());
	let state: IBackboardComposerMicState | undefined;
	let sessionReady = false;
	let resolveSession!: () => void;
	let rejectSession!: (error: Error) => void;
	const session = new Promise<void>((resolve, reject) => {
		resolveSession = resolve;
		rejectSession = reject;
	});
	const sessionTimeout = win.setTimeout(() => rejectSession(new Error('Backboard realtime voice session timed out.')), 15_000);
	let stream: MediaStream | undefined;
	let audioContext: AudioContext | undefined;
	let source: MediaStreamAudioSourceNode | undefined;
	let processor: ScriptProcessorNode | undefined;
	let silentOutput: GainNode | undefined;
	socket.addEventListener('open', () => {
		socket.send(JSON.stringify({
			thread_id: threadId,
			voice: {
				stt: {
					model: 'scribe_v2_realtime',
					sample_rate: 16000,
					audio_format: 'pcm_16000',
					commit_strategy: 'manual',
					language: 'en',
				}
			},
			send_to_llm: false,
			memory: 'off',
		}));
	}, { once: true });
	socket.addEventListener('message', event => {
		if (typeof event.data !== 'string') {
			return;
		}
		let payload: unknown;
		try {
			payload = JSON.parse(event.data);
		} catch {
			return;
		}
		if (!isBackboardRecord(payload)) {
			return;
		}
		const type = stringFromBackboardRecord(payload.type);
		if (type === 'session.begin') {
			sessionReady = true;
			win.clearTimeout(sessionTimeout);
			resolveSession();
			return;
		}
		if (type === 'error') {
			const error = new Error(stringFromBackboardRecord(payload.message) ?? stringFromBackboardRecord(payload.code) ?? 'Backboard realtime voice failed.');
			if (!sessionReady) {
				rejectSession(error);
			} else {
				state?.rejectFinal(error);
			}
			return;
		}
		if (type !== 'transcript.partial' && type !== 'transcript.final') {
			return;
		}
		const transcript = stringFromBackboardRecord(payload.text);
		if (!state || !transcript) {
			return;
		}
		state.lastTranscript = transcript;
		setBackboardComposerTranscript(state, transcript);
		if (type === 'transcript.final') {
			state.resolveFinal(transcript);
		}
	});
	socket.addEventListener('error', () => {
		const error = new Error('Backboard realtime voice connection failed.');
		if (!sessionReady) {
			rejectSession(error);
		} else {
			state?.rejectFinal(error);
		}
	});
	socket.addEventListener('close', () => {
		if (!sessionReady) {
			rejectSession(new Error('Backboard closed the realtime voice session before it started.'));
		} else if (state && !state.stopping) {
			state.rejectFinal(new Error('Backboard closed the realtime voice session.'));
		}
	});

	try {
		await session;
		stream = await win.navigator.mediaDevices.getUserMedia({
			audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true }
		});
		audioContext = new win.AudioContext();
		await audioContext.resume();
		source = audioContext.createMediaStreamSource(stream);
		processor = audioContext.createScriptProcessor(4096, 1, 1);
		silentOutput = audioContext.createGain();
		silentOutput.gain.value = 0;
		let resolveFinal!: (value: string) => void;
		let rejectFinal!: (error: Error) => void;
		const finalTranscript = new Promise<string>((resolve, reject) => {
			resolveFinal = resolve;
			rejectFinal = reject;
		});
		void finalTranscript.catch(() => undefined);
		state = {
			widget,
			socket,
			stream,
			audioContext,
			source,
			processor,
			silentOutput,
			initialInput: widget.inputEditor.getValue(),
			threadId,
			apiUrl,
			authHeaders,
			finalTranscript,
			resolveFinal,
			rejectFinal,
			setRecording,
			lastTranscript: '',
			stopping: false,
		};
		const inputSampleRate = audioContext.sampleRate;
		processor.onaudioprocess = event => {
			if (!state || state.stopping || socket.readyState !== win.WebSocket.OPEN) {
				return;
			}
			const pcm = encodeBackboardRealtimePcm(event.inputBuffer.getChannelData(0), inputSampleRate);
			if (pcm.byteLength > 0) {
				socket.send(pcm);
			}
		};
		source.connect(processor);
		processor.connect(silentOutput);
		silentOutput.connect(audioContext.destination);
		return state;
	} catch (error) {
		win.clearTimeout(sessionTimeout);
		processor?.disconnect();
		source?.disconnect();
		silentOutput?.disconnect();
		for (const track of stream?.getTracks() ?? []) {
			track.stop();
		}
		if (audioContext && audioContext.state !== 'closed') {
			await audioContext.close();
		}
		if (socket.readyState === win.WebSocket.OPEN) {
			socket.send(JSON.stringify({ type: 'stop' }));
		}
		socket.close();
		await deleteBackboardComposerVoiceThread(apiUrl, threadId, authHeaders);
		throw error;
	}
}

async function stopBackboardRealtimeTranscription(state: IBackboardComposerMicState): Promise<void> {
	if (state.stopping) {
		return;
	}
	state.stopping = true;
	state.setRecording(false);
	state.processor.onaudioprocess = null;
	state.source.disconnect();
	state.processor.disconnect();
	state.silentOutput.disconnect();
	for (const track of state.stream.getTracks()) {
		track.stop();
	}
	await state.audioContext.close();
	try {
		if (state.socket.readyState !== WebSocket.OPEN) {
			throw new Error('Backboard realtime voice connection is not open.');
		}
		state.socket.send(JSON.stringify({ type: 'commit' }));
		const transcript = await Promise.race([
			state.finalTranscript,
			new Promise<string>((_resolve, reject) => setTimeout(() => reject(new Error('Backboard did not finalize the transcript.')), 10_000)),
		]);
		setBackboardComposerTranscript(state, transcript);
		state.widget.inputEditor.focus();
	} finally {
		if (state.socket.readyState === WebSocket.OPEN) {
			state.socket.send(JSON.stringify({ type: 'stop' }));
		}
		state.socket.close();
		await deleteBackboardComposerVoiceThread(state.apiUrl, state.threadId, state.authHeaders);
		if (backboardComposerMicState === state) {
			backboardComposerMicState = undefined;
		}
	}
}

function setBackboardComposerTranscript(state: IBackboardComposerMicState, transcript: string): void {
	const current = state.initialInput;
	const next = current.trim().length > 0 ? `${current}${current.endsWith(' ') ? '' : ' '}${transcript}` : transcript;
	state.widget.setInput(next);
}

export function encodeBackboardRealtimePcm(input: Float32Array, inputSampleRate: number, outputSampleRate = 16000): ArrayBuffer {
	if (inputSampleRate < outputSampleRate || input.length === 0) {
		return new ArrayBuffer(0);
	}
	const ratio = inputSampleRate / outputSampleRate;
	const outputLength = Math.floor(input.length / ratio);
	const buffer = new ArrayBuffer(outputLength * 2);
	const view = new DataView(buffer);
	for (let outputIndex = 0; outputIndex < outputLength; outputIndex++) {
		const start = Math.floor(outputIndex * ratio);
		const end = Math.min(input.length, Math.max(start + 1, Math.floor((outputIndex + 1) * ratio)));
		let sum = 0;
		for (let inputIndex = start; inputIndex < end; inputIndex++) {
			sum += input[inputIndex];
		}
		const sample = Math.max(-1, Math.min(1, sum / (end - start)));
		view.setInt16(outputIndex * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
	}
	return buffer;
}

async function readBackboardComposerConfig(fileService: IFileService, pathService: IPathService): Promise<IBackboardConfigJson> {
	const resource = URI.joinPath(await pathService.userHome({ preferLocal: true }), '.backboard_ide', 'config.json');
	try {
		const parsed: unknown = JSON.parse((await fileService.readFile(resource)).value.toString());
		return isBackboardRecord(parsed) ? parsed : {};
	} catch (error) {
		if (toFileOperationResult(error) === FileOperationResult.FILE_NOT_FOUND || error instanceof SyntaxError) {
			return {};
		}
		throw error;
	}
}

async function resolveBackboardComposerAssistantId(
	config: IBackboardConfigJson,
	apiUrl: string,
	authHeaders: Record<string, string>,
): Promise<string> {
	const oauth = isBackboardRecord(config.oauth) ? config.oauth : undefined;
	const configured = stringFromBackboardRecord(config.assistant_id) ?? stringFromBackboardRecord(oauth?.assistant_id);
	if (configured) {
		return configured;
	}
	const response = await fetch(`${apiUrl}/assistants?limit=1`, { headers: authHeaders });
	if (!response.ok) {
		throw new Error(`Could not find a Backboard assistant: ${response.status} ${response.statusText}`);
	}
	const payload: unknown = await response.json();
	const assistants = Array.isArray(payload)
		? payload
		: isBackboardRecord(payload) && Array.isArray(payload.assistants) ? payload.assistants : [];
	for (const assistant of assistants) {
		if (isBackboardRecord(assistant)) {
			const assistantId = stringFromBackboardRecord(assistant.assistant_id) ?? stringFromBackboardRecord(assistant.assistantId);
			if (assistantId) {
				return assistantId;
			}
		}
	}
	throw new Error('No Backboard assistant is available for realtime voice.');
}

async function createBackboardComposerVoiceThread(
	apiUrl: string,
	assistantId: string,
	authHeaders: Record<string, string>,
): Promise<string> {
	const response = await fetch(`${apiUrl}/assistants/${encodeURIComponent(assistantId)}/threads`, {
		method: 'POST',
		headers: { ...authHeaders, 'Content-Type': 'application/json' },
		body: '{}',
	});
	if (!response.ok) {
		throw new Error(`Could not start a Backboard voice thread: ${response.status} ${response.statusText}`);
	}
	const payload: unknown = await response.json();
	const threadId = isBackboardRecord(payload)
		? stringFromBackboardRecord(payload.thread_id) ?? stringFromBackboardRecord(payload.threadId)
		: undefined;
	if (!threadId) {
		throw new Error('Backboard did not return a voice thread ID.');
	}
	return threadId;
}

async function deleteBackboardComposerVoiceThread(
	apiUrl: string,
	threadId: string,
	authHeaders: Record<string, string>,
): Promise<void> {
	try {
		await fetch(`${apiUrl}/threads/${encodeURIComponent(threadId)}`, {
			method: 'DELETE',
			headers: authHeaders,
		});
	} catch {
		// Dictation threads are temporary. Cleanup is best effort and must not
		// hide a successfully returned transcript.
	}
}

function backboardComposerApiUrl(config: IBackboardConfigJson, configurationService: IConfigurationService): string {
	const configured = stringFromBackboardRecord(config.api_url) ?? configurationService.getValue<string>('backboard.apiUrl');
	return (configured || 'https://app.backboard.io/api').replace(/\/+$/, '');
}

function backboardComposerAuthHeaders(config: IBackboardConfigJson): Record<string, string> | undefined {
	const apiKey = backboardComposerApiKey(config);
	if (apiKey) {
		return { 'X-API-Key': apiKey };
	}
	const accessToken = backboardComposerAccessToken(config);
	return accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined;
}

function backboardComposerApiKey(config: IBackboardConfigJson): string | undefined {
	const apiKey = stringFromBackboardRecord(config.api_key)
		?? stringFromBackboardRecord(config.apiKey)
		?? stringFromBackboardRecord(config.backboard_api_key)
		?? stringFromBackboardRecord(config.personal_api_key);
	if (apiKey) {
		return apiKey;
	}
	const env = normalizeBackboardComposerEnv(config.env);
	const envKeys = isBackboardRecord(config.env_keys) ? config.env_keys : {};
	return stringFromBackboardRecord(envKeys[env]);
}

function backboardComposerAccessToken(config: IBackboardConfigJson): string | undefined {
	const oauth = isBackboardRecord(config.oauth) ? config.oauth : undefined;
	return stringFromBackboardRecord(oauth?.access_token);
}

function normalizeBackboardComposerEnv(value: unknown): string {
	const env = stringFromBackboardRecord(value);
	return (env || 'prod').trim().toLowerCase();
}

function isBackboardRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringFromBackboardRecord(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

export class OpenPermissionPickerAction extends Action2 {
	static readonly ID = 'workbench.action.chat.openPermissionPicker';

	constructor() {
		super({
			id: OpenPermissionPickerAction.ID,
			title: localize2('interactive.openPermissionPicker.label', "Ask for approval"),
			tooltip: localize('setPermissionLevel', "Set Permissions"),
			category: CHAT_CATEGORY,
			f1: false,
			precondition: ChatContextKeys.enabled,
			menu: [
				{
					id: MenuId.ChatInputSecondary,
					order: 1,
					group: 'navigation',
					when:
						ContextKeyExpr.and(
							ChatContextKeys.enabled,
							ChatContextKeys.location.isEqualTo(ChatAgentLocation.Chat),
							ChatContextKeys.chatModeKind.notEqualsTo(ChatModeKind.Ask),
							ChatContextKeys.inQuickChat.negate(),
							ContextKeyExpr.or(
								ChatContextKeys.lockedToCodingAgent.negate(),
								ChatContextKeys.lockedCodingAgentId.isEqualTo(AgentSessionProviders.Background),
								ChatContextKeys.lockedCodingAgentId.isEqualTo(AgentSessionProviders.Claude),
							),
						)
				}
			]
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const widgetService = accessor.get(IChatWidgetService);
		const widget = widgetService.lastFocusedWidget;
		if (widget) {
			widget.input.openPermissionPicker();
		}
	}
}

export class OpenModePickerAction extends Action2 {
	static readonly ID = 'workbench.action.chat.openModePicker';

	constructor() {
		super({
			id: OpenModePickerAction.ID,
			title: localize2('interactive.openModePicker.label', "Open Agent Picker"),
			tooltip: localize('setChatMode', "Set Agent"),
			category: CHAT_CATEGORY,
			f1: false,
			precondition: ChatContextKeys.enabled,
			keybinding: {
				when: ContextKeyExpr.and(
					ChatContextKeys.inChatInput,
					ChatContextKeys.location.isEqualTo(ChatAgentLocation.Chat)),
				primary: KeyMod.CtrlCmd | KeyCode.Period,
				weight: KeybindingWeight.EditorContrib
			},
			menu: [
				{
					id: MenuId.ChatInput,
					order: 1,
					// Backboard keeps the composer focused on model/tools controls.
					// The current chat mode still exists, but the visible "Agent" chip is hidden.
					when: ContextKeyExpr.false(),
					group: 'navigation',
				},
			]
		});
	}

	override async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		const widgetService = accessor.get(IChatWidgetService);
		const widget = widgetService.lastFocusedWidget;
		if (widget) {
			widget.input.openModePicker();
		}
	}
}

export class OpenSessionTargetPickerAction extends Action2 {
	static readonly ID = 'workbench.action.chat.openSessionTargetPicker';

	constructor() {
		super({
			id: OpenSessionTargetPickerAction.ID,
			title: localize2('interactive.openSessionTargetPicker.label', "Open Session Target Picker"),
			tooltip: localize('setSessionTarget', "Set Session Target"),
			category: CHAT_CATEGORY,
			f1: false,
			precondition: ContextKeyExpr.and(ChatContextKeys.enabled, ContextKeyExpr.or(ChatContextKeys.chatSessionIsEmpty, ChatContextKeys.inAgentSessionsWelcome), ChatContextKeys.currentlyEditingInput.negate(), ChatContextKeys.currentlyEditing.negate()),
			menu: [
				{
					id: MenuId.ChatInput,
					order: 0,
					// Backboard ships with a single local provider, so there is
					// no session target to choose from in the composer.
					when: ContextKeyExpr.false(),
					group: 'navigation',
				},
				{
					id: MenuId.ChatInputSecondary,
					order: 0,
					when: ContextKeyExpr.false(),
					group: 'navigation',
				},
			]
		});
	}

	override async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		const widgetService = accessor.get(IChatWidgetService);
		const widget = widgetService.lastFocusedWidget;
		if (widget) {
			widget.input.openSessionTargetPicker();
		}
	}
}

export class OpenDelegationPickerAction extends Action2 {
	static readonly ID = 'workbench.action.chat.openDelegationPicker';

	constructor() {
		super({
			id: OpenDelegationPickerAction.ID,
			title: localize2('interactive.openDelegationPicker.label', "Open Delegation Picker"),
			tooltip: localize('delegateSession', "Delegate Session"),
			category: CHAT_CATEGORY,
			f1: false,
			precondition: ContextKeyExpr.and(ChatContextKeys.enabled, ChatContextKeys.chatSessionIsEmpty.negate(), ChatContextKeys.currentlyEditingInput.negate(), ChatContextKeys.currentlyEditing.negate()),
			menu: [
				{
					id: MenuId.ChatInputSecondary,
					order: 0.5,
					// Backboard keeps session execution local, so do not surface
					// the "Delegate Session" composer chip.
					when: ContextKeyExpr.false(),
					group: 'navigation',
				},
			]
		});
	}

	override async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		const widgetService = accessor.get(IChatWidgetService);
		const widget = widgetService.lastFocusedWidget;
		if (widget) {
			widget.input.openDelegationPicker();
		}
	}
}

export class OpenWorkspacePickerAction extends Action2 {
	static readonly ID = 'workbench.action.chat.openWorkspacePicker';

	constructor() {
		super({
			id: OpenWorkspacePickerAction.ID,
			title: localize2('interactive.openWorkspacePicker.label', "Open Workspace Picker"),
			tooltip: localize('selectWorkspace', "Select Target Workspace"),
			category: CHAT_CATEGORY,
			f1: false,
			// Also enabled in the Optimus (Advanced) window, whose composer
			// uses this picker to choose the folder a new task runs in.
			precondition: ContextKeyExpr.and(ChatContextKeys.enabled, ContextKeyExpr.or(ChatContextKeys.inAgentSessionsWelcome, IsOptimusWindowContext)),
			menu: [
				{
					id: MenuId.ChatInputSecondary,
					order: 0.6,
					when: ContextKeyExpr.or(
						ContextKeyExpr.and(
							ChatContextKeys.inAgentSessionsWelcome,
							ChatContextKeys.chatSessionType.isEqualTo(localChatSessionType)
						),
						IsOptimusWindowContext
					),
					group: 'navigation',
				},
			]
		});
	}

	override async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		// The picker is opened via the action view item
	}
}

export class ChatSessionPrimaryPickerAction extends Action2 {
	static readonly ID = 'workbench.action.chat.chatSessionPrimaryPicker';
	constructor() {
		super({
			id: ChatSessionPrimaryPickerAction.ID,
			title: localize2('interactive.openChatSessionPrimaryPicker.label', "Open Primary Session Picker"),
			category: CHAT_CATEGORY,
			f1: false,
			precondition: ChatContextKeys.enabled,
			menu: [
				{
					// Cloud sessions: keep on the primary chat input toolbar
					id: MenuId.ChatInput,
					order: 4,
					group: 'navigation',
					// Backboard does not surface remote/cloud session controls in the composer.
					when: ContextKeyExpr.false(),
				},
				{
					// All other coding agents (Claude, etc.): show in the secondary toolbar.
					// In the Agents window only, hide the worktree/branch pickers for Copilot
					// CLI sessions because their option groups are surfaced through the CLI
					// session UI there. They remain visible in the regular VS Code workbench.
					id: MenuId.ChatInputSecondary,
					order: 4,
					group: 'navigation',
					// Backboard does not surface remote/cloud session controls in the composer.
					when: ContextKeyExpr.false(),
				},
			]
		});
	}

	override async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		const widgetService = accessor.get(IChatWidgetService);
		const widget = widgetService.lastFocusedWidget;
		if (widget) {
			widget.input.openChatSessionPicker();
		}
	}
}

export const ChangeChatModelActionId = 'workbench.action.chat.changeModel';
class ChangeChatModelAction extends Action2 {
	static readonly ID = ChangeChatModelActionId;

	constructor() {
		super({
			id: ChangeChatModelAction.ID,
			title: localize2('interactive.changeModel.label', "Change Model"),
			category: CHAT_CATEGORY,
			f1: false,
			precondition: ChatContextKeys.enabled,
		});
	}

	override run(accessor: ServicesAccessor, ...args: unknown[]): void {
		const modelInfo = args[0] as Pick<ILanguageModelChatMetadata, 'vendor' | 'id' | 'family'>;
		// Type check the arg
		assertType(typeof modelInfo.vendor === 'string' && typeof modelInfo.id === 'string' && typeof modelInfo.family === 'string');
		const widgetService = accessor.get(IChatWidgetService);
		const widgets = widgetService.getAllWidgets();
		for (const widget of widgets) {
			widget.input.switchModel(modelInfo);
		}
	}
}

export class ChatEditingSessionSubmitAction extends SubmitAction {
	static readonly ID = 'workbench.action.edits.submit';

	constructor() {
		const notInProgressOrEditing = ContextKeyExpr.and(
			ContextKeyExpr.or(whenNoActiveRequest, ChatContextKeys.editingRequestType.isEqualTo(ChatContextKeys.EditingRequestType.Sent)),
			ChatContextKeys.editingRequestType.notEqualsTo(ChatContextKeys.EditingRequestType.Queue),
			ChatContextKeys.editingRequestType.notEqualsTo(ChatContextKeys.EditingRequestType.Steer)
		);

		const menuCondition = ChatContextKeys.chatModeKind.notEqualsTo(ChatModeKind.Ask);
		const precondition = ContextKeyExpr.and(
			ChatContextKeys.inputHasSendableContent,
			notInProgressOrEditing,
			ChatContextKeys.chatSessionOptionsValid
		);

		super({
			id: ChatEditingSessionSubmitAction.ID,
			title: localize2('edits.submit.label', "Send"),
			f1: false,
			category: CHAT_CATEGORY,
			icon: Codicon.arrowUp,
			precondition,
			menu: [
				{
					id: MenuId.ChatExecute,
					order: 4,
					when: ContextKeyExpr.and(
						notInProgressOrEditing,
						menuCondition),
					group: 'navigation',
					alt: {
						id: 'workbench.action.chat.sendToNewChat',
						title: localize2('chat.newChat.label', "Send to New Chat"),
						icon: Codicon.plus
					}
				}]
		});
	}
}

class SubmitWithoutDispatchingAction extends Action2 {
	static readonly ID = 'workbench.action.chat.submitWithoutDispatching';

	constructor() {
		const precondition = ContextKeyExpr.and(
			ChatContextKeys.inputHasText,
			whenNotInProgress,
			ChatContextKeys.chatModeKind.isEqualTo(ChatModeKind.Ask),
		);

		super({
			id: SubmitWithoutDispatchingAction.ID,
			title: localize2('interactive.submitWithoutDispatch.label', "Send"),
			f1: false,
			category: CHAT_CATEGORY,
			precondition,
			keybinding: {
				when: ChatContextKeys.inChatInput,
				primary: KeyMod.Alt | KeyMod.Shift | KeyCode.Enter,
				weight: KeybindingWeight.EditorContrib
			}
		});
	}

	run(accessor: ServicesAccessor, ...args: unknown[]) {
		const context = args[0] as IChatExecuteActionContext | undefined;

		const widgetService = accessor.get(IChatWidgetService);
		const widget = context?.widget ?? widgetService.lastFocusedWidget;
		widget?.acceptInput(context?.inputValue, { noCommandDetection: true });
	}
}

export class ChatSubmitWithCodebaseAction extends Action2 {
	static readonly ID = 'workbench.action.chat.submitWithCodebase';

	constructor() {
		const precondition = ContextKeyExpr.and(
			ChatContextKeys.inputHasText,
			whenNotInProgress,
		);

		super({
			id: ChatSubmitWithCodebaseAction.ID,
			title: localize2('actions.chat.submitWithCodebase', "Send with {0}", `${chatVariableLeader}codebase`),
			precondition,
			keybinding: {
				when: ChatContextKeys.inChatInput,
				primary: KeyMod.CtrlCmd | KeyCode.Enter,
				weight: KeybindingWeight.EditorContrib
			},
		});
	}

	run(accessor: ServicesAccessor, ...args: unknown[]) {
		const context = args[0] as IChatExecuteActionContext | undefined;

		const widgetService = accessor.get(IChatWidgetService);
		const widget = context?.widget ?? widgetService.lastFocusedWidget;
		if (!widget) {
			return;
		}

		const languageModelToolsService = accessor.get(ILanguageModelToolsService);
		const codebaseTool = languageModelToolsService.getToolByName('codebase');
		if (!codebaseTool) {
			return;
		}

		widget.input.attachmentModel.addContext({
			id: codebaseTool.id,
			name: codebaseTool.displayName ?? '',
			fullName: codebaseTool.displayName ?? '',
			value: undefined,
			icon: ThemeIcon.isThemeIcon(codebaseTool.icon) ? codebaseTool.icon : undefined,
			kind: 'tool'
		});
		widget.acceptInput();
	}
}

class SendToNewChatAction extends Action2 {
	constructor() {
		const precondition = ChatContextKeys.inputHasText;

		super({
			id: 'workbench.action.chat.sendToNewChat',
			title: localize2('chat.newChat.label', "Send to New Chat"),
			precondition,
			category: CHAT_CATEGORY,
			f1: false,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Enter,
				when: ChatContextKeys.inChatInput,
			}
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]) {
		const context = args[0] as IChatExecuteActionContext | undefined;

		const widgetService = accessor.get(IChatWidgetService);
		const viewsService = accessor.get(IViewsService);
		const dialogService = accessor.get(IDialogService);
		const chatService = accessor.get(IChatService);
		const configurationService = accessor.get(IConfigurationService);
		const chatSessionsService = accessor.get(IChatSessionsService);
		const widget = context?.widget ?? widgetService.lastFocusedWidget;
		if (!widget) {
			return;
		}

		const inputBeforeClear = widget.getInput();

		// Cancel any in-progress request before clearing
		if (widget.viewModel) {
			await chatService.cancelCurrentRequestForSession(widget.viewModel.sessionResource, 'newSessionAction');
		}

		if (widget.viewModel?.model) {
			if (!(await handleCurrentEditingSession(widget.viewModel.model, undefined, dialogService))) {
				return;
			}
		}

		// Clear the input from the current session before creating a new one
		widget.setInput('');

		await clearChatSessionPreservingType(widget, viewsService, undefined, configurationService, chatSessionsService);

		widget.acceptInput(inputBeforeClear, { storeToHistory: true });
	}
}

export const CancelChatActionId = 'workbench.action.chat.cancel';
export class CancelAction extends Action2 {
	static readonly ID = CancelChatActionId;
	constructor() {
		super({
			id: CancelAction.ID,
			title: localize2('interactive.cancel.label', "Cancel"),
			f1: false,
			category: CHAT_CATEGORY,
			icon: Codicon.stopCircle,
			menu: [{
				id: MenuId.ChatExecute,
				when: ContextKeyExpr.and(
					ChatContextKeys.hasActiveRequest,
					ChatContextKeys.remoteJobCreating.negate(),
					ChatContextKeys.currentlyEditing.negate(),
				),
				order: 4,
				group: 'navigation',
			}, {
				id: MenuId.ChatEditorInlineExecute,
				when: ContextKeyExpr.and(
					ctxIsGlobalEditingSession.negate(),
					ctxHasRequestInProgress,
				),
				order: 4,
				group: 'navigation',
			}
			],
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyCode.Escape,
				when: ContextKeyExpr.and(
					ChatContextKeys.hasActiveRequest,
					ChatContextKeys.remoteJobCreating.negate()
				),
				win: { primary: KeyMod.Alt | KeyCode.Backspace },
			}
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]) {
		const context = args[0] as IChatExecuteActionContext | undefined;
		const widgetService = accessor.get(IChatWidgetService);
		const logService = accessor.get(ILogService);
		const telemetryService = accessor.get(ITelemetryService);
		const widget = context?.widget ?? widgetService.lastFocusedWidget;
		if (!widget) {
			telemetryService.publicLog2<ChatStopCancellationNoopEvent, ChatStopCancellationNoopClassification>(ChatStopCancellationNoopEventName, {
				source: 'cancelAction',
				reason: 'noWidget',
				requestInProgress: 'unknown',
				pendingRequests: 0,
			});
			logService.info('ChatCancelAction#run: No focused chat widget was found');
			return;
		}

		const chatService = accessor.get(IChatService);
		if (widget.viewModel) {
			await chatService.cancelCurrentRequestForSession(widget.viewModel.sessionResource, 'cancelAction');
		} else {
			telemetryService.publicLog2<ChatStopCancellationNoopEvent, ChatStopCancellationNoopClassification>(ChatStopCancellationNoopEventName, {
				source: 'cancelAction',
				reason: 'noViewModel',
				requestInProgress: 'unknown',
				pendingRequests: 0,
			});
			logService.info('ChatCancelAction#run: Canceled chat widget has no view model');
		}
	}
}

export const CancelChatEditId = 'workbench.edit.chat.cancel';
export class CancelEdit extends Action2 {
	static readonly ID = CancelChatEditId;
	constructor() {
		super({
			id: CancelEdit.ID,
			title: localize2('interactive.cancelEdit.label', "Cancel Edit"),
			f1: false,
			category: CHAT_CATEGORY,
			icon: Codicon.x,
			menu: [
				{
					id: MenuId.ChatMessageTitle,
					group: 'navigation',
					order: 1,
					when: ContextKeyExpr.and(ChatContextKeys.isRequest, ChatContextKeys.currentlyEditing, ContextKeyExpr.equals(`config.${ChatConfiguration.EditRequests}`, 'input'))
				}
			],
			keybinding: {
				primary: KeyCode.Escape,
				when: ContextKeyExpr.and(ChatContextKeys.inChatInput,
					EditorContextKeys.hoverVisible.toNegated(),
					EditorContextKeys.hasNonEmptySelection.toNegated(),
					EditorContextKeys.hasMultipleSelections.toNegated(),
					ContextKeyExpr.or(ChatContextKeys.currentlyEditing, ChatContextKeys.currentlyEditingInput)),
				weight: KeybindingWeight.EditorContrib - 5
			}
		});
	}

	run(accessor: ServicesAccessor, ...args: unknown[]) {
		const context = args[0] as IChatExecuteActionContext | undefined;

		const widgetService = accessor.get(IChatWidgetService);
		const widget = context?.widget ?? widgetService.lastFocusedWidget;
		if (!widget) {
			return;
		}
		widget.finishedEditing();
	}
}

// --- Handoff Discovery & Execution Commands ---

export const GetHandoffsActionId = 'workbench.action.chat.getHandoffs';

interface IGetHandoffsArgs {
	/**
	 * Name of the custom agent (defined in an `.agent.md` file) whose handoffs
	 * you want to retrieve. If omitted, all
	 * handoffs from all agents and built-in modes are returned.
	 */
	sourceCustomAgent?: string;

}

/**
 * Discovers the handoffs available across custom agents (and built-in modes).
 *
 * **Return value**: `ICustomAgentInfo[]` — an array where each element
 * represents an agent/mode with its `id`, `name`, `isBuiltin`,
 * `visibility`, and `handoffs` list.
 *
 * @see ICustomAgentInfo
 * @see IHandoffInfo
 */
class GetHandoffsAction extends Action2 {

	static readonly ID = GetHandoffsActionId;

	constructor() {
		super({
			id: GetHandoffsAction.ID,
			title: localize2('chat.getHandoffs.label', "Get Handoffs"),
			f1: false,
			category: CHAT_CATEGORY,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]) {
		const modeService = accessor.get(IChatModeService);
		const arg = args.at(0) as IGetHandoffsArgs | undefined;

		const { builtin, custom } = await modeService.getLocalModes();
		let allModes: readonly IChatMode[] = [...builtin, ...custom];

		if (arg?.sourceCustomAgent) {
			const filterName = arg.sourceCustomAgent;
			allModes = allModes.filter(m => m.name.get().toLowerCase() === filterName.toLowerCase());
		}

		return buildCustomAgentHandoffsInfo(allModes);
	}
}

export const ExecuteHandoffActionId = 'workbench.action.chat.executeHandoff';

interface IExecuteHandoffArgs {
	/**
	 * The stable handoff ID (from getHandoffs). Primary match key.
	 * IDs are unique within a given source agent; when handoffs from
	 * multiple source agents share the same target+label, also provide
	 * `sourceCustomAgent` to disambiguate.
	 */
	id?: string;
	/** Fallback: handoff label to match. Case-insensitive. */
	label?: string;
	/**
	 * The chat session URI identifying which chat widget to execute in.
	 * If omitted, falls back to the last-focused chat widget.
	 */
	sessionResource?: string;
	/**
	 * Name of the *source* custom agent (from `.agent.md`) that declares the handoff to
	 * execute. If omitted, falls back to the session's currently active mode/agent.
	 */
	sourceCustomAgent?: string;
}

interface IExecuteHandoffResult {
	success: boolean;
	targetMode?: string;
	error?: string;
}

class ExecuteHandoffAction extends Action2 {

	static readonly ID = ExecuteHandoffActionId;

	constructor() {
		super({
			id: ExecuteHandoffAction.ID,
			title: localize2('chat.executeHandoff.label', "Execute Handoff"),
			f1: false,
			category: CHAT_CATEGORY,
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<IExecuteHandoffResult> {
		const chatWidgetService = accessor.get(IChatWidgetService);

		const arg = args.at(0) as IExecuteHandoffArgs | undefined;
		if (!arg?.id && !arg?.label) {
			return { success: false, error: 'Either id or label is required' };
		}

		// Resolve the target widget: explicit sessionResource, or fall back to last-focused
		let widget: IChatWidget | undefined;
		if (arg.sessionResource) {
			let sessionResource;
			try {
				sessionResource = URI.parse(arg.sessionResource);
			} catch {
				return { success: false, error: `Invalid sessionResource URI: '${arg.sessionResource}'` };
			}
			widget = chatWidgetService.getWidgetBySessionResource(sessionResource);
		} else {
			widget = chatWidgetService.lastFocusedWidget;
		}
		if (!widget) {
			return { success: false, error: 'No chat widget found. Provide sessionResource or focus a chat widget.' };
		}

		// Resolve the source custom agent whose handoffs we search (case-insensitive)
		let sourceMode: IChatMode | undefined;
		if (arg.sourceCustomAgent) {
			const filterName = arg.sourceCustomAgent.toLowerCase();
			const { builtin, custom } = widget.input.currentChatModesObs.get();
			sourceMode = [...builtin, ...custom].find(m => m.name.get().toLowerCase() === filterName || m.id.toLowerCase() === filterName);
		}
		if (!sourceMode) {
			sourceMode = widget.input.currentModeObs.get();
		}

		const handoffs = sourceMode?.handOffs?.get();
		if (!handoffs || handoffs.length === 0) {
			return { success: false, error: `No handoffs available for mode '${sourceMode?.name.get()}'` };
		}

		// Match by id first, then by label
		let matchedHandoff = arg.id
			? handoffs.find(h => getHandoffId(h) === arg.id)
			: undefined;

		if (!matchedHandoff && arg.label) {
			const labelLower = arg.label.trim().toLowerCase();
			matchedHandoff = handoffs.find(h => h.label.trim().toLowerCase() === labelLower);
		}

		if (!matchedHandoff) {
			const identifier = arg.id ?? arg.label;
			return { success: false, error: `No handoff with identifier '${identifier}' found for mode '${sourceMode?.name.get()}'` };
		}

		await widget.executeHandoff(matchedHandoff);
		return { success: true, targetMode: matchedHandoff.agent };
	}
}


export function registerChatExecuteActions(): DisposableStore {
	const store = new DisposableStore();
	store.add(registerAction2(ChatSubmitAction));
	store.add(registerAction2(ChatEditingSessionSubmitAction));
	store.add(registerAction2(SubmitWithoutDispatchingAction));
	store.add(registerAction2(CancelAction));
	store.add(registerAction2(SendToNewChatAction));
	store.add(registerAction2(ChatSubmitWithCodebaseAction));
	store.add(registerAction2(ToggleChatModeAction));
	store.add(registerAction2(SwitchToNextModelAction));
	store.add(registerAction2(SwitchToNextPinnedModelAction));
	store.add(registerAction2(OpenModelPickerAction));
	store.add(registerAction2(OpenChatThinkingPickerAction));
	store.add(registerAction2(ToggleBackboardComposerMicrophoneAction));
	store.add(registerAction2(OpenBackboardComposerOptionsAction));
	store.add(registerAction2(BackboardUsageMetricsAction));
	store.add(registerAction2(OpenPermissionPickerAction));
	store.add(registerAction2(OpenModePickerAction));
	store.add(registerAction2(OpenSessionTargetPickerAction));
	store.add(registerAction2(OpenDelegationPickerAction));
	store.add(registerAction2(OpenWorkspacePickerAction));
	store.add(registerAction2(ChatSessionPrimaryPickerAction));
	store.add(registerAction2(ChangeChatModelAction));
	store.add(registerAction2(CancelEdit));
	store.add(registerAction2(GetHandoffsAction));
	store.add(registerAction2(ExecuteHandoffAction));
	return store;
}
