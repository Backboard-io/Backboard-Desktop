/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const PROFILE_MARKER = '# Added by Backboard Studio';

/**
 * Puts the app's launcher on the user's PATH without asking for
 * administrator rights: the launcher is linked into `~/.backboard/bin`, the
 * folder the Backboard CLI installer already adds to PATH, and that folder is
 * only added to the shell profile when it is not on PATH yet.
 *
 * Resolves false when there is nothing to link, as in a dev checkout, or when
 * something other than our link already uses the name.
 */
export async function installTerminalCommand(appRoot: string, commandName: string): Promise<boolean> {
	if (process.platform === 'win32' || !/^[a-z0-9-]+$/i.test(commandName)) {
		return false;
	}

	const launcher = path.join(appRoot, 'bin', 'code');
	try {
		await fs.promises.access(launcher, fs.constants.X_OK);
	} catch {
		return false;
	}

	const binDirectory = path.join(os.homedir(), '.backboard', 'bin');
	await fs.promises.mkdir(binDirectory, { recursive: true });

	const link = path.join(binDirectory, commandName);
	let existingTarget: string | undefined;
	try {
		existingTarget = await fs.promises.readlink(link);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === 'EINVAL') {
			return false; // A real file has this name; leave it alone.
		}
		if (code !== 'ENOENT') {
			throw error;
		}
	}
	if (existingTarget !== launcher) {
		if (existingTarget !== undefined) {
			await fs.promises.unlink(link);
		}
		await fs.promises.symlink(launcher, link);
	}

	await addToShellPath(binDirectory);
	return true;
}

function shellProfile(): string {
	const shell = path.basename(process.env.SHELL ?? '');
	if (shell === 'zsh') {
		return path.join(os.homedir(), '.zshrc');
	}
	if (shell === 'bash') {
		return path.join(os.homedir(), process.platform === 'darwin' ? '.bash_profile' : '.bashrc');
	}
	return path.join(os.homedir(), '.profile');
}

async function addToShellPath(directory: string): Promise<void> {
	if ((process.env.PATH ?? '').split(path.delimiter).includes(directory)) {
		return;
	}

	const profile = shellProfile();
	let contents = '';
	try {
		contents = await fs.promises.readFile(profile, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw error;
		}
	}

	const relative = path.relative(os.homedir(), directory);
	if (contents.includes(directory) || contents.includes(`$HOME/${relative}`) || contents.includes(`~/${relative}`)) {
		return;
	}

	const separator = contents && !contents.endsWith('\n') ? '\n' : '';
	await fs.promises.appendFile(profile, `${separator}\n${PROFILE_MARKER}\nexport PATH="${directory}:$PATH"\n`);
}
