/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../base/common/codicons.js';
import { Schemas } from '../../../base/common/network.js';
import { basename } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';
import { ServicesAccessor } from '../../../editor/browser/editorExtensions.js';
import { localize, localize2 } from '../../../nls.js';
import { IFileService } from '../../../platform/files/common/files.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { Action2 } from '../../../platform/actions/common/actions.js';
import { AGENT_HOST_SCHEME, fromAgentHostUri } from '../../../platform/agentHost/common/agentHostUri.js';
import { IRemoteAgentHostService } from '../../../platform/agentHost/common/remoteAgentHostService.js';
import { KeyCode, KeyMod } from '../../../base/common/keyCodes.js';
import { ContextKeyExpr } from '../../../platform/contextkey/common/contextkey.js';
import { KeybindingWeight } from '../../../platform/keybinding/common/keybindingsRegistry.js';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry.js';
import { IsAuxiliaryWindowContext } from '../../../workbench/common/contextkeys.js';
import { IsPhoneLayoutContext } from '../../common/contextkeys.js';
import { logSessionsInteraction } from '../../common/sessionsTelemetry.js';
import { Menus } from '../../browser/menus.js';
import { ISessionsService } from '../../services/sessions/browser/sessionsService.js';
import { ISession } from '../../services/sessions/common/session.js';
import { ISessionsProvidersService } from '../../services/sessions/browser/sessionsProvidersService.js';
import { raceTimeout } from '../../../base/common/async.js';
import { CancellationTokenSource } from '../../../base/common/cancellation.js';
import { waitForState } from '../../../base/common/observable.js';
import { IWorkbenchContribution } from '../../../workbench/common/contributions.js';
import { OpenInVSCodeTitleBarWidget } from '../../browser/widget/openInVSCodeWidget.js';
import { IActionViewItemService } from '../../../platform/actions/browser/actionViewItemService.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { getSessionEditorFolderUri, resolveRemoteAuthority } from '../../browser/openInVSCodeUtils.js';
import { INativeHostService } from '../../../platform/native/common/native.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../platform/storage/common/storage.js';
import { BACKBOARD_WORKSPACE_OPEN_ON_STARTUP_STORAGE_KEY } from '../../../workbench/contrib/chat/electron-browser/backboardWorkspace/backboardWorkspaceConstants.js';
import { BACKBOARD_LAST_EDITOR_FOLDER_STORAGE_KEY } from '../../../workbench/contrib/chat/common/constants.js';

const OPEN_WORKSPACE_IN_VSCODE_ACTION_ID = 'agents.openWorkspaceInVSCode';

/**
 * A very small grace period for a first-ever switch whose session workspace is
 * still resolving. Normal round trips use the remembered Editor folder and do
 * not wait at all; this bound keeps the exceptional path effectively instant.
 */
const WORKSPACE_RESOLVE_TIMEOUT = 50;

function toFolderUri(session: ISession, sessionsProvidersService: ISessionsProvidersService, remoteAgentHostService: IRemoteAgentHostService): URI | undefined {
	const rawFolderUri = getSessionEditorFolderUri(session);
	if (!rawFolderUri) {
		return undefined;
	}

	if (rawFolderUri.scheme !== AGENT_HOST_SCHEME) {
		return rawFolderUri;
	}

	const remoteAuthority = resolveRemoteAuthority(session.providerId, sessionsProvidersService, remoteAgentHostService);
	if (!remoteAuthority) {
		return rawFolderUri;
	}

	const agentHostUri = fromAgentHostUri(rawFolderUri);
	return agentHostUri.with({ authority: remoteAuthority, scheme: Schemas.vscodeRemote });
}

/**
 * The folder the editor window was on when the user last left Editor mode, or
 * `undefined` if there is none recorded or it has since been deleted.
 */
async function getRememberedEditorFolder(storageService: IStorageService, fileService: IFileService): Promise<URI | undefined> {
	const stored = storageService.get(BACKBOARD_LAST_EDITOR_FOLDER_STORAGE_KEY, StorageScope.APPLICATION);
	if (!stored) {
		return undefined;
	}

	let folderUri: URI;
	try {
		folderUri = URI.parse(stored, true);
	} catch {
		return undefined;
	}

	// A remembered folder that no longer exists should fall through to the
	// session-based candidates rather than fail the whole switch.
	if (folderUri.scheme === Schemas.file && fileService.hasProvider(folderUri) && !await fileService.exists(folderUri)) {
		return undefined;
	}

	return folderUri;
}

