#!/usr/bin/env bun
import { chmod, mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface BuildTarget {
	name: string;
	target: string;
}

const targets: BuildTarget[] = [
	{ name: "backboard-linux-x64", target: "bun-linux-x64-baseline" },
	{ name: "backboard-linux-arm64", target: "bun-linux-arm64" },
	{ name: "backboard-linux-x64-musl", target: "bun-linux-x64-musl-baseline" },
	{ name: "backboard-linux-arm64-musl", target: "bun-linux-arm64-musl" },
];

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(scriptDir, "..");
const entrypoint = join(packageDir, "src", "entrypoints", "cli.tsx");
const outputDir = join(packageDir, "benchmarks", "terminal_bench_2_1", "dist");
const arm64MuslRuntimeDir = join(outputDir, "arm64-musl-runtime");

await mkdir(outputDir, { recursive: true });

for (const buildTarget of targets) {
	const output = join(outputDir, buildTarget.name);
	process.stdout.write(
		`Building ${buildTarget.name} (${buildTarget.target})...\n`,
	);
	const child = Bun.spawn(
		[
			process.execPath,
			"build",
			"--compile",
			`--target=${buildTarget.target}`,
			"--minify",
			"--sourcemap=none",
			"--outfile",
			output,
			entrypoint,
		],
		{ cwd: packageDir, stdout: "inherit", stderr: "inherit" },
	);
	const exitCode = await child.exited;
	if (exitCode !== 0) process.exit(exitCode);
	await chmod(output, 0o755);
	const bytes = (await stat(output)).size;
	process.stdout.write(
		`Built ${output} (${(bytes / 1024 / 1024).toFixed(1)} MiB)\n`,
	);
}

await mkdir(arm64MuslRuntimeDir, { recursive: true });
process.stdout.write("Extracting ARM64 musl compatibility runtime...\n");
const runtimeChild = Bun.spawn(
	[
		"docker",
		"run",
		"--rm",
		"--platform",
		"linux/arm64",
		"-v",
		`${arm64MuslRuntimeDir}:/out`,
		"alpine:3.20",
		"sh",
		"-eu",
		"-c",
		[
			"apk add --no-cache libstdc++ >/dev/null",
			"cp -L /lib/ld-musl-aarch64.so.1 /out/ld-musl-aarch64.so.1",
			"cp -L /usr/lib/libstdc++.so.6 /out/libstdc++.so.6",
			"cp -L /usr/lib/libgcc_s.so.1 /out/libgcc_s.so.1",
		].join(" && "),
	],
	{ cwd: packageDir, stdout: "inherit", stderr: "inherit" },
);
const runtimeExitCode = await runtimeChild.exited;
if (runtimeExitCode !== 0) process.exit(runtimeExitCode);
await chmod(join(arm64MuslRuntimeDir, "ld-musl-aarch64.so.1"), 0o755);
for (const name of ["libstdc++.so.6", "libgcc_s.so.1"]) {
	await chmod(join(arm64MuslRuntimeDir, name), 0o644);
}
process.stdout.write(`Extracted ARM64 runtime to ${arm64MuslRuntimeDir}\n`);
