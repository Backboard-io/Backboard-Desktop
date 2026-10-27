/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';
import * as fs from 'fs';
import { isAbsolute, join, relative } from '../../../base/common/path.js';
import { ILiveAgentPointer, ILiveUpdateBuildInfo, ILiveUpdateProductConfiguration, LIVE_AGENT_PROTOCOL_VERSION, LIVE_UPDATE_ID_PATTERN, LIVE_UPDATES_DIR_ENV, liveComponentBuildMismatch, liveUpdateBuildId } from '../common/liveUpdate.js';
import { readLiveUpdateJson } from './liveUpdateBoot.js';
import { verifyLiveUpdateEnvelope } from './liveUpdateSignature.js';

export interface ILiveAgentProduct {
	readonly backboardVersion?: string;
	readonly backboardBuildInfo?: ILiveUpdateBuildInfo;
	readonly backboardLiveUpdate?: ILiveUpdateProductConfiguration;
}

export interface ILiveAgentSelection {
	readonly id: string;
	/** Absolute path of the bundle's entry file. */
	readonly entry: string;
}

let entryHashCache: { readonly key: string; readonly sha256: string } | undefined;

function sha256OfFile(path: string): string | undefined {
	try {
		const stat = fs.statSync(path);
		const key = `${path}:${stat.size}:${stat.mtimeMs}`;
		if (entryHashCache?.key !== key) {
			entryHashCache = { key, sha256: createHash('sha256').update(fs.readFileSync(path)).digest('hex') };
		}
		return entryHashCache.sha256;
	} catch {
		return undefined;
	}
}

/**
 * The staged cli-ts bundle to run instead of the JavaScript compiled into the
 * app's cli-ts executable, or undefined to run the executable as shipped.
 * Cheap enough to call on every spawn: the entry hash is cached by size and
 * mtime, so only a newly staged bundle is hashed.
 */
export function resolveLiveAgent(product: ILiveAgentProduct, liveUpdatesDir = process.env[LIVE_UPDATES_DIR_ENV]): ILiveAgentSelection | undefined {
	const publicKeys = product.backboardLiveUpdate?.publicKeys;
	if (!liveUpdatesDir || !publicKeys?.length || !product.backboardVersion) {
		return undefined;
	}
	const agentDir = join(liveUpdatesDir, 'agent');
	const pointer = readLiveUpdateJson<ILiveAgentPointer>(join(agentDir, 'current.json'));
	if (!pointer || typeof pointer.id !== 'string' || !LIVE_UPDATE_ID_PATTERN.test(pointer.id) || typeof pointer.entry !== 'string') {
		return undefined;
	}
	const component = verifyLiveUpdateEnvelope(pointer.manifest, publicKeys)?.components.agent;
	if (component?.id !== pointer.id
		|| component.protocolVersion !== LIVE_AGENT_PROTOCOL_VERSION
		|| !component.bases.includes(product.backboardVersion)
		|| liveComponentBuildMismatch(component.builds, liveUpdateBuildId(product.backboardBuildInfo))) {
		return undefined;
	}
	const bundleDir = join(agentDir, pointer.id);
	const entry = join(bundleDir, component.entry);
	const inside = relative(bundleDir, entry);
	if (!inside || inside.startsWith('..') || isAbsolute(inside) || entry !== pointer.entry) {
		return undefined;
	}
	if (sha256OfFile(entry) !== component.entrySha256) {
		return undefined;
	}
	return { id: pointer.id, entry };
}