/**
 * The folder Editor mode should open.
 *
 * Falling through to `undefined` opens an *empty* editor window, which reads as
 * the app forgetting where the user was — so this tries hard to find a folder
 * before giving up:
 *
 * 1. The session on screen, when its workspace is already available.
 * 2. The folder the editor window was on when the user last left Editor mode.
 *    In particular, this makes a quick Editor → Simple/Advanced → Editor round
 *    trip immediate even while the sessions workbench is still resolving.
 * 3. If there is no remembered folder, briefly wait for the active session's
 *    workspace rather than treating a first-ever switch as folderless.
 * 4. Failing that, the most recently opened session that has a folder. This is
 *    what covers a first-ever switch into Editor mode, where nothing has been
 *    remembered yet. Recency is persisted, so it still points somewhere
 *    sensible after a restart.
 */
async function getFolderUriToOpen(sessionsService: ISessionsService, sessionsProvidersService: ISessionsProvidersService, remoteAgentHostService: IRemoteAgentHostService, storageService: IStorageService, fileService: IFileService): Promise<URI | undefined> {
	let rememberedFolderPromise: Promise<URI | undefined> | undefined;
	const getRememberedFolder = () => rememberedFolderPromise ??= getRememberedEditorFolder(storageService, fileService);
	const activeSession = sessionsService.activeSession.get();
	if (activeSession) {
		if (!activeSession.workspace.get() && activeSession.loading.get()) {
			const rememberedFolderUri = await getRememberedFolder();
			if (rememberedFolderUri) {
				return rememberedFolderUri;
			}

			// Cancelled either way, so a session that never finishes loading
			// doesn't leave an observer behind on every mode switch.
			const cts = new CancellationTokenSource();
			const settled = waitForState(activeSession.loading, loading => !loading, undefined, cts.token).catch(() => undefined);
			await raceTimeout(settled, WORKSPACE_RESOLVE_TIMEOUT);
			cts.dispose(true);
		}

		const activeFolderUri = toFolderUri(activeSession, sessionsProvidersService, remoteAgentHostService);
		if (activeFolderUri) {
			return activeFolderUri;
		}
	}

	const rememberedFolderUri = await getRememberedFolder();
	if (rememberedFolderUri) {
		return rememberedFolderUri;
	}

	for (const session of sessionsService.getRecentlyOpenedSessions().recent) {
		const folderUri = toFolderUri(session, sessionsProvidersService, remoteAgentHostService);
		if (folderUri) {
			return folderUri;
		}
	}

	return undefined;
}

async function openEditorWindowForActiveSession(accessor: ServicesAccessor, openInNewWindow?: boolean): Promise<void> {
	const sessionsService = accessor.get(ISessionsService);
	const sessionsProvidersService = accessor.get(ISessionsProvidersService);
	const remoteAgentHostService = accessor.get(IRemoteAgentHostService);
	const nativeHostService = accessor.get(INativeHostService);
	const fileService = accessor.get(IFileService);
	const notificationService = accessor.get(INotificationService);
	const storageService = accessor.get(IStorageService);

	const windowOptions = openInNewWindow ? { forceNewWindow: true } : { forceReuseWindow: true };
	const folderUri = await getFolderUriToOpen(sessionsService, sessionsProvidersService, remoteAgentHostService, storageService, fileService);
	if (!folderUri) {
		return nativeHostService.openWindow(windowOptions);
	}
	// The session's folder may have been deleted from disk. Opening it would
	// trigger a confusing "Path does not exist" dialog from the main process, so
	// fall back to an empty editor window and tell the user why.
	if (folderUri.scheme === Schemas.file && fileService.hasProvider(folderUri) && !await fileService.exists(folderUri)) {
		notificationService.error(localize('sessionFolderMissing', "The folder \"{0}\" no longer exists on this computer.", basename(folderUri)));
		return nativeHostService.openWindow(windowOptions);
	}

	// Keep the remembered folder in step with the window we are about to open, so
	// the next switch out of Editor mode has the right value even if that window
	// is closed rather than switched away from.
	storageService.store(BACKBOARD_LAST_EDITOR_FOLDER_STORAGE_KEY, folderUri.toString(), StorageScope.APPLICATION, StorageTarget.MACHINE);

	return nativeHostService.openWindow([{ folderUri }], windowOptions);
}

