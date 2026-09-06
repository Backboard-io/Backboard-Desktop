/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { asCSSUrl } from '../../../../base/browser/cssValue.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { BranchChatSessionAction } from './branchChatSessionAction.js';
import { RunScriptContribution } from './runScriptAction.js';
import './nullInlineChatSessionService.js';
import './nullChatTipService.js';
import './modelPicker.js';
import './agentHostDelegation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ISessionsTasksService, SessionsTasksService } from './sessionsTasksService.js';
import { ISessionTaskRunnerRegistry, SessionTaskRunnerRegistry } from './sessionTaskRunner.js';
import { RegisterDefaultSessionTaskRunnersContribution } from './registerDefaultSessionTaskRunners.js';
import { AgenticPromptsService } from './promptsService.js';
import { IPromptsService } from '../../../../workbench/contrib/chat/common/promptSyntax/service/promptsService.js';
import { IAICustomizationWorkspaceService } from '../../../../workbench/contrib/chat/common/aiCustomizationWorkspaceService.js';
import { ICustomizationHarnessService } from '../../../../workbench/contrib/chat/common/customizationHarnessService.js';
import { SessionsAICustomizationWorkspaceService } from './aiCustomizationWorkspaceService.js';
import { SessionsCustomizationHarnessService } from './customizationHarnessService.js';
import { IChatViewFactory } from '../../../services/chatView/browser/chatViewFactory.js';
import { ChatViewFactory } from './chatView.js';
import { CHAT_CATEGORY } from '../../../../workbench/contrib/chat/browser/actions/chatActions.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { SessionsChatAccessibilityHelp } from './sessionsChatAccessibilityHelp.js';
import { SessionsOpenerParticipantContribution } from './sessionsOpenerParticipant.js';
import { WorktreeCreatedTaskDispatcher, AGENT_HOST_RUN_WORKTREE_CREATED_TASKS_SETTING } from './worktreeCreatedTaskDispatcher.js';
import { AGENT_SESSIONS_SCOPED_INPUT_HISTORY_SETTING } from './sessionsChatHistory.js';
import '../../sessions/browser/mobile/mobileOverlayContribution.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorAreaFocusContext } from '../../../../workbench/common/contextkeys.js';
import { IWorkbenchLayoutService } from '../../../../workbench/services/layout/browser/layoutService.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { NEW_SESSION_ACTION_ID } from '../common/constants.js';
import { ISimpleModeBackgroundService, SimpleModeBackgroundImageSetContext, SimpleModeBackgroundService } from './simpleModeBackgroundService.js';

const OPTIMUS_NEW_SESSION_COMMAND_ID = 'optimus.newSession';

class NewChatInSessionsWindowAction extends Action2 {

	constructor() {
		super({
			id: NEW_SESSION_ACTION_ID,
			title: localize2('chat.newEdits.label', "New Chat"),
			category: CHAT_CATEGORY,
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib + 2,
				// Don't shadow Ctrl/Cmd+N (and Ctrl/Cmd+L) when focus is in the
				// editor area so the standard editor commands (new untitled file,
				// expand line selection) handle the shortcut instead.
				when: EditorAreaFocusContext.negate(),
				primary: KeyMod.CtrlCmd | KeyCode.KeyN,
				secondary: [KeyMod.CtrlCmd | KeyCode.KeyL],
				mac: {
					primary: KeyMod.CtrlCmd | KeyCode.KeyN,
					secondary: [KeyMod.WinCtrl | KeyCode.KeyL]
				},
			}
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		if (accessor.get(IWorkbenchEnvironmentService).isOptimusWindow) {
			await accessor.get(ICommandService).executeCommand(OPTIMUS_NEW_SESSION_COMMAND_ID);
			return;
		}

		const sessionsService = accessor.get(ISessionsService);
		// Inherit the active session's provider and session type so the new
		// session defaults to the same kind the user is currently working in.
		const activeSession = sessionsService.activeSession.get();
		if (
			activeSession?.isCreated.get() &&
			activeSession.capabilities.supportsMultipleChats &&
			!activeSession.isArchived.get()
		) {
			await sessionsService.openNewChatInSession(activeSession);
			return;
		}

		sessionsService.openNewSession({
			folderUri: activeSession?.workspace.get()?.uri,
			providerId: activeSession?.providerId,
			sessionTypeId: activeSession?.sessionType,
		});
	}
}

registerAction2(NewChatInSessionsWindowAction);

class ChooseSimpleModeBackgroundImageAction extends Action2 {

	static readonly ID = 'sessions.simpleMode.chooseBackgroundImage';

