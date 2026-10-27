/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { credentialFingerprint, postJson, signInSource, studioPlatform, usageTelemetryAllowed } from '../studioTrackingCore';

describe('studio sign-in tracking', () => {
	test('names platforms like the release bucket', () => {
		assert.deepStrictEqual(
			[['darwin', 'arm64'], ['darwin', 'x64'], ['win32', 'x64'], ['linux', 'x64'], ['linux', 'arm64'], ['win32', 'ia32'], ['freebsd', 'x64']].map(([platform, arch]) => studioPlatform(platform, arch)),
			['macos-aarch64', 'macos-x86_64', 'windows-x86_64', 'linux-x86_64', 'linux-aarch64', undefined, undefined],
		);
	});

	test('reports only at the default "all" telemetry level', () => {
		assert.deepStrictEqual([
			usageTelemetryAllowed(undefined, undefined, undefined),
			usageTelemetryAllowed('all', undefined, undefined),
			usageTelemetryAllowed('error', undefined, undefined),
			usageTelemetryAllowed('crash', undefined, undefined),
			usageTelemetryAllowed('off', undefined, undefined),
			usageTelemetryAllowed('all', false, undefined),
			usageTelemetryAllowed('all', undefined, false),
		], [true, true, false, false, false, false, false]);
	});

	test('labels the credential the IDE started with as startup and any later one as a sign-in', () => {
		assert.deepStrictEqual(
			[signInSource('started-with', 'started-with'), signInSource('new', 'started-with'), signInSource('new', undefined)],
			['startup', 'sign_in', 'sign_in'],
		);
	});

	test('fingerprints the backend and credential without exposing it', () => {
		const prod = 'https://app.backboard.io/api';
		const fingerprint = credentialFingerprint(prod, { 'X-API-Key': 'espr_secret' });

		assert.equal(credentialFingerprint(prod, { 'X-API-Key': 'espr_secret' }), fingerprint);
		assert.notEqual(credentialFingerprint(prod, { 'X-API-Key': 'espr_other' }), fingerprint);
		assert.notEqual(credentialFingerprint('http://localhost:8000', { 'X-API-Key': 'espr_secret' }), fingerprint);
		assert.equal(
			credentialFingerprint(prod, { 'A': '1', 'B': '2' }),
			credentialFingerprint(prod, { 'B': '2', 'A': '1' }),
		);
		assert.match(fingerprint, /^[0-9a-f]{64}$/);
		assert.equal(fingerprint.includes('espr_secret'), false);
	});

	describe('postJson', () => {
		const received: { method?: string; contentType?: string; apiKey?: string; body: unknown }[] = [];
		let status = 204;
		let server: http.Server;
		let baseUrl: string;

		before(async () => {
			server = http.createServer((request, response) => {
				const chunks: Buffer[] = [];
				request.on('data', chunk => chunks.push(chunk));
				request.on('end', () => {
					if (request.url === '/slow') {
						return;
					}
					received.push({
						method: request.method,
						contentType: request.headers['content-type'],
						apiKey: request.headers['x-api-key'] as string | undefined,
						body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
					});
					response.writeHead(status).end();
				});
			});
			await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
			baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		});

		after(async () => {
			server.closeAllConnections();
			await new Promise(resolve => server.close(resolve));
		});

		test('sends the body as JSON with the credential headers and returns the status', async () => {
			const statuses: number[] = [];
			for (status of [204, 429, 500]) {
				statuses.push(await postJson(`${baseUrl}/studio/events/first-sign-in`, { 'X-API-Key': 'espr_key' }, { source: 'sign_in' }, 5_000));
			}

			assert.deepStrictEqual(statuses, [204, 429, 500]);
			assert.deepStrictEqual(received[0], { method: 'POST', contentType: 'application/json', apiKey: 'espr_key', body: { source: 'sign_in' } });
		});

		test('rejects when the server does not answer in time', async () => {
			await assert.rejects(postJson(`${baseUrl}/slow`, {}, {}, 100), /timed out after 100 ms/);
		});

		test('rejects when nothing is listening', async () => {
			const closed = http.createServer();
			await new Promise<void>(resolve => closed.listen(0, '127.0.0.1', resolve));
			const { port } = closed.address() as AddressInfo;
			await new Promise(resolve => closed.close(resolve));

			await assert.rejects(postJson(`http://127.0.0.1:${port}/`, {}, {}, 5_000));
		});
	});
});
