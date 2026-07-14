/**
 * First-turn latency benchmark for the Backboard AI IDE.
 *
 * Isolates where first-turn time goes by measuring three layers with the SAME
 * backend account/model/prompt:
 *
 *   L1 RAW API   — direct fetch to the Backboard backend (the "just an API call"
 *                  baseline). Replays the exact POST /threads/messages bytes the
 *                  CLI sends, plus a minimal-payload variant, plus the GET
 *                  /assistants scan the warmup does.
 *   L2 SERVE     — the real `backboard --serve` binary the IDE spawns, driven
 *                  over stdio exactly like the IDE's BackboardBridge does.
 *                  Measured cold (submit immediately) and warm (warmup first).
 *
 * The IDE renderer/agent-host layer (L3) sits on top of L2; it is analyzed
 * separately from code. This harness pins the L1↔L2 gap = pure client overhead.
 *
 * Run:  bun bench.ts
 */

import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { createInterface } from "node:readline";

const BIN = "/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/cli-ts/backboard";
const DEFAULT_API_URL = "https://app.backboard.io/api";
const PROMPT = "Reply with exactly one word: pong. Do not call any tools.";
const SERVE_ITERS = 3;
const RAW_ITERS = 5;
const TURN_TIMEOUT_MS = 90_000;

// ---------- creds (mirror the IDE's serveCredentialEnv exactly) ----------
function loadCreds(): { apiKey: string; apiUrl: string; env: string } {
	const p = join(homedir(), ".backboard_ide", "config.json");
	const cfg = JSON.parse(readFileSync(p, "utf8")) as {
		env?: string;
		api_key?: string;
		env_keys?: Record<string, string>;
		apiUrl?: string;
	};
	const env = cfg.env ?? "prod";
	// IDE precedence: direct api_key ?? env_keys[env]
	const apiKey = cfg.api_key || (cfg.env_keys && cfg.env_keys[env]) || "";
	if (!apiKey) throw new Error("No API key found in ~/.backboard_ide/config.json");
	const apiUrl = process.env.BACKBOARD_API_URL?.trim() || cfg.apiUrl || DEFAULT_API_URL;
	return { apiKey, apiUrl, env };
}

function pct(sorted: number[], p: number): number {
	if (sorted.length === 0) return NaN;
	const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
	return sorted[idx];
}
function stats(xs: number[]) {
	const s = [...xs].sort((a, b) => a - b);
	const sum = s.reduce((a, b) => a + b, 0);
	return { n: s.length, min: s[0], med: pct(s, 50), p90: pct(s, 90), max: s[s.length - 1], mean: sum / s.length };
}
const ms = (x: number) => (Number.isFinite(x) ? `${Math.round(x)}ms` : "—");

// ---------- L2: drive the real serve binary over stdio ----------
interface ServeRun {
	boot: number;          // spawn -> serve:ready
	warm?: number;         // warmup sent -> serve:warm
	ttft: number;          // submit sent -> first assistant:delta (or assistant:reasoning)
	firstEvent: number;    // submit sent -> first client event of the turn (turn:start)
	turn: number;          // submit sent -> serve:turn
	sessionId: string;
	sessionRoot: string;
}

