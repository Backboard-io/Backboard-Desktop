/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../base/common/buffer.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { URI } from '../../../base/common/uri.js';
import { ISharedWebContentExtractorService } from '../common/webContentExtractor.js';

const TEXT_FETCH_TIMEOUT_MS = 30_000;
const TEXT_FETCH_MAX_BYTES = 16 * 1024 * 1024;
const PRIVATE_HOST_PATTERNS = [
	/^localhost$/i,
	/^127\./,
	/^10\./,
	/^192\.168\./,
	/^169\.254\./,
	/^172\.(1[6-9]|2\d|3[0-1])\./,
	/^0\./,
	/^\[?::1\]?$/i,
	/^\[?fc[0-9a-f]{2}:/i,
	/^\[?fd[0-9a-f]{2}:/i,
	/^\[?fe80:/i,
];

export class SharedWebContentExtractorService implements ISharedWebContentExtractorService {
	_serviceBrand: undefined;

	async readText(uri: URI, token: CancellationToken): Promise<string | undefined> {
		// The CancellationToken may have been marshalled across IPC, in which case
		// `onCancellationRequested` is no longer a function (ProxyChannel does not
		// support CancellationToken — see ipc.ts). Guard against this so we don't
		// throw "token.onCancellationRequested is not a function" and fail the fetch.
		const isCancellationRequested = token?.isCancellationRequested === true;
		if (isCancellationRequested) {
			return undefined;
		}
		if (!this.isSafeRemoteTextUri(uri)) {
			return undefined;
		}

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), TEXT_FETCH_TIMEOUT_MS);
		const cancellation = typeof token?.onCancellationRequested === 'function'
			? token.onCancellationRequested(() => controller.abort())
			: { dispose(): void { /* no-op — token was marshalled across IPC */ } };
		try {
			const headers: Record<string, string> = {
				'Accept': 'text/html,application/xhtml+xml,application/xml,application/json;q=0.9,*/*;q=0.8',
				'User-Agent': 'Mozilla/5.0'
			};
			const skillsShApiToken = this.getSkillsShApiToken(uri);
			if (skillsShApiToken) {
				headers.Authorization = `Bearer ${skillsShApiToken}`;
				headers['x-vercel-oidc-token'] = skillsShApiToken;
			}
			const response = await fetch(uri.toString(true), {
				headers,
				redirect: 'follow',
				signal: controller.signal,
			});
			if (!response.ok) {
				return undefined;
			}
			// Validate the final URL after redirects is still a safe remote URI.
			const finalUri = URI.parse(response.url);
			if (!this.isSafeRemoteTextUri(finalUri)) {
				return undefined;
			}
			const contentType = response.headers.get('content-type')?.toLowerCase();
			if (contentType && !contentType.startsWith('text/') && !contentType.includes('html') && !contentType.includes('xml') && !contentType.includes('json')) {
				return undefined;
			}
			const contentLength = Number(response.headers.get('content-length'));
			if (Number.isFinite(contentLength) && contentLength > TEXT_FETCH_MAX_BYTES) {
				return undefined;
			}
			return await this.readResponseText(response, TEXT_FETCH_MAX_BYTES);
		} catch (err) {
			console.error(err);
			return undefined;
		} finally {
			clearTimeout(timeout);
			cancellation.dispose();
		}
	}

	async readImage(uri: URI, token: CancellationToken): Promise<VSBuffer | undefined> {
		if (token.isCancellationRequested) {
			return undefined;
		}

		try {
			const response = await fetch(uri.toString(true), {
				headers: {
					'Accept': 'image/*',
					'User-Agent': 'Mozilla/5.0'
				}
			});
			const contentType = response.headers.get('content-type');
			if (!response.ok || !contentType?.startsWith('image/') || !/(webp|jpg|jpeg|gif|png|bmp)$/i.test(contentType)) {
				return undefined;
			}

			const content = VSBuffer.wrap(await (response as unknown as { bytes: () => Promise<Uint8Array<ArrayBuffer>> } /* workaround https://github.com/microsoft/TypeScript/issues/61826 */).bytes());
			return content;
		} catch (err) {
			console.error(err);
			return undefined;
		}
	}

	private getSkillsShApiToken(uri: URI): string | undefined {
		if (uri.scheme !== 'https' || uri.authority !== 'skills.sh' || !uri.path.startsWith('/api/v1/')) {
			return undefined;
		}
		const token = process.env.VERCEL_OIDC_TOKEN ?? process.env.SKILLS_SH_OIDC_TOKEN;
		return token?.trim() || undefined;
	}

	private isSafeRemoteTextUri(uri: URI): boolean {
		if (uri.scheme !== 'https') {
			return false;
		}
		let host: string;
		try {
			host = new URL(uri.toString(true)).hostname.toLowerCase();
		} catch {
			return false;
		}
		if (!host || PRIVATE_HOST_PATTERNS.some(pattern => pattern.test(host))) {
			return false;
		}
		return true;
	}

	private async readResponseText(response: Response, maxBytes: number): Promise<string | undefined> {
		const body = response.body;
		if (!body) {
			return undefined;
		}
		const reader = body.getReader();
		const chunks: Uint8Array[] = [];
		let total = 0;
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				total += value.byteLength;
				if (total > maxBytes) {
					await reader.cancel();
					return undefined;
				}
				chunks.push(value);
			}
		} finally {
			reader.releaseLock();
		}
		const bytes = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return new TextDecoder().decode(bytes);
	}
}
