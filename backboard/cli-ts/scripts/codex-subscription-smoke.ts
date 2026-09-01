import { runCodexSubscriptionSmoke } from "../src/providers/subscription/CodexSubscriptionSmoke.ts";

function argumentValue(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

try {
	const result = await runCodexSubscriptionSmoke({
		model: argumentValue("--model"),
		prompt: argumentValue("--prompt"),
		onProgress: (message) => console.log(`[smoke] ${message}`),
	});
	console.log(`[smoke] PASS: ${result.model} called ${result.toolCallId}`);
	console.log(
		`[smoke] Local tool output: ${JSON.stringify(result.toolOutput)}`,
	);
	console.log(`[smoke] Assistant continuation: ${result.assistantText}`);
} catch (error) {
	console.error(
		`[smoke] FAIL: ${error instanceof Error ? error.message : String(error)}`,
	);
	process.exitCode = 1;
}