function driveServe(opts: { warm: boolean; creds: ReturnType<typeof loadCreds> }): Promise<ServeRun> {
	return new Promise((resolve, reject) => {
		const sessionRoot = mkdtempSync(join(tmpdir(), "bb-bench-"));
		const cwd = mkdtempSync(join(tmpdir(), "bb-bench-cwd-"));
		const env = {
			...process.env,
			BACKBOARD_API_KEY: opts.creds.apiKey,
			BACKBOARD_API_URL: opts.creds.apiUrl,
			BACKBOARD_SESSION_ROOT: sessionRoot,
		};
		const t = () => performance.now();
		const tSpawn = t();
		let tReady = 0, tWarmSent = 0, tWarmDone = 0, tSubmitSent = 0, tFirstEvent = 0, tTtft = 0, tTurn = 0;
		let sessionId = "";
		let submitted = false, warmSent = false, ttftSeen = false, firstSeen = false, done = false;

		const child = spawn(BIN, ["--serve", "--cwd", cwd], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
		const timer = setTimeout(() => { if (!done) { child.kill("SIGKILL"); reject(new Error("serve run timed out")); } }, TURN_TIMEOUT_MS + 30_000);

		const send = (obj: unknown) => child.stdin.write(`${JSON.stringify(obj)}\n`);

		const submit = () => {
			submitted = true;
			tSubmitSent = t();
			send({ op: "submit", requestId: "r1", prompt: PROMPT });
		};

		const finish = () => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			try { send({ op: "dispose" }); } catch {}
			setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 1500);
			resolve({
				boot: tReady - tSpawn,
				...(opts.warm ? { warm: tWarmDone - tWarmSent } : {}),
				ttft: tTtft - tSubmitSent,
				firstEvent: tFirstEvent - tSubmitSent,
				turn: tTurn - tSubmitSent,
				sessionId,
				sessionRoot,
			});
		};

		createInterface({ input: child.stdout }).on("line", (line) => {
			let rec: any;
			try { rec = JSON.parse(line); } catch { return; }
			if (rec.source === "serve") {
				if (rec.type === "serve:ready") {
					tReady = t();
					sessionId = rec.payload?.sessionId ?? "";
					if (opts.warm) {
						warmSent = true; tWarmSent = t();
						send({ op: "warmup", requestId: "w1" });
					} else {
						submit();
					}
				} else if (rec.type === "serve:warm") {
					tWarmDone = t();
					submit();
				} else if (rec.type === "serve:turn") {
					tTurn = t();
					finish();
				} else if (rec.type === "serve:error") {
					if (!done) { done = true; clearTimeout(timer); child.kill("SIGKILL"); reject(new Error(`serve:error ${JSON.stringify(rec.payload)}`)); }
				}
			} else if (rec.source === "client" && submitted) {
				if (!firstSeen) { firstSeen = true; tFirstEvent = t(); }
				if (!ttftSeen && (rec.type === "assistant:delta" || rec.type === "assistant:reasoning" || rec.type === "assistant:message")) {
					ttftSeen = true; tTtft = t();
				}
			}
		});
		child.stderr.on("data", () => {});
		child.on("error", (e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } });
		child.on("exit", () => { /* handled by finish/timeout */ });
	});
}

function readCapturedRequest(run: ServeRun): any | null {
	const p = join(run.sessionRoot, run.sessionId, "server.jsonl");
	if (!existsSync(p)) return null;
	const lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
	for (const l of lines) {
		try {
			const r = JSON.parse(l);
			if (r.type === "request" && r.method === "POST" && r.endpoint === "/threads/messages") {
				return r.body;
			}
		} catch {}
	}
	return null;
}

// ---------- L1: raw API measurements ----------
interface RawResult { headers: number; firstByte: number; firstContent: number; total: number; status: number; bytes: number; frames: number; }

async function rawStream(creds: ReturnType<typeof loadCreds>, body: any): Promise<RawResult> {
	const url = `${creds.apiUrl}/threads/messages`;
	const t0 = performance.now();
	const res = await fetch(url, {
		method: "POST",
		headers: { "X-API-Key": creds.apiKey, "Content-Type": "application/json" },
		body: JSON.stringify({ ...body, stream: true }),
	});
	const tHeaders = performance.now();
	if (!res.ok || !res.body) {
		const txt = await res.text().catch(() => "");
		throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
	}
	const reader = res.body.getReader();
	const dec = new TextDecoder();
	let tFirstByte = 0, tFirstContent = 0, bytes = 0, frames = 0;
	let buf = "";
	let firstContentSeen = false;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!tFirstByte) tFirstByte = performance.now();
		bytes += value?.length ?? 0;
		buf += dec.decode(value, { stream: true });
		// count SSE data frames; first frame carrying real content marks TTFT
		let nl: number;
		while ((nl = buf.indexOf("\n")) >= 0) {
			const rawLine = buf.slice(0, nl);
			buf = buf.slice(nl + 1);
			const lineTrim = rawLine.trim();
			if (!lineTrim.startsWith("data:")) continue;
			frames++;
			const data = lineTrim.slice(5).trim();
			if (!firstContentSeen && data && data !== "[DONE]" && data !== "{}" ) {
				// heuristic: first data frame with a payload = model started emitting
				firstContentSeen = true;
				tFirstContent = performance.now();
			}
		}
	}
	const tTotal = performance.now();
	return {
		headers: tHeaders - t0,
		firstByte: (tFirstByte || tTotal) - t0,
		firstContent: (tFirstContent || tTotal) - t0,
		total: tTotal - t0,
		status: res.status,
		bytes,
		frames,
	};
}

