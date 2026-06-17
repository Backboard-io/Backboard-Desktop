/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { basename, dirname, extUri, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { isIChatSessionFileChange2 } from '../../../../workbench/contrib/chat/common/chatSessionsService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { parse } from '../../../../base/common/jsonc.js';
import { ISandboxPreviewCandidate } from '../common/preview.js';
import { ISession, ISessionFileChange } from '../../../services/sessions/common/session.js';

interface IPackageJson {
	readonly scripts?: Record<string, string>;
	readonly dependencies?: Record<string, string>;
	readonly devDependencies?: Record<string, string>;
}

interface IPackageDetection {
	readonly value: IPackageJson;
}

const HTML_ENTRY_NAMES = new Set(['index.html', 'index.htm']);
const SCRIPT_PRIORITY = ['dev', 'start', 'serve', 'preview'];
const COMMON_WEB_APP_DIRS = ['.', 'frontend', 'web', 'app', 'client', 'site'];

export class SandboxPreviewDetector {
	constructor(
		@IFileService private readonly _fileService: IFileService,
	) { }

	async detect(session: ISession): Promise<ISandboxPreviewCandidate | undefined> {
		const folder = session.workspace.get()?.folders[0];
		if (!folder) {
			return undefined;
		}

		const root = folder.workingDirectory ?? folder.root;
		const changedUris = session.changes.get()
			.map(change => getChangeUri(change))
			.filter((uri): uri is URI => !!uri && extUri.isEqualOrParent(uri, root));

		const staticCandidate = await this._detectStaticHtml(root, changedUris);
		if (staticCandidate) {
			return staticCandidate;
		}

		const packageCandidate = await this._detectPackageApp(root, changedUris);
		if (packageCandidate) {
			return packageCandidate;
		}

		const fallbackPackageCandidate = await this._detectPackageAppInDirs(root, await this._commonWebDirs(root));
		if (fallbackPackageCandidate) {
			return fallbackPackageCandidate;
		}

		const fallbackStaticCandidate = await this._detectCommonStaticHtml(root);
		if (fallbackStaticCandidate) {
			return fallbackStaticCandidate;
		}

		return undefined;
	}

	private async _detectStaticHtml(root: URI, changedUris: readonly URI[]): Promise<ISandboxPreviewCandidate | undefined> {
		for (const uri of changedUris) {
			if (HTML_ENTRY_NAMES.has(basename(uri).toLowerCase()) && await this._exists(uri)) {
				return this._staticCandidate(root, uri, 100);
			}
		}
		for (const uri of changedUris) {
			if (uri.path.toLowerCase().endsWith('.html') && await this._exists(uri)) {
				return this._staticCandidate(root, uri, 90);
			}
		}
		return undefined;
	}

	private async _detectPackageApp(root: URI, changedUris: readonly URI[]): Promise<ISandboxPreviewCandidate | undefined> {
		return this._detectPackageAppInDirs(root, getCandidatePackageDirs(root, changedUris));
	}

	private async _detectPackageAppInDirs(root: URI, dirs: readonly URI[]): Promise<ISandboxPreviewCandidate | undefined> {
		for (const dir of dirs) {
			const pkg = await this._readPackageJson(dir);
			if (!pkg) {
				continue;
			}

			const script = pickPreviewScript(pkg.value);
			if (!script) {
				continue;
			}

			const packageManager = await this._detectPackageManager(dir);
			const framework = detectFramework(pkg.value);
			const command = buildScriptCommand(packageManager, script);
			const url = inferLocalhostUrl(pkg.value.scripts?.[script], framework);
			const entry = await this._detectEntryFile(dir, framework);

			return {
				kind: 'dev-server',
				title: framework ? `${framework} preview` : 'Web preview',
				workspaceRoot: root,
				cwd: dir,
				entry,
				command,
				framework,
				url,
				confidence: dir.toString() === root.toString() ? 85 : 95,
			};
		}
		return undefined;
	}

	private async _detectCommonStaticHtml(root: URI): Promise<ISandboxPreviewCandidate | undefined> {
		for (const dir of await this._commonWebDirs(root)) {
			const entry = joinPath(dir, 'index.html');
			if (await this._exists(entry)) {
				return this._staticCandidate(root, entry, extUri.isEqual(dir, root) ? 80 : 75);
			}
		}
		return undefined;
	}

	private async _commonWebDirs(root: URI): Promise<URI[]> {
		const dirs: URI[] = [];
		for (const relativeDir of COMMON_WEB_APP_DIRS) {
			const dir = relativeDir === '.' ? root : joinPath(root, relativeDir);
			if (relativeDir === '.' || await this._exists(dir)) {
				dirs.push(dir);
			}
		}
		return dirs;
	}

	private async _detectEntryFile(cwd: URI, framework: string | undefined): Promise<URI | undefined> {
		const candidates = framework === 'Next.js'
			? ['app/page.tsx', 'app/page.jsx', 'pages/index.tsx', 'pages/index.jsx', 'src/app/page.tsx', 'src/pages/index.tsx']
			: ['src/App.tsx', 'src/App.jsx', 'src/main.tsx', 'src/main.jsx', 'src/index.tsx', 'src/index.jsx', 'app/page.tsx', 'pages/index.tsx', 'index.html'];
		for (const candidate of candidates) {
			const uri = joinPath(cwd, candidate);
			if (await this._exists(uri)) {
				return uri;
			}
		}
		return undefined;
	}

	private async _readPackageJson(dir: URI): Promise<IPackageDetection | undefined> {
		const uri = joinPath(dir, 'package.json');
		try {
			const content = await this._fileService.readFile(uri);
			return { value: parse<IPackageJson>(content.value.toString()) };
		} catch {
			return undefined;
		}
	}

	private async _detectPackageManager(dir: URI): Promise<'npm' | 'pnpm' | 'yarn' | 'bun'> {
		if (await this._exists(joinPath(dir, 'pnpm-lock.yaml'))) {
			return 'pnpm';
		}
		if (await this._exists(joinPath(dir, 'yarn.lock'))) {
			return 'yarn';
		}
		if (await this._exists(joinPath(dir, 'bun.lockb')) || await this._exists(joinPath(dir, 'bun.lock'))) {
			return 'bun';
		}
		return 'npm';
	}

	private async _exists(uri: URI): Promise<boolean> {
		try {
			return await this._fileService.exists(uri);
		} catch {
			return false;
		}
	}

	private _staticCandidate(root: URI, entry: URI, confidence: number): ISandboxPreviewCandidate {
		return {
			kind: 'static-html',
			title: basename(entry),
			workspaceRoot: root,
			cwd: dirname(entry),
			entry,
			url: entry.toString(),
			confidence,
		};
	}
}

function getChangeUri(change: ISessionFileChange): URI | undefined {
	return isIChatSessionFileChange2(change) ? (change.modifiedUri ?? change.uri) : change.modifiedUri;
}

function getCandidatePackageDirs(root: URI, changedUris: readonly URI[]): URI[] {
	const result: URI[] = [];
	const seen = new Set<string>();
	const add = (uri: URI) => {
		const key = uri.toString();
		if (!seen.has(key)) {
			seen.add(key);
			result.push(uri);
		}
	};

	for (const uri of changedUris) {
		let dir = dirname(uri);
		for (let depth = 0; depth < 5 && extUri.isEqualOrParent(dir, root); depth++) {
			add(dir);
			if (extUri.isEqual(dir, root)) {
				break;
			}
			const parent = dirname(dir);
			if (extUri.isEqual(parent, dir)) {
				break;
			}
			dir = parent;
		}
	}
	add(root);
	return result;
}

function pickPreviewScript(pkg: IPackageJson): string | undefined {
	const scripts = pkg.scripts ?? {};
	return SCRIPT_PRIORITY.find(script => typeof scripts[script] === 'string' && scripts[script].trim().length > 0);
}

function buildScriptCommand(packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun', script: string): string {
	if (packageManager === 'npm') {
		return script === 'start' ? 'npm start' : `npm run ${script}`;
	}
	if (packageManager === 'yarn') {
		return `yarn ${script}`;
	}
	if (packageManager === 'bun') {
		return `bun run ${script}`;
	}
	return `pnpm ${script}`;
}

function detectFramework(pkg: IPackageJson): string | undefined {
	const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
	if (deps.next) {
		return 'Next.js';
	}
	if (deps.vite) {
		return 'Vite';
	}
	if (deps['react-scripts']) {
		return 'React';
	}
	if (deps.astro) {
		return 'Astro';
	}
	if (deps['@sveltejs/kit']) {
		return 'SvelteKit';
	}
	if (deps.react) {
		return 'React';
	}
	return undefined;
}

function inferLocalhostUrl(script: string | undefined, framework: string | undefined): string | undefined {
	const explicitPort = parsePort(script);
	if (explicitPort) {
		return `http://localhost:${explicitPort}`;
	}
	switch (framework) {
		case 'Vite':
			return 'http://localhost:5173';
		case 'Astro':
			return 'http://localhost:4321';
		case 'Next.js':
		case 'React':
		case 'SvelteKit':
			return 'http://localhost:3000';
		default:
			return 'http://localhost:3000';
	}
}

function parsePort(script: string | undefined): number | undefined {
	if (!script) {
		return undefined;
	}
	const match = /(?:--port|-p|PORT=)\s*=?\s*(\d{2,5})/.exec(script);
	if (!match) {
		return undefined;
	}
	const port = Number(match[1]);
	return port > 0 && port < 65536 ? port : undefined;
}
