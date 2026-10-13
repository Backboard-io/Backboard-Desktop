/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { open, unlink } from 'node:fs/promises';

/** Remove bundled Unix native modules before Windows resource editing and signing. */
export async function removeNonWindowsNativeModule(filePath: string): Promise<boolean> {
	const file = await open(filePath, 'r');
	const header = Buffer.alloc(4);
	let bytesRead: number;
	try {
		({ bytesRead } = await file.read(header, 0, header.length, 0));
	} finally {
		await file.close();
	}
	const magic = header.readUInt32BE(0);
	// ELF, Mach-O (both byte orders, 32/64 bit), and universal Mach-O.
	if (bytesRead === 4 && [0x7f454c46, 0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(magic)) {
		await unlink(filePath);
		return true;
	}
	if (bytesRead < 2 || header.readUInt16LE(0) !== 0x5a4d) {
		throw new Error(`Unknown native module format in Windows payload: ${filePath}`);
	}
	return false;
}