async function rawGet(creds: ReturnType<typeof loadCreds>, path: string): Promise<{ ms: number; status: number; bytes: number }> {
	const t0 = performance.now();
	const res = await fetch(`${creds.apiUrl}${path}`, { headers: { "X-API-Key": creds.apiKey } });
	const txt = await res.text();
	return { ms: performance.now() - t0, status: res.status, bytes: txt.length };
}

function bodySize(b: any): number { return Buffer.byteLength(JSON.stringify(b)); }

// ---------- main ----------
async function main() {
	const creds = loadCreds();
	console.log(`# Backboard first-turn latency benchmark`);
	console.log(`apiUrl=${creds.apiUrl}  env=${creds.env}  bin=${BIN}`);
	console.log(`prompt="${PROMPT}"`);
	console.log(`serveIters=${SERVE_ITERS} rawIters=${RAW_ITERS}`);
	console.log("");

	// --- L2 warm run first (also captures the exact request body) ---
	console.log(`## L2 serve — WARM (spawn → ready → warmup → submit)`);
	const warmRuns: ServeRun[] = [];
	let captured: any = null;
	for (let i = 0; i < SERVE_ITERS; i++) {
		try {
			const r = await driveServe({ warm: true, creds });
			warmRuns.push(r);
			if (!captured) captured = readCapturedRequest(r);
			console.log(`  [${i + 1}] boot=${ms(r.boot)} warm=${ms(r.warm ?? NaN)} firstEvent=${ms(r.firstEvent)} ttft=${ms(r.ttft)} turn=${ms(r.turn)}`);
		} catch (e) { console.log(`  [${i + 1}] FAILED: ${(e as Error).message}`); }
	}

	console.log("");
	console.log(`## L2 serve — COLD (spawn → ready → submit, no warmup)`);
	const coldRuns: ServeRun[] = [];
	for (let i = 0; i < SERVE_ITERS; i++) {
		try {
			const r = await driveServe({ warm: false, creds });
			coldRuns.push(r);
			console.log(`  [${i + 1}] boot=${ms(r.boot)} firstEvent=${ms(r.firstEvent)} ttft=${ms(r.ttft)} turn=${ms(r.turn)}`);
		} catch (e) { console.log(`  [${i + 1}] FAILED: ${(e as Error).message}`); }
	}

	// --- L1 raw API ---
	console.log("");
	console.log(`## L1 raw API`);
	if (!captured) {
		console.log(`  (could not capture request body from serve; skipping faithful replay)`);
	} else {
		console.log(`  captured POST /threads/messages body: ${bodySize(captured)} bytes ` +
			`(system_prompt=${captured.system_prompt ? Buffer.byteLength(captured.system_prompt) : 0}B, ` +
			`tools=${Array.isArray(captured.tools) ? captured.tools.length : 0}, ` +
			`model=${captured.llm_provider}/${captured.model_name}, assistant_id=${captured.assistant_id ? "yes" : "no"})`);
	}

	// GET /assistants scan (what warmup pays on cache miss)
	console.log(`  ### GET /assistants?limit=200 (warmup scan)`);
	const assistScan: number[] = [];
	for (let i = 0; i < RAW_ITERS; i++) {
		try { const r = await rawGet(creds, "/assistants?limit=200"); assistScan.push(r.ms); console.log(`    [${i + 1}] ${ms(r.ms)} (status ${r.status}, ${r.bytes}B)`); }
		catch (e) { console.log(`    [${i + 1}] FAILED ${(e as Error).message}`); }
	}

	// Full faithful body, fresh thread each time
	const fullResults: RawResult[] = [];
	if (captured) {
		console.log(`  ### POST /threads/messages — FULL captured body, fresh thread`);
		const { thread_id, ...bodyNoThread } = captured;
		for (let i = 0; i < RAW_ITERS; i++) {
			try {
				const r = await rawStream(creds, bodyNoThread);
				fullResults.push(r);
				console.log(`    [${i + 1}] headers=${ms(r.headers)} firstByte=${ms(r.firstByte)} firstContent=${ms(r.firstContent)} total=${ms(r.total)} (${r.frames} frames, ${r.bytes}B)`);
			} catch (e) { console.log(`    [${i + 1}] FAILED ${(e as Error).message}`); }
		}
	}

	// Minimal body: no system prompt, no tools, no assistant — theoretical backend floor
	console.log(`  ### POST /threads/messages — MINIMAL body (no system_prompt, no tools), fresh thread`);
	const minResults: RawResult[] = [];
	const minBody: any = {
		content: PROMPT,
		...(captured ? { llm_provider: captured.llm_provider, model_name: captured.model_name } : {}),
	};
	for (let i = 0; i < RAW_ITERS; i++) {
		try {
			const r = await rawStream(creds, minBody);
			minResults.push(r);
			console.log(`    [${i + 1}] headers=${ms(r.headers)} firstByte=${ms(r.firstByte)} firstContent=${ms(r.firstContent)} total=${ms(r.total)} (${r.frames} frames, ${r.bytes}B)`);
		} catch (e) { console.log(`    [${i + 1}] FAILED ${(e as Error).message}`); }
	}

	// --- summary ---
	console.log("");
	console.log(`## SUMMARY (median / p90)`);
	const line = (label: string, xs: number[]) => {
		if (!xs.length) { console.log(`  ${label.padEnd(38)} —`); return; }
		const s = stats(xs);
		console.log(`  ${label.padEnd(38)} med=${ms(s.med).padEnd(8)} p90=${ms(s.p90).padEnd(8)} min=${ms(s.min).padEnd(8)} max=${ms(s.max)}  (n=${s.n})`);
	};
	line("L2 serve WARM boot", warmRuns.map(r => r.boot));
	line("L2 serve WARM warmup", warmRuns.map(r => r.warm!).filter(Number.isFinite));
	line("L2 serve WARM ttft (submit→token)", warmRuns.map(r => r.ttft));
	line("L2 serve WARM turn (submit→done)", warmRuns.map(r => r.turn));
	line("L2 serve COLD boot", coldRuns.map(r => r.boot));
	line("L2 serve COLD ttft (submit→token)", coldRuns.map(r => r.ttft));
	line("L2 serve COLD turn (submit→done)", coldRuns.map(r => r.turn));
	line("L1 raw GET /assistants scan", assistScan);
	line("L1 raw FULL headers(TTFB)", fullResults.map(r => r.headers));
	line("L1 raw FULL firstByte", fullResults.map(r => r.firstByte));
	line("L1 raw FULL firstContent(TTFT)", fullResults.map(r => r.firstContent));
	line("L1 raw FULL total", fullResults.map(r => r.total));
	line("L1 raw MINIMAL firstContent(TTFT)", minResults.map(r => r.firstContent));
	line("L1 raw MINIMAL total", minResults.map(r => r.total));

	// machine-readable
	const out = {
		meta: { apiUrl: creds.apiUrl, prompt: PROMPT, serveIters: SERVE_ITERS, rawIters: RAW_ITERS, capturedBodyBytes: captured ? bodySize(captured) : null, systemPromptBytes: captured?.system_prompt ? Buffer.byteLength(captured.system_prompt) : null, toolCount: Array.isArray(captured?.tools) ? captured.tools.length : null, model: captured ? `${captured.llm_provider}/${captured.model_name}` : null },
		warm: warmRuns, cold: coldRuns,
		raw: { assistantsScan: assistScan, full: fullResults, minimal: minResults },
	};
	const outPath = join(process.env.SCRATCH ?? ".", "bench-results.json");
	try { require("node:fs").writeFileSync(outPath, JSON.stringify(out, null, 2)); console.log(`\nwrote ${outPath}`); } catch {}
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
