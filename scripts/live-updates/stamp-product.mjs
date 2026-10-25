#!/usr/bin/env node
// Writes `backboardLiveUpdate` into a packaged app's product.json:
//   node scripts/live-updates/stamp-product.mjs --product PATH --channel stable --platform darwin-arm64
//
// The keys are the trust anchor for live updates, so they only ever come from
// the release machine: BACKBOARD_LIVE_UPDATE_PUBLIC_KEYS (comma separated), or
// ~/.backboard/live-update-signing/public-key.txt written by `publish.mjs keygen`.
// Without keys the build ships with live updates off.
//
// BACKBOARD_LIVE_UPDATE_MANIFEST_BASE_URL  where upload_live_update.sh puts channels
// BACKBOARD_LIVE_UPDATE_EVENTS_URL         optional events-server.mjs endpoint

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const args = process.argv.slice(2);
const option = name => {
	const index = args.indexOf(`--${name}`);
	const value = index >= 0 ? args[index + 1] : undefined;
	if (!value) {
		console.error(`--${name} is required`);
		process.exit(1);
	}
	return value;
};
const productPath = option('product');
const channel = option('channel');
const platform = option('platform');
if (!/^(darwin|win32|linux)-(arm64|x64)$/.test(platform)) {
	console.error(`--platform must look like darwin-arm64, got ${platform}`);
	process.exit(1);
}

const keyFile = path.join(os.homedir(), '.backboard', 'live-update-signing', 'public-key.txt');
const keys = (process.env.BACKBOARD_LIVE_UPDATE_PUBLIC_KEYS || (fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8') : ''))
	.split(/[\s,]+/)
	.filter(Boolean);
const base = (process.env.BACKBOARD_LIVE_UPDATE_MANIFEST_BASE_URL || 'https://backboard-studio-releases.s3.ca-central-1.amazonaws.com/ide-releases/live').replace(/\/+$/, '');
const eventsUrl = process.env.BACKBOARD_LIVE_UPDATE_EVENTS_URL?.trim();

const product = JSON.parse(fs.readFileSync(productPath, 'utf8'));
if (keys.length) {
	product.backboardLiveUpdate = {
		manifestUrl: `${base}/${channel}/${platform}/manifest.json`,
		...(eventsUrl ? { eventsUrl } : {}),
		publicKeys: keys,
	};
	console.log(`Live updates on: ${product.backboardLiveUpdate.manifestUrl} (${keys.length} key${keys.length === 1 ? '' : 's'})`);
} else {
	delete product.backboardLiveUpdate;
	console.log(`Live updates off: no public key (set BACKBOARD_LIVE_UPDATE_PUBLIC_KEYS or create ${keyFile})`);
}
fs.writeFileSync(productPath, `${JSON.stringify(product, null, 2)}\n`);
