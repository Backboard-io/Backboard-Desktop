/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Prototype: run the Backboard agent host in a Daytona sandbox and connect the
// desktop app to it as a `websocket` remote agent host.
//
//   node daytona.mjs up              create/reuse the sandbox, upload the current build, start the agent host
//   node daytona.mjs url             mint a fresh signed address (signed preview URLs expire after 24h)
//   node daytona.mjs status          sandbox state and whether the agent host process is alive
//   node daytona.mjs logs            tail the agent host log inside the sandbox
//   node daytona.mjs keepalive       refresh sandbox activity until Ctrl-C (preview traffic does not count as activity)
//   node daytona.mjs down [--delete] stop (or delete) the sandbox
//   node daytona.mjs bundle          build the upload bundle locally without touching Daytona
//
// Credentials are read from ~/.config/backboard/daytona.env:
//   DAYTONA_API_KEY=...   required
//   BACKBOARD_API_KEY=... optional; copied into the sandbox so the Backboard runtime can call models
//
// `up` ships the compiled `out/` tree, so keep the dev watch (or `npm run compile`) current first.

import { Daytona, Image } from '@daytona/sdk';
import { execFileSync } from 'child_process';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const configDir = path.join(os.homedir(), '.config', 'backboard');
const envFile = path.join(configDir, 'daytona.env');
const stateFile = path.join(configDir, 'daytona-agent-host.json');
const cacheDir = path.join(repoRoot, '.build', 'cloud-agent-host');

const agentHostPort = 8123;
const signedUrlTtlSeconds = 24 * 60 * 60;
const keepaliveIntervalMs = 4 * 60 * 1000;
const sandboxLabels = { 'backboard-role': 'agent-host' };
/** Server dependencies (`remote/package.json`) are baked into the image so native modules build once. */
const depsDir = '/opt/backboard-agent-host-deps';
const installDir = '~/backboard-agent-host';
const tokenFile = '~/.backboard-agent-host-token';
const apiKeyFile = '~/.backboard-agent-host-api-key';
const logFile = '~/agent-host.log';

function log(message) {
	console.log(`[cloud-agent-host] ${message}`);
}

