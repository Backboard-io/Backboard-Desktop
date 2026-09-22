import { detectCommandShell } from "../../../../utils/commandShell.ts";
import {
	definePrompt,
	hasTool,
	type PromptContext,
	type PromptModule,
} from "../../../PromptModule.ts";
import { agent } from "../../../tools/agent.tsx";
import {
	agentCancel,
	agentSpawn,
	agentSpawnBatch,
} from "../../../tools/agentSpawn.tsx";
import { agentWait } from "../../../tools/agentWait.tsx";
import { computer } from "../../../tools/computer.tsx";
import { generateVideo } from "../../../tools/generateVideo.tsx";
import { glob } from "../../../tools/glob.tsx";
import { grep } from "../../../tools/grep.tsx";
import { todoWrite } from "../../../tools/todoWrite.tsx";

const read = definePrompt(buildReadPrompt(), buildReadPrompt);
const write = definePrompt(buildWritePrompt(), buildWritePrompt);
const edit = definePrompt(buildEditPrompt(), buildEditPrompt);
const applyPatch = definePrompt(buildApplyPatchPrompt(), buildApplyPatchPrompt);
const execute = definePrompt(buildExecutePrompt(), buildExecutePrompt);
const fetchUrl = definePrompt(buildFetchUrlPrompt(), buildFetchUrlPrompt);
const webSearch = definePrompt(buildWebSearchPrompt(), buildWebSearchPrompt);
const askUser = definePrompt(buildAskUserPrompt());
const browser = definePrompt(buildBrowserPrompt());

export const toolPrompts: Record<string, PromptModule> = {
	read,
	write,
	edit,
	apply_patch: applyPatch,
	execute,
	grep,
	glob,
	fetch_url: fetchUrl,
	web_search: webSearch,
	ask_user: askUser,
	todo_write: todoWrite,
	computer,
	browser,
	agent,
	agent_spawn: agentSpawn,
	agent_spawn_batch: agentSpawnBatch,
	agent_cancel: agentCancel,
	agent_wait: agentWait,
	generate_video: generateVideo,
};

function buildReadPrompt(context: PromptContext = {}): string {
	return `Read file content from an exact path.

Use this when you already know the file to inspect, need surrounding code before editing, need a targeted slice after search results, or need to view/analyze a local image file directly. Do not use it for path discovery${hasTool(context, "Glob") ? "; use glob for that" : ""}${hasTool(context, "Grep") ? ", or for content search; use grep for that" : ""}.

Behavior:
- Reads the full file unless offset or limit is provided.
- Large files may be truncated; reread a smaller range when needed.
- Use 0-based line offsets.
- For image files up to 5 MB, returns direct image content for PNG, JPEG/JPG, WebP, GIF, BMP, TIFF/TIF, AVIF, HEIC/HEIF, and ICO.
- Provide an absolute path.
`.trim();
}

function buildWritePrompt(context: PromptContext = {}): string {
	return `Write complete file contents.

Use this primarily for new files. For an existing file, do not use write unless nearly all content must be replaced and a targeted edit or patch cannot express the change.${hasTool(context, "Edit") ? " Batch targeted changes into one edit call instead." : ""}${hasTool(context, "ApplyPatch") ? " Prefer apply_patch for reviewable or multi-file changes." : ""}
Re-emitting a large existing file delays execution because the complete content must be generated before the write can begin.

Behavior:
- Creates missing parent directories when possible.
- Replaces the whole file if it already exists.
- Provide the final complete content, not a diff.
`.trim();
}

function buildEditPrompt(context: PromptContext = {}): string {
	return `Apply exact find-and-replace edits to an existing file.

Use this for targeted changes when the current text is known.${hasTool(context, "Read") ? " Read the file first so old_str values match current content." : ""}

Rules:
- Batch all edits for the same file in one call when practical.
- Preserve existing indentation, line endings, and surrounding style.
- Each old_str must match exactly and be unique unless replace_all is intended.
- Use enough surrounding context in old_str to avoid replacing the wrong occurrence.
- Edits are validated before the file is written.
- Do not use this to create a new file${hasTool(context, "Write") ? "; use write" : hasTool(context, "ApplyPatch") ? "; use apply_patch" : ""}.
`.trim();
}

function buildApplyPatchPrompt(context: PromptContext = {}): string {
	return `Apply a structured patch for file creation, deletion, moves, or edits.

Prefer this for manual source changes when available, especially multi-file edits or changes that should be easy to review. Use generated tooling instead for formatter output or build artifacts.

Patch syntax:
- Start with \`*** Begin Patch\` and end with \`*** End Patch\`.
- Create files with \`*** Add File: <path>\` and prefix each content line with \`+\`.
- Delete files with \`*** Delete File: <path>\`.
- Update files with \`*** Update File: <path>\` followed by hunks.
- Hunk lines use a leading space for context, \`-\` for removal, and \`+\` for addition.
- Move a file by placing \`*** Move to: <path>\` immediately after the update header.
- Include enough context to identify the exact location.
- A patch validates before writing, so failed patches do not partially apply.

Tool relationship:
${mutationAlternatives(context)}
`.trim();
}

