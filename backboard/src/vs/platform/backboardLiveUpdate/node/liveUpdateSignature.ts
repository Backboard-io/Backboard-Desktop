/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash, createPublicKey, verify } from 'crypto';
import type { ILiveUpdateEnvelope, ILiveUpdateManifest } from '../common/liveUpdate.js';

/** First 16 hex characters of sha256 over a base64 DER public key. */
export function liveUpdateKeyId(publicKey: string): string {
	return createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex').slice(0, 16);
}

/**
 * Returns the manifest when one of `publicKeys` signed the envelope's exact
 * payload bytes, otherwise undefined. Never throws on malformed input: callers
 * treat anything unverifiable as "no live update".
 */
export function verifyLiveUpdateEnvelope(envelope: ILiveUpdateEnvelope | undefined, publicKeys: readonly string[] | undefined): ILiveUpdateManifest | undefined {
	if (!envelope || typeof envelope.payload !== 'string' || !Array.isArray(envelope.signatures) || !publicKeys?.length) {
		return undefined;
	}
	const payload = Buffer.from(envelope.payload, 'base64');
	const trusted = new Map(publicKeys.map(key => [liveUpdateKeyId(key), key]));
	const signed = envelope.signatures.some(entry => {
		const key = typeof entry?.keyId === 'string' ? trusted.get(entry.keyId) : undefined;
		if (!key || typeof entry.signature !== 'string') {
			return false;
		}
		try {
			return verify(null, payload, createPublicKey({ key: Buffer.from(key, 'base64'), format: 'der', type: 'spki' }), Buffer.from(entry.signature, 'base64'));
		} catch {
			return false;
		}
	});
	if (!signed) {
		return undefined;
	}
	try {
		const manifest = JSON.parse(payload.toString('utf8')) as ILiveUpdateManifest;
		return manifest?.schema === 1 && typeof manifest.sequence === 'number' && typeof manifest.components === 'object' ? manifest : undefined;
	} catch {
		return undefined;
	}
}
