import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Commands macOS ships in /usr/bin only as stubs for the Command Line Tools.
 * When the tools are not installed, running one pops the system "install
 * command line developer tools" dialog instead of running anything.
 */
const DEVELOPER_TOOL_STUBS = new Set([
	"git",
	"python3",
	"pip3",
	"swift",
	"swiftc",
	"clang",
	"cc",
	"make",
]);

let toolsInstalled: Promise<boolean> | undefined;

function commandLineToolsInstalled(): Promise<boolean> {
	toolsInstalled ??= new Promise((resolve) => {
		execFile("/usr/bin/xcode-select", ["-p"], (error, stdout) => {
			resolve(!error && existsSync(stdout.trim()));
		});
	});
	return toolsInstalled;
}

/**
 * True when running `command` would hit a Command Line Tools stub on a Mac
 * without the tools, i.e. it would raise the install dialog rather than run.
 * Automatic probes must skip such commands; a Homebrew or other non-stub
 * install earlier on PATH is used normally.
 */
export async function wouldPromptForDeveloperTools(
	command: string,
	path = process.env.PATH,
): Promise<boolean> {
	if (process.platform !== "darwin" || !DEVELOPER_TOOL_STUBS.has(command)) {
		return false;
	}
	const resolved = Bun.which(command, { PATH: path ?? "" });
	if (resolved === null || dirname(resolved) !== "/usr/bin") return false;
	return !(await commandLineToolsInstalled());
}
