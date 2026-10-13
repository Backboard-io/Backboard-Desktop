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
const buildInfoPathArgument = argumentsByName.get('--build-info');

if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
	throw new Error(`Invalid release version: ${version}`);
}
if (!['x64', 'arm64'].includes(arch)) {
	throw new Error(`Invalid Windows architecture: ${arch}`);
}
if (!['stable', 'sandbox'].includes(channel)) {
	throw new Error(`Invalid release channel: ${channel}`);
}
if (!/^[0-9a-fA-F]{40}$/.test(sourceCommit)) {
	throw new Error(`Invalid source commit: ${sourceCommit}`);
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
productJson.sharedDataFolderName = stable ? '.backboard-studio-shared' : '.backboard-studio-sandbox-shared';
productJson.nameShort = displayName;
productJson.nameLong = displayName;
productJson.win32DirName = displayName;
productJson.win32NameVersion = displayName;
productJson.win32RegValueName = stable ? 'BackboardStudio' : 'BackboardStudioSandbox';
productJson.win32ShellNameShort = displayName;
productJson.win32MutexName = applicationName;
productJson.win32TunnelServiceMutex = `${applicationName}-tunnelservice`;
productJson.win32TunnelMutex = `${applicationName}-tunnel`;
productJson.win32AppUserModelId = stable ? 'Backboard.Studio' : 'Backboard.Studio.Sandbox';
productJson.win32x64AppId = stable ? '{{D77B7E06-80BA-4137-BCF4-654B95CCEBC5}' : '{{475B1643-C2FF-4A51-B953-9CEAF015AF58}';
productJson.win32arm64AppId = stable ? '{{D1ACE434-89C5-48D1-88D3-E2991DF85475}' : '{{0009EB01-7467-4C3F-98F4-0E9FA6473CA4}';
productJson.win32x64UserAppId = stable ? '{{CC6B787D-37A0-49E8-AE24-8559A032BE0C}' : '{{3B22DF3D-8D74-42AA-A2B1-FDAC72471A7B}';
productJson.win32arm64UserAppId = stable ? '{{3AEBF0C8-F733-4AD4-BADE-FDB816D53D7B}' : '{{0C96832E-B383-47E5-A9EC-EFD4C18E185E}';
productJson.version = engineVersion;
productJson.backboardVersion = version;
productJson.backboardStudioVersion = version;
productJson.backboardUpdateChannel = channel;
productJson.date = builtAt;
productJson.commit = sourceCommit;
productJson.backboardBuildInfo = {
	version,
	engineVersion,
	arch,
	channel,
	builtAt,
	sourceCommit,
	sourceApp: `windows-${arch}-github-actions`,
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
