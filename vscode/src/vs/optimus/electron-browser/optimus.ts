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
		applyInitialTheme(configuration);

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

	function applyInitialTheme(configuration: INativeWindowConfiguration): void {
		const theme = resolveInitialTheme(configuration);
		document.documentElement.classList.toggle('vs', theme.baseTheme === 'vs');
		document.documentElement.classList.toggle('vs-dark', theme.baseTheme === 'vs-dark');
		document.documentElement.classList.toggle('hc-black', theme.baseTheme === 'hc-black');
		document.documentElement.classList.toggle('hc-light', theme.baseTheme === 'hc-light');

		const style = document.createElement('style');
		style.className = 'optimus-initial-theme';
		document.head.appendChild(style);
		style.textContent = `:root {
	--vscode-foreground: ${theme.foreground};
	--vscode-editor-foreground: ${theme.foreground};
	--vscode-editor-background: ${theme.editorBackground};
	--vscode-titleBar-activeBackground: ${theme.titleBarBackground};
	--vscode-titleBar-border: ${theme.titleBarBorder};
	--vscode-sideBar-background: ${theme.sideBarBackground};
	--vscode-sideBar-border: ${theme.sideBarBorder};
	--vscode-editorWidget-background: ${theme.sideBarBackground};
	--vscode-input-background: ${theme.editorBackground};
	--vscode-widget-border: ${theme.sideBarBorder};
	--vscode-contrastBorder: ${theme.sideBarBorder};
}`;
	}

	function resolveInitialTheme(configuration: INativeWindowConfiguration): IOptimusInitialTheme {
		const splash = configuration.partsSplash;
		const baseTheme = splash?.baseTheme
			?? (configuration.colorScheme.highContrast
				? configuration.colorScheme.dark ? 'hc-black' : 'hc-light'
				: configuration.colorScheme.dark ? 'vs-dark' : 'vs');
		const dark = baseTheme === 'vs-dark' || baseTheme === 'hc-black' || configuration.colorScheme.dark;
		const highContrast = baseTheme === 'hc-black' || baseTheme === 'hc-light' || configuration.colorScheme.highContrast;
		const fallbackBackground = dark ? 'rgb(30, 30, 30)' : 'rgb(255, 255, 255)';
		const fallbackForeground = dark ? 'rgb(204, 204, 204)' : 'rgb(0, 0, 0)';
		const fallbackBorder = highContrast
			? fallbackForeground
			: dark ? 'rgb(61, 61, 61)' : 'rgb(224, 224, 224)';
		const editorBackground = cssColor(splash?.colorInfo.editorBackground) ?? cssColor(splash?.colorInfo.background) ?? fallbackBackground;
		const foreground = cssColor(splash?.colorInfo.foreground) ?? fallbackForeground;
		const sideBarBackground = cssColor(splash?.colorInfo.sideBarBackground) ?? editorBackground;
		return {
			baseTheme,
			foreground,
			editorBackground,
			titleBarBackground: cssColor(splash?.colorInfo.titleBarBackground) ?? sideBarBackground,
			titleBarBorder: cssColor(splash?.colorInfo.titleBarBorder) ?? cssColor(splash?.colorInfo.windowBorder) ?? fallbackBorder,
			sideBarBackground,
			sideBarBorder: cssColor(splash?.colorInfo.sideBarBorder) ?? fallbackBorder
		};
	}

	function cssColor(value: string | undefined): string | undefined {
		if (!value) {
			return undefined;
		}
		const trimmed = value.trim();
		return /^#[\da-f]{3,8}$/i.test(trimmed) || /^rgba?\([\d\s.,%]+\)$/i.test(trimmed) || /^hsla?\([\d\s.,%degturnrad]+\)$/i.test(trimmed)
			? trimmed
			: undefined;
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

	interface IOptimusInitialTheme {
		readonly baseTheme: 'vs' | 'vs-dark' | 'hc-black' | 'hc-light';
		readonly foreground: string;
		readonly editorBackground: string;
		readonly titleBarBackground: string;
		readonly titleBarBorder: string;
		readonly sideBarBackground: string;
		readonly sideBarBorder: string;
	}
}());
