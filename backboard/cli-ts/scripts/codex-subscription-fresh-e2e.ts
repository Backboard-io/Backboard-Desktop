import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CHATGPT_SUBSCRIPTION_AUTH_FILE_ENV } from "../src/config/auth.ts";
import type { AgentEvent } from "../src/core/bus/events.ts";
import { CodexSubscriptionClient } from "../src/providers/subscription/CodexSubscriptionClient.ts";
import { loadCodexSubscriptionCredentials } from "../src/providers/subscription/CodexSubscriptionSmoke.ts";

interface JsonEventRecord {
	type: AgentEvent["type"];
	payload: AgentEvent;
}

interface ChatEvidence {
	toolStarts: Extract<AgentEvent, { type: "tool:start" }>[];
	toolResults: Extract<AgentEvent, { type: "tool:result" }>[];
	assistantMessages: Extract<AgentEvent, { type: "assistant:message" }>[];
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(scriptDir, "..");
const cliEntrypoint = join(packageDir, "src", "entrypoints", "cli.tsx");
const repositoryRoot = resolve(packageDir, "..", "..");
const runName = new Date()
	.toISOString()
	.replaceAll(":", "-")
	.replaceAll(".", "-");
const workspace = join(
	repositoryRoot,
	"artifacts",
	"codex-subscription-e2e",
	`fresh-workspace-${runName}`,
);
const fakeInstallRoot = await mkdtemp(
	join(tmpdir(), "backboard-codex-subscription-fresh-e2e-"),
);
const fakeHome = join(fakeInstallRoot, "home");
const fakeCodexHome = join(fakeHome, ".codex");
const fakeAuthFile = join(fakeCodexHome, "auth.json");

const firstContents = [
	"Chat 1: created by the Backboard CLI using a ChatGPT subscription.",
	"Harness: Backboard ToolScheduler.",
	"",
].join("\n");
const secondContents = [
	"Chat 2: a separate fresh CLI process used the same isolated subscription login.",
	"The model requested this edit; Backboard ApplyPatch performed it.",
	"",
].join("\n");

await mkdir(workspace, { recursive: true });
await mkdir(fakeCodexHome, { recursive: true });

try {
	const sourceCredentials = await loadCodexSubscriptionCredentials();
	await writeFile(
		fakeAuthFile,
		`${JSON.stringify(
			{
				auth_mode: "chatgpt",
				tokens: {
					access_token: sourceCredentials.accessToken,
					account_id: sourceCredentials.accountId,
				},
			},
			null,
			2,
		)}\n`,
		{ mode: 0o600 },
	);
	await chmod(fakeAuthFile, 0o600);

	const catalog = await new CodexSubscriptionClient({
		authFile: fakeAuthFile,
	}).listModels();
	const model = process.env.BACKBOARD_CHATGPT_SUBSCRIPTION_E2E_MODEL?.trim()
		? catalog.models.find(
				(candidate) =>
					candidate.name ===
					process.env.BACKBOARD_CHATGPT_SUBSCRIPTION_E2E_MODEL?.trim(),
			)?.name
		: catalog.models[0]?.name;
	if (!model) {
		throw new Error("No requested ChatGPT subscription model is available.");
	}

	console.log(`[e2e] FRESH HOME  ${fakeHome}`);
	console.log(`[e2e] WORKSPACE   ${workspace}`);
	console.log(
		"[e2e] AUTH        copied minimum login fields; no refresh token",
	);
	console.log("[e2e] CODEX CLI   excluded from child-process PATH");
	console.log(`[e2e] MODEL       ${model}`);

	const first = await runChat(
		"chat-1",
		model,
		[
			"Use ApplyPatch to create chat-one.txt with exactly these two lines and a trailing newline:",
			"Chat 1: created by the Backboard CLI using a ChatGPT subscription.",
			"Harness: Backboard ToolScheduler.",
			"Then use Read to verify chat-one.txt. Do not use any other tool. Finish with one short sentence.",
		].join("\n"),
	);
	assertToolEvidence("chat-1", first, 1);
	await assertFile(join(workspace, "chat-one.txt"), firstContents);

	const second = await runChat(
		"chat-2",
		model,
		[
			"This is a separate chat. First use Read on chat-one.txt.",
			"Then use ApplyPatch to create nested/chat-two.txt with exactly these two lines and a trailing newline:",
			"Chat 2: a separate fresh CLI process used the same isolated subscription login.",
			"The model requested this edit; Backboard ApplyPatch performed it.",
			"Finally use Read on nested/chat-two.txt. Do not use any other tool. Finish with one short sentence.",
		].join("\n"),
	);
	assertToolEvidence("chat-2", second, 2);
	await assertFile(join(workspace, "nested", "chat-two.txt"), secondContents);

	console.log("[e2e] PASS        2 real CLI chats completed");
	console.log(
		"[e2e] PASS        all mutation/read calls ran through Backboard tools",
	);
	console.log("[e2e] PASS        both text files match exact expected bytes");
	console.log(`[e2e] OUTPUT      ${workspace}`);
} finally {
	// The output workspace is intentionally retained; the temporary credential
	// copy and fake home are always removed.
	await rm(fakeInstallRoot, { recursive: true, force: true });
}

async function runChat(
	label: string,
	model: string,
	prompt: string,
): Promise<ChatEvidence> {
	console.log(`[e2e] CHAT        ${label}`);
	const child = Bun.spawn(
		[
			process.execPath,
			cliEntrypoint,
			"--format",
			"json",
			"--fresh",
			"--model",
			`openai-subscription/${model}`,
			"--thinking",
			"low",
			"--memory",
			"off",
			"--permission-mode",
			"bypass",
			"--no-final-verification",
			"--excluded-tools",
			[
				"Write",
				"Edit",
				"Execute",
				"Grep",
				"Glob",
				"FetchUrl",
				"WebSearch",
				"AskUser",
				"TodoWrite",
				"Computer",
				"Browser",
				"Agent",
				"FindSkill",
				"FindMcp",
			].join(","),
			"--cwd",
			workspace,
			"--print",
			prompt,
		],
		{
			cwd: workspace,
			env: {
				...process.env,
				HOME: fakeHome,
				CODEX_HOME: fakeCodexHome,
				PATH: "/usr/bin:/bin",
				[CHATGPT_SUBSCRIPTION_AUTH_FILE_ENV]: fakeAuthFile,
				BACKBOARD_API_KEY: "",
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);

	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(
			`${label} CLI exited ${exitCode}: ${stderr.trim() || stdout.trim()}`,
		);
	}
	if (stderr.trim()) console.log(`[e2e] STDERR      ${stderr.trim()}`);

	const records = stdout
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as JsonEventRecord);
	const events = records.map((record) => record.payload);
	const toolStarts = events.filter(
		(event): event is Extract<AgentEvent, { type: "tool:start" }> =>
			event.type === "tool:start",
	);
	const toolResults = events.filter(
		(event): event is Extract<AgentEvent, { type: "tool:result" }> =>
			event.type === "tool:result",
	);
	const assistantMessages = events.filter(
		(event): event is Extract<AgentEvent, { type: "assistant:message" }> =>
			event.type === "assistant:message",
	);

	for (const event of toolStarts) {
		console.log(
			`[cli:${label}] TOOL START  ${event.name} ${event.inputSummary}`,
		);
	}
	for (const event of toolResults) {
		console.log(`[cli:${label}] TOOL RESULT ${event.name}: ${event.title}`);
	}
	for (const event of assistantMessages) {
		console.log(`[cli:${label}] ASSISTANT   ${event.text}`);
	}

	return { toolStarts, toolResults, assistantMessages };
}

function assertToolEvidence(
	label: string,
	evidence: ChatEvidence,
	minimumReads: number,
): void {
	const names = evidence.toolStarts.map((event) => event.name);
	if (!names.includes("ApplyPatch")) {
		throw new Error(`${label} did not execute Backboard ApplyPatch.`);
	}
	if (names.filter((name) => name === "Read").length < minimumReads) {
		throw new Error(
			`${label} did not execute the expected Backboard Read calls.`,
		);
	}
	if (evidence.toolResults.length !== evidence.toolStarts.length) {
		throw new Error(`${label} had a tool call without a successful result.`);
	}
	if (evidence.assistantMessages.length === 0) {
		throw new Error(`${label} produced no final assistant message.`);
	}
}

async function assertFile(path: string, expected: string): Promise<void> {
	const actual = await readFile(path, "utf8");
	if (actual !== expected) {
		throw new Error(
			`Unexpected contents for ${path}. Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`,
		);
	}
}
