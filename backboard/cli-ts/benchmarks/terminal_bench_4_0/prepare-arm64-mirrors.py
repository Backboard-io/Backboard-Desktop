#!/usr/bin/env python3
"""Prepare cached Terminal-Bench tasks for native ARM64 builds.

Debian and Ubuntu keep their official package repositories. Images use HTTPS
before apt; minimal images use a one-command APT_CONFIG bootstrap until the
task's original package install supplies its CA bundle. Separate verifiers
and task environments keep the official sources and pinned
dependencies, but are built from their provided Dockerfiles instead of running
amd64-only prebuilt images through QEMU. Task instructions, packages, test code,
and verifier logic are not changed.
"""

from __future__ import annotations

import os
from pathlib import Path


TASK_ROOT = Path(
    os.environ.get(
        "BACKBOARD_TBENCH4_TASK_ROOT",
        Path.home() / ".cache/harbor/tasks/packages/terminal-bench",
    )
)
APT_MARKER = "# backboard-tbench4-arm64-apt-mirrors"
VERIFIER_MARKER = "# backboard-tbench4-arm64-native-verifier:"
ENVIRONMENT_MARKER = "# backboard-tbench4-arm64-native-environment:"
VPP_TORCH_MARKER = "# backboard-tbench4-vpp-cpu-torch-resolver"
COMPOSE_IMAGE_MARKER = "# backboard-tbench4-arm64-native-compose-image:"
# pymeep 1.29 has no linux-aarch64 build on conda-forge. Keep the benchmark's
# official pinned images for this task and run them through Docker's emulation.
AMD64_FALLBACK_TASKS = {"takens-embedding-lean", "wdm-design"}
# Coq's native verifier rebuild can fail while refreshing an old Debian base;
# its official pinned verifier is architecture-independent for scoring and is
# safer to run unchanged through emulation. Keep the agent environment native.
AMD64_VERIFIER_FALLBACK_TASKS = {"coq-block-bound"}
REWRITE_V1 = (
    "find /etc/apt -maxdepth 2 -type f -exec sed -i "
    "-e 's|http://deb.debian.org/debian|http://mirror.csclub.uwaterloo.ca/debian|g' "
    "-e 's|http://ports.ubuntu.com/ubuntu-ports|http://mirrors.tuna.tsinghua.edu.cn/ubuntu-ports|g' "
    "{} + 2>/dev/null || true; "
)
REWRITE_V2 = (
    "if grep -Rqs 'http://ports.ubuntu.com/ubuntu-ports' /etc/apt; then "
    "printf 'Acquire::https::Verify-Peer \"false\";\\n' "
    "> /etc/apt/apt.conf.d/99backboard-mirrors; fi; "
    "find /etc/apt -maxdepth 2 -type f -exec sed -i "
    "-e 's|http://deb.debian.org/debian|https://mirror.csclub.uwaterloo.ca/debian|g' "
    "-e 's|http://ports.ubuntu.com/ubuntu-ports|https://mirrors.tuna.tsinghua.edu.cn/ubuntu-ports|g' "
    "{} + 2>/dev/null || true; "
)
REWRITE_V3 = (
    "find /etc/apt -maxdepth 2 -type f -exec sed -i "
    "-e 's|http://deb.debian.org/debian|https://mirror.csclub.uwaterloo.ca/debian|g' "
    "{} + 2>/dev/null || true; "
)
REWRITE_V4 = (
    "if [ -s /etc/ssl/certs/ca-certificates.crt ]; then "
    "find /etc/apt -maxdepth 2 -type f -exec sed -i "
    "'s|http://deb.debian.org/debian|https://deb.debian.org/debian|g' {} +; "
    "fi; "
)
REWRITE_V5 = (
    "if [ -s /etc/ssl/certs/ca-certificates.crt ]; then "
    "find /etc/apt -maxdepth 2 -type f -exec sed -i "
    "-e 's|http://deb.debian.org/debian|https://deb.debian.org/debian|g' "
    "-e 's|http://ports.ubuntu.com/ubuntu-ports|https://ports.ubuntu.com/ubuntu-ports|g' "
    "{} +; "
    "fi; "
)
LEGACY_REWRITES = (REWRITE_V1, REWRITE_V2, REWRITE_V3, REWRITE_V4, REWRITE_V5)
REWRITE = (
    "if [ ! -s /etc/ssl/certs/ca-certificates.crt ]; then "
    "printf 'Acquire::https::Verify-Peer \"false\";\\n' "
    "> /tmp/backboard-apt-bootstrap.conf; "
    "export APT_CONFIG=/tmp/backboard-apt-bootstrap.conf; "
    "fi; "
    "find /etc/apt -maxdepth 2 -type f -exec sed -i "
    "-e 's|http://deb.debian.org/debian|https://deb.debian.org/debian|g' "
    "-e 's|http://ports.ubuntu.com/ubuntu-ports|https://ports.ubuntu.com/ubuntu-ports|g' "
    "{} +; "
)


