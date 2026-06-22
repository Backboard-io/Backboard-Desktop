/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
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
			icon: Codicon.newLine,
			precondition,
			toggled: {
				condition: ChatContextKeys.lockedToCodingAgent,
				icon: Codicon.newLine,
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
				order: 3,
				group: 'navigation',
				when:
					ContextKeyExpr.and(
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
					)
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
}

interface IBackboardComposerMicState {
	readonly recorder: MediaRecorder;
	readonly chunks: Blob[];
	readonly widget: IChatWidget;
}

let backboardComposerMicState: IBackboardComposerMicState | undefined;

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
				id: MenuId.ChatInput,
				order: 5,
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
			backboardComposerMicState.recorder.stop();
			return;
		}

		const win = widget.inputEditor.getDomNode()?.ownerDocument.defaultView;
		if (!win?.navigator.mediaDevices?.getUserMedia || typeof win.MediaRecorder === 'undefined') {
			notificationService.error(localize('interactive.backboardMicrophone.unsupported', "Microphone recording is not available in this window."));
			return;
		}

		try {
			const stream = await win.navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
			const mimeType = win.MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
			const chunks: Blob[] = [];
			const recorder = new win.MediaRecorder(stream, { mimeType });
			backboardComposerMicState = { recorder, chunks, widget };
			recordingKey.set(true);
			recorder.ondataavailable = event => {
				if (event.data.size > 0) {
					chunks.push(event.data);
				}
			};
			recorder.onstop = () => {
				const stoppedState = backboardComposerMicState;
				backboardComposerMicState = undefined;
				recordingKey.set(false);
				for (const track of stream.getTracks()) {
					track.stop();
				}
				if (!stoppedState || stoppedState.chunks.length === 0) {
					return;
				}
				transcribeBackboardComposerAudio(stoppedState, mimeType, fileService, pathService, configurationService, notificationService).catch(error => {
					notificationService.error(localize('interactive.backboardMicrophone.failed', "Backboard transcription failed: {0}", getErrorMessage(error)));
				});
			};
			recorder.start();
			notificationService.info(localize('interactive.backboardMicrophone.listening', "Listening. Click the microphone again to stop."));
		} catch (error) {
			backboardComposerMicState = undefined;
			recordingKey.set(false);
			notificationService.error(localize('interactive.backboardMicrophone.startFailed', "Could not start microphone: {0}", getErrorMessage(error)));
		}
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
			icon: Codicon.listFilter,
			f1: false,
			menu: {
				id: MenuId.ChatInput,
				order: 6,
				group: 'navigation',
				when: ChatContextKeys.inQuickChat.negate()
			}
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
			tooltip: localize('interactive.backboardUsageMetrics.tooltip', "Show model, token, cost, and speed metrics"),
			category: CHAT_CATEGORY,
			icon: Codicon.dashboard,
			f1: false,
			menu: {
				id: MenuId.ChatInputStatus,
				order: 1,
				group: 'navigation',
				when: ChatContextKeys.inQuickChat.negate()
			}
		});
	}

	override async run(): Promise<void> {
		// Hover-only status action. The view item renders live metrics.
	}
}

async function transcribeBackboardComposerAudio(
	state: IBackboardComposerMicState,
	mimeType: string,
	fileService: IFileService,
	pathService: IPathService,
	configurationService: IConfigurationService,
	notificationService: INotificationService,
): Promise<void> {
	notificationService.info(localize('interactive.backboardMicrophone.transcribing', "Transcribing with Backboard..."));
	const config = await readBackboardComposerConfig(fileService, pathService);
	const authHeaders = backboardComposerAuthHeaders(config);
	if (!authHeaders) {
		throw new Error(localize('interactive.backboardMicrophone.noCredentials', "No Backboard API key or OAuth token found in ~/.backboard_ide/config.json."));
	}

	const blob = new Blob(state.chunks, { type: mimeType });
	const form = new FormData();
	form.append('stream', 'false');
	form.append('content', '');
	form.append('send_to_llm', 'false');
	form.append('voice', JSON.stringify({
		stt: {
			provider: 'openai',
			model: 'gpt-4o-mini-transcribe',
			language: 'en',
		}
	}));
	form.append('audio_file', blob, 'backboard-composer-voice.webm');

	const response = await fetch(`${backboardComposerApiUrl(config, configurationService)}/threads/messages`, {
		method: 'POST',
		headers: authHeaders,
		body: form,
	});
	if (!response.ok) {
		throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
	}

	const payload: unknown = await response.json();
	const transcript = extractBackboardTranscript(payload);
	if (!transcript) {
		throw new Error(localize('interactive.backboardMicrophone.noTranscript', "Backboard response did not include a transcript."));
	}

	const current = state.widget.inputEditor.getValue();
	const next = current.trim().length > 0 ? `${current}${current.endsWith(' ') ? '' : ' '}${transcript}` : transcript;
	state.widget.setInput(next);
	state.widget.inputEditor.focus();
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

function extractBackboardTranscript(value: unknown): string | undefined {
	if (!isBackboardRecord(value)) {
		return undefined;
	}
	const direct = stringFromBackboardRecord(value.transcript) ?? stringFromBackboardRecord(value.text);
	if (direct) {
		return direct;
	}
	const messages = Array.isArray(value.messages) ? value.messages : [value];
	for (const message of messages) {
		if (!isBackboardRecord(message)) {
			continue;
		}
		const voiceRecords = isBackboardRecord(message.voice_records) ? message.voice_records : isBackboardRecord(message.voiceRecords) ? message.voiceRecords : undefined;
		const stt = isBackboardRecord(voiceRecords?.stt) ? voiceRecords.stt : undefined;
		const transcript = stringFromBackboardRecord(stt?.transcript) ?? stringFromBackboardRecord(stt?.text) ?? stringFromBackboardRecord(stt?.message);
		if (transcript) {
			return transcript;
		}
		const content = stringFromBackboardRecord(message.content) ?? stringFromBackboardRecord(message.message);
		if (content) {
			return content;
		}
	}
	return undefined;
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
			title: localize2('interactive.openPermissionPicker.label', "Open Permission Picker"),
			tooltip: localize('setPermissionLevel', "Set Permissions"),
			category: CHAT_CATEGORY,
			f1: false,
			precondition: ChatContextKeys.enabled,
			menu: {
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
			precondition: ContextKeyExpr.and(ChatContextKeys.enabled, ChatContextKeys.inAgentSessionsWelcome),
			menu: [
				{
					id: MenuId.ChatInputSecondary,
					order: 0.6,
					when: ContextKeyExpr.and(
						ChatContextKeys.inAgentSessionsWelcome,
						ChatContextKeys.chatSessionType.isEqualTo(localChatSessionType)
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
			icon: Codicon.newLine,
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
