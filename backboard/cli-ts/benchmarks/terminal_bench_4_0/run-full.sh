#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
package_dir=$(CDPATH= cd -- "$script_dir/../.." && pwd)
repository_root=$(CDPATH= cd -- "$package_dir/../.." && pwd)

harbor_bin=${HARBOR_BIN:-$HOME/.local/bin/harbor}
auth_json=${BACKBOARD_CHATGPT_SUBSCRIPTION_AUTH_FILE:-$HOME/.codex/auth.json}
binary_dir="$package_dir/benchmarks/terminal_bench_2_1/dist"
jobs_dir="$repository_root/artifacts/terminal-bench-4.0/jobs"
job_name=${BACKBOARD_TBENCH4_JOB_NAME:-terminal-bench-4.0-backboard-full-20260831-overnight}
concurrency=${BACKBOARD_TBENCH4_CONCURRENCY:-2}

mkdir -p "$jobs_dir"
export PYTHONPATH="$package_dir${PYTHONPATH:+:$PYTHONPATH}"

python3 "$script_dir/prepare-arm64-mirrors.py"

exec "$harbor_bin" run \
	--dataset terminal-bench/terminal-bench@4.0.0 \
	--agent benchmarks.terminal_bench_2_1.backboard_agent:BackboardAgent \
	--model openai-subscription/gpt-5.6-sol \
	--force-build \
	--agent-kwarg "binary_dir=$binary_dir" \
	--agent-kwarg "auth_json_path=$auth_json" \
	--agent-kwarg thinking=high \
	--agent-include-logs backboard.jsonl \
	--n-attempts 1 \
	--max-retries 1 \
	--retry-include RuntimeError \
	--n-concurrent "$concurrency" \
	--n-concurrent-agents "$concurrency" \
	--jobs-dir "$jobs_dir" \
	--job-name "$job_name" \
	--yes