def main() -> None:
    if not TASK_ROOT.is_dir():
        raise SystemExit(f"Terminal-Bench task cache not found: {TASK_ROOT}")

    changed_files = 0
    changed_commands = 0
    for dockerfile in TASK_ROOT.rglob("Dockerfile*"):
        if not dockerfile.is_file():
            continue
        source = dockerfile.read_text()
        patched = source
        removed_commands = 0
        for legacy_rewrite in LEGACY_REWRITES:
            removed_commands += patched.count(legacy_rewrite)
            patched = patched.replace(legacy_rewrite, "")
        if removed_commands:
            patched = patched.replace(f"{APT_MARKER}\n", "")
        if "apt-get update" in patched and APT_MARKER not in patched:
            count = patched.count("apt-get update")
            patched = patched.replace("apt-get update", f"{REWRITE}apt-get update")
            patched = f"{APT_MARKER}\n{patched}"
            changed_commands += count
        if patched != source:
            dockerfile.write_text(patched)
            changed_files += 1
            changed_commands += removed_commands

    native_verifiers = 0
    for task_toml in TASK_ROOT.glob("*/*/task.toml"):
        if task_toml.parent.parent.name in (
            AMD64_FALLBACK_TASKS | AMD64_VERIFIER_FALLBACK_TASKS
        ):
            continue
        if not (task_toml.parent / "tests/Dockerfile").is_file():
            continue
        lines = task_toml.read_text().splitlines(keepends=True)
        in_verifier_environment = False
        patched_lines: list[str] = []
        changed = False
        for line in lines:
            stripped = line.strip()
            if stripped.startswith("[") and stripped.endswith("]"):
                in_verifier_environment = stripped == "[verifier.environment]"
            if in_verifier_environment and stripped.startswith("docker_image ="):
                newline = "\n" if line.endswith("\n") else ""
                patched_lines.append(f"{VERIFIER_MARKER} {stripped}{newline}")
                changed = True
                continue
            patched_lines.append(line)
        if changed:
            task_toml.write_text("".join(patched_lines))
            native_verifiers += 1

    native_environments = 0
    for task_toml in TASK_ROOT.glob("*/*/task.toml"):
        if task_toml.parent.parent.name in AMD64_FALLBACK_TASKS:
            continue
        if not (task_toml.parent / "environment/Dockerfile").is_file():
            continue
        lines = task_toml.read_text().splitlines(keepends=True)
        in_environment = False
        patched_lines = []
        changed = False
        for line in lines:
            stripped = line.strip()
            if stripped.startswith("[") and stripped.endswith("]"):
                in_environment = stripped == "[environment]"
            if in_environment and stripped.startswith("docker_image ="):
                newline = "\n" if line.endswith("\n") else ""
                patched_lines.append(f"{ENVIRONMENT_MARKER} {stripped}{newline}")
                changed = True
                continue
            patched_lines.append(line)
        if changed:
            task_toml.write_text("".join(patched_lines))
            native_environments += 1

    vpp_resolvers = 0
    for dockerfile in TASK_ROOT.glob("vpp-loss-divergence/*/*/Dockerfile"):
        source = dockerfile.read_text()
        if VPP_TORCH_MARKER in source:
            continue
        needle = (
            "# NeMo 2.2.1 + pinned compatible Lightning + megatron-core.\n"
            "RUN pip install --no-cache-dir \\\n"
        )
        replacement = (
            "# NeMo 2.2.1 + pinned compatible Lightning + megatron-core.\n"
            f"{VPP_TORCH_MARKER}\n"
            "RUN pip install --no-cache-dir \\\n"
            "        --extra-index-url https://download.pytorch.org/whl/cpu \\\n"
            "        \"torch==2.6.0+cpu\" \\\n"
        )
        if needle not in source:
            continue
        dockerfile.write_text(source.replace(needle, replacement, 1))
        vpp_resolvers += 1

    compose_images = 0
    for compose_file in TASK_ROOT.glob("*/*/environment/docker-compose.yaml"):
        task_dir = compose_file.parent.parent
        task_toml = task_dir / "task.toml"
        if not task_toml.is_file() or ENVIRONMENT_MARKER not in task_toml.read_text():
            continue
        lines = compose_file.read_text().splitlines(keepends=True)
        in_main = False
        patched_lines = []
        changed = False
        for line in lines:
            stripped = line.strip()
            if line.startswith("  ") and not line.startswith("    ") and stripped.endswith(":"):
                in_main = stripped == "main:"
            if in_main and line.startswith("    image: "):
                newline = "\n" if line.endswith("\n") else ""
                patched_lines.append(
                    f"    {COMPOSE_IMAGE_MARKER} {stripped}{newline}"
                )
                changed = True
                continue
            patched_lines.append(line)
        if changed:
            compose_file.write_text("".join(patched_lines))
            compose_images += 1

    print(
        f"ARM64 apt transport setup: patched {changed_commands} commands "
        f"across {changed_files} Dockerfiles under {TASK_ROOT}"
    )
    print(
        f"ARM64 verifier selection: switched {native_verifiers} tasks from "
        "prebuilt amd64 images to their unchanged native Dockerfiles"
    )
    print(
        f"ARM64 environment selection: switched {native_environments} tasks "
        "from prebuilt amd64 images to their unchanged native Dockerfiles"
    )
    print(
        f"VPP CPU dependency resolution: pinned {vpp_resolvers} Dockerfiles "
        "to the task's declared CPU-only PyTorch build"
    )
    print(
        f"ARM64 compose selection: removed {compose_images} conflicting "
        "main-service image tags while preserving sidecar images"
    )


if __name__ == "__main__":
    main()
