/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { ILogService } from '../../log/common/log.js';
import { IBrowserViewOwner } from '../common/browserView.js';
import { IBrowserViewGroupService } from '../common/browserViewGroup.js';
import { CDPRequest } from '../common/cdp/types.js';
import type * as wsTypes from 'ws';
import type * as httpTypes from 'http';

export const IBrowserViewCdpEndpointMainService = createDecorator<IBrowserViewCdpEndpointMainService>('browserViewCdpEndpointMainService');

/**
 * Exposes the integrated browser's agent-shared tabs as a loopback,
 * token-authenticated CDP WebSocket endpoint so external agent runtimes
 * (the cli-ts `browser` tool) can drive the exact tab the user shared
 * instead of launching their own browser.
 *
 * Every WebSocket connection gets its own {@link IBrowserViewGroupMainService}
 * group (and therefore its own CDP browser session state); group membership
 * mirrors the set of views the workbench reports as shared with the agent.
 */
export interface IBrowserViewCdpEndpointMainService {
	readonly _serviceBrand: undefined;

	/**
	 * Start the endpoint server if it is not running yet.
	 * @returns The `ws://127.0.0.1:<port>/cdp/<token>` URL, or `undefined`
	 * when the server could not be started (never throws).
	 */
	ensureStarted(): Promise<string | undefined>;

	/**
	 * Mark a browser view as shared/unshared with the agent. Shared views are
	 * visible as page targets on every endpoint connection. The owner is only
	 * required when sharing; unsharing works after the view is gone.
	 */
	setViewShared(viewId: string, shared: boolean, owner?: IBrowserViewOwner): void;
}

interface ISharedViewEntry {
	readonly owner: IBrowserViewOwner;
}

export class BrowserViewCdpEndpointMainService extends Disposable implements IBrowserViewCdpEndpointMainService {
	declare readonly _serviceBrand: undefined;

	private readonly _sharedViews = new Map<string, ISharedViewEntry>();
	private readonly _connections = new Set<{ addView(viewId: string): void; removeView(viewId: string): void }>();

	private _starting: Promise<string | undefined> | undefined;
	private _server: httpTypes.Server | undefined;
	private _wss: wsTypes.WebSocketServer | undefined;
	private _groupService: IBrowserViewGroupService | undefined;

	constructor(
		private readonly _logService: ILogService,
	) {
		super();
		this._register(toDisposable(() => {
			this._wss?.close();
			this._server?.close();
		}));
	}

	/**
	 * Late-bound: the group service singleton only exists once the main
	 * instantiation service is up, while this service must start (and hand
	 * its URL to the agent host spawn env) during service construction.
	 * Connections arriving before the group service is accepted fail
	 * gracefully and the agent runtime falls back to its own browser.
	 */
	acceptGroupService(groupService: IBrowserViewGroupService): void {
		this._groupService = groupService;
	}

	ensureStarted(): Promise<string | undefined> {
		this._starting ??= this._start().catch(error => {
			this._logService.warn('[BrowserViewCdpEndpoint] Failed to start endpoint server.', error);
			return undefined;
		});
		return this._starting;
	}

	setViewShared(viewId: string, shared: boolean, owner?: IBrowserViewOwner): void {
		if (shared && owner) {
			this._sharedViews.set(viewId, { owner });
			for (const connection of this._connections) {
				connection.addView(viewId);
			}
		} else if (!shared && this._sharedViews.delete(viewId)) {
			for (const connection of this._connections) {
				connection.removeView(viewId);
			}
		}
	}

	private async _start(): Promise<string> {
		const [{ WebSocketServer }, http] = await Promise.all([
			import('ws'),
			import('http'),
		]);

		const token = generateUuid().replace(/-/g, '');
		const path = `/cdp/${token}`;

		const server = http.createServer((_request, response) => {
			// Plain HTTP requests carry no CDP traffic; the endpoint is WS-only.
			response.statusCode = 404;
			response.end();
		});
		this._server = server;

		// `path` makes the ws server destroy upgrade requests that don't carry
		// the token, so the port alone grants no access.
		const wss = new WebSocketServer({ server, path });
		this._wss = wss;
		wss.on('connection', socket => this._handleConnection(socket));

		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(0, '127.0.0.1', () => {
				server.removeListener('error', reject);
				resolve();
			});
		});

		const address = server.address();
		if (!address || typeof address === 'string') {
			throw new Error('CDP endpoint server did not report a TCP address');
		}
		const url = `ws://127.0.0.1:${address.port}${path}`;
		this._logService.info(`[BrowserViewCdpEndpoint] Listening for agent CDP connections.`);
		return url;
	}

	private _handleConnection(socket: wsTypes.WebSocket): void {
		const groupService = this._groupService;
		if (!groupService) {
			// Too early: the workbench services have not come up yet. The agent
			// runtime treats the failed probe as "no shared page" and falls back.
			socket.close();
			return;
		}

		const store = new DisposableStore();
		let closed = false;
		const close = (): void => {
			if (closed) {
				return;
			}
			closed = true;
			this._connections.delete(connection);
			store.dispose();
			if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) {
				socket.close();
			}
		};

		// Each connection gets an isolated group so per-connection CDP session
		// state (attachments, discovery) cannot leak across agent runtimes. The
		// owner only matters for window queries and target creation; with no
		// shared view yet there is nothing to own, so a placeholder is fine.
		const owner: IBrowserViewOwner = [...this._sharedViews.values()][0]?.owner ?? { mainWindowId: -1 };
		const groupIdPromise = groupService.createGroup(owner).then(groupId => {
			if (closed) {
				void groupService.destroyGroup(groupId);
				return undefined;
			}
			store.add(toDisposable(() => {
				void groupService.destroyGroup(groupId).catch(() => { });
			}));
			store.add(groupService.onDynamicCDPMessage(groupId)(message => {
				if (socket.readyState === socket.OPEN) {
					socket.send(JSON.stringify(message));
				}
			}));
			for (const viewId of this._sharedViews.keys()) {
				void groupService.addViewToGroup(groupId, viewId).catch(error => {
					this._logService.warn(`[BrowserViewCdpEndpoint] Could not expose shared view over CDP.`, error);
				});
			}
			return groupId;
		}, error => {
			this._logService.warn('[BrowserViewCdpEndpoint] Failed to create CDP group for connection.', error);
			close();
			return undefined;
		});

		const connection = {
			addView: (viewId: string): void => {
				void groupIdPromise.then(groupId => {
					if (groupId !== undefined && !closed) {
						void groupService.addViewToGroup(groupId, viewId).catch(() => { });
					}
				});
			},
			removeView: (viewId: string): void => {
				void groupIdPromise.then(groupId => {
					if (groupId !== undefined && !closed) {
						void groupService.removeViewFromGroup(groupId, viewId).catch(() => { });
					}
				});
			},
		};
		this._connections.add(connection);

		socket.on('message', data => {
			let message: CDPRequest;
			try {
				message = JSON.parse(data.toString()) as CDPRequest;
			} catch {
				return;
			}
			void groupIdPromise.then(groupId => {
				if (groupId !== undefined && !closed) {
					void groupService.sendCDPMessage(groupId, message).catch(error => {
						this._logService.debug('[BrowserViewCdpEndpoint] CDP message failed.', error);
					});
				}
			});
		});
		socket.on('close', close);
		socket.on('error', close);
	}
}
