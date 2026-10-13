/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../../base/common/uri.js';
import { IAgentHostService } from '../../../../../../platform/agentHost/common/agentService.js';
import type { ResolveSessionConfigResult } from '../../../../../../platform/agentHost/common/state/protocol/commands.js';

const inflight = new Map<string, Promise<ResolveSessionConfigResult>>();

/**
 * Resolves a provider's session-config schema, deduplicating concurrent
 * identical requests. Every composer picker (mode, permissions, generic
 * option chips, …) resolves the same `(provider, workingDirectory)` schema
 * when a new chat mounts; sharing the in-flight promise turns N parallel
 * round-trips into one, so all pickers populate together as fast as the
 * single resolution allows. Only the in-flight promise is shared — results
 * are not cached, so a fresh call always observes current config values.
 */
export function resolveSessionConfigShared(
	agentHostService: IAgentHostService,
	params: { provider: string; workingDirectory: URI | undefined },
): Promise<ResolveSessionConfigResult> {
	const key = `${params.provider}|${params.workingDirectory?.toString() ?? ''}`;
	const existing = inflight.get(key);
	if (existing) {
		return existing;
	}
	const promise = agentHostService.resolveSessionConfig(params).finally(() => {
		inflight.delete(key);
	});
	inflight.set(key, promise);
	return promise;
}
