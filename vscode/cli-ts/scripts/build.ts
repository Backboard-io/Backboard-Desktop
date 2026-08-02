#!/usr/bin/env bun
import { APP_COMMAND_NAME } from "../src/config/branding.ts";

const command = [
	"bun",
	"build",
	"--compile",
	"--outfile",
	APP_COMMAND_NAME,
	"./src/entrypoints/cli.tsx",
];

// Cross-compilation target, e.g. "bun-darwin-x64". Without it bun compiles for
// whatever host runs the build, which silently produces an arm64 CLI inside an
// Intel release when building x64 on Apple Silicon.
const compileTarget = process.env.BACKBOARD_CLI_TARGET?.trim();
if (compileTarget) {
	command.splice(3, 0, "--target", compileTarget);
}

const oauthClientId = process.env.BACKBOARD_OAUTH_CLIENT_ID?.trim();
if (oauthClientId) {
	command.splice(
		3,
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
