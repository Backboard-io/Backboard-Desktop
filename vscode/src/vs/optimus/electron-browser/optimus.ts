/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable no-restricted-globals */

(async function () {
	performance.mark('code/didStartRenderer');

	type INativeWindowConfiguration = import('../../platform/window/common/window.js').INativeWindowConfiguration;
	type IMainWindowSandboxGlobals = import('../../base/parts/sandbox/electron-browser/globals.js').IMainWindowSandboxGlobals;

	const preloadGlobals = (window as unknown as { vscode: IMainWindowSandboxGlobals }).vscode;
	const safeProcess = preloadGlobals.process;
	const isDev = !!safeProcess.env['VSCODE_DEV'];

	try {
		const configuration = await preloadGlobals.context.resolveConfiguration() as INativeWindowConfiguration;
		globalThis._VSCODE_NLS_MESSAGES = configuration.nls.messages;
		globalThis._VSCODE_NLS_LANGUAGE = configuration.nls.language;

		if (isDev) {
			registerDeveloperKeybindings();
		}

		const baseUrl = new URL(`${fileUriFromPath(configuration.appRoot, { isWindows: safeProcess.platform === 'win32', scheme: 'vscode-file', fallbackAuthority: 'vscode-app' })}/out/`);
		globalThis._VSCODE_FILE_ROOT = baseUrl.toString();

		let optimusUrl: string;
		if (isDev && globalThis._VSCODE_USE_RELATIVE_IMPORTS) {
			optimusUrl = '../optimus.desktop.main.js';
		} else {
			optimusUrl = new URL('vs/optimus/optimus.desktop.main.js', baseUrl).href;
		}

		await import(optimusUrl);

		if (isDev) {
			installHotRefresh();
		}
	} catch (error) {
		onUnexpectedError(error);
		throw error;
	}

	function registerDeveloperKeybindings(): void {
		const ipcRenderer = preloadGlobals.ipcRenderer;
		const toggleDevToolsKey = safeProcess.platform === 'darwin' ? 'meta-alt-73' : 'ctrl-shift-73';
		const toggleDevToolsAltKey = '123';
		const reloadKey = safeProcess.platform === 'darwin' ? 'meta-82' : 'ctrl-82';

		window.addEventListener('keydown', event => {
			const key = [
				event.ctrlKey ? 'ctrl-' : '',
				event.metaKey ? 'meta-' : '',
				event.altKey ? 'alt-' : '',
				event.shiftKey ? 'shift-' : '',
				event.keyCode
			].join('');
			if (key === toggleDevToolsKey || key === toggleDevToolsAltKey) {
				ipcRenderer.send('vscode:toggleDevTools');
			} else if (key === reloadKey) {
				ipcRenderer.send('vscode:reloadWindow');
			}
		});
	}

	function installHotRefresh(): void {
		let lastVersion: string | undefined;
		let pending = false;
		let disposed = false;

		const poll = async () => {
			if (pending || disposed) {
				return;
			}
			pending = true;
			try {
				const state = await preloadGlobals.ipcRenderer.invoke('vscode:optimusDevHotRefreshState') as IOptimusDevHotRefreshState | undefined;
				if (state?.enabled && state.version) {
					if (lastVersion === undefined) {
						lastVersion = state.version;
					} else if (state.version !== lastVersion) {
						preloadGlobals.ipcRenderer.send('vscode:reloadWindow');
						disposed = true;
					}
				}
			} catch (error) {
				console.warn(`[optimus hot refresh] ${error instanceof Error ? error.message : String(error)}`);
				disposed = true;
			} finally {
				pending = false;
			}
		};

		void poll();
		const handle = window.setInterval(() => void poll(), 1000);
		window.addEventListener('beforeunload', () => {
			disposed = true;
			window.clearInterval(handle);
		}, { once: true });
	}

	function onUnexpectedError(error: unknown): void {
		preloadGlobals.ipcRenderer.send('vscode:openDevTools');
		console.error(`[uncaught exception]: ${error}`);

		if (error instanceof Error && error.stack) {
			console.error(error.stack);
		}
	}

	function fileUriFromPath(path: string, config: { isWindows?: boolean; scheme?: string; fallbackAuthority?: string }): string {
		let pathName = path.replace(/\\/g, '/');
		if (pathName.length > 0 && pathName.charAt(0) !== '/') {
			pathName = `/${pathName}`;
		}

		let uri: string;
		if (config.isWindows && pathName.startsWith('//')) {
			uri = encodeURI(`${config.scheme || 'file'}:${pathName}`);
		} else {
			uri = encodeURI(`${config.scheme || 'file'}://${config.fallbackAuthority || ''}${pathName}`);
		}

		return uri.replace(/#/g, '%23');
	}

	interface IOptimusDevHotRefreshState {
		readonly enabled: boolean;
		readonly version?: string;
	}
}());
