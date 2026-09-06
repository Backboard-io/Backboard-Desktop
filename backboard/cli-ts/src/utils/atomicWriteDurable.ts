/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from "node:crypto";
import { open, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

/** Publish complete bytes only after file sync, then sync the directory entry. Parent must exist. */
export async function atomicWriteDurable(
	path: string,
	content: string | Uint8Array,
	mode = 0o600,
): Promise<void> {
	const temporaryPath = `${path}.tmp-${randomUUID()}`;
	const file = await open(temporaryPath, "wx", mode);
	try {
		try {
			await file.writeFile(content);
			await file.sync();
		} finally {
			await file.close();
		}
		await rename(temporaryPath, path);
		let directory;
		try {
			directory = await open(dirname(path), "r");
		} catch (error) {
			// Node/libuv cannot obtain a directory handle through ordinary open on
			// Windows. Keep the synced file + atomic rename, but do not suppress
			// missing paths, EACCES, or other real filesystem failures.
			if (
				process.platform === "win32" &&
				["EISDIR", "EPERM"].includes(
					(error as NodeJS.ErrnoException).code ?? "",
				) &&
				(await stat(dirname(path))).isDirectory()
			)
				return;
			throw error;
		}
		try {
			await directory.sync();
		} catch (error) {
			if (
				!["EINVAL", "ENOTSUP"].includes(
					(error as NodeJS.ErrnoException).code ?? "",
				)
			)
				throw error;
		} finally {
			await directory.close();
		}
	} catch (error) {
		await rm(temporaryPath, { force: true }).catch(() => {});
		throw error;
	}
}