function buildExecutePrompt(context: PromptContext = {}): string {
	return `Run a shell command with an optional timeout.

Use this for tests, builds, package managers, git, project scripts, and OS-level checks that no dedicated tool handles. Avoid it for reading files, listing directories, searching code, or editing files when specialized tools are available.

Shell model:
- Each call starts a new isolated shell; working directory changes, exports, aliases, and virtualenv activation do not persist.
- ${shellDescription(context)}
- Use the cwd parameter instead of relying on \`cd\` when possible.
- Quote paths containing spaces or shell metacharacters.
- Chain setup and command in the same call when environment activation is needed.

Safety:
- Understand side effects before running a command.
- Never run destructive commands, broad deletion, forced git reset/checkout, or sudo unless explicitly requested and safe.
- Use non-interactive commands only; avoid flags or tools that require a prompt.
- Before git commit or push, inspect status and staged diff and check for secrets.
- Do not update git config, amend commits, or push unless explicitly requested.
- When killing processes, target explicit PIDs or use patterns that cannot match the kill command itself.

Validation workflow:
- Discover scripts from project files before inventing commands.
- Prefer focused checks during iteration and the strongest practical relevant check before final response.
- If a command times out, inspect partial output and decide whether a longer timeout or narrower check is safer.

Output:
- Command output may be truncated; rerun narrower commands when needed.
- Default timeout is 90 seconds.

Long-running commands and background jobs:
- Do not use \`sleep\` as a polling mechanism for background commands.
- Bad: \`sleep 120 && cat /tmp/job.log\`; repeated \`sleep 60\` followed by \`ps\`, \`tail\`, or log checks; arbitrary sleeps for compilation, tests, training, downloads, or benchmarks.
- If a command may take a long time, use fireAndForget only when you have useful independent work to do. Record the returned PID and temp log path, continue other work, then check process status and logs directly when you need the result.
- If no useful independent work remains, run the command in the foreground with an appropriate timeout instead of backgrounding it and sleeping.
- If the environment provides job wait/status/notification tools, use those instead of shell sleeps.
`.trim();
}

function buildFetchUrlPrompt(context: PromptContext = {}): string {
	return `Fetch raw content from an HTTP or HTTPS URL that the user explicitly provided.

Use this for reading a specific public page, document, or integration URL. Do not use it for web search${hasTool(context, "WebSearch") ? "; use web_search" : ""}, private network targets, local files, or URLs not supplied by the user.

Before fetching:
- Confirm the protocol is http or https.
- Reject localhost, loopback addresses, private IP ranges, file URLs, ssh/ftp schemes, and browser-only schemes.
- Reject malformed URLs, temporary session-token links, API endpoints that require non-GET methods, and corporate/internal infrastructure.
- If the user provides multiple valid URLs, fetch them in parallel when useful.
`.trim();
}

function buildWebSearchPrompt(context: PromptContext = {}): string {
	return `Search the web for current or external public information.

Use this when local context is insufficient and the answer depends on recent facts, public documentation, published references, current APIs, companies, organizations, people, public repositories, or trends. Do not use it for purely local codebase discovery, creative writing, ordinary reasoning, or math.

Guidance:
- Write specific queries with key names, versions, errors, or domains.
- Prefer official sources and primary references when available.
${hasTool(context, "FetchUrl") ? "- Use fetch_url for a permitted user-provided URL when detailed reading is needed." : ""}
`.trim();
}

function buildAskUserPrompt(): string {
	return `Ask the user one or more focused multiple-choice clarification questions.

Use this only when the answer materially changes the result and cannot be safely inferred from context. Do all safe non-blocked work first.

Guidance:
- Batch related decisions into a single call: pass several \`questions\` the user would naturally settle together rather than interrupting repeatedly. Put the most load-bearing question first.
- Give each question a short \`header\` (2-4 words) — headers form a breadcrumb across the top so the user can see and jump between the whole set.
- Keep each question short, specific, and actionable, with clear option labels. The user can always type a custom answer, so do not add an "other" option.
- Include enough context in the question text for the user to understand the tradeoff.
`.trim();
}

function buildBrowserPrompt(): string {
	return `Automate a Chromium browser tab through screenshots and direct page actions.

Use navigate for URLs instead of typing into the address bar. Prefer element IDs from fresh screenshots; use coordinates only as a fallback.

Safety:
- Take or rely on a fresh screenshot before clicking.
- Inspect the result after state-changing actions.
- Ask the user before submitting forms, purchasing, deleting, entering credentials, or changing sensitive settings.
- Queue only the actions needed for the immediate step.


Actions: screenshot, navigate, click, type, key, wait.`.trim();
}

function mutationAlternatives(context: PromptContext): string {
	const alternatives = [
		hasTool(context, "Write") ? "write is best for complete file contents" : "",
		hasTool(context, "Edit")
			? "edit is best for exact targeted replacements"
			: "",
	].filter(Boolean);

	return alternatives.length > 0
		? `- ${alternatives.join(".\n- ")}.`
		: "- Use the safest available file-editing tool for the change.";
}

function shellDescription(context: PromptContext): string {
	const shell =
		context.commandShellKind && context.commandShellPath
			? { kind: context.commandShellKind, path: context.commandShellPath }
			: detectCommandShell();

	if (shell.kind === "posix") return "Commands run under POSIX sh.";
	return `Commands run under bash (${shell.path}); bash syntax such as arrays and [[ ]] is available.`;
}
