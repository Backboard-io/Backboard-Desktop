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

	try {
		const configuration = await preloadGlobals.context.resolveConfiguration() as INativeWindowConfiguration;
		globalThis._VSCODE_NLS_MESSAGES = configuration.nls.messages;
		globalThis._VSCODE_NLS_LANGUAGE = configuration.nls.language;

		const baseUrl = new URL(`${fileUriFromPath(configuration.appRoot, { isWindows: safeProcess.platform === 'win32', scheme: 'vscode-file', fallbackAuthority: 'vscode-app' })}/out/`);
		globalThis._VSCODE_FILE_ROOT = baseUrl.toString();

		let optimusUrl: string;
		if (!!safeProcess.env['VSCODE_DEV'] && globalThis._VSCODE_USE_RELATIVE_IMPORTS) {
			optimusUrl = '../optimus.desktop.main.js';
		} else {
			optimusUrl = new URL('vs/optimus/optimus.desktop.main.js', baseUrl).href;
		}

		await import(optimusUrl);
	} catch (error) {
		onUnexpectedError(error);
		throw error;
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
}());
