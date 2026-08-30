/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { URI } from '../../../../base/common/uri.js';
import { type ClaudePermissionMode, ClaudeSessionConfigKey, narrowClaudeFastMode, narrowClaudePermissionMode } from '../../common/claudeSessionConfigKeys.js';
import type { IAgentConfigurationService } from '../agentConfigurationService.js';

/**
 * Read the live `permissionMode` for a session from
 * {@link IAgentConfigurationService}, narrowed to the SDK's
 * `PermissionMode` union (5/6 values, excluding `dontAsk`; sdk.d.ts:1560).
 * Returns `undefined` when the session's schema hasn't been registered or
 * carries a value that slipped past schema validation — callers pick the
 * fallback (the createSession-time intent at materialize, `'default'` at
 * the canUseTool gate, etc.).
 *
 * Called on every canUseTool entry, on every rebind, and before each
 * `session.send` so a mid-turn `SessionConfigChanged` action wins over
 * the materialize-time seed (plan S3.6).
 */
export function readClaudePermissionMode(
	configurationService: IAgentConfigurationService,
	sessionUri: URI,
): ClaudePermissionMode | undefined {
	return narrowClaudePermissionMode(
		configurationService.getSessionConfigValues(sessionUri.toString())?.[ClaudeSessionConfigKey.PermissionMode],
	);
}

/**
 * Read the live `fastMode` flag for a session, same semantics as
 * {@link readClaudePermissionMode}: `undefined` when the session carries
 * no (valid) value and the caller applies its own fallback. Read at
 * materialize and before each `session.send` so a mid-session toggle
 * reaches the SDK on the next turn.
 */
export function readClaudeFastMode(
	configurationService: IAgentConfigurationService,
	sessionUri: URI,
): boolean | undefined {
	return narrowClaudeFastMode(
		configurationService.getSessionConfigValues(sessionUri.toString())?.[ClaudeSessionConfigKey.FastMode],
	);
}
