/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getWindowId } from '../../../base/browser/dom.js';
import { mainWindow } from '../../../base/browser/window.js';
import { Schemas } from '../../../base/common/network.js';
import { URI } from '../../../base/common/uri.js';
import { ServicesAccessor } from '../../../editor/browser/editorExtensions.js';
import { localize2 } from '../../../nls.js';
import { Action2 } from '../../../platform/actions/common/actions.js';
import { AGENT_HOST_SCHEME, fromAgentHostUri } from '../../../platform/agentHost/common/agentHostUri.js';
import { IRemoteAgentHostService } from '../../../platform/agentHost/common/remoteAgentHostService.js';
import { KeyCode, KeyMod } from '../../../base/common/keyCodes.js';
import { ContextKeyExpr } from '../../../platform/contextkey/common/contextkey.js';
import { KeybindingWeight } from '../../../platform/keybinding/common/keybindingsRegistry.js';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry.js';
import { IsAuxiliaryWindowContext } from '../../../workbench/common/contextkeys.js';
import { SessionsWelcomeVisibleContext } from '../../common/contextkeys.js';
import { logSessionsInteraction } from '../../common/sessionsTelemetry.js';
import { ISessionsManagementService } from '../../services/sessions/common/sessionsManagement.js';
import { ISessionsProvidersService } from '../../services/sessions/browser/sessionsProvidersService.js';
import { resolveRemoteAuthority } from '../../browser/openInVSCodeUtils.js';
import { INativeHostService } from '../../../platform/native/common/native.js';

export class OpenSessionInVSCodeAction extends Action2 {
	static readonly ID = 'agents.openSessionInVSCode';

	constructor() {
		super({
			id: OpenSessionInVSCodeAction.ID,
			title: localize2('openInVSCode', 'Open in Editor'),
			precondition: ContextKeyExpr.and(IsAuxiliaryWindowContext.toNegated(), SessionsWelcomeVisibleContext.toNegated()),
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const telemetryService = accessor.get(ITelemetryService);
		logSessionsInteraction(telemetryService, 'openInVSCode');

		const sessionsManagementService = accessor.get(ISessionsManagementService);
		const sessionsProvidersService = accessor.get(ISessionsProvidersService);
		const remoteAgentHostService = accessor.get(IRemoteAgentHostService);
		const nativeHostService = accessor.get(INativeHostService);

		const folderUri = this.getFolderUriToOpen(sessionsManagementService, sessionsProvidersService, remoteAgentHostService);
		if (!folderUri) {
			return nativeHostService.openWindow({ forceReuseWindow: true });
		}
		return nativeHostService.openWindow([{ folderUri }], { forceReuseWindow: true });
	}

	private getFolderUriToOpen(sessionsManagementService: ISessionsManagementService, sessionsProvidersService: ISessionsProvidersService, remoteAgentHostService: IRemoteAgentHostService): URI | undefined {
		const activeSession = sessionsManagementService.activeSession.get();
		if (!activeSession) {
			return undefined;
		}

		const workspace = activeSession.workspace.get();
		const rawFolderUri = workspace?.folders[0]?.workingDirectory;
		if (!rawFolderUri) {
			return undefined;
		}

		if (rawFolderUri.scheme !== AGENT_HOST_SCHEME) {
			return rawFolderUri;
		}

		const remoteAuthority = resolveRemoteAuthority(activeSession.providerId, sessionsProvidersService, remoteAgentHostService);
		if (!remoteAuthority) {
			return rawFolderUri;
		}

		const agentHostUri = fromAgentHostUri(rawFolderUri);
		return agentHostUri.with({ authority: remoteAuthority, scheme: Schemas.vscodeRemote });
	}
}

export class OpenVSCodeWindowAction extends Action2 {
	static readonly ID = 'agents.openVSCodeWindow';

	constructor() {
		super({
			id: OpenVSCodeWindowAction.ID,
			title: localize2('openVSCodeWindow', 'Open VS Code Window'),
			f1: true,
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyA,
				weight: KeybindingWeight.WorkbenchContrib,
			},
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const nativeHostService = accessor.get(INativeHostService);

		const windows = await nativeHostService.getWindows({ includeAuxiliaryWindows: false });
		const currentWindowId = getWindowId(mainWindow);
		const vscodeWindow = windows.find(w => w.id !== currentWindowId);

		if (vscodeWindow) {
			await nativeHostService.focusWindow({ targetWindowId: vscodeWindow.id });
		} else {
			await nativeHostService.openWindow();
		}
	}
}
