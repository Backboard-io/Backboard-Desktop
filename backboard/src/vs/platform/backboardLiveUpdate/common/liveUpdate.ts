/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Live updates ship Backboard's JavaScript without a new signed app. A signed
 * manifest lists components; the Backboard extension downloads and verifies
 * them into `<userData>/LiveUpdates`, then writes a small pointer file per
 * component. The boot loader (`bootstrap-live.ts`) and the agent host only read
 * those pointers, re-checking the signature against the keys pinned in the
 * installed app's product.json.
 *
 * Layout of the live updates folder:
 *   app/current.json   pointer to the staged app overlay (out/ + extensions/)
 *   app/boot.json      start attempts of the active overlay, reset once it runs
 *   app/bad.json       overlay ids that failed to start and must not run again
 *   app/<id>/          the overlay root, used in place of the installed app root
 *   agent/current.json pointer to the staged cli-ts JavaScript bundle
 *   agent/<id>/        the bundle, run by the app's signed cli-ts executable
 */

/** Set by the boot loader for every process the app starts. */
export const LIVE_UPDATES_DIR_ENV = 'BACKBOARD_LIVE_UPDATES_DIR';
/** The installed app root (`Contents/Resources/app`), also when an overlay runs. */
export const LIVE_BASE_APP_ROOT_ENV = 'BACKBOARD_LIVE_BASE_APP_ROOT';
/** Id of the overlay the running app started from; unset when it runs the installed app. */
export const LIVE_APP_ID_ENV = 'BACKBOARD_LIVE_APP_ID';
/** Why the boot loader picked the overlay or the installed app, for the update log. */
export const LIVE_APP_SELECTION_ENV = 'BACKBOARD_LIVE_APP_SELECTION';

/** Overlay start attempts allowed before the overlay is marked bad. */
export const LIVE_APP_MAX_BOOT_ATTEMPTS = 3;

/** cli-ts control protocol the host speaks. A bundle declaring another one is ignored. */
export const LIVE_AGENT_PROTOCOL_VERSION = 1;

/** Ids become folder names, so they are restricted to a safe alphabet. */
export const LIVE_UPDATE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,95}$/;

/** `backboardLiveUpdate` in product.json. Absent or without keys: live updates are off. */
export interface ILiveUpdateProductConfiguration {
	readonly manifestUrl?: string;
	readonly eventsUrl?: string;
	/** Base64 DER (SPKI) Ed25519 public keys. Any one of them may sign a manifest. */
	readonly publicKeys?: readonly string[];
}

export interface ILiveUpdateSignature {
	/** First 16 hex characters of sha256 over the DER public key. */
	readonly keyId: string;
	readonly signature: string;
}

/** What the server publishes: the manifest bytes plus detached signatures over them. */
export interface ILiveUpdateEnvelope {
	/** Base64 of the UTF-8 manifest JSON. Signatures cover these exact bytes. */
	readonly payload: string;
	readonly signatures: readonly ILiveUpdateSignature[];
}

export interface ILiveUpdateFileSet {
	/** Gzipped JSON file list, relative to the manifest URL. */
	readonly url: string;
	readonly sha256: string;
	readonly count: number;
	readonly bytes: number;
}

export interface ILiveUpdateRollout {
	/** 0–100. Machines hash into a bucket; buckets below the percentage take the update. */
	readonly percent: number;
	readonly salt?: string;
}

export interface ILiveAppComponent {
	readonly id: string;
	/** Installed app versions (`backboardVersion`) the overlay was built against. */
	readonly bases: readonly string[];
	/** Electron version of those installs. Native modules are shared, so it must match. */
	readonly electron: string;
	readonly files: ILiveUpdateFileSet;
	readonly rollout?: ILiveUpdateRollout;
	/** Ask the user to restart now instead of waiting for the next launch. */
	readonly urgent?: boolean;
	readonly notes?: string;
}

export interface ILiveAgentComponent {
	readonly id: string;
	readonly bases: readonly string[];
	readonly protocolVersion: number;
	/** Bun version embedded in the cli-ts executable the bundle was built for. */
	readonly bunVersion: string;
	/** Entry file inside the bundle, e.g. `cli.js`. */
	readonly entry: string;
	readonly entrySha256: string;
	readonly files: ILiveUpdateFileSet;
	readonly rollout?: ILiveUpdateRollout;
	readonly notes?: string;
}

export interface ILiveUpdateAnnouncement {
	readonly id: string;
	readonly message: string;
	readonly severity?: 'info' | 'warning';
	readonly url?: string;
}

export interface ILiveUpdateConfig {
	/** Exposed as `backboard.flag.<name>` context keys and to the agent runtime. */
	readonly flags?: Readonly<Record<string, string | number | boolean>>;
	readonly announcement?: ILiveUpdateAnnouncement;
	/** How often clients re-read the manifest when no push channel is connected. */
	readonly pollIntervalSeconds?: number;
}

/**
 * The full desired state of one channel and platform. A component missing from
 * a newer manifest is rolled back to what the installed app ships.
 */
export interface ILiveUpdateManifest {
	readonly schema: 1;
	readonly channel: string;
	readonly platform: string;
	readonly arch: string;
	/** Increases with every publish. Clients never accept a lower one (no replay). */
	readonly sequence: number;
	readonly createdAt: string;
	readonly components: {
		readonly app?: ILiveAppComponent;
		readonly agent?: ILiveAgentComponent;
	};
	readonly config?: ILiveUpdateConfig;
	/** Component ids that must stop running even on clients that already have them. */
	readonly revoked?: readonly string[];
}

interface ILiveComponentPointer {
	readonly schema: 1;
	readonly id: string;
	/** The verified envelope the component came from, re-checked by every reader. */
	readonly manifest: ILiveUpdateEnvelope;
	readonly stagedAt: string;
}

export type ILiveAppPointer = ILiveComponentPointer;

export interface ILiveAgentPointer extends ILiveComponentPointer {
	/** Absolute path of the entry file. */
	readonly entry: string;
}

/**
 * Written by the boot loader for every primary start, overlay or not. A later
 * launch that finds `pid` alive is a second instance that only hands its
 * arguments to the running one, so it runs the same code and counts nothing.
 */
export interface ILiveAppBootRecord {
	/** Overlay the primary instance started from; undefined = the installed app. */
	readonly id?: string;
	/** Starts of this overlay since it last reached a healthy state. */
	readonly attempts: number;
	readonly pid?: number;
	/** Set by the extension host once the overlay is up. */
	readonly healthy?: boolean;
}

export interface ILiveAppBadRecord {
	readonly ids: readonly string[];
}
