/**
 * Isolate backend server-prep vs model-TTFT, and the assistant_id effect.
 * Measures time-to-phase from the Backboard SSE stream:
 *   stateless_prep (ack) -> prep (server assembly done) -> content_streaming (first token) -> run_ended
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const cfg = JSON.parse(readFileSync(join(homedir(), ".backboard_ide", "config.json"), "utf8"));
const env = cfg.env ?? "prod";
const apiKey = cfg.api_key || cfg.env_keys?.[env] || "";
const apiUrl = "https://app.backboard.io/api";
const cache = JSON.parse(readFileSync(join(homedir(), ".backboard", "assistants-cache.json"), "utf8"));
const assistantId = Object.values(cache)[0] as string;
const MODEL = ["openai", "gpt-5.5"];
const N = 4;

const bigPrompt = "You are a coding agent. Follow instructions carefully. ".repeat(70); // ~3.9KB
const tools = Array.from({ length: 11 }, (_, i) => ({
	type: "function",
	function: { name: `tool_${i}`, description: "x".repeat(400), parameters: { type: "object", properties: { a: { type: "string" } } } },
}));

interface Marks { statelessPrep: number; prep: number; firstToken: number; end: number; total: number; }

async function one(body: any): Promise<Marks> {
	const t0 = performance.now();
	const res = await fetch(`${apiUrl}/threads/messages`, {
		method: "POST", headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
		body: JSON.stringify({ ...body, stream: true }),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
	const reader = res.body!.getReader();
	const dec = new TextDecoder();
	let buf = "";
	const m: Marks = { statelessPrep: NaN, prep: NaN, firstToken: NaN, end: NaN, total: NaN };
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buf += dec.decode(value, { stream: true });
		let nl: number;
		while ((nl = buf.indexOf("\n")) >= 0) {
			const l = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
			if (!l.startsWith("data:")) continue;
			const now = performance.now() - t0;
			const s = l.slice(5).trim();
			if (s.includes('"stateless_prep"') && Number.isNaN(m.statelessPrep)) m.statelessPrep = now;
			else if (s.includes('"phase": "prep"') && Number.isNaN(m.prep)) m.prep = now;
			if (s.includes('"content_streaming"') && Number.isNaN(m.firstToken)) m.firstToken = now;
			if (s.includes('"run_ended"')) m.end = now;
		}
	}
	m.total = performance.now() - t0;
	return m;
}

function agg(label: string, rows: Marks[]) {
	const col = (k: keyof Marks) => {
		const xs = rows.map(r => r[k]).filter(Number.isFinite).sort((a, b) => a - b);
		return xs.length ? Math.round(xs[Math.floor(xs.length / 2)]) : NaN;
	};
	console.log(`  ${label.padEnd(34)} statelessPrep=${String(col("statelessPrep")).padStart(5)}ms  prep=${String(col("prep")).padStart(5)}ms  firstToken=${String(col("firstToken")).padStart(5)}ms  end=${String(col("end")).padStart(5)}ms`);
}

const variants: { label: string; body: any }[] = [
	{ label: "A) minimal (content only)", body: { content: "Reply one word: pong.", llm_provider: MODEL[0], model_name: MODEL[1] } },
	{ label: "B) inline sysprompt+11 tools", body: { content: "Reply one word: pong.", llm_provider: MODEL[0], model_name: MODEL[1], system_prompt: bigPrompt, tools } },
	{ label: "C) assistant_id only", body: { content: "Reply one word: pong.", assistant_id: assistantId, llm_provider: MODEL[0], model_name: MODEL[1] } },
	{ label: "D) assistant_id+sysprompt+tools", body: { content: "Reply one word: pong.", assistant_id: assistantId, llm_provider: MODEL[0], model_name: MODEL[1], system_prompt: bigPrompt, tools } },
];

console.log(`# Backend phase decomposition (median of N=${N}), assistant_id=${assistantId.slice(0, 8)}…, model=${MODEL.join("/")}`);
console.log(`# times are ms from request-sent; prep-statelessPrep = server assembly, firstToken-prep = model TTFT`);
for (const v of variants) {
	const rows: Marks[] = [];
	for (let i = 0; i < N; i++) {
		try { rows.push(await one(v.body)); } catch (e) { console.log(`  ${v.label} iter ${i} FAILED ${(e as Error).message}`); }
	}
	agg(v.label, rows);
}
process.exit(0);
