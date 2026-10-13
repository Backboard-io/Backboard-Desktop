#!/usr/bin/env bun
import { access, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DATASET = "terminal-bench/terminal-bench-2-1";
const DEFAULT_MODEL = "openai-subscription/gpt-5.6-sol";
const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(scriptDir, "..");
const repositoryRoot = resolve(packageDir, "..", "..");
const benchmarkDir = join(packageDir, "benchmarks", "terminal_bench_2_1");
const binaryDir = join(benchmarkDir, "dist");
const nativeArmImage = "backboard-terminal-bench-2.1/fix-git:20260403-arm64";
const nativeArmDockerfile = join(benchmarkDir, "Dockerfile.fix-git-arm64");
const nativeArmCompose = join(benchmarkDir, "docker-compose.arm64.yaml");
const jobsDir = join(repositoryRoot, "artifacts", "terminal-bench-2.1", "jobs");
const runStamp = new Date()
	.toISOString()
	.replaceAll(":", "-")
	.replaceAll(".", "-");
const harbor = await resolveExecutable("harbor", [
	join(homedir(), ".local", "bin", "harbor"),
]);
const command = process.argv[2] ?? "preflight";
const task = process.argv[3];
const qualifiedTask = task
	? task.includes("/")
		? task
		: `terminal-bench/${task}`
	: undefined;
const taskSlug = qualifiedTask?.split("/").at(-1);
const authFile = resolve(
	process.env.BACKBOARD_CHATGPT_SUBSCRIPTION_AUTH_FILE?.trim() ||
		join(
			process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"),
			"auth.json",
		),
);
const model = process.env.BACKBOARD_TBENCH_MODEL?.trim() || DEFAULT_MODEL;
let cachedDockerArchitecture: string | undefined;

switch (command) {
	case "prepare":
		await prepareNativeEnvironment();
		await preflight(false);
		break;
	case "preflight":
		await preflight();
		break;
	case "oracle": {
		requireTask(qualifiedTask);
		await preflight(false);
		const jobName = `terminal-bench-2.1-${taskSlug}-oracle-${runStamp}`;
		await runHarbor([
			"run",
			"--dataset",
			DATASET,
			"--agent",
			"oracle",
			...(await nativeEnvironmentArgs()),
			"--include-task-name",
			qualifiedTask,
			"--n-attempts",
			"1",
			"--n-concurrent",
			"1",
			"--jobs-dir",
			jobsDir,
			"--job-name",
			jobName,
			"--yes",
		]);
		await assertJobCompleted(jobName);
		break;
	}
	case "run": {
		requireTask(qualifiedTask);
		await preflight();
		const jobName = `terminal-bench-2.1-${taskSlug}-backboard-${runStamp}`;
		await runHarbor([
			"run",
			"--dataset",
			DATASET,
			"--agent",
			"benchmarks.terminal_bench_2_1.backboard_agent:BackboardAgent",
			"--model",
			model,
			...(await nativeEnvironmentArgs()),
			"--agent-kwarg",
			`binary_dir=${binaryDir}`,
			"--agent-kwarg",
			`auth_json_path=${authFile}`,
			"--agent-kwarg",
			"thinking=high",
			"--agent-include-logs",
			"backboard.jsonl",
			"--include-task-name",
			qualifiedTask,
			"--n-attempts",
			"1",
			"--n-concurrent",
			"1",
			"--jobs-dir",
			jobsDir,
			"--job-name",
			jobName,
			"--yes",
		]);
		await assertJobCompleted(jobName);
		break;
	}
	case "storage":
		await run("docker", ["system", "df"]);
		break;
	default:
		throw new Error(
			`Unknown command ${command}. Use prepare, preflight, oracle <task>, run <task>, or storage.`,
		);
}

async function preflight(requireBinaries = true): Promise<void> {
	await run("docker", ["info", "--format", "{{.ServerVersion}}"]);
	await run("docker", ["compose", "version", "--short"]);
	await runHarbor(["--version"]);
	const auth = JSON.parse(await readFile(authFile, "utf8")) as {
		auth_mode?: unknown;
		tokens?: { access_token?: unknown; account_id?: unknown };
	};
	if (auth.auth_mode !== "chatgpt") {
		throw new Error(`Expected auth_mode=chatgpt in ${authFile}`);
	}
	if (
		typeof auth.tokens?.access_token !== "string" ||
		typeof auth.tokens.account_id !== "string"
	) {
		throw new Error(`Subscription credentials are incomplete in ${authFile}`);
	}
	const expiresAt = jwtExpiry(auth.tokens.access_token);
	if (expiresAt !== null && expiresAt <= Date.now() + 5 * 60_000) {
		throw new Error(
			"The ChatGPT subscription token expires in under five minutes.",
		);
	}
	if (requireBinaries) {
		for (const name of [
			"backboard-linux-x64",
			"backboard-linux-arm64",
			"backboard-linux-x64-musl",
			"backboard-linux-arm64-musl",
		]) {
			await access(join(binaryDir, name));
		}
	}
	if (await usesArmDocker()) {
		const imageArchitecture = await capture("docker", [
			"image",
			"inspect",
			nativeArmImage,
			"--format",
			"{{.Architecture}}",
		]).catch(() => "");
		if (imageArchitecture !== "arm64") {
			throw new Error(
				`Native task image ${nativeArmImage} is missing. Run bun run test:terminal-bench:prepare.`,
			);
		}
	}
	await mkdir(jobsDir, { recursive: true });
	process.stdout.write(
		`${[
			"Terminal-Bench preflight passed.",
			`Model: ${model}`,
			`Credential: ChatGPT subscription (${authFile})`,
			expiresAt === null
				? "Token expiry: unavailable"
				: `Token expiry: ${new Date(expiresAt).toISOString()}`,
			`Jobs: ${jobsDir}`,
		].join("\n")}\n`,
	);
}

async function prepareNativeEnvironment(): Promise<void> {
	if (!(await usesArmDocker())) {
		process.stdout.write(
			"Docker is not ARM64; no native task image is needed.\n",
		);
		return;
	}
	await run("docker", [
		"build",
		"--platform",
		"linux/arm64",
		"--file",
		nativeArmDockerfile,
		"--tag",
		nativeArmImage,
		benchmarkDir,
	]);
}

async function nativeEnvironmentArgs(): Promise<string[]> {
	return (await usesArmDocker())
		? ["--extra-docker-compose", nativeArmCompose]
		: [];
}

async function usesArmDocker(): Promise<boolean> {
	cachedDockerArchitecture ??= await capture("docker", [
		"info",
		"--format",
		"{{.Architecture}}",
	]);
	return ["arm64", "aarch64"].includes(cachedDockerArchitecture);
}

async function assertJobCompleted(jobName: string): Promise<void> {
	const resultPath = join(jobsDir, jobName, "result.json");
	const result = JSON.parse(await readFile(resultPath, "utf8")) as {
		n_total_trials?: number;
		stats?: {
			n_errored_trials?: number;
			evals?: Record<
				string,
				{
					n_trials?: number;
					n_errors?: number;
					metrics?: Array<{ mean?: number }>;
				}
			>;
		};
	};
	const stats = result.stats;
	const evaluation = Object.values(stats?.evals ?? {})[0];
	if (
		!stats ||
		result.n_total_trials !== 1 ||
		stats.n_errored_trials !== 0 ||
		evaluation?.n_trials !== 1 ||
		evaluation.n_errors !== 0
	) {
		throw new Error(`Harbor job did not complete cleanly: ${resultPath}`);
	}
	process.stdout.write(
		`Verified Harbor result: reward=${evaluation.metrics?.[0]?.mean ?? "unknown"}\n${resultPath}\n`,
	);
}

function jwtExpiry(token: string): number | null {
	const payload = token.split(".")[1];
	if (!payload) return null;
	try {
		const claims = JSON.parse(
			Buffer.from(payload, "base64url").toString("utf8"),
		) as { exp?: unknown };
		return typeof claims.exp === "number" ? claims.exp * 1000 : null;
	} catch {
		return null;
	}
}

async function runHarbor(args: string[]): Promise<void> {
	await run(harbor, args, {
		PYTHONPATH: [packageDir, process.env.PYTHONPATH].filter(Boolean).join(":"),
	});
}

async function run(
	executable: string,
	args: string[],
	extraEnv: Record<string, string> = {},
): Promise<void> {
	const child = Bun.spawn([executable, ...args], {
		cwd: packageDir,
		env: { ...process.env, ...extraEnv },
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await child.exited;
	if (exitCode !== 0) {
		throw new Error(`${executable} exited with status ${exitCode}`);
	}
}

async function capture(executable: string, args: string[]): Promise<string> {
	const child = Bun.spawn([executable, ...args], {
		cwd: packageDir,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(
			`${executable} exited with status ${exitCode}: ${stderr.trim()}`,
		);
	}
	return stdout.trim();
}

async function resolveExecutable(
	name: string,
	fallbacks: string[],
): Promise<string> {
	const finder = Bun.spawn(["/bin/zsh", "-lc", `command -v ${name}`], {
		stdout: "pipe",
		stderr: "ignore",
	});
	const resolved = (await new Response(finder.stdout).text()).trim();
	if ((await finder.exited) === 0 && resolved) return resolved;
	for (const fallback of fallbacks) {
		try {
			await access(fallback);
			return fallback;
		} catch {}
	}
	throw new Error(`${name} is not installed`);
}

function requireTask(value: string | undefined): asserts value is string {
	if (!value) {
		throw new Error(
			`Usage: bun run scripts/terminal-bench.ts ${command} <task>`,
		);
	}
}
