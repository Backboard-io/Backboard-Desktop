/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const extensionRoot = path.resolve(__dirname, '..');
const manifestPath = path.join(extensionRoot, 'rust', 'Cargo.toml');
const binaryName = process.platform === 'win32' ? 'backboard-bridge.exe' : 'backboard-bridge';
const source = path.join(extensionRoot, 'rust', 'target', 'release', binaryName);
const destinationDirectory = path.join(extensionRoot, 'bin');
const destination = path.join(destinationDirectory, binaryName);

cp.execFileSync('cargo', ['build', '--release', '--manifest-path', manifestPath, '-p', 'backboard_bridge'], {
	cwd: extensionRoot,
	stdio: 'inherit'
});

fs.mkdirSync(destinationDirectory, { recursive: true });
fs.copyFileSync(source, destination);
if (process.platform !== 'win32') {
	fs.chmodSync(destination, 0o755);
}

console.log(`Packaged ${destination}`);
