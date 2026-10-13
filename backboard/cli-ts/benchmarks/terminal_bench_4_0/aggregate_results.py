#!/usr/bin/env python3
"""Reconcile Terminal-Bench 4.0 results across the primary and repair lanes.

The benchmark was split after the original Harbor job encountered tasks whose
declared resources are unavailable on the local Apple Silicon Docker host.
This script keeps the official 66-task universe from the original lockfile and
selects at most one authoritative outcome per task.  A clean verifier result
always wins; otherwise the newest repair/continuation lane describes the task's
current state.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


PRIMARY_JOB = "terminal-bench-4.0-backboard-full-20260831-overnight"
LANES = (
    (PRIMARY_JOB, 100),
    ("terminal-bench-4.0-backboard-full-20260831-cpu-continuation", 200),
    ("terminal-bench-4.0-backboard-tail-partition", 250),
    ("terminal-bench-4.0-backboard-infra-retry-2", 300),
    ("terminal-bench-4.0-backboard-infra-retry-3b", 400),
    ("terminal-bench-4.0-backboard-infra-retry-4", 500),
    ("terminal-bench-4.0-backboard-infra-retry-4b", 600),
    ("terminal-bench-4.0-backboard-infra-retry-5", 700),
    ("terminal-bench-4.0-backboard-infra-retry-6", 800),
    ("terminal-bench-4.0-backboard-infra-retry-6b", 900),
    ("terminal-bench-4.0-backboard-infra-retry-7", 950),
    ("terminal-bench-4.0-backboard-infra-retry-8", 960),
    ("terminal-bench-4.0-backboard-infra-retry-9", 970),
    ("terminal-bench-4.0-backboard-infra-retry-10", 980),
    ("terminal-bench-4.0-backboard-infra-retry-11", 990),
    ("terminal-bench-4.0-backboard-infra-retry-12", 995),
    ("terminal-bench-4.0-backboard-infra-retry-13", 997),
    ("terminal-bench-4.0-backboard-infra-retry-14", 1_100),
    ("terminal-bench-4.0-backboard-infra-retry-15", 1_200),
    ("terminal-bench-4.0-backboard-infra-retry-16", 1_300),
    ("terminal-bench-4.0-backboard-infra-retry-17", 1_400),
    ("terminal-bench-4.0-backboard-infra-retry-18", 1_500),
)
H100_TASKS = {
    "terminal-bench/fp8-rmsnorm-gemm",
    "terminal-bench/math-eval-grader",
    "terminal-bench/jax-speedrun-gpu",
}
@dataclass(frozen=True)
class Candidate:
    task_name: str
    lane: str
    priority: int
    state: str
    trial_dir: Path | None = None
    result: dict[str, Any] | None = None
    expected_model: str | None = None

    @property
    def is_clean(self) -> bool:
        if self.result is None or self.result.get("exception_info") is not None:
            return False
        verifier = self.result.get("verifier_result")
        return isinstance(verifier, dict) and isinstance(verifier.get("rewards"), dict)

    @property
    def finished_at(self) -> str:
        if self.result is None:
            return ""
        return str(self.result.get("finished_at") or "")


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text())


def planned_tasks(job_dir: Path) -> dict[str, str | None]:
    lock_path = job_dir / "lock.json"
    if not lock_path.exists():
        return {}
    tasks: dict[str, str | None] = {}
    for trial in read_json(lock_path).get("trials", []):
        name = trial.get("task", {}).get("name")
        if not name:
            continue
        tasks[name] = trial.get("agent", {}).get("model_name")
    return tasks


def trial_candidates(job_dir: Path, lane: str, priority: int) -> list[Candidate]:
    planned = planned_tasks(job_dir)
    by_task: dict[str, list[Candidate]] = {name: [] for name in planned}

    if job_dir.exists():
        for trial_dir in job_dir.iterdir():
            if not trial_dir.is_dir():
                continue
            result_path = trial_dir / "result.json"
            config_path = trial_dir / "config.json"
            result = read_json(result_path) if result_path.exists() else None
            config = read_json(config_path) if config_path.exists() else {}
            task_name = (
                (result or {}).get("task_name")
                or config.get("task", {}).get("name")
            )
            if not task_name:
                continue
            if result is not None:
                state = "scored" if Candidate(
                    task_name, lane, priority, "unknown", result=result
                ).is_clean else "exception"
            else:
                state = "running"
            by_task.setdefault(task_name, []).append(
                Candidate(
                    task_name=task_name,
                    lane=lane,
                    priority=priority,
                    state=state,
                    trial_dir=trial_dir,
                    result=result,
                    expected_model=config.get("agent", {}).get("model_name")
                    or planned.get(task_name),
                )
            )

    candidates: list[Candidate] = []
    for task_name, task_candidates in by_task.items():
        if task_candidates:
            candidates.extend(task_candidates)
        else:
            candidates.append(
                Candidate(
                    task_name=task_name,
                    lane=lane,
                    priority=priority,
                    state="pending",
                    expected_model=planned.get(task_name),
                )
            )
    return candidates


def regrade_candidates(repo_root: Path) -> list[Candidate]:
    regrades_dir = repo_root / "artifacts/terminal-bench-4.0/regrades"
    candidates: list[Candidate] = []
    for result_path in sorted(regrades_dir.glob("*/result.json")):
        result = read_json(result_path)
        trial_dir = result_path.parent
        probe = Candidate(
            task_name=result["task_name"],
            lane=f"native-verifier-regrade:{trial_dir.name}",
            priority=100_000,
            state="unknown",
            trial_dir=trial_dir,
            result=result,
        )
        candidates.append(
            Candidate(
                task_name=probe.task_name,
                lane=probe.lane,
                priority=probe.priority,
                state="scored" if probe.is_clean else "exception",
                trial_dir=probe.trial_dir,
                result=probe.result,
            )
        )
    return candidates


def choose_candidate(candidates: list[Candidate]) -> Candidate:
    clean = [candidate for candidate in candidates if candidate.is_clean]
    pool = clean or candidates
    return max(
        pool,
        key=lambda candidate: (
            candidate.priority,
            candidate.finished_at,
            candidate.state == "running",
        ),
    )


def reward_for(candidate: Candidate) -> float | None:
    if not candidate.is_clean or candidate.result is None:
        return None
    rewards = candidate.result["verifier_result"]["rewards"]
    reward = rewards.get("reward")
    return float(reward) if reward is not None else None


def task_record(candidate: Candidate) -> dict[str, Any]:
    result = candidate.result or {}
    agent_info = result.get("agent_info") or {}
    model_info = agent_info.get("model_info") or {}
    exception = result.get("exception_info") or {}
    reward = reward_for(candidate)
    status = candidate.state
    if candidate.task_name in H100_TASKS and not candidate.is_clean:
        status = "hardware_unavailable"
    return {
        "task_name": candidate.task_name,
        "status": status,
        "reward": reward,
        "passed": reward == 1.0 if reward is not None else None,
        "lane": candidate.lane,
        "trial_name": result.get("trial_name"),
        "trial_path": str(candidate.trial_dir) if candidate.trial_dir else None,
        "provider": model_info.get("provider"),
        "model": model_info.get("name") or candidate.expected_model,
        "agent": agent_info.get("name"),
        "agent_version": agent_info.get("version"),
        "exception_type": exception.get("exception_type"),
        "exception_message": exception.get("exception_message"),
        "started_at": result.get("started_at"),
        "finished_at": result.get("finished_at"),
        "input_tokens": (result.get("agent_result") or {}).get("n_input_tokens"),
        "output_tokens": (result.get("agent_result") or {}).get("n_output_tokens"),
    }


def build_report(repo_root: Path) -> dict[str, Any]:
    jobs_root = repo_root / "artifacts/terminal-bench-4.0/jobs"
    primary_lock = read_json(jobs_root / PRIMARY_JOB / "lock.json")
    official_tasks = sorted(
        {trial["task"]["name"] for trial in primary_lock.get("trials", [])}
    )
    if len(official_tasks) != 66:
        raise RuntimeError(
            f"Expected 66 official TB4 tasks in the primary lock, found {len(official_tasks)}"
        )

    candidates_by_task: dict[str, list[Candidate]] = {
        task_name: [] for task_name in official_tasks
    }
    for lane, priority in LANES:
        job_dir = jobs_root / lane
        for candidate in trial_candidates(job_dir, lane, priority):
            if candidate.task_name in candidates_by_task:
                candidates_by_task[candidate.task_name].append(candidate)

    for regrade in regrade_candidates(repo_root):
        if regrade.task_name in candidates_by_task:
            candidates_by_task[regrade.task_name].append(regrade)

    records: list[dict[str, Any]] = []
    for task_name in official_tasks:
        candidates = candidates_by_task[task_name]
        if not candidates:
            candidate = Candidate(
                task_name=task_name,
                lane="unassigned",
                priority=0,
                state="pending",
            )
        else:
            candidate = choose_candidate(candidates)
        records.append(task_record(candidate))

    status_counts: dict[str, int] = {}
    for record in records:
        status_counts[record["status"]] = status_counts.get(record["status"], 0) + 1
    scored = [record for record in records if record["reward"] is not None]
    reward_sum = sum(record["reward"] for record in scored)
    input_tokens = sum(record["input_tokens"] or 0 for record in scored)
    output_tokens = sum(record["output_tokens"] or 0 for record in scored)
    proven_provider_models = sorted(
        {
            f"{record['provider']}/{record['model']}"
            for record in scored
            if record["provider"] and record["model"]
        }
    )
    return {
        "generated_at": datetime.now(UTC).isoformat(),
        "dataset": "terminal-bench/terminal-bench@4.0.0",
        "official_task_count": len(official_tasks),
        "summary": {
            "status_counts": status_counts,
            "scored_tasks": len(scored),
            "passed_tasks": sum(record["passed"] is True for record in scored),
            "reward_sum": reward_sum,
            "mean_reward_on_scored_tasks": reward_sum / len(scored) if scored else None,
            "coverage": len(scored) / len(official_tasks),
            "hardware_unavailable_tasks": sorted(H100_TASKS),
            "selected_input_tokens": input_tokens,
            "selected_output_tokens": output_tokens,
            "proven_provider_models": proven_provider_models,
        },
        "lanes": [lane for lane, _ in LANES],
        "tasks": records,
    }


def markdown(report: dict[str, Any]) -> str:
    summary = report["summary"]
    counts = summary["status_counts"]
    lines = [
        "# Terminal-Bench 4.0 — Backboard / ChatGPT subscription",
        "",
        f"Generated: `{report['generated_at']}`",
        "",
        f"- Official tasks: **{report['official_task_count']}**",
        f"- Scored tasks: **{summary['scored_tasks']}**",
        f"- Passed tasks: **{summary['passed_tasks']}**",
        f"- Mean reward on scored tasks: **{summary['mean_reward_on_scored_tasks']}**",
        f"- Coverage: **{summary['coverage']:.2%}**",
        f"- Provider/model evidence: **{', '.join(summary['proven_provider_models']) or 'pending'}**",
        "",
        "## Status counts",
        "",
    ]
    lines.extend(f"- {status}: **{count}**" for status, count in sorted(counts.items()))
    lines.extend(
        [
            "",
            "## Tasks",
            "",
            "| Task | Status | Reward | Lane | Exception |",
            "|---|---:|---:|---|---|",
        ]
    )
    for record in report["tasks"]:
        reward = "" if record["reward"] is None else str(record["reward"])
        exception = record["exception_type"] or ""
        lines.append(
            f"| `{record['task_name']}` | {record['status']} | {reward} | "
            f"`{record['lane']}` | {exception} |"
        )
    lines.append("")
    return "\n".join(lines)


def parse_args() -> argparse.Namespace:
    default_repo = Path(__file__).resolve().parents[4]
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", type=Path, default=default_repo)
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=None,
        help="Defaults to artifacts/terminal-bench-4.0/final-report under the repo root.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    repo_root = args.repo_root.resolve()
    output_dir = args.output_dir or (
        repo_root / "artifacts/terminal-bench-4.0/final-report"
    )
    output_dir.mkdir(parents=True, exist_ok=True)
    report = build_report(repo_root)
    (output_dir / "aggregate.json").write_text(json.dumps(report, indent=2) + "\n")
    (output_dir / "README.md").write_text(markdown(report))
    print(json.dumps(report["summary"], indent=2))


if __name__ == "__main__":
    main()
