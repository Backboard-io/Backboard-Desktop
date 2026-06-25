/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../base/common/buffer.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { URI } from '../../../base/common/uri.js';
import { ISharedWebContentExtractorService } from '../common/webContentExtractor.js';

export class SharedWebContentExtractorService implements ISharedWebContentExtractorService {
	_serviceBrand: undefined;

	async readText(uri: URI, token: CancellationToken): Promise<string | undefined> {
		if (token.isCancellationRequested) {
			return undefined;
		}

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
				headers
			});
			if (!response.ok) {
				return undefined;
			}
			const contentType = response.headers.get('content-type')?.toLowerCase();
			if (contentType && !contentType.startsWith('text/') && !contentType.includes('html') && !contentType.includes('xml') && !contentType.includes('json')) {
				return undefined;
			}
			return await response.text();
		} catch (err) {
			console.error(err);
			return undefined;
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
}
