import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConfigFromPolicy, getAvailableToolsPolicy, spawnSandboxFromConfig } from '../backboard/node_modules/@microsoft/mxc-sdk/dist/index.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backboard-mxc-test.'));
try {
	const tools = getAvailableToolsPolicy(process.env);
	const config = createConfigFromPolicy({
		version: '0.6.0-alpha',
		filesystem: { readonlyPaths: tools.readonlyPaths, readwritePaths: [root] },
		network: { allowOutbound: false },
		timeoutMs: 30000,
	});
	config.process.commandLine = '/bin/echo BACKBOARD_SANDBOX_OK';
	const child = spawnSandboxFromConfig(config, { usePty: false, experimental: true });
	let output = '';
	let errors = '';
	child.stdout?.on('data', data => { output += data; });
	child.stderr?.on('data', data => { errors += data; });
	const code = await new Promise((resolve, reject) => {
		const timeout = setTimeout(() => { child.kill(); reject(new Error('Sandbox smoke test timed out')); }, 35000);
		child.once('error', error => { clearTimeout(timeout); reject(error); });
		child.once('close', code => { clearTimeout(timeout); resolve(code); });
	});
	assert.equal(code, 0, errors);
	assert.match(output, /BACKBOARD_SANDBOX_OK/);
	console.log('Native macOS sandbox execution passed through the pinned SDK');
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}