export class OpenSessionInVSCodeAction extends Action2 {
	static readonly ID = 'agents.openSessionInVSCode';

	constructor() {
		super({
			id: OpenSessionInVSCodeAction.ID,
			title: localize2('openInVSCode', 'Open in Editor'),
			icon: Codicon.window,
			precondition: IsAuxiliaryWindowContext.toNegated(),
			menu: [{
				id: Menus.TitleBarLeftLayout,
				group: 'navigation',
				order: -10,
				when: ContextKeyExpr.and(IsAuxiliaryWindowContext.toNegated(), IsPhoneLayoutContext.negate()),
			}]
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const telemetryService = accessor.get(ITelemetryService);
		logSessionsInteraction(telemetryService, 'openInVSCode');

		return openEditorWindowForActiveSession(accessor);
	}
}

/**
 * Opens the editor window without reusing the current one. Used by the
 * Optimus window's mode switcher: transforming the Optimus window into an
 * editor window is not supported, so Editor mode opens alongside it.
 */
export class OpenSessionInVSCodeNewWindowAction extends Action2 {
	static readonly ID = 'agents.openSessionInVSCodeNewWindow';

	constructor() {
		super({
			id: OpenSessionInVSCodeNewWindowAction.ID,
			title: localize2('openInVSCodeNewWindow', 'Open in Editor (New Window)'),
			f1: false,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		return openEditorWindowForActiveSession(accessor, true);
	}
}

export class OpenWorkspaceInVSCodeAction extends Action2 {
	static readonly ID = OPEN_WORKSPACE_IN_VSCODE_ACTION_ID;

	constructor() {
		super({
			id: OpenWorkspaceInVSCodeAction.ID,
			title: localize2('openWorkspaceInVSCode', 'Open Workspace'),
			icon: Codicon.layout,
			precondition: IsAuxiliaryWindowContext.toNegated(),
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		accessor.get(IStorageService).store(BACKBOARD_WORKSPACE_OPEN_ON_STARTUP_STORAGE_KEY, true, StorageScope.APPLICATION, StorageTarget.MACHINE);
		await openEditorWindowForActiveSession(accessor);
	}
}

export class OpenVSCodeWindowAction extends Action2 {
	static readonly ID = 'agents.openVSCodeWindow';

	constructor() {
		super({
			id: OpenVSCodeWindowAction.ID,
			title: localize2('openVSCodeWindow', 'Open Backboard IDE Window'),
			f1: true,
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyA,
				weight: KeybindingWeight.WorkbenchContrib,
			},
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const nativeHostService = accessor.get(INativeHostService);
		await nativeHostService.openWindow({ forceReuseWindow: true });
	}
}

export class OpenAgentsWindowAction extends Action2 {
	static readonly ID = 'agents.openAgentsWindow';

	constructor() {
		super({
			id: OpenAgentsWindowAction.ID,
			title: localize2('openAgentsWindow', 'Open Simple'),
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const nativeHostService = accessor.get(INativeHostService);
		await nativeHostService.openAgentsWindow();
	}
}

export class OpenOptimusWindowAction extends Action2 {
	static readonly ID = 'agents.openOptimusWindow';

	constructor() {
		super({
			id: OpenOptimusWindowAction.ID,
			title: localize2('openOptimusWindow', 'Open Advanced'),
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const nativeHostService = accessor.get(INativeHostService);
		await nativeHostService.openOptimusWindow();
	}
}

export class OpenInVSCodeWidgetContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.openInVSCode.widget';

	constructor(
		@IActionViewItemService actionViewItemService: IActionViewItemService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this._register(actionViewItemService.register(Menus.TitleBarLeftLayout, OpenSessionInVSCodeAction.ID, (action, options) => {
			return instantiationService.createInstance(OpenInVSCodeTitleBarWidget, action, options, OpenVSCodeWindowAction.ID, OpenAgentsWindowAction.ID, OpenOptimusWindowAction.ID);
		}, undefined));
	}
}
