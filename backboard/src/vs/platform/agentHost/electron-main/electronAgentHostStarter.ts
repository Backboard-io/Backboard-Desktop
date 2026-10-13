/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { DeferredPromise, raceTimeout } from '../../../base/common/async.js';
import { Emitter } from '../../../base/common/event.js';
import { IpcMainEvent } from 'electron';
import { validatedIpcMain } from '../../../base/parts/ipc/electron-main/ipcMain.js';
import { Client as MessagePortClient } from '../../../base/parts/ipc/electron-main/ipc.mp.js';
import { ProxyChannel } from '../../../base/parts/ipc/common/ipc.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { parseAgentHostDebugPort } from '../../environment/node/environmentService.js';
import { ILifecycleMainService } from '../../lifecycle/electron-main/lifecycleMainService.js';
import { ILogService } from '../../log/common/log.js';
import { Schemas } from '../../../base/common/network.js';
import { getResolvedShellEnv } from '../../shell/node/shellEnv.js';
import { NullTelemetryService } from '../../telemetry/common/telemetryUtils.js';
import { UtilityProcess } from '../../utilityProcess/electron-main/utilityProcess.js';
import { IBrowserViewCdpEndpointMainService } from '../../browserView/electron-main/browserViewCdpEndpointMainService.js';
import { IAgentHostConnection, IAgentHostStarter } from '../common/agent.js';
import { AgentHostClaudeAgentEnabledSettingId, AgentHostCodexAgentBinaryArgsSettingId, AgentHostCodexAgentEnabledSettingId, AgentHostCodexAgentSdkRootSettingId, AgentHostCodexAgentCodexHomeSettingId, AgentHostIpcChannels, AgentHostOTelCaptureContentSettingId, AgentHostOTelDbSpanExporterEnabledSettingId, AgentHostOTelEnabledSettingId, AgentHostOTelExporterTypeSettingId, AgentHostOTelOtlpEndpointSettingId, AgentHostOTelOutfileSettingId, buildAgentHostOTelEnv, buildAgentSdkEnv, IAgentService } from '../common/agentService.js';
import { deepClone } from '../../../base/common/objects.js';
import '../common/agentHost.config.contribution.js';
import '../common/agentHostStarter.config.contribution.js';

export class ElectronAgentHostStarter extends Disposable implements IAgentHostStarter {

	private utilityProcess: UtilityProcess | undefined = undefined;
	private utilityProcessStarted: DeferredPromise<void> | undefined = undefined;
	private agentService: IAgentService | undefined;

	private readonly _onRequestConnection = this._register(new Emitter<void>());
	readonly onRequestConnection = this._onRequestConnection.event;
	private readonly _onWillShutdown = this._register(new Emitter<void>());
	readonly onWillShutdown = this._onWillShutdown.event;

	constructor(
		private readonly _browserViewCdpEndpointService: IBrowserViewCdpEndpointMainService | undefined,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IEnvironmentMainService private readonly _environmentMainService: IEnvironmentMainService,
		@ILifecycleMainService private readonly _lifecycleMainService: ILifecycleMainService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();

		this._register(this._lifecycleMainService.onWillShutdown(event => {
			this._onWillShutdown.fire();
			event.join('agentHost', this._shutdownAgentHost());
		}));

		// Listen for new windows to establish a direct MessagePort connection to the agent host
		const onWindowConnection = (e: IpcMainEvent, nonce: string) => this._onWindowConnection(e, nonce);
		validatedIpcMain.on('vscode:createAgentHostMessageChannel', onWindowConnection);
		this._register(toDisposable(() => {
			validatedIpcMain.removeListener('vscode:createAgentHostMessageChannel', onWindowConnection);
		}));
	}

