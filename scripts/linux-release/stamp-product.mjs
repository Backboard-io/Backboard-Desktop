#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const argumentsByName = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
	argumentsByName.set(process.argv[index], process.argv[index + 1]);
}

function required(name) {
	const value = argumentsByName.get(name);
	if (!value) {
		throw new Error(`Missing required argument ${name}`);
	}
	return value;
}

function readJson(filePath) {
	return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
	fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

const productPath = path.resolve(required('--product'));
const packagePath = path.resolve(required('--package'));
const version = required('--version');
const arch = required('--arch');
const channel = required('--channel');
const builtAt = required('--built-at');
const sourceCommit = required('--source-commit');
const sourceDirtySha256 = required('--source-dirty-sha256');
const buildInfoPathArgument = argumentsByName.get('--build-info');

if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
	throw new Error(`Invalid release version: ${version}`);
}
if (!['stable', 'sandbox'].includes(channel)) {
	throw new Error(`Invalid channel: ${channel}`);
}

const packageJson = readJson(packagePath);
const engineVersion = String(packageJson.version);
if (Number(engineVersion.split('.')[0]) !== 1) {
	throw new Error(
		`VS Code engine version must remain on the 1.x line, but found ${engineVersion}. ` +
		`Backboard's ${version} release version belongs in product branding metadata.`,
	);
}

const stable = channel === 'stable';
const applicationName = stable ? 'backboard-studio' : 'backboard-studio-sandbox';
const displayName = stable ? 'Backboard Studio' : 'Backboard Studio Sandbox';
const productJson = readJson(productPath);

productJson.applicationName = applicationName;
productJson.dataFolderName = stable ? '.backboard-studio' : '.backboard-studio-sandbox';
productJson.nameShort = displayName;
productJson.nameLong = displayName;
productJson.linuxIconName = applicationName;
productJson.version = engineVersion;
productJson.backboardVersion = version;
productJson.backboardStudioVersion = version;
productJson.backboardUpdateChannel = channel;
productJson.date = builtAt;
productJson.backboardBuildInfo = {
	version,
	engineVersion,
	arch,
	channel,
	builtAt,
	sourceCommit,
	sourceDirtySha256,
	sourceApp: 'linux-x86_64-container-build',
};
writeJson(productPath, productJson);

if (buildInfoPathArgument) {
	writeJson(path.resolve(buildInfoPathArgument), {
		...productJson.backboardBuildInfo,
		applicationName,
		displayName,
		packageJsonVersion: packageJson.version,
		productJsonVersion: productJson.version,
		productJsonBackboardVersion: productJson.backboardVersion,
		productJsonBackboardStudioVersion: productJson.backboardStudioVersion,
		productJsonBackboardUpdateChannel: productJson.backboardUpdateChannel,
	});
}

