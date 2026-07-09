/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { URI } from '../../../../base/common/uri.js';
import { SessionConfigKey, narrowSessionBillingMode, type SessionBillingMode } from '../../common/sessionConfigKeys.js';
import type { IAgentConfigurationService } from '../agentConfigurationService.js';

/**
 * Resolve the billing mode for a session: who pays for model usage.
 *
 * Precedence: the live per-session config value (a `SessionConfigChanged`
 * that arrived after create), then the create-time provisional config bag,
 * then the caller-supplied fallback (typically a persisted overlay value on
 * resume), then `'backboard'`.
 *
 * Shared by the Claude and Codex agents — both advertise the same
 * {@link SessionConfigKey.Billing} schema property.
 */
export function resolveSessionBillingMode(
	configurationService: IAgentConfigurationService,
	sessionUri: URI,
	provisionalConfig: Record<string, unknown> | undefined,
	fallback?: SessionBillingMode,
): SessionBillingMode {
	return narrowSessionBillingMode(configurationService.getSessionConfigValues(sessionUri.toString())?.[SessionConfigKey.Billing])
		?? narrowSessionBillingMode(provisionalConfig?.[SessionConfigKey.Billing])
		?? fallback
		?? 'backboard';
}