	async start(): Promise<IAgentHostConnection> {
		this.utilityProcess = new UtilityProcess(this._logService, NullTelemetryService, this._lifecycleMainService);
		this.utilityProcessStarted = new DeferredPromise<void>();

		const inspectParams = parseAgentHostDebugPort(this._environmentMainService.args, this._environmentMainService.isBuilt);
		const execArgv = inspectParams.port ? [
			'--nolazy',
			`--inspect${inspectParams.break ? '-brk' : ''}=${inspectParams.port}`
		] : undefined;

		// Resolve user shell environment so spawned tools/terminals inherit
		// PATH and other vars from the user's login shell (macOS/Linux GUI launches).
		const shellEnv = await this._resolveShellEnv();

		// Forward the Claude/Codex SDK overrides + codex home/args from
		// workbench settings to the agent host process. Parent env wins on
		// collision — see `buildAgentSdkEnv` for the precedence rule.
		const sdkEnv = buildAgentSdkEnv({
			codexSdkRoot: this._configurationService.getValue<string>(AgentHostCodexAgentSdkRootSettingId),
			codexHome: this._configurationService.getValue<string>(AgentHostCodexAgentCodexHomeSettingId),
			codexBinaryArgs: this._configurationService.getValue<readonly string[]>(AgentHostCodexAgentBinaryArgsSettingId),
			claudeAgentEnabled: this._configurationService.getValue<boolean>(AgentHostClaudeAgentEnabledSettingId),
			codexAgentEnabled: this._configurationService.getValue<boolean>(AgentHostCodexAgentEnabledSettingId),
		}, process.env);

		// Translate `chat.agentHost.otel.*` settings into the env vars consumed by
		// the agent host process. Any value already present on `process.env` wins
		// (developer override) — see `buildAgentHostOTelEnv` for the precedence.
		const otelEnv = buildAgentHostOTelEnv({
			enabled: this._configurationService.getValue<boolean>(AgentHostOTelEnabledSettingId),
			exporterType: this._configurationService.getValue<string>(AgentHostOTelExporterTypeSettingId),
			otlpEndpoint: this._configurationService.getValue<string>(AgentHostOTelOtlpEndpointSettingId),
			captureContent: this._configurationService.getValue<boolean>(AgentHostOTelCaptureContentSettingId),
			outfile: this._configurationService.getValue<string>(AgentHostOTelOutfileSettingId),
			dbSpanExporterEnabled: this._configurationService.getValue<boolean>(AgentHostOTelDbSpanExporterEnabledSettingId),
		}, process.env);
		const backboardEnv = this._buildBackboardEnv(process.env);

		// Hand the integrated browser's loopback CDP endpoint down so agent
		// runtimes (cli-ts's `browser` tool) can drive tabs the user shares
		// with the agent instead of launching their own browser. Best-effort:
		// without the endpoint the runtimes simply keep their fallback.
		const browserCdpEnv: Record<string, string> = {};
		const browserCdpEndpoint = await this._browserViewCdpEndpointService?.ensureStarted();
		if (browserCdpEndpoint) {
			browserCdpEnv['BACKBOARD_BROWSER_CDP_WS'] = browserCdpEndpoint;
		}

		const args = [
			'--logsPath', this._environmentMainService.logsHome.with({ scheme: Schemas.file }).fsPath,
			'--user-data-dir', this._environmentMainService.userDataPath,
		];
		if (this._environmentMainService.disableTelemetry) {
			args.push('--disable-telemetry');
		}

		this.utilityProcess.start({
			type: 'agentHost',
			name: 'agent-host',
			entryPoint: 'vs/platform/agentHost/node/agentHostMain',
			execArgv,
			args,
			env: {
				...deepClone(process.env),
				...shellEnv,
				VSCODE_ESM_ENTRYPOINT: 'vs/platform/agentHost/node/agentHostMain',
				VSCODE_PIPE_LOGGING: 'true',
				VSCODE_VERBOSE_LOGGING: 'true',
				...sdkEnv,
				...otelEnv,
				...backboardEnv,
				...browserCdpEnv,
			}
		});

		this.utilityProcessStarted.complete();

		const port = this.utilityProcess.connect();
		const client = new MessagePortClient(port, 'agentHost');
		const agentService = ProxyChannel.toService<IAgentService>(client.getChannel(AgentHostIpcChannels.AgentHost));
		this.agentService = agentService;

		const store = new DisposableStore();
		store.add(client);
		store.add(this.utilityProcess.onStderr(data => {
			if (this._isExpectedStderr(data)) {
				return;
			}
			this._logService.error(`[AgentHost:stderr] ${data}`);
		}));
		store.add(toDisposable(() => {
			if (this.agentService === agentService) {
				this.agentService = undefined;
			}
			this.utilityProcess?.kill();
			this.utilityProcess?.dispose();
			this.utilityProcess = undefined;
			this.utilityProcessStarted = undefined;
		}));

		return {
			client,
			store,
			onDidProcessExit: this.utilityProcess.onExit,
		};
	}

	private async _shutdownAgentHost(): Promise<void> {
		try {
			const shutdown = this.agentService?.shutdown();
			if (shutdown) {
				await raceTimeout(shutdown, 3000, () => {
					this._logService.warn('Timed out waiting for the agent host to shut down; closing it anyway.');
				});
			}
		} catch (error) {
			this._logService.warn(`Agent host did not finish its graceful shutdown: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async _resolveShellEnv(): Promise<typeof process.env> {
		try {
			return await getResolvedShellEnv(this._configurationService, this._logService, this._environmentMainService.args, process.env);
		} catch (error) {
			this._logService.error('AgentHostStarter was unable to resolve shell environment', error);
			return {};
		}
	}

	private _buildBackboardEnv(parentEnv: NodeJS.ProcessEnv): Record<string, string> {
		const env: Record<string, string> = {};
		const configuredEnv = this._configurationService.getValue<string>('backboard.env')?.trim();
		const parentBackboardEnv = parentEnv.BACKBOARD_ENV || parentEnv.VSCODE_BACKBOARD_ENV;
		const resolvedEnv = parentBackboardEnv || configuredEnv;
		if (resolvedEnv) {
			env.VSCODE_BACKBOARD_ENV = resolvedEnv;
		}

		const configuredApiUrl = this._configurationService.getValue<string>('backboard.apiUrl')?.trim();
		const parentApiUrl = parentEnv.BACKBOARD_API_URL || parentEnv.VSCODE_BACKBOARD_API_URL;
		const resolvedApiUrl = parentApiUrl || configuredApiUrl;
		if (resolvedApiUrl) {
			env.VSCODE_BACKBOARD_API_URL = resolvedApiUrl;
		}
		return env;
	}

	private async _onWindowConnection(e: IpcMainEvent, nonce: string): Promise<void> {
		this._onRequestConnection.fire();

		// Wait for utilityProcess.start() to actually run before calling connect(),
		// otherwise the MessagePort posted via connect() is silently dropped.
		await this.utilityProcessStarted?.p;

		if (!this.utilityProcess) {
			this._logService.error('AgentHostStarter: cannot create window connection, agent host process is not running');
			return;
		}

		const port = this.utilityProcess.connect();

		if (e.sender.isDestroyed()) {
			port.close();
			return;
		}

		e.sender.postMessage('vscode:createAgentHostMessageChannelResult', nonce, [port]);
	}

	private static readonly _expectedStderrPatterns = [
		'Most NODE_OPTIONs are not supported in packaged apps',
		'Debugger listening on ws://',
		'For help, see: https://nodejs.org/en/docs/inspector',
		'ExperimentalWarning: SQLite is an experimental feature',
	];

	private _isExpectedStderr(data: string): boolean {
		return ElectronAgentHostStarter._expectedStderrPatterns.some(pattern => data.includes(pattern));
	}
}
