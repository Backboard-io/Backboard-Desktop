/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Schemas } from '../../../base/common/network.js';
import { URI } from '../../../base/common/uri.js';
import { ServicesAccessor } from '../../../editor/browser/editorExtensions.js';
import { localize2 } from '../../../nls.js';
import { Action2 } from '../../../platform/actions/common/actions.js';
import { AGENT_HOST_SCHEME, fromAgentHostUri } from '../../../platform/agentHost/common/agentHostUri.js';
import { IRemoteAgentHostService } from '../../../platform/agentHost/common/remoteAgentHostService.js';
import { ContextKeyExpr } from '../../../platform/contextkey/common/contextkey.js';
import { IOpenerService } from '../../../platform/opener/common/opener.js';
import { IProductService } from '../../../platform/product/common/productService.js';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry.js';
import { IsAuxiliaryWindowContext } from '../../../workbench/common/contextkeys.js';
import { SessionsWelcomeVisibleContext } from '../../common/contextkeys.js';
import { logSessionsInteraction } from '../../common/sessionsTelemetry.js';
import { ISessionsManagementService } from '../../services/sessions/common/sessionsManagement.js';
import { ISessionsProvidersService } from '../../services/sessions/browser/sessionsProvidersService.js';
import { resolveRemoteAuthority } from '../openInVSCodeUtils.js';

export class OpenInVSCodeAction extends Action2 {
	static readonly ID = 'sessions.openInVSCode';

	constructor() {
		super({
			id: OpenInVSCodeAction.ID,
			title: localize2('openInVSCode', 'Open in Editor'),
			precondition: ContextKeyExpr.and(IsAuxiliaryWindowContext.toNegated(), SessionsWelcomeVisibleContext.toNegated()),
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const telemetryService = accessor.get(ITelemetryService);
		logSessionsInteraction(telemetryService, 'openInVSCode');

		const openerService = accessor.get(IOpenerService);
		const productService = accessor.get(IProductService);
		const sessionsManagementService = accessor.get(ISessionsManagementService);
		const sessionsProvidersService = accessor.get(ISessionsProvidersService);
		const remoteAgentHostService = accessor.get(IRemoteAgentHostService);

		const scheme = productService.quality === 'stable'
			? 'vscode'
			: productService.quality === 'exploration'
				? 'vscode-exploration'
				: productService.quality === 'insider'
					? 'vscode-insiders'
					: productService.urlProtocol;

		const params = new URLSearchParams();

		const activeSession = sessionsManagementService.activeSession.get();
		if (!activeSession) {
			await openerService.open(URI.from({ scheme, query: params.toString() }), { openExternal: true });
			return;
		}

		const workspace = activeSession.workspace.get();
		const folder = workspace?.folders[0];
		const rawFolderUri = workspace?.isVirtualWorkspace ? undefined : folder?.workingDirectory;

		if (!rawFolderUri) {
			await openerService.open(URI.from({ scheme, query: params.toString() }), { openExternal: true });
			return;
		}

		const folderUri = rawFolderUri.scheme === AGENT_HOST_SCHEME ? fromAgentHostUri(rawFolderUri) : rawFolderUri;
		const remoteAuthority = resolveRemoteAuthority(
			activeSession.providerId, sessionsProvidersService, remoteAgentHostService);

		params.set('session', activeSession.resource.toString());

		if (remoteAuthority) {
			await openerService.open(URI.from({
				scheme,
				authority: Schemas.vscodeRemote,
				path: `/${remoteAuthority}${folderUri.path}`,
				query: params.toString(),
			}), { openExternal: true });
		} else {
			await openerService.open(URI.from({
				scheme,
				authority: Schemas.file,
				path: folderUri.path,
				query: params.toString(),
			}), { openExternal: true });
		}
	}
}
