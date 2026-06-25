/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../base/common/codicons.js';
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
import { IsPhoneLayoutContext } from '../../common/contextkeys.js';
import { logSessionsInteraction } from '../../common/sessionsTelemetry.js';
import { Menus } from '../../browser/menus.js';
import { ISessionsService } from '../../services/sessions/browser/sessionsService.js';
import { ISessionsProvidersService } from '../../services/sessions/browser/sessionsProvidersService.js';
import { IWorkbenchContribution } from '../../../workbench/common/contributions.js';
import { OpenInVSCodeTitleBarWidget } from '../../browser/widget/openInVSCodeWidget.js';
import { IActionViewItemService } from '../../../platform/actions/browser/actionViewItemService.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { resolveRemoteAuthority } from '../../browser/openInVSCodeUtils.js';
import { INativeHostService } from '../../../platform/native/common/native.js';

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

		const sessionsService = accessor.get(ISessionsService);
		const sessionsProvidersService = accessor.get(ISessionsProvidersService);
		const remoteAgentHostService = accessor.get(IRemoteAgentHostService);
		const nativeHostService = accessor.get(INativeHostService);

		const folderUri = this.getFolderUriToOpen(sessionsService, sessionsProvidersService, remoteAgentHostService);
		if (!folderUri) {
			return nativeHostService.openWindow({ forceReuseWindow: true });
		}
		return nativeHostService.openWindow([{ folderUri }], { forceReuseWindow: true });
	}

	private getFolderUriToOpen(sessionsService: ISessionsService, sessionsProvidersService: ISessionsProvidersService, remoteAgentHostService: IRemoteAgentHostService): URI | undefined {
		const activeSession = sessionsService.activeSession.get();
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

export class OpenJarvisWindowAction extends Action2 {
	static readonly ID = 'agents.openJarvisWindow';

	constructor() {
		super({
			id: OpenJarvisWindowAction.ID,
			title: localize2('openJarvisWindow', 'Open Jarvis'),
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const nativeHostService = accessor.get(INativeHostService);
		await nativeHostService.openJarvisWindow();
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
			return instantiationService.createInstance(OpenInVSCodeTitleBarWidget, action, options, OpenVSCodeWindowAction.ID);
		}, undefined));
	}
}
