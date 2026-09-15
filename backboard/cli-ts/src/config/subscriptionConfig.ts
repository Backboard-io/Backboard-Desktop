/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BackboardConfigFile } from "./BackboardConfigTypes.ts";

type SubscriptionConfig = Pick<BackboardConfigFile, "chatgptSubscriptionAuthFile" | "claudeSubscriptionEnabled">;

export function subscriptionConfigPath(homeDir = os.homedir()): string {
	return path.join(homeDir, ".backboard_ide", "subscriptions.json");
}

export function subscriptionAuthPath(homeDir = os.homedir()): string {
	return path.join(homeDir, ".backboard_ide", "chatgpt-auth.json");
}

function readObject(file: string, strict = true): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			if (strict) throw new Error(`Expected a configuration object in ${file}.`);
			return undefined;
		}
		return value as Record<string, unknown>;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function subscriptionFields(config: Record<string, unknown>): SubscriptionConfig {
	return {
		...(typeof config.chatgptSubscriptionAuthFile === "string" && config.chatgptSubscriptionAuthFile.trim()
			? { chatgptSubscriptionAuthFile: config.chatgptSubscriptionAuthFile.trim() } : {}),
		...(typeof config.claudeSubscriptionEnabled === "boolean"
			? { claudeSubscriptionEnabled: config.claudeSubscriptionEnabled } : {}),
	};
}

/** Replace only a complete file, keeping credentials private throughout the write. */
function writeObject(file: string, value: object): void {
	mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const temporary = `${file}.tmp-${randomUUID()}`;
	try {
		writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
		renameSync(temporary, file);
		chmodSync(file, 0o600);
	} finally {
		rmSync(temporary, { force: true });
	}
}

/** Migrate once, removing legacy flags so deleting .backboard_ide stays a reset. */
export function readSubscriptionConfig(homeDir = os.homedir()): SubscriptionConfig {
	const file = subscriptionConfigPath(homeDir);
	const current = readObject(file);
	const legacyFile = path.join(homeDir, ".backboard", "config.json");
	const legacy = readObject(legacyFile, false);
	const hasLegacy = legacy && ("chatgptSubscriptionAuthFile" in legacy || "claudeSubscriptionEnabled" in legacy);
	if (!hasLegacy) return subscriptionFields(current ?? {});

	const config = subscriptionFields(current ?? legacy);
	const oldAuthFile = path.join(homeDir, ".backboard", "chatgpt-auth.json");
	const newAuthFile = subscriptionAuthPath(homeDir);
	let movedAuth = false;
	if (!current && config.chatgptSubscriptionAuthFile === oldAuthFile) {
		const auth = readObject(oldAuthFile);
		// Imported vendor credentials remain owned by that vendor.
		if (auth?.managed_by === "backboard") {
			const destination = readObject(newAuthFile);
			if (destination && JSON.stringify(destination) !== JSON.stringify(auth)) {
				throw new Error("A different ChatGPT login already exists in .backboard_ide. Reconnect ChatGPT before migrating the old login.");
			}
			if (!destination) writeObject(newAuthFile, auth);
			config.chatgptSubscriptionAuthFile = newAuthFile;
			movedAuth = true;
		}
	}
	if (!current) writeObject(file, config);
	const { chatgptSubscriptionAuthFile: _chatgpt, claudeSubscriptionEnabled: _claude, ...remaining } = legacy;
	writeObject(legacyFile, remaining);
	if (movedAuth) rmSync(oldAuthFile, { force: true });
	return config;
}

export function saveSubscriptionConfig(config: SubscriptionConfig, homeDir = os.homedir()): void {
	const file = subscriptionConfigPath(homeDir);
	const fields = subscriptionFields(config);
	if (Object.keys(fields).length || existsSync(file)) writeObject(file, fields);
}
