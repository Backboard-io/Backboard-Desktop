#!/usr/bin/env node
// Push channel for Backboard Studio live updates.
//
// Apps hold one server-sent events connection each:
//   GET  /events?channel=stable&platform=darwin-arm64
// and fetch the manifest as soon as this sends
//   event: manifest
//   data: {"sequence":1761340000}
// Without this server apps still poll the manifest (every 5 minutes by default),
// so it only shortens the delay; it carries no update content and needs no trust.
//
// Announce a publish (scripts/upload_live_update.sh does this after uploading):
//   POST /publish  Authorization: Bearer $BACKBOARD_LIVE_EVENTS_TOKEN
//                  {"channel":"stable","platform":"darwin-arm64","sequence":1761340000}
//
// Options:
//   --port 8787 --host 127.0.0.1
//   --watch DIR    also announce whenever DIR/<channel>/<platform>/manifest.json changes
//   --static DIR   also serve DIR over HTTP with ETags (local testing without S3)

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';

const args = process.argv.slice(2);
const option = (name, fallback) => {
	const index = args.indexOf(`--${name}`);
	return index >= 0 ? args[index + 1] : fallback;
};
const port = Number(option('port', process.env.PORT ?? '8787'));
const host = option('host', '127.0.0.1');
const watchDir = option('watch');
const staticDir = option('static');
const token = process.env.BACKBOARD_LIVE_EVENTS_TOKEN;
const KEY_PATTERN = /^(stable|sandbox)\/(darwin|win32|linux)-(arm64|x64)$/;

/** @type {Map<string, Set<http.ServerResponse>>} */
const clients = new Map();
/** Latest sequence per channel/platform, replayed to clients that reconnect. */
const latest = new Map();

function log(message) {
	console.log(`${new Date().toISOString()} ${message}`);
}

function announce(key, sequence) {
	if (latest.get(key) >= sequence) {
		return 0;
	}
	latest.set(key, sequence);
	const listeners = clients.get(key) ?? new Set();
	for (const response of listeners) {
		response.write(`event: manifest\ndata: ${JSON.stringify({ sequence })}\n\n`);
	}
	log(`announced ${key} ${sequence} to ${listeners.size} clients`);
	return listeners.size;
}

function handleEvents(request, response, url) {
	const key = `${url.searchParams.get('channel')}/${url.searchParams.get('platform')}`;
	if (!KEY_PATTERN.test(key)) {
		response.writeHead(400).end('channel and platform are required\n');
		return;
	}
	response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
	response.write(': connected\n\n');
	if (latest.has(key)) {
		response.write(`event: manifest\ndata: ${JSON.stringify({ sequence: latest.get(key) })}\n\n`);
	}
	const set = clients.get(key) ?? new Set();
	set.add(response);
	clients.set(key, set);
	// Proxies close idle streams; a comment every 25 s keeps this one open.
	const heartbeat = setInterval(() => response.write(': ping\n\n'), 25_000);
	request.on('close', () => {
		clearInterval(heartbeat);
		set.delete(response);
	});
}

async function handlePublish(request, response) {
	if (!token || request.headers.authorization !== `Bearer ${token}`) {
		response.writeHead(401).end('unauthorized\n');
		return;
	}
	let body = '';
	for await (const chunk of request) {
		body += chunk;
		if (body.length > 4096) {
			response.writeHead(413).end();
			return;
		}
	}
	let message;
	try {
		message = JSON.parse(body);
	} catch {
		response.writeHead(400).end('invalid JSON\n');
		return;
	}
	const key = `${message.channel}/${message.platform}`;
	if (!KEY_PATTERN.test(key) || typeof message.sequence !== 'number') {
		response.writeHead(400).end('channel, platform and sequence are required\n');
		return;
	}
	const count = announce(key, message.sequence);
	response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ clients: count }));
}

function handleStatic(request, response, url) {
	const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
	const file = path.resolve(staticDir, relative);
	if (!file.startsWith(path.resolve(staticDir) + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
		response.writeHead(404).end();
		return;
	}
	const stat = fs.statSync(file);
	const etag = `"${crypto.createHash('sha1').update(`${stat.size}:${stat.mtimeMs}`).digest('hex')}"`;
	if (request.headers['if-none-match'] === etag) {
		response.writeHead(304, { ETag: etag }).end();
		return;
	}
	response.writeHead(200, { 'Content-Length': stat.size, 'ETag': etag, 'Content-Type': file.endsWith('.json') ? 'application/json' : 'application/octet-stream' });
	fs.createReadStream(file).pipe(response);
}

function sequenceOf(manifestPath) {
	try {
		const envelope = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
		return JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8')).sequence;
	} catch {
		return undefined;
	}
}

function watchManifests(dir) {
	const scan = () => {
		for (const channel of ['stable', 'sandbox']) {
			const channelDir = path.join(dir, channel);
			if (!fs.existsSync(channelDir)) {
				continue;
			}
			for (const platform of fs.readdirSync(channelDir)) {
				const sequence = sequenceOf(path.join(channelDir, platform, 'manifest.json'));
				const key = `${channel}/${platform}`;
				if (typeof sequence === 'number' && KEY_PATTERN.test(key)) {
					announce(key, sequence);
				}
			}
		}
	};
	scan();
	setInterval(scan, 1_000);
}

const server = http.createServer((request, response) => {
	const url = new URL(request.url ?? '/', 'http://localhost');
	if (request.method === 'GET' && url.pathname === '/events') {
		handleEvents(request, response, url);
	} else if (request.method === 'POST' && url.pathname === '/publish') {
		void handlePublish(request, response);
	} else if (request.method === 'GET' && url.pathname === '/healthz') {
		response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ clients: [...clients.values()].reduce((sum, set) => sum + set.size, 0), latest: Object.fromEntries(latest) }));
	} else if (request.method === 'GET' && staticDir) {
		handleStatic(request, response, url);
	} else {
		response.writeHead(404).end();
	}
});
// Event streams stay open indefinitely.
server.requestTimeout = 0;
server.headersTimeout = 30_000;
server.listen(port, host, () => {
	log(`live update events on http://${host}:${port}/events${staticDir ? `, serving ${staticDir}` : ''}${watchDir ? `, watching ${watchDir}` : ''}`);
	if (!token) {
		log('BACKBOARD_LIVE_EVENTS_TOKEN is not set: POST /publish is disabled');
	}
});
if (watchDir) {
	watchManifests(watchDir);
}
