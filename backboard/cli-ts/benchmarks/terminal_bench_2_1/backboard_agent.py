"""Harbor installed-agent adapter for the Backboard CLI."""

from __future__ import annotations

import base64
import json
import os
import re
import shlex
import tempfile
import time
from pathlib import Path, PurePosixPath
from typing import Any, override

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trial.paths import EnvironmentPaths


class BackboardAgent(BaseInstalledAgent):
    """Run Backboard headlessly inside a Harbor task container."""

    _REMOTE_BINARY = PurePosixPath("/installed-agent/backboard")
    _REMOTE_ARM64_RUNTIME = PurePosixPath("/installed-agent/arm64-musl-runtime")
    _REMOTE_SECRETS_DIR = PurePosixPath("/installed-agent/secrets")
    _REMOTE_AUTH = _REMOTE_SECRETS_DIR / "auth.json"
    _OUTPUT_FILENAME = "backboard.jsonl"
    _MODEL_PATTERN = re.compile(r"^openai-subscription/[A-Za-z0-9._-]+$")
    _THINKING_LEVELS = frozenset({"off", "low", "medium", "high", "max"})
    _EXCLUDED_TOOLS = (
        "AskUser,Computer,Browser,Agent,FindSkill,FindMcp,FetchUrl,WebSearch"
    )

    def __init__(
        self,
        logs_dir: Path,
        binary_dir: str | Path | None = None,
        auth_json_path: str | Path | None = None,
        thinking: str = "high",
        *args: Any,
        **kwargs: Any,
    ) -> None:
        super().__init__(logs_dir, *args, **kwargs)
        self._binary_dir = (
            Path(binary_dir).expanduser().resolve()
            if binary_dir
            else (Path(__file__).parent / "dist").resolve()
        )
        configured_auth = auth_json_path or os.environ.get(
            "BACKBOARD_CHATGPT_SUBSCRIPTION_AUTH_FILE"
        )
        if configured_auth:
            self._auth_json_path = Path(configured_auth).expanduser().resolve()
        else:
            codex_home = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex"))
            self._auth_json_path = (codex_home / "auth.json").resolve()
        if thinking not in self._THINKING_LEVELS:
            raise ValueError(
                f"thinking must be one of {', '.join(sorted(self._THINKING_LEVELS))}"
            )
        self._thinking = thinking
        self._remote_command = (self._REMOTE_BINARY.as_posix(),)

    @staticmethod
    def name() -> str:
        return "backboard"

    def get_version_command(self) -> str:
        return shlex.join([*self._remote_command, "--version"])

    async def install(self, environment: BaseEnvironment) -> None:
        platform_result = await environment.exec(
            command=(
                "arch=$(uname -m); "
                "if [ -e /etc/alpine-release ]; then libc=musl; else libc=glibc; fi; "
                "if grep -qw avx /proc/cpuinfo; then avx=avx; else avx=noavx; fi; "
                'printf "%s %s %s" "$arch" "$libc" "$avx"'
            ),
            user="root",
        )
        if platform_result.return_code != 0:
            raise RuntimeError("Could not detect the task container architecture")
        platform = platform_result.stdout.strip()
        architecture, libc, _ = platform.split(" ", maxsplit=2)
        x64_without_avx = platform in {
            "x86_64 glibc noavx",
            "amd64 glibc noavx",
            "x86_64 musl noavx",
            "amd64 musl noavx",
        }
        if x64_without_avx:
            # Some official benchmark images are amd64-only. On an ARM64 Docker
            # host, their x64 userspace is emulated without AVX, so Bun's x64
            # executable cannot start. Linux can still execute the native ARM64
            # binary; ship its small musl runtime alongside it so this works
            # without altering the task image or benchmark dependencies.
            binary_name = "backboard-linux-arm64-musl"
        else:
            binary_name = {
                "x86_64 glibc": "backboard-linux-x64",
                "amd64 glibc": "backboard-linux-x64",
                "aarch64 glibc": "backboard-linux-arm64",
                "arm64 glibc": "backboard-linux-arm64",
                "x86_64 musl": "backboard-linux-x64-musl",
                "amd64 musl": "backboard-linux-x64-musl",
                "aarch64 musl": "backboard-linux-arm64-musl",
                "arm64 musl": "backboard-linux-arm64-musl",
            }.get(f"{architecture} {libc}")
        if binary_name is None:
            raise RuntimeError(f"Unsupported task container platform: {platform}")
        local_binary = self._binary_dir / binary_name
        if not local_binary.is_file():
            raise FileNotFoundError(
                f"Backboard benchmark binary not found: {local_binary}. "
                "Run `bun run test:terminal-bench:build` first."
            )
        await environment.upload_file(local_binary, self._REMOTE_BINARY.as_posix())
        await self.exec_as_root(
            environment,
            command=f"chmod 755 {shlex.quote(self._REMOTE_BINARY.as_posix())}",
        )
        if x64_without_avx:
            runtime_dir = self._binary_dir / "arm64-musl-runtime"
            runtime_files = (
                "ld-musl-aarch64.so.1",
                "libstdc++.so.6",
                "libgcc_s.so.1",
            )
            missing = [
                str(runtime_dir / name)
                for name in runtime_files
                if not (runtime_dir / name).is_file()
            ]
            if missing:
                raise FileNotFoundError(
                    "ARM64 compatibility runtime not found: "
                    + ", ".join(missing)
                    + ". Run `bun run test:terminal-bench:build` first."
                )
            remote_runtime = self._REMOTE_ARM64_RUNTIME.as_posix()
            await self.exec_as_root(
                environment,
                command=f"mkdir -p {shlex.quote(remote_runtime)}",
            )
            for name in runtime_files:
                await environment.upload_file(
                    runtime_dir / name,
                    (self._REMOTE_ARM64_RUNTIME / name).as_posix(),
                )
            remote_loader = (
                self._REMOTE_ARM64_RUNTIME / "ld-musl-aarch64.so.1"
            ).as_posix()
            await self.exec_as_root(
                environment,
                command=f"chmod 755 {shlex.quote(remote_loader)}",
            )
            self._remote_command = (
                remote_loader,
                "--library-path",
                remote_runtime,
                self._REMOTE_BINARY.as_posix(),
            )
        else:
            self._remote_command = (self._REMOTE_BINARY.as_posix(),)

    @override
    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        model = self.model_name or ""
        if not self._MODEL_PATTERN.fullmatch(model):
            raise ValueError(
                "Backboard Terminal-Bench runs require an explicit "
                "openai-subscription/<model> model"
            )

        auth_payload = self._minimal_subscription_auth()
        remote_auth = self._REMOTE_AUTH.as_posix()
        remote_secrets_dir = self._REMOTE_SECRETS_DIR.as_posix()
        agent_logs_dir = EnvironmentPaths.agent_dir.as_posix()
        output_path = (EnvironmentPaths.agent_dir / self._OUTPUT_FILENAME).as_posix()
        identity_result = await environment.exec(command="id -u && id -g")
        identity_lines = identity_result.stdout.splitlines()
        if identity_result.return_code != 0 or len(identity_lines) != 2:
            raise RuntimeError("Could not determine the task container agent user")
        try:
            agent_uid, agent_gid = (int(value.strip()) for value in identity_lines)
        except ValueError as exc:
            raise RuntimeError(
                "Task container returned an invalid agent user identity"
            ) from exc
        owner = shlex.quote(f"{agent_uid}:{agent_gid}")
        owner_command = (
            f"chown {owner} {shlex.quote(remote_secrets_dir)} "
            f"{shlex.quote(agent_logs_dir)} && "
        )

        await self.exec_as_root(
            environment,
            command=(
                f"mkdir -p {shlex.quote(remote_secrets_dir)} "
                f"{shlex.quote(agent_logs_dir)} && "
                + owner_command
                + f"chmod 700 {shlex.quote(remote_secrets_dir)}"
            ),
        )

        try:
            with tempfile.TemporaryDirectory(
                prefix="backboard-terminal-bench-auth-"
            ) as temp_dir:
                local_auth = Path(temp_dir) / "auth.json"
                local_auth.write_text(json.dumps(auth_payload) + "\n")
                local_auth.chmod(0o600)
                await environment.upload_file(local_auth, remote_auth)

            owner_command = f"chown {owner} {shlex.quote(remote_auth)} && "
            await self.exec_as_root(
                environment,
                command=(
                    owner_command
                    + f"chmod 600 {shlex.quote(remote_auth)}"
                ),
            )

            command = shlex.join(
                [
                    *self._remote_command,
                    "--format",
                    "json",
                    "--fresh",
                    "--model",
                    model,
                    "--thinking",
                    self._thinking,
                    "--memory",
                    "off",
                    "--permission-mode",
                    "bypass",
                    "--no-final-verification",
                    "--excluded-tools",
                    self._EXCLUDED_TOOLS,
                    "--print",
                    instruction,
                ]
            )
            result = await self.exec_as_agent(
                environment,
                command=(
                    f"{command} 2>&1 | tee {shlex.quote(output_path)}"
                ),
                env={
                    "BACKBOARD_CHATGPT_SUBSCRIPTION_AUTH_FILE": remote_auth,
                    "BACKBOARD_API_KEY": "",
                },
            )
            self._populate_usage_context(result.stdout or "", context, model)
        finally:
            try:
                await self.exec_as_root(
                    environment,
                    command=(
                        f"rm -f {shlex.quote(remote_auth)} && "
                        f"rmdir {shlex.quote(remote_secrets_dir)} 2>/dev/null || true"
                    ),
                )
            except Exception:
                pass

    def _minimal_subscription_auth(self) -> dict[str, object]:
        try:
            parsed = json.loads(self._auth_json_path.read_text())
        except (OSError, json.JSONDecodeError) as exc:
            raise ValueError(
                f"Could not read ChatGPT login at {self._auth_json_path}"
            ) from exc
        if parsed.get("auth_mode") != "chatgpt":
            raise ValueError(
                f"Expected auth_mode=chatgpt in {self._auth_json_path}"
            )
        tokens = parsed.get("tokens")
        if not isinstance(tokens, dict):
            raise ValueError("ChatGPT login does not contain subscription tokens")
        access_token = tokens.get("access_token")
        account_id = tokens.get("account_id")
        if not isinstance(access_token, str) or not access_token:
            raise ValueError("ChatGPT login is missing access_token")
        if not isinstance(account_id, str) or not account_id:
            raise ValueError("ChatGPT login is missing account_id")

        expires_at = self._jwt_expiry(access_token)
        if expires_at is not None and expires_at <= time.time() + 300:
            raise ValueError(
                "ChatGPT subscription token expires in less than five minutes. "
                "Refresh the login before starting Terminal-Bench."
            )
        return {
            "auth_mode": "chatgpt",
            "tokens": {
                "access_token": access_token,
                "account_id": account_id,
            },
        }

    @staticmethod
    def _jwt_expiry(token: str) -> float | None:
        parts = token.split(".")
        if len(parts) != 3:
            return None
        payload = parts[1] + "=" * (-len(parts[1]) % 4)
        try:
            claims = json.loads(base64.urlsafe_b64decode(payload))
        except (ValueError, json.JSONDecodeError):
            return None
        if not isinstance(claims, dict):
            return None
        expiry = claims.get("exp")
        return float(expiry) if isinstance(expiry, (int, float)) else None

    @staticmethod
    def _populate_usage_context(
        output: str, context: AgentContext, model: str
    ) -> None:
        input_tokens = 0
        output_tokens = 0
        usage_events = 0
        for line in output.splitlines():
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            if record.get("type") != "usage":
                continue
            usage = record.get("payload", {}).get("usage", {})
            if not isinstance(usage, dict):
                continue
            input_tokens += int(usage.get("inputTokens") or 0)
            output_tokens += int(usage.get("outputTokens") or 0)
            usage_events += 1
        context.n_input_tokens = input_tokens or None
        context.n_output_tokens = output_tokens or None
        context.metadata = {
            "backboard_model": model,
            "backboard_usage_events": usage_events,
            "credential_kind": "chatgpt_subscription",
        }
