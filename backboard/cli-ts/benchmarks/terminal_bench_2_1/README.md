# Backboard Terminal-Bench 2.1 smoke test

This integration runs one official Terminal-Bench 2.1 task through the
Backboard CLI harness with the `openai-subscription/gpt-5.6-sol` backend. It is
intentionally scoped to `terminal-bench/fix-git`; it does not launch the full
benchmark suite.

The Harbor installed-agent adapter uploads a compiled Backboard CLI into the
task container, copies only the active ChatGPT access token and account ID into
a mode-`0600` temporary file, runs the normal Backboard tool scheduler, and
deletes the credential file before Harbor collects logs.

## Prerequisites

- Bun and this package's dependencies
- Docker Engine with the Compose plugin
- Harbor 0.22 or later (`uv tool install harbor`)
- A ChatGPT subscription login

By default the runner uses `${CODEX_HOME:-$HOME/.codex}/auth.json`. To use a
Backboard-owned login instead, run `backboard subscription login` and set:

```sh
export BACKBOARD_CHATGPT_SUBSCRIPTION_AUTH_FILE="$HOME/.backboard/chatgpt-auth.json"
```

The preflight rejects non-ChatGPT credentials, incomplete credentials, and JWTs
that expire in under five minutes. It never prints token contents.

## One-task workflow

Run these commands from `backboard/cli-ts` (`vscode/cli-ts` remains a compatibility symlink):

```sh
bun run test:terminal-bench:build
bun run test:terminal-bench:prepare
bun run test:terminal-bench:preflight
bun run test:terminal-bench:oracle -- fix-git
bun run test:terminal-bench:run -- fix-git
```

`prepare` is a no-op on x86 Docker hosts. On Apple Silicon it builds a native
ARM64 task image from the official `alexgshaw/fix-git:20260403` filesystem and
Git identity. Harbor applies the ARM64 Compose override so Bun runs natively
instead of through x86 emulation. Always require the ARM64 oracle to score 1.0
before treating a model result as valid.

Results are written under
`artifacts/terminal-bench-2.1/jobs/<job-name>/result.json`. The native Backboard
trajectory is saved as `agent/backboard.jsonl` inside the trial directory.

## Storage

```sh
bun run test:terminal-bench:storage
du -sh ~/.colima
```

The generated agent binaries are ignored by Git and occupy about 311 MiB in
`benchmarks/terminal_bench_2_1/dist`. Docker images and Colima's sparse VM disk
are additional. The scripts do not prune Docker data automatically because
other projects may depend on it.