	constructor() {
		super({
			id: ChooseSimpleModeBackgroundImageAction.ID,
			title: localize2('simpleModeBackground.choose', "Choose Simple Mode Background Image…"),
			category: CHAT_CATEGORY,
			icon: Codicon.fileMedia,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(ISimpleModeBackgroundService).chooseBackgroundImage();
	}
}

class ClearSimpleModeBackgroundImageAction extends Action2 {

	static readonly ID = 'sessions.simpleMode.clearBackgroundImage';

	constructor() {
		super({
			id: ClearSimpleModeBackgroundImageAction.ID,
			title: localize2('simpleModeBackground.clear', "Clear Simple Mode Background Image"),
			category: CHAT_CATEGORY,
			icon: Codicon.trash,
			f1: true,
			precondition: SimpleModeBackgroundImageSetContext,
		});
	}

	override run(accessor: ServicesAccessor): void {
		accessor.get(ISimpleModeBackgroundService).clearBackgroundImage();
	}
}

registerAction2(ChooseSimpleModeBackgroundImageAction);
registerAction2(ClearSimpleModeBackgroundImageAction);

/**
 * Applies the Simple mode background image at the workbench level instead of
 * leaving it to whichever chat view happens to be alive. Session views are
 * created, replaced, and rebound while the user interacts (draft graduation,
 * session switches, grid reconciliation), so per-view application could miss
 * an update whenever no rendered view was subscribed at that moment — the
 * picker accepted a file but the canvas never changed. The workbench root is
 * always present, so the marker class and the image URL are owned here; the
 * new-task canvas only advertises its own transparency hook.
 */
class SimpleModeBackgroundWorkbenchContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.simpleModeBackground';

	constructor(
		@ISimpleModeBackgroundService private readonly simpleModeBackgroundService: ISimpleModeBackgroundService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
	) {
		super();

		this.applyBackground(this.simpleModeBackgroundService.backgroundImage);
		this._register(this.simpleModeBackgroundService.onDidChangeBackgroundImage(resource => this.applyBackground(resource)));
	}

	private applyBackground(resource: URI | undefined): void {
		// The layout root exists before its classes are attached during startup.
		// Applying directly also restores the image before the first chat renders.
		const workbench = this.layoutService.mainContainer;

		workbench.classList.toggle('sessions-chat-custom-background', !!resource);
		if (resource) {
			// Make every accepted picker result a distinct CSS value so a cached
			// image is repainted when it is selected again.
			const versionedResource = resource.with({ fragment: `backboard-background-${this.simpleModeBackgroundService.backgroundImageRevision}` });
			workbench.style.setProperty('--new-chat-background-image', asCSSUrl(versionedResource));
		} else {
			workbench.style.removeProperty('--new-chat-background-image');
		}
	}
}

// register actions
registerAction2(BranchChatSessionAction);

// register workbench contributions
// BlockRestore is the earliest phase that runs after the sessions workbench
// has rendered (BlockStartup precedes `renderWorkbench`), so the persisted
// image lands without waiting for idle and without missing the first paint by
// much.
registerWorkbenchContribution2(SimpleModeBackgroundWorkbenchContribution.ID, SimpleModeBackgroundWorkbenchContribution, WorkbenchPhase.BlockRestore);
registerWorkbenchContribution2(RunScriptContribution.ID, RunScriptContribution, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(SessionsOpenerParticipantContribution.ID, SessionsOpenerParticipantContribution, WorkbenchPhase.BlockStartup);
registerWorkbenchContribution2(RegisterDefaultSessionTaskRunnersContribution.ID, RegisterDefaultSessionTaskRunnersContribution, WorkbenchPhase.BlockStartup);
registerWorkbenchContribution2(WorktreeCreatedTaskDispatcher.ID, WorktreeCreatedTaskDispatcher, WorkbenchPhase.AfterRestored);

// register services
registerSingleton(IPromptsService, AgenticPromptsService, InstantiationType.Delayed);
registerSingleton(ISessionTaskRunnerRegistry, SessionTaskRunnerRegistry, InstantiationType.Delayed);
registerSingleton(ISessionsTasksService, SessionsTasksService, InstantiationType.Delayed);
registerSingleton(IAICustomizationWorkspaceService, SessionsAICustomizationWorkspaceService, InstantiationType.Delayed);
registerSingleton(ICustomizationHarnessService, SessionsCustomizationHarnessService, InstantiationType.Delayed);
registerSingleton(IChatViewFactory, ChatViewFactory, InstantiationType.Delayed);
registerSingleton(ISimpleModeBackgroundService, SimpleModeBackgroundService, InstantiationType.Delayed);

// register accessibility help
AccessibleViewRegistry.register(new SessionsChatAccessibilityHelp());

// register configuration
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	properties: {
		[AGENT_HOST_RUN_WORKTREE_CREATED_TASKS_SETTING]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			description: localize('chat.agentHost.runWorktreeCreatedTasks', "Whether to automatically run tasks tagged with `\"runOptions\": { \"runOn\": \"worktreeCreated\" }` when a new agent host session worktree is created. Manual `Run Task` invocations are unaffected."),
		},
		[AGENT_SESSIONS_SCOPED_INPUT_HISTORY_SETTING]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			description: localize('chat.agentSessions.scopedInputHistory', "Controls whether chat input history in the Agents Window is scoped to the current session. Disable this to use shared input history across sessions."),
		},
	},
});
