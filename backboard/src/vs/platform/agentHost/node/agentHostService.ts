/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { ProxyChannel } from '../../../base/parts/ipc/common/ipc.js';
import { ILogService, ILoggerService } from '../../log/common/log.js';
import { RemoteLoggerChannelClient } from '../../log/common/logIpc.js';
import { IAgentHostStarter } from '../common/agent.js';
import { AgentHostIpcChannels, IAgentService } from '../common/agentService.js';

enum Constants {
	MaxRestarts = 5,
}

/**
 * What the main process itself may do with a running agent host, beyond
 * relaying window connections: know when a (re)started host is ready, and
 * call it. Renderers keep their own direct connections.
 */
export interface IAgentHostProcessAccess {
	/** Fires after each (re)start once the process accepts requests. A restarted host holds no keys or sessions. */
	readonly onDidStart: Event<void>;
	/** The main process's own proxy to the running host, or undefined between runs. */
	readonly agentService: IAgentService | undefined;
}

/**
 * Main-process service that manages the agent host utility process lifecycle
 * (lazy start, crash recovery, logger forwarding). The renderer communicates
 * with the utility process directly via MessagePort - this class does not
 * relay any agent service calls on their behalf.
 */
export class AgentHostProcessManager extends Disposable implements IAgentHostProcessAccess {

	private _started = false;
	private _wasQuitRequested = false;
	private _restartCount = 0;
	private _agentService: IAgentService | undefined;

	private readonly _onDidStart = this._register(new Emitter<void>());
	readonly onDidStart = this._onDidStart.event;

	get agentService(): IAgentService | undefined {
		return this._agentService;
	}

	constructor(
		private readonly _starter: IAgentHostStarter,
		@ILogService private readonly _logService: ILogService,
		@ILoggerService private readonly _loggerService: ILoggerService,
	) {
		super();

		this._register(this._starter);

		// Start lazily when the first window asks for a connection
		if (this._starter.onRequestConnection) {
			this._register(Event.once(this._starter.onRequestConnection)(() => this._ensureStarted()));
		}

		if (this._starter.onWillShutdown) {
			this._register(this._starter.onWillShutdown(() => this._wasQuitRequested = true));
		}
	}

	/**
	 * Starts the agent host before the first renderer requests it so utility
	 * process startup overlaps the initial window load instead of the first
	 * switch into Simple or Advanced mode. Idempotent; the lazy request path
	 * remains as a fallback.
	 */
	ensureStarted(): void {
		this._ensureStarted();
	}

	private _ensureStarted(): void {
		if (!this._started) {
			this._start();
		}
	}

	private async _start(): Promise<void> {
		this._started = true;
		try {
			const connection = await this._starter.start();

			if (this._store.isDisposed) {
				connection.store.dispose();
				return;
			}

			this._logService.info('AgentHostProcessManager: agent host started');

			// Connect logger channel so agent host logs appear in the output channel
			this._register(new RemoteLoggerChannelClient(this._loggerService, connection.client.getChannel(AgentHostIpcChannels.Logger)));

			const agentService = ProxyChannel.toService<IAgentService>(connection.client.getChannel(AgentHostIpcChannels.AgentHost));
			this._agentService = agentService;
			connection.store.add(toDisposable(() => {
				if (this._agentService === agentService) {
					this._agentService = undefined;
				}
			}));
			this._onDidStart.fire();

			// Handle unexpected exit
			this._register(connection.onDidProcessExit(e => {
				if (!this._wasQuitRequested && !this._store.isDisposed) {
					if (this._restartCount <= Constants.MaxRestarts) {
						this._logService.error(`AgentHostProcessManager: agent host terminated unexpectedly with code ${e.code}`);
						this._restartCount++;
						this._started = false;
						connection.store.dispose();
						this._start();
					} else {
						this._logService.error(`AgentHostProcessManager: agent host terminated with code ${e.code}, giving up after ${Constants.MaxRestarts} restarts`);
					}
				}
			}));

			this._register(toDisposable(() => connection.store.dispose()));
		} catch (error) {
			this._started = false;
			this._logService.error('AgentHostProcessManager: failed to start agent host', error);
		}
	}
}
