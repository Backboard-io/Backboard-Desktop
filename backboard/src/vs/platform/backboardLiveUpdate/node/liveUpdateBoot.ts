/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import { join } from '../../../base/common/path.js';
import { ILiveAppBadRecord, ILiveAppBootRecord, ILiveAppPointer, ILiveUpdateBuildInfo, ILiveUpdateProductConfiguration, LIVE_APP_MAX_BOOT_ATTEMPTS, LIVE_BASE_APP_ROOT_ENV, LIVE_UPDATE_ID_PATTERN, liveComponentBuildMismatch, liveUpdateBuildId } from '../common/liveUpdate.js';
import { verifyLiveUpdateEnvelope } from './liveUpdateSignature.js';

export interface ILiveAppBootOptions {
	readonly liveUpdatesDir: string;
	readonly product: {
		readonly backboardVersion?: string;
		readonly backboardBuildInfo?: ILiveUpdateBuildInfo;
		readonly backboardLiveUpdate?: ILiveUpdateProductConfiguration;
	};
	readonly electronVersion: string;
	readonly isDev: boolean;
}

export interface ILiveAppSelection {
	/** Overlay root to start from; undefined starts the installed app. */
	readonly root?: string;
	readonly id?: string;
	readonly reason: string;
}

/** Marker the extension writes last, once every file of an overlay is in place. */
export const LIVE_APP_COMPLETE_MARKER = '.complete';

/**
 * The installed app root. While a live update runs, `appRoot` is its overlay
 * folder, which a later update deletes, so anything that outlives this run
 * (the terminal command link, tunnel binaries) must point here instead.
 */
export function installedAppRoot(appRoot: string): string {
	return process.env[LIVE_BASE_APP_ROOT_ENV] || appRoot;
}

export function readLiveUpdateJson<T>(path: string): T | undefined {
	try {
		return JSON.parse(fs.readFileSync(path, 'utf8')) as T;
	} catch {
		return undefined;
	}
}

function writeLiveUpdateJson(path: string, value: unknown): void {
	const temporary = `${path}.${process.pid}.tmp`;
	fs.writeFileSync(temporary, JSON.stringify(value));
	fs.renameSync(temporary, path);
}

/** Records that an overlay must not start again. */
export function markLiveAppBad(liveUpdatesDir: string, id: string): void {
	const path = join(liveUpdatesDir, 'app', 'bad.json');
	const ids = new Set(readLiveUpdateJson<ILiveAppBadRecord>(path)?.ids ?? []);
	ids.add(id);
	try {
		writeLiveUpdateJson(path, { ids: [...ids] } satisfies ILiveAppBadRecord);
	} catch {
		// Without the record the attempt counter still stops the overlay.
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}

/**
 * Picks the folder the app starts from. Every check failing means the installed
 * app runs, so a broken or missing live update can never stop the app starting.
 * Counts the start attempt: the extension marks the overlay healthy once it is
 * up, and an overlay that fails to get there repeatedly is marked bad.
 */
export function selectLiveAppRoot(options: ILiveAppBootOptions): ILiveAppSelection {
	if (options.isDev) {
		return { reason: 'development build' };
	}
	const config = options.product.backboardLiveUpdate;
	if (!config?.publicKeys?.length) {
		return { reason: 'live updates are not configured' };
	}
	const appDir = join(options.liveUpdatesDir, 'app');
	const bootPath = join(appDir, 'boot.json');
	const previous = readLiveUpdateJson<ILiveAppBootRecord>(bootPath);
	if (typeof previous?.pid === 'number' && previous.pid !== process.pid && isProcessAlive(previous.pid)) {
		// A second launch (the terminal command, a file opened from Finder on
		// some platforms) only hands its arguments to the running instance, so
		// it runs the same code as that instance and is not a start attempt.
		const root = previous.id && LIVE_UPDATE_ID_PATTERN.test(previous.id) ? join(appDir, previous.id) : undefined;
		return root && fs.existsSync(join(root, 'out', 'main.js'))
			? { root, id: previous.id, reason: `instance ${previous.pid} runs overlay ${previous.id}` }
			: { reason: `instance ${previous.pid} runs the installed app` };
	}
	const record = (value: ILiveAppBootRecord): boolean => {
		try {
			fs.mkdirSync(appDir, { recursive: true });
			writeLiveUpdateJson(bootPath, value);
			return true;
		} catch {
			return false;
		}
	};
	const selection = chooseLiveApp(options, appDir, config.publicKeys);
	if (!selection.root || !selection.id) {
		record({ attempts: 0, pid: process.pid });
		return selection;
	}
	const id = selection.id;
	const attempts = (previous?.id === id && !previous.healthy ? previous.attempts : 0) + 1;
	if (attempts > LIVE_APP_MAX_BOOT_ATTEMPTS) {
		markLiveAppBad(options.liveUpdatesDir, id);
		record({ attempts: 0, pid: process.pid });
		return { reason: `overlay ${id} did not finish starting ${LIVE_APP_MAX_BOOT_ATTEMPTS} times` };
	}
	if (!record({ id, attempts, pid: process.pid, healthy: false })) {
		// An unwritable folder means the attempt cannot be counted, so the
		// overlay could crash-loop. Run the installed app instead.
		return { reason: `cannot record a start attempt for overlay ${id}` };
	}
	return { ...selection, reason: `overlay ${id}, attempt ${attempts}` };
}

function chooseLiveApp(options: ILiveAppBootOptions, appDir: string, publicKeys: readonly string[]): ILiveAppSelection {
	const pointer = readLiveUpdateJson<ILiveAppPointer>(join(appDir, 'current.json'));
	if (!pointer) {
		return { reason: 'no overlay staged' };
	}
	const id = pointer.id;
	if (typeof id !== 'string' || !LIVE_UPDATE_ID_PATTERN.test(id)) {
		return { reason: 'invalid overlay id' };
	}
	const component = verifyLiveUpdateEnvelope(pointer.manifest, publicKeys)?.components.app;
	if (component?.id !== id) {
		return { reason: `overlay ${id} is not in a manifest signed by a trusted key` };
	}
	if (!options.product.backboardVersion || !component.bases.includes(options.product.backboardVersion)) {
		return { reason: `overlay ${id} targets ${component.bases.join(', ')}, installed app is ${options.product.backboardVersion}` };
	}
	const buildMismatch = liveComponentBuildMismatch(component.builds, liveUpdateBuildId(options.product.backboardBuildInfo));
	if (buildMismatch) {
		return { reason: `overlay ${id} ${buildMismatch}` };
	}
	if (component.electron !== options.electronVersion) {
		return { reason: `overlay ${id} needs Electron ${component.electron}, installed app has ${options.electronVersion}` };
	}
	const root = join(appDir, id);
	if (!fs.existsSync(join(root, LIVE_APP_COMPLETE_MARKER)) || !fs.existsSync(join(root, 'out', 'main.js'))) {
		return { reason: `overlay ${id} is incomplete` };
	}
	if (readLiveUpdateJson<ILiveAppBadRecord>(join(appDir, 'bad.json'))?.ids?.includes(id)) {
		return { reason: `overlay ${id} failed to start before` };
	}
	return { root, id, reason: `overlay ${id}` };
}
