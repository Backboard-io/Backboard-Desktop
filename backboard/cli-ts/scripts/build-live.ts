#!/usr/bin/env bun
// Builds cli-ts as a plain JavaScript bundle for live updates. The installed
// app runs it with its signed cli-ts executable in Bun runtime mode
// (BUN_BE_BUN=1), so the bundle mirrors scripts/build.ts minus --compile.
import { buildIdentityArgs } from "./buildIdentity.ts";

const outdir = process.env.BACKBOARD_CLI_LIVE_OUTDIR?.trim() || "dist-live";

const command = [
	"bun",
	"build",
	"--target",
	"bun",
	"--outdir",
	outdir,
	// The variable that put the executable in runtime mode must not reach the
	// bundle's own children: `claude` and other Bun executables would start as
	// a bare Bun runtime instead of themselves.
	"--banner",
	"delete process.env.BUN_BE_BUN;",
	...(await buildIdentityArgs()),
	"./src/entrypoints/cli.tsx",
];

const oauthClientId = process.env.BACKBOARD_OAUTH_CLIENT_ID?.trim();
if (oauthClientId) {
	command.splice(
		2,
		0,
		"--define",
		`process.env.BACKBOARD_OAUTH_CLIENT_ID=${JSON.stringify(oauthClientId)}`,
	);
}

const child = Bun.spawn(command, {
	stdout: "inherit",
	stderr: "inherit",
});

const code = await child.exited;
if (code !== 0) {
	process.exit(code);
}
