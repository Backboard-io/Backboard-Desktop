/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import path from 'path';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const rootDir = path.resolve(import.meta.dirname, '..', '..');

function runProcess(command: string, args: ReadonlyArray<string> = []) {
	return new Promise<void>((resolve, reject) => {
		const child = spawn(command, args, { cwd: rootDir, stdio: 'inherit', env: process.env, shell: process.platform === 'win32' });
		child.on('exit', err => !err ? resolve() : process.exit(err ?? 1));
		child.on('error', reject);
	});
}

async function exists(subdir: string) {
	try {
		await fs.stat(path.join(rootDir, subdir));
		return true;
	} catch {
		return false;
	}
}

async function ensureNodeModules() {
	if (!(await exists('node_modules'))) {
		await runProcess(npm, ['ci']);
	}
}

async function getElectron() {
	await runProcess(npm, ['run', 'electron']);
}

async function syncDarwinDevAppIcon() {
	if (process.platform !== 'darwin') {
		return;
	}

	const electronDir = path.join(rootDir, '.build', 'electron');
	const iconPath = path.join(rootDir, 'resources', 'darwin', 'code.icns');
	if (!(await exists(path.relative(rootDir, electronDir))) || !(await exists(path.relative(rootDir, iconPath)))) {
		return;
	}

	const entries = await fs.readdir(electronDir, { withFileTypes: true });
	await Promise.all(entries
		.filter(entry => entry.isDirectory() && entry.name.endsWith('.app'))
		.map(async entry => {
			const appPath = path.join(electronDir, entry.name);
			const resourcesPath = path.join(appPath, 'Contents', 'Resources');
			const infoPlistPath = path.join(appPath, 'Contents', 'Info.plist');
			const appIconName = entry.name.replace(/\.app$/, '.icns');
			let iconFileName = appIconName;
			if (!(await exists(path.relative(rootDir, resourcesPath)))) {
				return;
			}

			try {
				const infoPlist = await fs.readFile(infoPlistPath, 'utf8');
				const match = /<key>CFBundleIconFile<\/key>\s*<string>([^<]+)<\/string>/.exec(infoPlist);
				if (match?.[1]) {
					iconFileName = match[1].endsWith('.icns') ? match[1] : `${match[1]}.icns`;
				}
			} catch {
				// Fall back to the standard Electron bundle icon name.
			}

			await fs.copyFile(iconPath, path.join(resourcesPath, iconFileName));
			const now = new Date();
			await fs.utimes(appPath, now, now);
		}));
}

async function ensureCompiled() {
	if (!(await exists('out'))) {
		await runProcess(npm, ['run', 'compile']);
	}
}

async function main() {
	await ensureNodeModules();
	await getElectron();
	await syncDarwinDevAppIcon();
	await ensureCompiled();

	// Can't require this until after dependencies are installed
	const { getBuiltInExtensions } = await import('./builtInExtensions.ts');
	await getBuiltInExtensions();
}

if (import.meta.main) {
	main().catch(err => {
		console.error(err);
		process.exit(1);
	});
}
