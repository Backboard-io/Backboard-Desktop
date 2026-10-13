import { detectCommandShell } from "../../utils/commandShell.ts";
import {
	definePrompt,
	hasTool,
	type PromptContext,
	type PromptModule,
} from "../PromptModule.ts";

export const execute: PromptModule = definePrompt(
	buildExecutePrompt(),
	buildExecutePrompt,
);

function buildExecutePrompt(context: PromptContext = {}): string {
	const dedicated = [
		"Read",
		"Grep",
		"Glob",
		"Write",
		"Edit",
		"ApplyPatch",
	].filter((tool) => hasTool(context, tool));
	return `Run a shell command for tests, builds, git, project scripts, or OS operations. The schema defines arguments and limits.

${dedicated.length ? `Prefer available dedicated tools (${dedicated.join(", ")}) for their supported file operations.` : ""}

${shellGuidance(context)}
Each call starts an isolated shell: cwd changes, exports, aliases, and environment activation do not persist. Use cwd explicitly and quote paths and literals with appropriate shell escaping. Do not interpolate untrusted text into shell code. For a virtual environment, call its executable directly (for example .venv/bin/python), or activate and execute in one call. Do not repeat environment probes when supplied context already answers them.

Understand side effects and use non-interactive commands. Preserve user edits and honor permission denials and cancellation. Destructive commands, sudo, git configuration changes, amending commits, and pushes require explicit authorization. Before a requested commit or push, inspect status and the staged diff for scope, secrets, and generated noise; stage only intended files. Check hook changes before a retry and never amend unrelated work.

Use the project's relevant validation command and respect requested acceptance criteria. Once sufficient checks pass, finish; broaden or repeat only for a new change, failure, or unresolved risk. A successful unrelated command is not validation.

Timeout defaults to 90 seconds. Exit code 124 means execute timed out the command; inspect partial output before deciding whether a longer timeout is appropriate. Output can be truncated; a partial transcript is not proof of full output.

Do not use \`sleep\` as a polling mechanism for background commands. Use fireAndForget only when useful independent work remains, record the PID and log path, then inspect process status and logs when needed. Otherwise run in the foreground with an appropriate timeout. Prefer available job wait/status tools. Stop only the intended process, using its PID or a pattern that cannot match the kill command itself.`;
}

function shellGuidance(context: PromptContext): string {
	const shell =
		context.commandShellKind && context.commandShellPath
			? { kind: context.commandShellKind, path: context.commandShellPath }
			: detectCommandShell();
	if (shell.kind === "posix") {
		return "Shell: Commands run under POSIX `sh`.";
	}
	return `Shell: commands run under bash (${shell.path}). Bash features such as \`[[ ]]\`, arrays, and process substitution are available.`;
}
