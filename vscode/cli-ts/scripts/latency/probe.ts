import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const cfg = JSON.parse(readFileSync(join(homedir(), ".backboard_ide", "config.json"), "utf8"));
const env = cfg.env ?? "prod";
const apiKey = cfg.api_key || cfg.env_keys?.[env] || "";
const apiUrl = "https://app.backboard.io/api";
const captured = JSON.parse(readFileSync(join(process.env.SCRATCH!, "bench-results.json"), "utf8"));
// rebuild a full body from captured meta is not stored; re-capture from a serve server.jsonl is gone.
// Instead reconstruct minimal + a "full-ish" body using the captured meta model.
const model = captured.meta.model.split("/");

async function probe(label: string, body: any) {
	const t0 = performance.now();
	const res = await fetch(`${apiUrl}/threads/messages`, {
		method: "POST",
		headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
		body: JSON.stringify({ ...body, stream: true }),
	});
	console.log(`\n=== ${label} === status ${res.status}, headers@${Math.round(performance.now() - t0)}ms`);
	const reader = res.body!.getReader();
	const dec = new TextDecoder();
	let buf = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buf += dec.decode(value, { stream: true });
		let nl: number;
		while ((nl = buf.indexOf("\n")) >= 0) {
			const l = buf.slice(0, nl).trim();
			buf = buf.slice(nl + 1);
			if (!l) continue;
			console.log(`  @${String(Math.round(performance.now() - t0)).padStart(5)}ms  ${l.slice(0, 100)}`);
		}
	}
	console.log(`  DONE @${Math.round(performance.now() - t0)}ms`);
}

const bigPrompt = "You are a coding agent. ".repeat(150); // ~3.5KB, similar to captured system_prompt
const fakeTools = Array.from({ length: 11 }, (_, i) => ({
	type: "function",
	function: { name: `tool_${i}`, description: "x".repeat(400), parameters: { type: "object", properties: { a: { type: "string" } } } },
}));

await probe("MINIMAL", { content: "Reply with one word: pong.", llm_provider: model[0], model_name: model[1] });
await probe("FULL-ish (3.5KB system + 11 tools)", {
	content: "Reply with one word: pong.",
	llm_provider: model[0],
	model_name: model[1],
	system_prompt: bigPrompt,
	tools: fakeTools,
});
process.exit(0);