function loadEnvFile() {
	if (!fs.existsSync(envFile)) {
		return;
	}
	for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
		const match = /^\s*(?:export\s+)?(?<key>[A-Z0-9_]+)\s*=\s*(?<value>.*?)\s*$/.exec(line);
		if (match && !process.env[match.groups.key]) {
			process.env[match.groups.key] = match.groups.value.replace(/^(['"])(.*)\1$/, '$2');
		}
	}
}

function readState() {
	try {
		return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
	} catch {
		return {};
	}
}

function writeState(state) {
	fs.mkdirSync(configDir, { recursive: true });
	fs.writeFileSync(stateFile, JSON.stringify(state, undefined, '\t'), { mode: 0o600 });
}

function shellQuote(value) {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Runs a bash command in the sandbox and throws with its output on a non-zero exit. */
async function run(sandbox, command, timeoutSeconds = 300) {
	const response = await sandbox.process.executeCommand(`bash -lc ${shellQuote(command)}`, undefined, undefined, timeoutSeconds);
	if (response.exitCode !== 0) {
		throw new Error(`Sandbox command failed (exit ${response.exitCode}): ${command}\n${response.result}`);
	}
	return response.result;
}

function agentHostImage() {
	const remote = path.join(repoRoot, 'remote');
	return Image.base('node:24-bookworm')
		.runCommands('apt-get update && apt-get install -y --no-install-recommends libkrb5-dev libsecret-1-dev ripgrep && rm -rf /var/lib/apt/lists/*')
		.addLocalFile(path.join(remote, 'package.json'), `${depsDir}/package.json`)
		.addLocalFile(path.join(remote, 'package-lock.json'), `${depsDir}/package-lock.json`)
		// Not remote/.npmrc: its pinned `target` makes every parallel node-gyp build
		// download the same headers into one cache, and they read each other's
		// half-extracted files. Build against the image's own Node headers instead.
		.runCommands(
			`printf 'legacy-peer-deps=true\\nnodedir=/usr/local\\n' > ${depsDir}/.npmrc`,
			`cd ${depsDir} && npm ci --omit=dev && chmod -R a+rX ${depsDir}`,
		);
}

/** Deletes sandboxes from earlier runs whose image build failed; they never reach the state file. */
async function deleteFailedSandboxes(daytona) {
	for await (const sandbox of daytona.list({ labels: sandboxLabels })) {
		if (sandbox.state === 'build_failed' || sandbox.state === 'error') {
			log(`Deleting failed sandbox ${sandbox.id} (${sandbox.state})`);
			await sandbox.delete();
		}
	}
}

/** Cross-compiles cli-ts for the sandbox (the macOS binary in extensions/backboard/bin can't run there). */
function buildCliTs() {
	const outfile = path.join(cacheDir, 'bin', 'backboard-cli-ts');
	fs.mkdirSync(path.dirname(outfile), { recursive: true });
	log('Building cli-ts for linux-x64...');
	execFileSync('bun', ['run', 'build'], {
		cwd: path.join(repoRoot, 'cli-ts'),
		stdio: ['ignore', 'ignore', 'inherit'],
		env: { ...process.env, BACKBOARD_CLI_TARGET: 'bun-linux-x64', BACKBOARD_CLI_OUTFILE: outfile },
	});
}

/**
 * Packs only what the standalone server loads: the `out/` bootstrap files plus
 * `vs/base` and `vs/platform` (layering keeps the agent host out of editor/workbench).
 */
function createBundle() {
	const serverMain = path.join(repoRoot, 'out', 'vs', 'platform', 'agentHost', 'node', 'agentHostServerMain.js');
	if (!fs.existsSync(serverMain)) {
		throw new Error(`Missing ${serverMain}. Compile the sources first.`);
	}
	buildCliTs();
	const outRoot = path.join(repoRoot, 'out');
	const topLevel = fs.readdirSync(outRoot).filter(name => name.endsWith('.js') || name === 'nls.messages.json').map(name => `out/${name}`);
	const vsLevel = fs.readdirSync(path.join(outRoot, 'vs')).filter(name => name.endsWith('.js')).map(name => `out/vs/${name}`);
	const bundle = path.join(cacheDir, 'bundle.tgz');
	execFileSync('tar', [
		'-czf', bundle,
		'-C', repoRoot, ...topLevel, ...vsLevel, 'out/vs/base', 'out/vs/platform', 'product.json', 'package.json',
		'-C', cacheDir, 'bin/backboard-cli-ts',
	], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
	log(`Bundle: ${(fs.statSync(bundle).size / 1024 / 1024).toFixed(1)} MB`);
	return bundle;
}

async function findSandbox(daytona) {
	const { sandboxId } = readState();
	if (!sandboxId) {
		return undefined;
	}
	try {
		return await daytona.get(sandboxId);
	} catch {
		return undefined;
	}
}

async function requireSandbox(daytona) {
	const sandbox = await findSandbox(daytona);
	if (!sandbox) {
		throw new Error('No sandbox recorded. Run `up` first.');
	}
	return sandbox;
}

async function mintAddress(sandbox, token) {
	const preview = await sandbox.getSignedPreviewUrl(agentHostPort, signedUrlTtlSeconds);
	const url = new URL(preview.url);
	url.protocol = 'wss:';
	url.searchParams.set('tkn', token);
	return url.toString();
}

/** Opens a WebSocket through Daytona's proxy the same way the desktop client does. */
async function probe(address) {
	return new Promise(resolve => {
		const socket = new WebSocket(address);
		const timer = setTimeout(() => {
			socket.close();
			resolve('timed out after 15s');
		}, 15_000);
		socket.addEventListener('open', () => {
			clearTimeout(timer);
			socket.close();
			resolve(undefined);
		});
		socket.addEventListener('error', event => {
			clearTimeout(timer);
			resolve(event.message ?? 'connection error');
		});
	});
}

async function up() {
	const daytona = new Daytona();
	const bundle = createBundle();
	let sandbox = await findSandbox(daytona);
	if (!sandbox) {
		await deleteFailedSandboxes(daytona);
		log('Creating sandbox. The first run builds the image (apt + npm ci of server deps), which takes several minutes...');
		sandbox = await daytona.create({
			image: agentHostImage(),
			resources: { cpu: 2, memory: 4, disk: 10 },
			labels: sandboxLabels,
			autoStopInterval: 30,
			autoArchiveInterval: 60 * 24,
		}, { timeout: 0, onSnapshotCreateLogs: chunk => process.stdout.write(chunk) });
		writeState({ ...readState(), sandboxId: sandbox.id });
		log(`Created sandbox ${sandbox.id}`);
	} else if (sandbox.state !== 'started') {
		log(`Starting sandbox ${sandbox.id} (was ${sandbox.state})...`);
		await sandbox.start(300);
	} else {
		log(`Reusing sandbox ${sandbox.id}`);
	}

	const state = readState();
	const token = state.token ?? randomBytes(24).toString('base64url');
	writeState({ ...state, token });

	const home = await sandbox.getUserHomeDir();
	log('Uploading bundle...');
	await sandbox.fs.uploadFile(bundle, `${home}/backboard-agent-host.tgz`, 600);
	await sandbox.fs.uploadFile(Buffer.from(token), `${home}/.backboard-agent-host-token`);
	if (process.env.BACKBOARD_API_KEY) {
		await sandbox.fs.uploadFile(Buffer.from(process.env.BACKBOARD_API_KEY), `${home}/.backboard-agent-host-api-key`);
	}

	await run(sandbox, [
		'pkill -f "[a]gentHostServerMain" || true',
		`chmod 600 ${tokenFile}`,
		process.env.BACKBOARD_API_KEY ? `chmod 600 ${apiKeyFile}` : `rm -f ${apiKeyFile}`,
		`rm -rf ${installDir} && mkdir -p ${installDir}`,
		`tar -xzf ~/backboard-agent-host.tgz -C ${installDir} 2>/dev/null`,
		'rm ~/backboard-agent-host.tgz',
		`ln -sfn ${depsDir}/node_modules ${installDir}/node_modules`,
		`chmod 755 ${installDir}/bin/backboard-cli-ts`,
	].join(' && '));

	log('Starting agent host...');
	const sessionId = `agent-host-${Date.now()}`;
	await sandbox.process.createSession(sessionId);
	await sandbox.process.executeSessionCommand(sessionId, {
		runAsync: true,
		command: [
			`cd ${installDir}`,
			`export BACKBOARD_CLI_TS_PATH="$HOME/backboard-agent-host/bin/backboard-cli-ts"`,
			`if [ -f ${apiKeyFile} ]; then export BACKBOARD_API_KEY="$(cat ${apiKeyFile})"; fi`,
			// The server exits when stdin closes, so hold it open.
			`sleep infinity | node out/vs/platform/agentHost/node/agentHostServerMain.js --host 0.0.0.0 --port ${agentHostPort} --connection-token-file ${tokenFile} > ${logFile} 2>&1`,
		].join(' && '),
	});

	const deadline = Date.now() + 60_000;
	while ((await sandbox.process.executeCommand(`bash -lc ${shellQuote(`grep -q READY: ${logFile}`)}`)).exitCode !== 0) {
		if (Date.now() > deadline) {
			const tail = await run(sandbox, `tail -n 60 ${logFile} || true`);
			throw new Error(`Agent host did not report READY within 60s. Log tail:\n${tail}`);
		}
		await new Promise(resolve => setTimeout(resolve, 1000));
	}

	const address = await mintAddress(sandbox, token);
	const probeError = await probe(address);
	log(probeError ? `WARNING: WebSocket probe through the Daytona proxy failed: ${probeError}` : 'WebSocket probe through the Daytona proxy succeeded.');
	printAddress(address);
}

function printAddress(address) {
	console.log('');
	console.log('Remote agent host address (valid 24h, contains credentials; do not share):');
	console.log(`  ${address}`);
	console.log('');
	console.log('In Backboard: enable "chat.remoteAgentHostsEnabled", then add this address as a remote agent host.');
	console.log('Run `keepalive` while you work: Daytona does not count preview traffic as activity.');
}

async function url() {
	const sandbox = await requireSandbox(new Daytona());
	const { token } = readState();
	if (sandbox.state !== 'started' || !token) {
		throw new Error(`Sandbox is ${sandbox.state}. Run \`up\` to start it and the agent host.`);
	}
	printAddress(await mintAddress(sandbox, token));
}

async function status() {
	const sandbox = await requireSandbox(new Daytona());
	log(`Sandbox ${sandbox.id}: ${sandbox.state}`);
	if (sandbox.state === 'started') {
		log(`Agent host: ${(await run(sandbox, 'pgrep -f "[a]gentHostServerMain" >/dev/null && echo running || echo not running')).trim()}`);
	}
}

async function logs() {
	const sandbox = await requireSandbox(new Daytona());
	console.log(await run(sandbox, `tail -n 200 ${logFile} || true`));
}

async function keepalive() {
	const sandbox = await requireSandbox(new Daytona());
	log('Refreshing sandbox activity every 4 minutes. Ctrl-C to stop.');
	for (;;) {
		await sandbox.refreshActivity();
		log(`Activity refreshed at ${new Date().toLocaleTimeString()}`);
		await new Promise(resolve => setTimeout(resolve, keepaliveIntervalMs));
	}
}

async function down(deleteSandbox) {
	const sandbox = await requireSandbox(new Daytona());
	if (deleteSandbox) {
		await sandbox.delete();
		writeState({});
		log(`Deleted sandbox ${sandbox.id}`);
	} else {
		await sandbox.stop();
		log(`Stopped sandbox ${sandbox.id}. \`up\` restarts it.`);
	}
}

async function main() {
	loadEnvFile();
	const [command = 'help', ...rest] = process.argv.slice(2);
	if (command === 'bundle') {
		log(`Wrote ${createBundle()}`);
		return;
	}
	if (command !== 'help' && !process.env.DAYTONA_API_KEY) {
		throw new Error(`DAYTONA_API_KEY is not set. Put it in ${envFile}.`);
	}
	switch (command) {
		case 'up': return up();
		case 'url': return url();
		case 'status': return status();
		case 'logs': return logs();
		case 'keepalive': return keepalive();
		case 'down': return down(rest.includes('--delete'));
		default:
			console.log('Usage: node daytona.mjs <up|url|status|logs|keepalive|down [--delete]>');
	}
}

main().catch(error => {
	console.error(`[cloud-agent-host] ${error.message}`);
	process.exit(1);
});
