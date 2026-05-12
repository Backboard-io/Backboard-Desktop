#!/usr/bin/env python3
"""Backboard ACP bridge for the Backboard Zed fork.

This file is intentionally owned by the IDE tree. It imports the existing
Backboard CLI as a read-only agent engine, then speaks ACP JSON-RPC over stdio
so the native Zed agent panel can render chat, tools, terminal output, and
reviewable diffs.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import shlex
import signal
import sys
import traceback
import uuid
from pathlib import Path
from typing import Any, Awaitable, Callable


PROTOCOL_STDOUT = sys.stdout
sys.stdout = sys.stderr


def _find_cli_root() -> Path:
    env_root = os.environ.get("BACKBOARD_CLI_ROOT")
    if env_root:
        return Path(env_root).expanduser().resolve()

    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "cli"
        if (candidate / "backboard_cli").is_dir():
            return candidate

    # Default checkout layout: ide/zed/script/backboard-ide-acp.py -> repo/cli.
    return here.parents[3] / "cli"


CLI_ROOT = _find_cli_root()
if str(CLI_ROOT) not in sys.path:
    sys.path.insert(0, str(CLI_ROOT))

CLI_IMPORT_ERROR: BaseException | None = None
CLI_IMPORT_TRACEBACK = ""
try:
    from backboard_cli.agent.engine import RLMEngine
    from backboard_cli.agent.subagents import SubagentManager
    from backboard_cli.api.client import BackboardAPIClient
    from backboard_cli.api.mcp.manager import MCPManager
    from backboard_cli.cli.chat.pricing import PricingService
    from backboard_cli.cli.chat.prompt import build_system_prompt
    from backboard_cli.skills.manager import SkillManager
    from backboard_cli.state.config import config
    from backboard_cli.tools.manager import AdvancedToolManager
except BaseException as exc:  # pragma: no cover - surfaced in the IDE.
    CLI_IMPORT_ERROR = exc
    CLI_IMPORT_TRACEBACK = traceback.format_exc()


JSONRPC = "2.0"
MUTATING_TOOLS = {
    "write",
    "edit",
    "search_replace",
    "delete_file",
    "create_directory",
    "edit_notebook",
}
SHELL_TOOLS = {"bash", "run_terminal_cmd", "run_code", "repl", "computer"}
ASK_BLOCKED_TOOLS = MUTATING_TOOLS | SHELL_TOOLS | {"task"}
MANUAL_BLOCKED_TOOLS = SHELL_TOOLS | {"task"}
MAX_DISPLAY_CHARS = 16000
DEFAULT_PROVIDER = "openai"
DEFAULT_MODEL = "gpt-4o"
DEFAULT_CONTEXT_WINDOW = 258_000
MODEL_LIST_CACHE_TTL_SECONDS = 300.0
TOOL_DEFINITION_CACHE_TTL_SECONDS = 30.0
CONTEXT_PACK_MAX_CHARS = 9000
CONTEXT_PREWARM_MAX_FILES = 120
CONTEXT_PREWARM_TIMEOUT_SECONDS = 3.0
DEFAULT_COMMAND_TIMEOUT_MS = 45_000
READ_ONLY_COMMAND_TIMEOUT_MS = 20_000
CHECK_COMMAND_TIMEOUT_MS = 90_000
INSTALL_COMMAND_TIMEOUT_MS = 120_000
DEV_SERVER_STARTUP_TIMEOUT_MS = 10_000
MAX_COMMAND_TIMEOUT_MS = 180_000
TERMINAL_UPDATE_INTERVAL_SECONDS = 0.25
TERMINAL_UPDATE_MAX_CHARS = 12_000
READ_ONLY_IDE_TOOLS = {
    "read_file",
    "list_dir",
    "glob",
    "glob_file_search",
    "grep",
    "codebase_search",
    "web_fetch",
    "web_search",
    "read_lints",
}
CONTEXT_IGNORE_DIRS = {
    ".backboard",
    ".git",
    ".hg",
    ".svn",
    ".venv",
    "__pycache__",
    "build",
    "dist",
    "node_modules",
    "target",
    "vendor",
}
MODEL_LIST_CACHE: dict[str, Any] = {"expires_at": 0.0, "models": None}
READ_ONLY_COMMANDS = {
    "cat",
    "du",
    "fd",
    "file",
    "find",
    "git",
    "grep",
    "head",
    "ls",
    "pwd",
    "rg",
    "sed",
    "stat",
    "tail",
    "tree",
    "curl",
    "wc",
}
READ_ONLY_GIT_SUBCOMMANDS = {
    "blame",
    "describe",
    "diff",
    "grep",
    "log",
    "ls-files",
    "ls-tree",
    "rev-parse",
    "show",
    "status",
}
SAFE_GIT_BRANCH_FLAGS = {"--show-current", "--list", "-a", "-r", "-v", "-vv", "--verbose"}
SAFE_GIT_REMOTE_FLAGS = {"-v", "--verbose"}
SAFE_GIT_CONFIG_FLAGS = {"--get", "--get-all", "--get-regexp", "--list", "-l", "--show-origin"}
UNSAFE_GIT_SUBCOMMANDS = {
    "add",
    "am",
    "apply",
    "bisect",
    "branch",
    "checkout",
    "cherry-pick",
    "clean",
    "clone",
    "commit",
    "config",
    "fetch",
    "gc",
    "init",
    "merge",
    "mv",
    "pull",
    "push",
    "rebase",
    "remote",
    "reset",
    "restore",
    "revert",
    "rm",
    "stash",
    "submodule",
    "switch",
    "tag",
    "worktree",
}
UNSAFE_SHELL_TOKENS = {";", "&", "|", ">", "<", "`", "$", "\n", "\r"}
UNSAFE_READ_FLAGS = {
    "--delete",
    "--exec",
    "--execdir",
    "--ok",
    "--okdir",
    "-delete",
    "-exec",
    "-execdir",
    "-ok",
    "-okdir",
    "-i",
    "-i''",
    "-i\"\"",
    "--in-place",
}
CURL_SAFE_METHODS = {"GET", "HEAD"}

INSTALL_COMMAND_NAMES = {"npm", "pnpm", "yarn", "bun"}
CHECK_COMMAND_NAMES = {"cargo", "pytest", "vitest", "playwright", "tsc", "ruff", "eslint"}
DEV_SERVER_COMMAND_MARKERS = {
    "npm run dev",
    "pnpm dev",
    "pnpm run dev",
    "yarn dev",
    "yarn run dev",
    "bun dev",
    "bun run dev",
    "vite",
    "next dev",
    "astro dev",
    "python -m http.server",
    "python3 -m http.server",
}
SUPPORTED_MODES = {"agent", "ask", "manual", "free"}


class JsonRpcError(Exception):
    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _json_dumps(payload: dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def _text_block(text: str) -> dict[str, Any]:
    return {"type": "text", "text": text}


def _content_item(text: str) -> dict[str, Any]:
    return {"type": "content", "content": _text_block(text)}


def _diff_item(path: Path, old_text: str | None, new_text: str) -> dict[str, Any]:
    item: dict[str, Any] = {
        "type": "diff",
        "path": str(path),
        "newText": new_text,
    }
    if old_text is not None:
        item["oldText"] = old_text
    return item


def _tool_locations(path: Path) -> list[dict[str, Any]]:
    return [{"path": str(path)}]


def _truncate(text: str, limit: int = MAX_DISPLAY_CHARS) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n\n[truncated {len(text) - limit} chars]"


def _shared_config_defaults() -> tuple[str, str]:
    config_path = Path.home() / ".backboard" / "config.json"
    provider = DEFAULT_PROVIDER
    model = DEFAULT_MODEL

    with contextlib.suppress(Exception):
        payload = json.loads(config_path.read_text(encoding="utf-8"))
        if isinstance(payload, dict):
            provider = str(payload.get("default_provider") or provider).strip() or provider
            model = str(payload.get("default_model") or model).strip() or model

    return provider, model


def _result_text(value: Any) -> str:
    if isinstance(value, str):
        return _truncate(value)
    try:
        return _truncate(json.dumps(value, indent=2, ensure_ascii=False))
    except TypeError:
        return _truncate(str(value))


def _function_payload(tool_call: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    function = tool_call.get("function") or {}
    name = tool_call.get("name") or function.get("name") or tool_call.get("tool_name") or "tool"
    raw_args = tool_call.get("arguments")
    if raw_args is None:
        raw_args = function.get("arguments", {})

    if isinstance(raw_args, str):
        try:
            args = json.loads(raw_args) if raw_args.strip() else {}
        except json.JSONDecodeError:
            args = {"raw_arguments": raw_args}
    elif isinstance(raw_args, dict):
        args = raw_args
    else:
        args = {}
    return str(name), args


def _tool_call_id(tool_call: dict[str, Any]) -> str:
    return str(
        tool_call.get("id")
        or tool_call.get("tool_call_id")
        or tool_call.get("call_id")
        or f"tool-{uuid.uuid4().hex}"
    )


def _tool_kind(name: str) -> str:
    if name in {"read_file", "list_dir"}:
        return "read"
    if name in {"write", "edit", "search_replace", "edit_notebook"}:
        return "edit"
    if name == "delete_file":
        return "delete"
    if name in {"glob", "glob_file_search", "grep", "codebase_search"}:
        return "search"
    if name in SHELL_TOOLS:
        return "execute"
    if name in {"web_fetch", "web_search"}:
        return "fetch"
    if name in {"todo_write", "enter_plan_mode", "exit_plan_mode", "persistence_decide"}:
        return "think"
    return "other"


def _path_arg(args: dict[str, Any]) -> str | None:
    for key in (
        "file_path",
        "path",
        "target_file",
        "target_directory",
        "file",
        "filename",
        "directory_path",
    ):
        value = args.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def _content_arg(args: dict[str, Any]) -> str | None:
    for key in ("content", "contents", "text", "new_content"):
        if key in args:
            value = args.get(key)
            return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    return None


def _extract_shell_command(name: str, args: dict[str, Any]) -> str:
    for key in ("command", "cmd", "code", "script"):
        value = args.get(key)
        if isinstance(value, str):
            return value
    return name


def _selected_permission_option(response: dict[str, Any]) -> str | None:
    outcome = response.get("outcome") if isinstance(response, dict) else None
    if not isinstance(outcome, dict):
        return None
    if outcome.get("outcome") != "selected":
        return None
    option_id = outcome.get("optionId")
    return str(option_id) if option_id else None


def _is_read_only_shell_command(command: str) -> bool:
    command = command.strip()
    if not command:
        return False
    if any(token in command for token in UNSAFE_SHELL_TOKENS):
        return False
    try:
        tokens = shlex.split(command, posix=True)
    except ValueError:
        return False
    if not tokens:
        return False

    executable = Path(tokens[0]).name
    if executable not in READ_ONLY_COMMANDS:
        return False
    if executable == "curl":
        return _is_read_only_curl_command(tokens[1:])
    if any(token in UNSAFE_READ_FLAGS for token in tokens[1:]):
        return False
    if executable == "git":
        return _is_read_only_git_command(tokens[1:])
    if executable == "find":
        return not any(token in UNSAFE_READ_FLAGS for token in tokens[1:])
    if executable == "sed":
        return _is_read_only_sed_command(tokens[1:])
    return True


def _is_read_only_git_command(args: list[str]) -> bool:
    if not args:
        return True

    # Skip `git -C path status` and global read-only display flags.
    cleaned: list[str] = []
    skip_next = False
    for index, arg in enumerate(args):
        if skip_next:
            skip_next = False
            continue
        if arg == "-C":
            skip_next = True
            continue
        if arg in {"--no-pager", "--paginate"}:
            continue
        cleaned.append(arg)

    if not cleaned:
        return True

    subcommand = cleaned[0]
    rest = cleaned[1:]
    if subcommand in READ_ONLY_GIT_SUBCOMMANDS:
        return True
    if subcommand == "branch":
        has_list_mode = not rest or any(arg in {"--list", "-a", "-r", "-v", "-vv", "--verbose"} for arg in rest)
        return has_list_mode and all(arg in SAFE_GIT_BRANCH_FLAGS or not arg.startswith("-") for arg in rest)
    if subcommand == "remote":
        return not rest or all(arg in SAFE_GIT_REMOTE_FLAGS or arg == "show" for arg in rest)
    if subcommand == "config":
        return bool(rest) and rest[0] in SAFE_GIT_CONFIG_FLAGS
    if subcommand == "stash":
        return bool(rest) and rest[0] in {"list", "show"}
    if subcommand in UNSAFE_GIT_SUBCOMMANDS:
        return False
    return False


def _is_read_only_sed_command(args: list[str]) -> bool:
    if any(arg in {"-i", "--in-place"} or arg.startswith("-i") for arg in args):
        return False
    scripts = [arg for arg in args if not arg.startswith("-")]
    # `sed` can write files with the `w` command and execute shell commands on
    # some platforms with `e`; keep the auto-approval path limited.
    return not any("w " in script or script.endswith("w") or "e " in script for script in scripts)


def _is_mutating_curl_arg(arg: str) -> bool:
    return (
        arg in {
            "-d",
            "--data",
            "--data-binary",
            "--data-raw",
            "--data-urlencode",
            "-F",
            "--form",
            "--form-string",
            "-T",
            "--upload-file",
            "-o",
            "--output",
            "-O",
            "--remote-name",
            "--remote-name-all",
            "--remote-header-name",
            "-J",
            "--upload-file",
        }
        or arg.startswith("-d")
        or arg.startswith("--data")
        or arg.startswith("-F")
        or arg.startswith("--form")
        or arg.startswith("-T")
        or arg.startswith("--upload-file")
        or arg.startswith("-o")
        or arg.startswith("--output=")
        or arg == "--remote-name"
        or arg == "--remote-header-name"
    )


def _is_read_only_curl_command(args: list[str]) -> bool:
    if not args:
        return False

    request_method = "GET"
    index = 0
    while index < len(args):
        arg = args[index]

        if arg == "-I" or arg == "--head":
            request_method = "HEAD"
            index += 1
            continue

        if arg == "-X" or arg == "--request":
            if index + 1 >= len(args):
                return False
            request_method = args[index + 1].strip().upper()
            if request_method not in CURL_SAFE_METHODS:
                return False
            index += 2
            continue

        if arg.startswith("--request="):
            request_method = arg.split("=", 1)[1].strip().upper()
            if request_method not in CURL_SAFE_METHODS:
                return False
            index += 1
            continue

        if arg.startswith("-X") and arg != "-X":
            request_method = arg[2:].lstrip("=").strip().upper()
            if request_method not in CURL_SAFE_METHODS:
                return False
            index += 1
            continue

        if arg == "--":
            break

        if _is_mutating_curl_arg(arg):
            return False

        index += 1

    return request_method in CURL_SAFE_METHODS


def _command_tokens(command: str) -> list[str]:
    with contextlib.suppress(ValueError):
        return shlex.split(command.strip(), posix=True)
    return []


def _is_dev_server_command(command: str) -> bool:
    normalized = " ".join(command.strip().split()).lower()
    return any(
        normalized == marker or normalized.startswith(f"{marker} ")
        for marker in DEV_SERVER_COMMAND_MARKERS
    )


def _is_install_command(command: str) -> bool:
    tokens = _command_tokens(command)
    if not tokens:
        return False
    executable = Path(tokens[0]).name
    if executable == "npm":
        return len(tokens) > 1 and tokens[1] in {"install", "i", "ci"}
    if executable in {"pnpm", "yarn", "bun"}:
        return len(tokens) > 1 and tokens[1] in {"install", "i", "add"}
    return False


def _is_check_command(command: str) -> bool:
    tokens = _command_tokens(command)
    if not tokens:
        return False
    executable = Path(tokens[0]).name
    if executable in CHECK_COMMAND_NAMES:
        return True
    if executable in INSTALL_COMMAND_NAMES and any(token in {"test", "build", "lint", "check"} for token in tokens[1:]):
        return True
    return False


def _command_timeout_ms(command: str, args: dict[str, Any], read_only: bool) -> int:
    explicit = args.get("timeout")
    if explicit is not None:
        with contextlib.suppress(TypeError, ValueError):
            return max(1_000, min(int(float(explicit)), MAX_COMMAND_TIMEOUT_MS))
    if _is_dev_server_command(command):
        return DEV_SERVER_STARTUP_TIMEOUT_MS
    if read_only:
        return READ_ONLY_COMMAND_TIMEOUT_MS
    if _is_install_command(command):
        return INSTALL_COMMAND_TIMEOUT_MS
    if _is_check_command(command):
        return CHECK_COMMAND_TIMEOUT_MS
    return DEFAULT_COMMAND_TIMEOUT_MS


def _session_store_path() -> Path:
    return Path.home() / ".backboard" / "ide_sessions.json"


def _load_session_store() -> dict[str, Any]:
    path = _session_store_path()
    if not path.exists():
        return {}
    with contextlib.suppress(Exception):
        loaded = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(loaded, dict):
            return loaded
    return {}


class AcpServer:
    def __init__(self) -> None:
        self.sessions: dict[str, BackboardIdeSession] = {}
        self.pending: dict[str, asyncio.Future] = {}
        self.tasks: set[asyncio.Task] = set()
        self._write_lock = asyncio.Lock()
        self._next_request_id = 1

    async def serve(self) -> None:
        while True:
            line = await asyncio.to_thread(sys.stdin.readline)
            if not line:
                break
            with contextlib.suppress(Exception):
                await self.handle_line(line)

        for task in list(self.tasks):
            task.cancel()
        for session in list(self.sessions.values()):
            await session.close()

    async def handle_line(self, line: str) -> None:
        try:
            message = json.loads(line)
        except json.JSONDecodeError as exc:
            await self._send_error(None, -32700, f"Malformed JSON: {exc}")
            return

        if "method" in message:
            if "id" in message:
                task = asyncio.create_task(self._request_task(message))
                self.tasks.add(task)
                task.add_done_callback(self.tasks.discard)
            else:
                await self._handle_notification(message)
            return

        request_id = str(message.get("id"))
        future = self.pending.pop(request_id, None)
        if future and not future.done():
            if "error" in message:
                error = message.get("error") or {}
                future.set_exception(JsonRpcError(error.get("code", -32000), error.get("message", "Request failed")))
            else:
                future.set_result(message.get("result"))

    async def _request_task(self, message: dict[str, Any]) -> None:
        request_id = message.get("id")
        try:
            result = await self._handle_request(message.get("method"), message.get("params") or {})
        except JsonRpcError as exc:
            await self._send_error(request_id, exc.code, exc.message)
        except Exception as exc:  # pragma: no cover - defensive bridge surface.
            print(traceback.format_exc(), file=sys.stderr)
            await self._send_error(request_id, -32000, str(exc))
        else:
            await self._send({"jsonrpc": JSONRPC, "id": request_id, "result": result})

    async def _handle_request(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        if method == "initialize":
            return {
                "protocolVersion": params.get("protocolVersion", 1),
                "agentCapabilities": {
                    "loadSession": True,
                    "promptCapabilities": {
                        "embeddedContext": True,
                        "image": False,
                        "audio": False,
                    },
                    "mcpCapabilities": {},
                    "sessionCapabilities": {"close": {}},
                },
                "agentInfo": {
                    "name": "backboard",
                    "title": "Backboard",
                    "version": "ide-acp",
                },
            }

        if method == "authenticate":
            return {}

        if method == "session/new":
            cwd = Path(params.get("cwd") or os.getcwd()).expanduser().resolve()
            session_id = f"backboard-{uuid.uuid4().hex}"
            session = BackboardIdeSession(self, session_id, cwd)
            self.sessions[session_id] = session
            session.start_prewarm()
            return {
                "sessionId": session_id,
                "modes": self._mode_state("agent"),
                "models": await session.model_state(),
                "configOptions": session.config_options(),
            }

        if method == "session/load":
            session_id = str(params.get("sessionId") or params.get("session_id") or "")
            cwd = Path(params.get("cwd") or os.getcwd()).expanduser().resolve()
            session = self.sessions.get(session_id)
            if session is None:
                session = BackboardIdeSession(self, session_id, cwd)
                self.sessions[session_id] = session
            else:
                session.workspace = cwd
            session.start_prewarm()
            return await session.load()

        if method == "session/list":
            sessions = []
            for session_id, data in _load_session_store().items():
                workspace = data.get("workspace") or str(Path.home())
                sessions.append(
                    {
                        "sessionId": session_id,
                        "cwd": workspace,
                        "title": data.get("title") or Path(workspace).name,
                        "updatedAt": data.get("updated_at"),
                    }
                )
            return {"sessions": sessions}

        if method == "session/set_mode":
            session = self._session(params)
            mode_id = str(params.get("modeId") or params.get("mode_id") or "agent")
            if mode_id not in SUPPORTED_MODES:
                mode_id = "agent"
            session.mode = mode_id
            session._tool_definitions_cache.clear()
            return {}

        if method == "session/set_model":
            session = self._session(params)
            model_id = str(params.get("modelId") or params.get("model_id") or "")
            if "/" in model_id:
                session.provider, session.model = model_id.split("/", 1)
            elif model_id:
                session.model = model_id
            session._tool_definitions_cache.clear()
            if session.assistant_id or session.thread_id:
                session._persist_session_mapping()
            return {}

        if method == "session/set_config_option":
            session = self._session(params)
            config_id = str(params.get("configId") or params.get("config_id") or "")
            value = params.get("value")
            if isinstance(value, dict):
                value = value.get("value")
            value_id = str(value or "")
            if config_id == "backboard_intensity":
                session.intensity = value_id if value_id in {"fast", "balanced", "deep"} else "fast"
                session._tool_definitions_cache.clear()
            return {"configOptions": session.config_options()}

        if method == "session/prompt":
            session = self._session(params)
            return await session.prompt(params.get("prompt") or [])

        if method == "session/close":
            session = self._session(params)
            await session.close()
            self.sessions.pop(session.session_id, None)
            return {}

        raise JsonRpcError(-32601, f"Unsupported ACP method: {method}")

    async def _handle_notification(self, message: dict[str, Any]) -> None:
        method = message.get("method")
        params = message.get("params") or {}
        if method == "session/cancel":
            session_id = params.get("sessionId") or params.get("session_id")
            session = self.sessions.get(str(session_id))
            if session:
                await session.cancel()

    def _session(self, params: dict[str, Any]) -> "BackboardIdeSession":
        session_id = params.get("sessionId") or params.get("session_id")
        session = self.sessions.get(str(session_id))
        if not session:
            raise JsonRpcError(-32602, f"Unknown Backboard session: {session_id}")
        return session

    def _mode_state(self, current: str) -> dict[str, Any]:
        return {
            "currentModeId": current,
            "availableModes": [
                {
                    "id": "agent",
                    "name": "Agent",
                    "description": "Autonomous edits, terminal commands, MCP, indexing, memories, and subagents.",
                },
                {
                    "id": "ask",
                    "name": "Ask",
                    "description": "Read, search, and explain without file writes or shell mutation.",
                },
                {
                    "id": "manual",
                    "name": "Manual",
                    "description": "Focused edit proposals with explicit diff review.",
                },
                {
                    "id": "free",
                    "name": "Free",
                    "description": "Unrestricted tool access. Terminal commands run without approval prompts.",
                },
            ],
        }

    async def notify(self, method: str, params: dict[str, Any]) -> None:
        await self._send({"jsonrpc": JSONRPC, "method": method, "params": params})

    async def request(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        request_id = f"backboard-{self._next_request_id}"
        self._next_request_id += 1
        loop = asyncio.get_running_loop()
        future = loop.create_future()
        self.pending[request_id] = future
        await self._send({"jsonrpc": JSONRPC, "id": request_id, "method": method, "params": params})
        result = await future
        return result or {}

    async def _send_error(self, request_id: Any, code: int, message: str) -> None:
        await self._send(
            {
                "jsonrpc": JSONRPC,
                "id": request_id,
                "error": {"code": code, "message": message},
            }
        )

    async def _send(self, payload: dict[str, Any]) -> None:
        async with self._write_lock:
            PROTOCOL_STDOUT.write(_json_dumps(payload) + "\n")
            PROTOCOL_STDOUT.flush()


class BackboardIdeSession:
    def __init__(self, server: AcpServer, session_id: str, cwd: Path) -> None:
        self.server = server
        self.session_id = session_id
        self.workspace = cwd
        self.mode = "agent"
        self.provider: str | None = None
        self.model: str | None = None
        self.intensity = "fast"
        self.pricing = PricingService()
        self.session_total_cost = 0.0
        self.api_client: Any = None
        self.tool_system: Any = None
        self.mcp_manager: Any = None
        self.assistant_id: str | None = None
        self.thread_id: str | None = None
        self.current_run_id: str | None = None
        self.context_window_tokens: int | None = None
        self.cancel_event = asyncio.Event()
        self._ready_lock = asyncio.Lock()
        self._prompt_lock = asyncio.Lock()
        self._thinking = False
        self._history_replayed = False
        self._phase = "starting"
        self._heartbeat_task: asyncio.Task | None = None
        self._prewarm_task: asyncio.Task | None = None
        self._last_visible_event = 0.0
        self._last_progress_note = ""
        self._tool_definitions_cache: dict[str, tuple[float, list[dict[str, Any]]]] = {}
        self._tool_names_cache: list[str] | None = None
        self._skill_section_cache: str | None = None
        self._system_prompt_cache: str | None = None
        self._context_cache: dict[str, Any] = {}
        self._context_cache_at = 0.0
        self._turn_started_at = 0.0
        self._first_token_seen = False
        self._speed_timings: dict[str, float] = {}
        self._speed_totals: dict[str, float] = {}
        self._slowest_tool_name: str | None = None
        self._slowest_tool_ms = 0.0

    async def load(self) -> dict[str, Any]:
        self.cancel_event.clear()

        if CLI_IMPORT_ERROR is not None:
            await self._agent_text(
                "Backboard IDE could not import the existing CLI engine.\n\n"
                f"{CLI_IMPORT_ERROR}\n\n{CLI_IMPORT_TRACEBACK}"
            )
            return {
                "modes": self.server._mode_state(self.mode),
                "models": await self.model_state(),
                "configOptions": self.config_options(),
            }

        restored = self._restore_session_mapping()
        if not restored:
            # Treat missing persisted state as a fresh session instead of a launch failure.
            if await self._ensure_runtime():
                await self._ensure_thread_binding()
        elif await self._ensure_runtime():
            await self._replay_history()
        else:
            await self._agent_text(
                "Backboard needs an API key before the IDE agent can restore this session. "
                "Set it in the shared config with `backboard config set-api-key <key>`."
            )

        return {
            "modes": self.server._mode_state(self.mode),
            "models": await self.model_state(),
            "configOptions": self.config_options(),
        }

    async def model_state(self) -> dict[str, Any]:
        if CLI_IMPORT_ERROR is not None:
            return self._fallback_model_state()

        config.sync_from_disk_if_changed()
        self.provider = self.provider or config.default_provider
        self.model = self.model or config.default_model
        fallback = self._fallback_model_state()

        if not config.api_key:
            return fallback

        try:
            started = self._loop_time()
            await self._ensure_runtime()
            self._record_timing("runtime_load_ms", started)
            now = self._loop_time()
            cached_models = MODEL_LIST_CACHE.get("models")
            expires_at = float(MODEL_LIST_CACHE.get("expires_at") or 0.0)
            if cached_models is not None and now < expires_at:
                models = cached_models
            else:
                started = self._loop_time()
                models = await self.api_client.list_models(limit=250)
                self._record_timing("model_list_ms", started)
                MODEL_LIST_CACHE["models"] = models
                MODEL_LIST_CACHE["expires_at"] = now + MODEL_LIST_CACHE_TTL_SECONDS
            with contextlib.suppress(Exception):
                self.pricing.update_from_catalog(models)
        except Exception:
            return fallback

        available_models = []
        seen = set()
        for item in models:
            if not isinstance(item, dict):
                continue
            provider = str(item.get("provider") or "").strip()
            name = str(item.get("name") or item.get("id") or "").strip()
            if not provider or not name:
                continue
            model_id = f"{provider}/{name}"
            if model_id in seen:
                continue
            seen.add(model_id)
            context_limit = item.get("context_limit") or item.get("context_window") or item.get("max_context_tokens")
            if model_id == fallback["currentModelId"] and isinstance(context_limit, (int, float)):
                self.context_window_tokens = int(context_limit)
            available_models.append(
                {
                    "modelId": model_id,
                    "name": name,
                    "description": provider,
                }
            )

        current_id = fallback["currentModelId"]
        if current_id not in seen:
            available_models.insert(0, fallback["availableModels"][0])

        return {
            "currentModelId": current_id,
            "availableModels": available_models,
        }

    def config_options(self) -> list[dict[str, Any]]:
        return [
            {
                "id": "backboard_intensity",
                "name": "Intensity",
                "description": "Controls speed by changing how much extended model thinking Backboard asks for.",
                "category": "thought_level",
                "type": "select",
                "currentValue": self.intensity,
                "options": [
                    {
                        "value": "fast",
                        "name": "Fast",
                        "description": "Prioritize quick streaming and skip extended thinking.",
                    },
                    {
                        "value": "balanced",
                        "name": "Balanced",
                        "description": "Use a small thinking budget when the selected model supports it.",
                    },
                    {
                        "value": "deep",
                        "name": "Deep",
                        "description": "Use the configured Backboard thinking settings for harder work.",
                    },
                ],
            }
        ]

    def start_prewarm(self) -> None:
        if self._prewarm_task and not self._prewarm_task.done():
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        self._prewarm_task = loop.create_task(self._prewarm_context())

    def _loop_time(self) -> float:
        with contextlib.suppress(RuntimeError):
            return asyncio.get_running_loop().time()
        return 0.0

    def _elapsed_ms(self, started_at: float) -> float:
        now = self._loop_time()
        if not started_at or not now:
            return 0.0
        return round(max(0.0, now - started_at) * 1000.0, 1)

    def _record_timing(self, key: str, started_at: float) -> None:
        elapsed = self._elapsed_ms(started_at)
        if elapsed:
            self._speed_timings[key] = elapsed

    def _add_timing(self, key: str, started_at: float) -> None:
        elapsed = self._elapsed_ms(started_at)
        if elapsed:
            self._speed_totals[key] = round(self._speed_totals.get(key, 0.0) + elapsed, 1)

    def _record_tool_duration(self, name: str, started_at: float) -> None:
        elapsed = self._elapsed_ms(started_at)
        if not elapsed:
            return
        if name in SHELL_TOOLS:
            bucket = "shell_tools_ms"
        elif name in {"read_file", "list_dir", "read_lints"}:
            bucket = "read_tools_ms"
        elif name in {"glob", "glob_file_search", "grep", "codebase_search"}:
            bucket = "search_tools_ms"
        elif name in {"write", "edit", "search_replace", "delete_file", "create_directory", "edit_notebook"}:
            bucket = "edit_tools_ms"
        else:
            bucket = "other_tools_ms"
        self._speed_totals[bucket] = round(self._speed_totals.get(bucket, 0.0) + elapsed, 1)
        if elapsed > self._slowest_tool_ms:
            self._slowest_tool_ms = elapsed
            self._slowest_tool_name = name

    def _reset_turn_metrics(self) -> None:
        self._turn_started_at = self._loop_time()
        self._first_token_seen = False
        self._speed_timings = {}
        self._speed_totals = {}
        self._slowest_tool_name = None
        self._slowest_tool_ms = 0.0

    def _speed_meta(self) -> dict[str, Any]:
        meta: dict[str, Any] = {
            "model": self.model or config.default_model if CLI_IMPORT_ERROR is None else self.model,
            "provider": self.provider or config.default_provider if CLI_IMPORT_ERROR is None else self.provider,
            "intensity": self.intensity,
        }
        meta.update({key: value for key, value in self._speed_timings.items() if value})
        meta.update({key: value for key, value in self._speed_totals.items() if value})
        if self._slowest_tool_name and self._slowest_tool_ms:
            meta["slowest_tool"] = self._slowest_tool_name
            meta["slowest_tool_ms"] = self._slowest_tool_ms
        if self._turn_started_at:
            meta["total_turn_ms"] = self._elapsed_ms(self._turn_started_at)
        return {key: value for key, value in meta.items() if value is not None}

    async def prompt(self, blocks: list[dict[str, Any]]) -> dict[str, Any]:
        async with self._prompt_lock:
            return await self._run_prompt(blocks)

    async def _run_prompt(self, blocks: list[dict[str, Any]]) -> dict[str, Any]:
        self.cancel_event.clear()
        self._reset_turn_metrics()
        message = self._extract_prompt_text(blocks)
        if not message.strip():
            await self._agent_text("Give me a prompt and I will work from the current workspace.")
            return {"stopReason": "end_turn"}

        await self._start_heartbeat("reading the request")
        await self._emit_progress("Backboard is reading your request.", "reading the request")

        try:
            if CLI_IMPORT_ERROR is not None:
                await self._agent_text(
                    "Backboard IDE could not import the existing CLI engine.\n\n"
                    f"{CLI_IMPORT_ERROR}\n\n{CLI_IMPORT_TRACEBACK}"
                )
                return {"stopReason": "end_turn"}

            await self._emit_progress("Loading the Backboard agent runtime.", "loading runtime")
            started = self._loop_time()
            if not await self._ensure_runtime():
                await self._agent_text(
                    "Backboard needs an API key before the IDE agent can run. "
                    "Set it in the shared config with `backboard config set-api-key <key>`."
                )
                return {"stopReason": "end_turn"}
            self._record_timing("runtime_load_ms", started)
            await self._emit_progress("Preparing workspace context and tools.", "preparing workspace context")
            context_started = self._loop_time()
            augmented_message = await self._augment_prompt_with_context(message, blocks)
            self._record_timing("context_pack_ms", context_started)
            await self._ensure_thread_binding()
            await self._emit_progress("Sending the task to the selected model.", "waiting for model")
            stream = self.api_client.send_message_stream(
                self.thread_id,
                augmented_message,
                provider=self.provider,
                model=self.model,
                tools=self._tool_definitions(),
                thinking=self._thinking_payload(),
                is_thinking=lambda: self._thinking,
                web_search="off",
            )
            stop = await self._consume_stream(stream)
            return {"stopReason": stop}
        except asyncio.CancelledError:
            return {"stopReason": "cancelled"}
        except Exception as exc:
            print(traceback.format_exc(), file=sys.stderr)
            await self._agent_text(f"Backboard IDE agent error: {exc}")
            return {"stopReason": "end_turn"}
        finally:
            self._thinking = False
            self.current_run_id = None
            self._phase = "idle"
            if self._turn_started_at:
                self._speed_timings["total_turn_ms"] = self._elapsed_ms(self._turn_started_at)
            await self._stop_heartbeat()

    async def cancel(self) -> None:
        self.cancel_event.set()
        self._phase = "cancelling"
        if self.api_client and self.thread_id and self.current_run_id:
            with contextlib.suppress(Exception):
                await self.api_client.cancel_run(self.thread_id, self.current_run_id)
        if self.tool_system and hasattr(self.tool_system, "cancel_active_subprocesses"):
            with contextlib.suppress(Exception):
                self.tool_system.cancel_active_subprocesses()
        await self._stop_heartbeat()

    async def close(self) -> None:
        await self.cancel()
        if self.api_client and hasattr(self.api_client, "close"):
            with contextlib.suppress(Exception):
                await self.api_client.close()

    async def _start_heartbeat(self, phase: str) -> None:
        await self._stop_heartbeat()
        self._phase = phase
        self._last_progress_note = ""
        self._last_visible_event = asyncio.get_running_loop().time()
        self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())

    async def _stop_heartbeat(self) -> None:
        task = self._heartbeat_task
        self._heartbeat_task = None
        if task and not task.done():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

    async def _heartbeat_loop(self) -> None:
        while True:
            await asyncio.sleep(2.5)
            if self.cancel_event.is_set():
                return
            idle_for = asyncio.get_running_loop().time() - self._last_visible_event
            if idle_for >= 2.5:
                await self._emit_progress(f"Backboard is still {self._phase}.", self._phase)

    async def _emit_progress(self, text: str, phase: str | None = None) -> None:
        if phase:
            self._phase = phase
        if not text or text == self._last_progress_note:
            return
        self._last_progress_note = text
        await self._agent_thought(text)

    async def _prewarm_context(self) -> None:
        try:
            self._context_cache = await asyncio.wait_for(
                self._collect_workspace_context(include_semantic_query=None),
                timeout=CONTEXT_PREWARM_TIMEOUT_SECONDS,
            )
            self._context_cache_at = self._loop_time()
        except Exception:
            self._context_cache = {}

    async def _augment_prompt_with_context(self, message: str, blocks: list[dict[str, Any]]) -> str:
        self.start_prewarm()
        context = dict(self._context_cache)
        if self._prewarm_task and not self._prewarm_task.done():
            with contextlib.suppress(Exception):
                await asyncio.wait_for(asyncio.shield(self._prewarm_task), timeout=0.25)
                context = dict(self._context_cache)
        if not context:
            with contextlib.suppress(Exception):
                context = await asyncio.wait_for(
                    self._collect_workspace_context(include_semantic_query=None),
                    timeout=1.0,
                )

        if self.intensity in {"balanced", "deep"} and self.tool_system:
            semantic_started = self._loop_time()
            semantic = await self._semantic_context(message)
            self._record_timing("semantic_context_ms", semantic_started)
            if semantic:
                context["semantic_hits"] = semantic

        prompt_context = self._format_context_pack(context, blocks)
        if not prompt_context:
            return message
        return f"{message}\n\n<backboard_ide_context>\n{prompt_context}\n</backboard_ide_context>"

    async def _collect_workspace_context(self, include_semantic_query: str | None) -> dict[str, Any]:
        del include_semantic_query
        tree_task = asyncio.create_task(asyncio.to_thread(self._lightweight_file_tree))
        stack_task = asyncio.create_task(asyncio.to_thread(self._workspace_stack_summary))
        rules_task = asyncio.create_task(asyncio.to_thread(self._rules_summary))
        git_task = asyncio.create_task(self._git_summary())
        results = await asyncio.gather(tree_task, stack_task, rules_task, git_task, return_exceptions=True)
        context: dict[str, Any] = {}
        for key, value in zip(("files", "stack", "rules", "git"), results):
            if not isinstance(value, Exception) and value:
                context[key] = value
        return context

    def _lightweight_file_tree(self) -> list[str]:
        files: list[str] = []
        if not self.workspace.exists():
            return files
        for root, dirs, filenames in os.walk(self.workspace):
            dirs[:] = [name for name in dirs if name not in CONTEXT_IGNORE_DIRS and not name.startswith(".cache")]
            rel_root = Path(root).relative_to(self.workspace)
            for filename in sorted(filenames):
                if filename.startswith(".DS_Store"):
                    continue
                rel_path = rel_root / filename if str(rel_root) != "." else Path(filename)
                files.append(str(rel_path))
                if len(files) >= CONTEXT_PREWARM_MAX_FILES:
                    return files
        return files

    def _workspace_stack_summary(self) -> list[str]:
        summary: list[str] = []
        markers = {
            "package.json": "Node/JavaScript project",
            "vite.config.ts": "Vite app",
            "vite.config.js": "Vite app",
            "next.config.js": "Next.js app",
            "Cargo.toml": "Rust project",
            "pyproject.toml": "Python project",
            "requirements.txt": "Python requirements",
            "go.mod": "Go module",
        }
        for filename, label in markers.items():
            if (self.workspace / filename).exists():
                summary.append(label)
        package_json = self.workspace / "package.json"
        if package_json.exists():
            with contextlib.suppress(Exception):
                payload = json.loads(package_json.read_text(encoding="utf-8"))
                deps = {}
                for key in ("dependencies", "devDependencies"):
                    value = payload.get(key)
                    if isinstance(value, dict):
                        deps.update(value)
                frameworks = [name for name in ("react", "vue", "svelte", "next", "vite", "typescript", "tailwindcss") if name in deps]
                if frameworks:
                    summary.append("Frameworks: " + ", ".join(frameworks))
                scripts = payload.get("scripts")
                if isinstance(scripts, dict) and scripts:
                    summary.append("Scripts: " + ", ".join(sorted(scripts.keys())[:8]))
        return summary

    def _rules_summary(self) -> list[str]:
        snippets: list[str] = []
        for relative in ("CLAUDE.md", "AGENTS.md", ".cursorrules", ".backboard/rules.md"):
            path = self.workspace / relative
            if path.exists() and path.is_file():
                with contextlib.suppress(Exception):
                    text = path.read_text(encoding="utf-8").strip()
                    if text:
                        snippets.append(f"{relative}: {_truncate(text, 1200)}")
        return snippets

    async def _git_summary(self) -> dict[str, str]:
        summary: dict[str, str] = {}
        status = await self._run_readonly_command(["git", "status", "--short"], timeout=1.5)
        if status:
            summary["status"] = _truncate(status, 2000)
        diff = await self._run_readonly_command(["git", "diff", "--stat"], timeout=1.5)
        if diff:
            summary["diff_stat"] = _truncate(diff, 2000)
        branch = await self._run_readonly_command(["git", "branch", "--show-current"], timeout=1.0)
        if branch:
            summary["branch"] = branch.strip()
        return summary

    async def _run_readonly_command(self, args: list[str], timeout: float) -> str:
        try:
            proc = await asyncio.create_subprocess_exec(
                *args,
                cwd=str(self.workspace),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
            if proc.returncode == 0 and stdout:
                return stdout.decode(errors="replace").strip()
        except Exception:
            return ""
        return ""

    async def _semantic_context(self, message: str) -> str:
        if not self.tool_system or not message.strip():
            return ""
        with contextlib.suppress(Exception):
            if hasattr(self.tool_system, "_semantic_search_ready") and not self.tool_system._semantic_search_ready():
                return ""
        args = {"query": message.strip(), "limit": 5}
        loop = asyncio.get_running_loop()
        try:
            result = await asyncio.wait_for(
                loop.run_in_executor(None, lambda: self.tool_system.execute_tool("codebase_search", args)),
                timeout=2.5,
            )
        except Exception:
            return ""
        return _truncate(_result_text(result), 2500)

    def _format_context_pack(self, context: dict[str, Any], blocks: list[dict[str, Any]]) -> str:
        lines: list[str] = []
        lines.append("Use this IDE context to reduce repeated exploration. Prefer explicit tools if this summary is stale.")
        if self.intensity == "fast":
            lines.append("Intensity: Fast; keep context use focused and avoid extra deep exploration unless required.")
        elif self.intensity == "deep":
            lines.append("Intensity: Deep; use the broader context and verify architecture-level assumptions.")
        if context.get("stack"):
            lines.append("Workspace stack: " + "; ".join(context["stack"][:8]))
        git = context.get("git")
        if isinstance(git, dict):
            if git.get("branch"):
                lines.append(f"Git branch: {git['branch']}")
            if git.get("status"):
                lines.append("Git status:\n" + git["status"])
            if git.get("diff_stat"):
                lines.append("Git diff stat:\n" + git["diff_stat"])
        files = context.get("files")
        if isinstance(files, list) and files:
            limit = 35 if self.intensity == "fast" else 80
            lines.append("Workspace files:\n" + "\n".join(str(path) for path in files[:limit]))
        rules = context.get("rules")
        if isinstance(rules, list) and rules:
            lines.append("Project rules:\n" + "\n\n".join(rules[:3]))
        if context.get("semantic_hits"):
            lines.append("Semantic hits:\n" + str(context["semantic_hits"]))
        resources = self._embedded_context_summary(blocks)
        if resources:
            lines.append("Embedded editor context:\n" + resources)
        return _truncate("\n\n".join(lines), CONTEXT_PACK_MAX_CHARS)

    def _embedded_context_summary(self, blocks: list[dict[str, Any]]) -> str:
        resources: list[str] = []
        for block in blocks:
            block_type = block.get("type")
            if block_type == "resource_link":
                resources.append(str(block.get("uri") or block.get("name") or "resource"))
            elif block_type == "resource":
                resource = block.get("resource") or {}
                if isinstance(resource, dict):
                    uri = resource.get("uri") or resource.get("name")
                    text = resource.get("text") or resource.get("contents") or resource.get("content")
                    if uri or text:
                        resources.append(_truncate(f"{uri or 'resource'}\n{text or ''}", 1200))
        return "\n\n".join(resources[:5])

    async def _ensure_runtime(self) -> bool:
        async with self._ready_lock:
            if self.api_client and self.tool_system:
                return True

            config.sync_from_disk_if_changed()
            config.set_workspace(str(self.workspace))
            if not config.api_key:
                return False

            self.provider = self.provider or config.default_provider
            self.model = self.model or config.default_model
            self.api_client = BackboardAPIClient()
            self.tool_system = AdvancedToolManager(str(self.workspace), api_key=config.api_key)

            self.mcp_manager = MCPManager(config.mcp_servers_enabled)
            self.tool_system.set_mcp_manager(self.mcp_manager)
            with contextlib.suppress(Exception):
                await self.mcp_manager.start_all(quiet=True)

            rlm_engine = RLMEngine(self.api_client, self.tool_system, str(self.workspace), api_key=config.api_key)
            subagents = SubagentManager(self.api_client, self.tool_system, str(self.workspace))
            subagents.set_rlm_engine(rlm_engine)
            self.tool_system.set_rlm_engine(rlm_engine)
            self.tool_system.set_subagent_manager(subagents)

            return True

    def _fallback_model_state(self) -> dict[str, Any]:
        if CLI_IMPORT_ERROR is None:
            config.sync_from_disk_if_changed()
            provider = self.provider or config.default_provider
            model = self.model or config.default_model
        else:
            default_provider, default_model = _shared_config_defaults()
            provider = self.provider or default_provider
            model = self.model or default_model
        model_id = f"{provider}/{model}"
        return {
            "currentModelId": model_id,
            "availableModels": [
                {
                    "modelId": model_id,
                    "name": model,
                    "description": provider,
                }
            ],
        }

    async def _ensure_thread_binding(self) -> None:
        if self.assistant_id and self.thread_id:
            return

        started = self._loop_time()
        system_prompt = self._system_prompt()
        assistant = await self.api_client.create_assistant(
            name="Backboard IDE Agent",
            description=system_prompt,
            tools=self._tool_definitions(),
        )
        self._record_timing("assistant_create_ms", started)
        self.assistant_id = assistant["assistant_id"]
        thread = await self.api_client.create_thread(self.assistant_id)
        self.thread_id = thread["thread_id"]
        self._persist_session_mapping()

    def _system_prompt(self) -> str:
        if self._system_prompt_cache:
            return self._system_prompt_cache
        if self._tool_names_cache is None:
            self._tool_names_cache = [
                tool["function"]["name"]
                for tool in self._tool_definitions()
                if isinstance(tool.get("function"), dict) and tool["function"].get("name")
            ]
        if self._skill_section_cache is None:
            self._skill_section_cache = ""
            with contextlib.suppress(Exception):
                self._skill_section_cache = SkillManager(str(self.workspace)).build_prompt_section()
        system_prompt = build_system_prompt(str(self.workspace), self._tool_names_cache, self._skill_section_cache)
        system_prompt += (
            "\n\nYou are running inside Backboard IDE through Zed's native ACP panel. "
            "When editing files, use write/edit/delete tools so the IDE can show reviewable diffs. "
            "Do not claim a file changed until the IDE edit approval path has applied it."
            "\n\nBackboard IDE speed UX: emit concise progress early, prefer cached/indexed context before "
            "manual exploration, and batch independent read/search work. Use todo_write for multi-step tasks, "
            "keep exactly one item in_progress, and mark items completed immediately after finishing them. "
            "Before long commands, file writes, or checks, state the concrete thing being worked on."
            "\n\nBackboard IDE website defaults: when the user asks to create a website or app in an empty "
            "workspace, build a real Vite React TypeScript project unless they explicitly request static HTML "
            "or a single file. The baseline should include package.json, index.html, src/main.tsx, src/App.tsx, "
            "and src/styles.css, plus any domain-specific components/assets needed by the prompt. If an existing "
            "app stack is present, follow that stack instead. Do not collapse website/app requests into one HTML "
            "file unless the user asks for a single-file/static artifact. Verify with install/build/dev-server "
            "checks when practical."
        )
        self._system_prompt_cache = system_prompt
        return system_prompt

    def _persist_session_mapping(self) -> None:
        path = _session_store_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        data = _load_session_store()
        data[self.session_id] = {
            "workspace": str(self.workspace),
            "assistant_id": self.assistant_id,
            "thread_id": self.thread_id,
            "provider": self.provider,
            "model": self.model,
            "title": self.workspace.name,
        }
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        tmp.replace(path)

    def _restore_session_mapping(self) -> bool:
        record = _load_session_store().get(self.session_id)
        if not isinstance(record, dict):
            return False
        workspace = record.get("workspace")
        if isinstance(workspace, str) and workspace:
            self.workspace = Path(workspace).expanduser().resolve()
        provider = record.get("provider")
        model = record.get("model")
        assistant_id = record.get("assistant_id")
        thread_id = record.get("thread_id")
        self.provider = provider if isinstance(provider, str) and provider else self.provider
        self.model = model if isinstance(model, str) and model else self.model
        self.assistant_id = assistant_id if isinstance(assistant_id, str) and assistant_id else None
        self.thread_id = thread_id if isinstance(thread_id, str) and thread_id else None
        return bool(self.thread_id)

    async def _replay_history(self) -> None:
        if self._history_replayed or not self.thread_id or not self.api_client:
            return
        try:
            thread_data = await self.api_client.get_thread(self.thread_id)
        except Exception:
            return
        messages = thread_data.get("messages", []) or []
        for message in messages:
            if not isinstance(message, dict):
                continue
            role = message.get("role")
            content = message.get("content")
            text = content if isinstance(content, str) else ""
            if role == "user" and text:
                await self._update({"sessionUpdate": "user_message_chunk", "content": _text_block(text)})
            elif role == "assistant":
                if text:
                    await self._update({"sessionUpdate": "agent_message_chunk", "content": _text_block(text)})
                meta = message.get("metadata_") or message.get("metadata") or {}
                tool_calls = meta.get("tool_calls") if isinstance(meta, dict) else None
                if isinstance(tool_calls, list):
                    for idx, tool_call in enumerate(tool_calls, start=1):
                        if not isinstance(tool_call, dict):
                            continue
                        title = str(tool_call.get("function", {}).get("name") or tool_call.get("name") or f"tool {idx}")
                        await self._tool_call(
                            f"history-{self.session_id}-{idx}-{uuid.uuid4().hex[:8]}",
                            title,
                            _tool_kind(title),
                            "completed",
                            [_content_item("Tool call from restored session.")],
                            tool_call if isinstance(tool_call, dict) else {},
                        )
        self._history_replayed = True

    def _tool_definitions(self) -> list[dict[str, Any]]:
        cache_key = self.mode
        now = self._loop_time()
        cached = self._tool_definitions_cache.get(cache_key)
        if cached and now - cached[0] < TOOL_DEFINITION_CACHE_TTL_SECONDS:
            return cached[1]

        tools = self.tool_system.get_tool_definitions()
        if self.mode == "ask":
            blocked = ASK_BLOCKED_TOOLS
        elif self.mode == "manual":
            blocked = MANUAL_BLOCKED_TOOLS
        else:
            blocked = set()
        if not blocked:
            self._tool_definitions_cache[cache_key] = (now, tools)
            return tools
        filtered = []
        for tool in tools:
            name = ((tool.get("function") or {}).get("name") or "").strip()
            if name not in blocked:
                filtered.append(tool)
        self._tool_definitions_cache[cache_key] = (now, filtered)
        return filtered

    def _thinking_payload(self) -> dict[str, Any] | None:
        if self.intensity == "fast":
            return None
        with contextlib.suppress(Exception):
            payload = config.thinking_for_provider(self.provider or config.default_provider, self.model or config.default_model)
            if self.intensity == "balanced":
                return self._cap_thinking_payload(payload, 2048)
            return payload
        return None

    def _cap_thinking_payload(self, payload: Any, budget_tokens: int) -> Any:
        if not isinstance(payload, dict):
            return payload
        capped = dict(payload)
        for key in ("budget_tokens", "budgetTokens", "max_tokens", "maxTokens"):
            value = capped.get(key)
            if isinstance(value, (int, float)):
                capped[key] = min(int(value), budget_tokens)
        return capped

    async def _consume_stream(self, stream: Any) -> str:
        async for chunk in stream:
            if self.cancel_event.is_set():
                return "cancelled"

            chunk_type = chunk.get("type")
            if chunk_type == "run_started":
                self.current_run_id = chunk.get("run_id") or chunk.get("id") or self.current_run_id
                await self._emit_progress("Backboard connected to the model.", "waiting for model")
            elif chunk_type == "reasoning_started":
                self._thinking = True
                await self._emit_progress("Backboard is planning the next step.", "thinking through the implementation")
            elif chunk_type in {"reasoning_streaming", "reasoning_delta"}:
                self._phase = "thinking through the implementation"
            elif chunk_type == "reasoning_ended":
                self._thinking = False
                self._phase = "preparing the next action"
            elif chunk_type == "content_streaming":
                self._phase = "streaming the response"
                if not self._first_token_seen:
                    self._first_token_seen = True
                    self._record_timing("first_token_ms", self._turn_started_at)
                await self._agent_text(str(chunk.get("content") or chunk.get("text") or chunk.get("delta") or ""))
            elif chunk_type == "tool_submit_required":
                await self._emit_progress("Backboard is preparing tool actions.", "preparing tool actions")
                await self._handle_tool_submit(chunk)
            elif chunk_type == "run_ended":
                self._thinking = False
                if chunk.get("status") == "requires_action" and chunk.get("tool_calls"):
                    await self._emit_progress("Backboard is preparing tool actions.", "preparing tool actions")
                    await self._handle_tool_submit(chunk)
                else:
                    await self._usage(chunk)
                    return "end_turn"
            elif chunk_type in {"run_failed", "error"}:
                self._thinking = False
                await self._agent_text(str(chunk.get("error") or chunk.get("message") or "Backboard run failed."))
                return "end_turn"
        return "end_turn"

    async def _handle_tool_submit(self, chunk: dict[str, Any]) -> None:
        run_id = chunk.get("run_id") or self.current_run_id
        tool_calls = chunk.get("tool_calls") or []
        if not run_id or not tool_calls:
            return
        await self._emit_progress(
            f"Backboard is running {len(tool_calls)} tool action{'s' if len(tool_calls) != 1 else ''}.",
            "running tools",
        )
        batch_started = self._loop_time()
        outputs = await self._execute_tool_batch(tool_calls)
        self._add_timing("tool_batch_ms", batch_started)
        if self.cancel_event.is_set():
            return
        stream = self.api_client.submit_tool_outputs(
            self.thread_id,
            run_id,
            outputs,
            stream=True,
            tools=self._tool_definitions(),
            is_thinking=lambda: self._thinking,
        )
        await self._consume_stream(stream)

    async def _execute_tool_batch(self, tool_calls: list[dict[str, Any]]) -> list[dict[str, str]]:
        if not tool_calls:
            return []

        outputs: list[dict[str, str]] = []
        index = 0
        while index < len(tool_calls):
            if self._is_parallel_read_only_tool_call(tool_calls[index]):
                read_group = []
                while index < len(tool_calls) and self._is_parallel_read_only_tool_call(tool_calls[index]):
                    read_group.append(tool_calls[index])
                    index += 1
                if len(read_group) > 1:
                    await self._emit_progress(
                        f"Running {len(read_group)} read/search actions in parallel.",
                        "running parallel read/search tools",
                    )
                    outputs.extend(await self._execute_read_only_batch_parallel(read_group))
                else:
                    output = await self._execute_timed_tool_call(read_group[0])
                    outputs.append(self._tool_output_payload(read_group[0], output))
            else:
                tool_call = tool_calls[index]
                output = await self._execute_timed_tool_call(tool_call)
                outputs.append(self._tool_output_payload(tool_call, output))
                index += 1
            if self.cancel_event.is_set():
                break
        return outputs

    def _is_parallel_read_only_tool_call(self, tool_call: dict[str, Any]) -> bool:
        name, _args = _function_payload(tool_call)
        return name in READ_ONLY_IDE_TOOLS and not (self.tool_system and self.tool_system.is_mcp_tool(name))

    async def _execute_read_only_batch_parallel(self, tool_calls: list[dict[str, Any]]) -> list[dict[str, str]]:
        deduped: dict[tuple[str, str], asyncio.Task] = {}
        output_by_key: dict[tuple[str, str], dict[str, Any]] = {}

        def key_for(tool_call: dict[str, Any]) -> tuple[str, str]:
            name, args = _function_payload(tool_call)
            try:
                encoded = json.dumps(args, sort_keys=True, ensure_ascii=False, default=str)
            except Exception:
                encoded = str(args)
            return name, encoded

        async def run_one(key: tuple[str, str], tool_call: dict[str, Any]) -> None:
            output_by_key[key] = await self._execute_timed_tool_call(tool_call)

        for tool_call in tool_calls:
            key = key_for(tool_call)
            if key not in deduped:
                deduped[key] = asyncio.create_task(run_one(key, tool_call))

        await asyncio.gather(*deduped.values(), return_exceptions=False)
        return [self._tool_output_payload(tool_call, output_by_key[key_for(tool_call)]) for tool_call in tool_calls]

    async def _execute_timed_tool_call(self, tool_call: dict[str, Any]) -> dict[str, Any]:
        name, _args = _function_payload(tool_call)
        started = self._loop_time()
        try:
            return await self._execute_tool_call(tool_call)
        finally:
            self._record_tool_duration(name, started)

    def _tool_output_payload(self, tool_call: dict[str, Any], output: dict[str, Any]) -> dict[str, str]:
        return {
            "tool_call_id": _tool_call_id(tool_call),
            "output": json.dumps(self._compress_tool_output(tool_call, output), ensure_ascii=False),
        }

    def _compress_tool_output(self, tool_call: dict[str, Any], output: Any) -> Any:
        name, _args = _function_payload(tool_call)
        if name not in READ_ONLY_IDE_TOOLS:
            return output
        if not isinstance(output, dict):
            return _truncate(str(output), 8000)
        compressed = dict(output)
        for key in ("content", "output", "stdout", "stderr", "message", "results"):
            value = compressed.get(key)
            if isinstance(value, str):
                compressed[key] = _truncate(value, 8000)
            elif isinstance(value, list) and len(value) > 50:
                compressed[key] = value[:50] + [{"truncated": len(value) - 50}]
        if name in {"grep", "glob", "glob_file_search", "codebase_search"}:
            compressed["_backboard_note"] = "Search output compressed for model context; use read_file for exact full content."
        return compressed

    async def _execute_tool_call(self, tool_call: dict[str, Any]) -> dict[str, Any]:
        tool_id = _tool_call_id(tool_call)
        name, args = _function_payload(tool_call)
        kind = _tool_kind(name)
        title = self._tool_title(name, args)
        await self._emit_progress(self._tool_progress(name, args), self._tool_phase(name, args))

        if self.mode == "ask" and name in ASK_BLOCKED_TOOLS:
            result = {"success": False, "error": f"{name} is disabled in Ask mode."}
            await self._tool_call(tool_id, title, kind, "failed", [_content_item(result["error"])], args)
            return result
        if self.mode == "manual" and name in MANUAL_BLOCKED_TOOLS:
            result = {"success": False, "error": f"{name} is disabled in Manual mode."}
            await self._tool_call(tool_id, title, kind, "failed", [_content_item(result["error"])], args)
            return result

        if name in {"write", "edit", "search_replace", "delete_file"}:
            return await self._propose_file_change(tool_id, name, args)
        if name == "create_directory":
            return await self._propose_directory(tool_id, args)
        if name in MUTATING_TOOLS:
            message = f"{name} needs a dedicated Backboard IDE diff adapter before it can run safely."
            await self._tool_call(tool_id, self._tool_title(name, args), _tool_kind(name), "failed", [_content_item(message)], args)
            return {"success": False, "error": message}
        if name in SHELL_TOOLS:
            return await self._run_shell_tool(tool_id, name, args)

        await self._tool_call(tool_id, title, kind, "in_progress", [_content_item(_result_text(args))], args)
        try:
            if name == "todo_write":
                await self._emit_plan_from_todos(args)
            result = await self._call_tool(name, args)
            if name == "todo_write":
                await self._emit_plan_from_todos(result)
            await self._tool_update(tool_id, "completed", [_content_item(_result_text(result))])
            return result
        except Exception as exc:
            result = {"success": False, "error": str(exc)}
            await self._tool_update(tool_id, "failed", [_content_item(str(exc))])
            return result

    async def _call_tool(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        if self.tool_system.is_mcp_tool(name):
            return await self.tool_system.execute_mcp_tool(name, args)
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, lambda: self.tool_system.execute_tool(name, args))

    async def _propose_file_change(self, tool_id: str, name: str, args: dict[str, Any]) -> dict[str, Any]:
        await self._emit_progress(self._tool_progress(name, args), "preparing file diff")
        try:
            path, old_text, new_text = self._compute_file_change(name, args)
        except Exception as exc:
            await self._tool_call(tool_id, self._tool_title(name, args), _tool_kind(name), "failed", [_content_item(str(exc))], args)
            return {"success": False, "error": str(exc)}

        diff = _diff_item(path, old_text, new_text)
        title = self._tool_title(name, args)
        await self._emit_progress(
            f"Applying a reviewable diff for `{self._display_path(path)}`.",
            "applying file change",
        )
        locations = _tool_locations(path)
        await self._tool_call(
            tool_id,
            title,
            _tool_kind(name),
            "in_progress",
            [diff],
            args,
            locations=locations,
        )

        try:
            await self._emit_progress(f"Applying `{self._display_path(path)}`.", "applying file change")
            if name == "delete_file":
                if path.exists():
                    path.unlink()
            else:
                await self._write_file_via_ide(path, new_text)
            await self._tool_update(tool_id, "completed", [diff], locations=locations)
            return {"success": True, "path": str(path), "applied": True}
        except Exception as exc:
            await self._tool_update(tool_id, "failed", [_content_item(str(exc))])
            return {"success": False, "error": str(exc)}

    async def _propose_directory(self, tool_id: str, args: dict[str, Any]) -> dict[str, Any]:
        path = self._resolve_path(_path_arg(args) or args.get("path") or "")
        title = f"Creating directory `{self._display_path(path)}`"
        await self._emit_progress(f"Creating directory `{self._display_path(path)}`.", "creating directory")
        await self._tool_call(tool_id, title, "edit", "in_progress", [_content_item(str(path))], args)
        path.mkdir(parents=True, exist_ok=True)
        await self._tool_update(tool_id, "completed", [_content_item(str(path))])
        return {"success": True, "path": str(path)}

    async def _run_shell_tool(self, tool_id: str, name: str, args: dict[str, Any]) -> dict[str, Any]:
        command = _extract_shell_command(name, args)
        title = self._tool_title(name, args)
        terminal_id = f"backboard-terminal-{uuid.uuid4().hex}"
        meta = {"terminal_info": {"terminal_id": terminal_id, "cwd": str(self.workspace)}}
        read_only_auto_approved = name in {"bash", "run_terminal_cmd"} and _is_read_only_shell_command(command)
        free_mode_auto_approved = self.mode == "free"
        command_auto_approved = read_only_auto_approved or free_mode_auto_approved
        timeout_ms = _command_timeout_ms(command, args, read_only_auto_approved)
        command_card = f"{command}\n\nBackboard timeout: {timeout_ms / 1000:.0f}s"
        if free_mode_auto_approved:
            await self._emit_progress(f"Running without approval (Free mode): {title}.", "running command")
        elif read_only_auto_approved:
            await self._emit_progress(f"Running read-only command: {title}.", "running command")
        else:
            await self._emit_progress(f"Waiting for approval: {title}.", "waiting for command approval")
        await self._tool_call(
            tool_id,
            title,
            "execute",
            "in_progress" if command_auto_approved else "pending",
            [{"type": "terminal", "terminalId": terminal_id}, _content_item(command_card)],
            args,
            meta=meta,
        )
        if not command_auto_approved:
            wait_started = self._loop_time()
            allowed = await self._request_tool_permission(tool_id, title, "execute", [_content_item(command)], args)
            self._add_timing("command_wait_ms", wait_started)
            if not allowed:
                await self._tool_update(tool_id, "failed", [_content_item("Command rejected in Backboard IDE.")])
                return {"success": False, "error": "Command rejected in Backboard IDE."}

        if name in {"bash", "run_terminal_cmd"}:
            try:
                return await self._run_shell_subprocess(
                    tool_id,
                    terminal_id,
                    command,
                    args,
                    read_only_auto_approved,
                )
            except Exception as exc:
                await self._tool_update(
                    tool_id,
                    "failed",
                    [_content_item(str(exc))],
                    meta={
                        "terminal_output": {"terminal_id": terminal_id, "data": str(exc)},
                        "terminal_exit": {"terminal_id": terminal_id, "exit_code": 1},
                    },
                )
                return {"success": False, "error": str(exc)}

        try:
            await self._emit_progress(f"{title}.", "running command")
            result = await self._call_tool(name, args)
            output = self._shell_output(result)
            exit_code = self._shell_exit_code(result)
            await self._tool_update(
                tool_id,
                "completed" if exit_code == 0 else "failed",
                [_content_item(_result_text(result))],
                meta={
                    "terminal_output": {"terminal_id": terminal_id, "data": output},
                    "terminal_exit": {"terminal_id": terminal_id, "exit_code": exit_code},
                },
            )
            return result
        except Exception as exc:
            await self._tool_update(
                tool_id,
                "failed",
                [_content_item(str(exc))],
                meta={
                    "terminal_output": {"terminal_id": terminal_id, "data": str(exc)},
                    "terminal_exit": {"terminal_id": terminal_id, "exit_code": 1},
                },
            )
            return {"success": False, "error": str(exc)}

    async def _run_shell_subprocess(
        self,
        tool_id: str,
        terminal_id: str,
        command: str,
        args: dict[str, Any],
        read_only_auto_approved: bool,
    ) -> dict[str, Any]:
        sandbox_err = None
        if self.tool_system and hasattr(self.tool_system, "_sandbox_check"):
            with contextlib.suppress(Exception):
                sandbox_err = self.tool_system._sandbox_check(command)
        if sandbox_err:
            await self._tool_update(tool_id, "failed", [_content_item(sandbox_err)])
            return {"success": False, "error": sandbox_err}

        cwd = self.workspace
        working_directory = args.get("working_directory") or args.get("cwd")
        if isinstance(working_directory, str) and working_directory.strip():
            cwd = self._resolve_path(working_directory)

        timeout_ms = _command_timeout_ms(command, args, read_only_auto_approved)
        timeout_s = max(float(timeout_ms) / 1000, 0.1)
        is_dev_server = _is_dev_server_command(command)

        env = os.environ.copy()
        backboard_bin = Path.home() / ".backboard" / "bin"
        env["PATH"] = f"{backboard_bin}{os.pathsep}{env.get('PATH', '')}"
        popen_kwargs: dict[str, Any] = {
            "cwd": str(cwd),
            "env": env,
            "stdout": asyncio.subprocess.PIPE,
            "stderr": asyncio.subprocess.PIPE,
        }
        if os.name != "nt":
            popen_kwargs["start_new_session"] = True

        await self._emit_progress(f"Running `{command.splitlines()[0][:80]}`.", "running command")
        await self._tool_update(
            tool_id,
            "in_progress",
            [_content_item(command)],
            meta={"terminal_output": {"terminal_id": terminal_id, "data": f"$ {command}\n"}},
        )

        loop = asyncio.get_running_loop()
        stdout_parts: list[str] = []
        stderr_parts: list[str] = []
        pending_terminal: list[str] = []
        pending_lock = asyncio.Lock()
        last_terminal_update = loop.time()
        proc = await asyncio.create_subprocess_shell(command, **popen_kwargs)
        started = loop.time()

        async def flush_terminal(force: bool = False) -> None:
            nonlocal last_terminal_update
            async with pending_lock:
                now = loop.time()
                if not force and now - last_terminal_update < TERMINAL_UPDATE_INTERVAL_SECONDS:
                    return
                if not pending_terminal and not force:
                    return
                data = "".join(pending_terminal)
                pending_terminal.clear()
                last_terminal_update = now
            content = _truncate("".join(stdout_parts + stderr_parts), TERMINAL_UPDATE_MAX_CHARS)
            meta = {"terminal_output": {"terminal_id": terminal_id, "data": data}} if data else None
            await self._tool_update(tool_id, "in_progress", [_content_item(content)], meta=meta)

        async def pump(reader: asyncio.StreamReader | None, parts: list[str]) -> None:
            if reader is None:
                return
            while True:
                chunk = await reader.readline()
                if not chunk:
                    return
                text = chunk.decode(errors="replace")
                parts.append(text)
                async with pending_lock:
                    pending_terminal.append(text)
                await flush_terminal()

        pumps = [
            asyncio.create_task(pump(proc.stdout, stdout_parts)),
            asyncio.create_task(pump(proc.stderr, stderr_parts)),
        ]

        timed_out = False
        try:
            while proc.returncode is None:
                if self.cancel_event.is_set():
                    await self._terminate_process(proc)
                    await asyncio.gather(*pumps, return_exceptions=True)
                    await self._tool_update(
                        tool_id,
                        "failed",
                        [_content_item("Command cancelled.")],
                        meta={"terminal_exit": {"terminal_id": terminal_id, "exit_code": 130}},
                    )
                    return {"success": False, "error": "Command cancelled.", "exit_code": 130}
                if loop.time() - started > timeout_s:
                    timed_out = True
                    await self._terminate_process(proc)
                    break
                await asyncio.sleep(0.05)
        finally:
            await asyncio.gather(*pumps, return_exceptions=True)
            await flush_terminal(force=True)

        exit_code = proc.returncode if proc.returncode is not None else 124
        stdout = "".join(stdout_parts)
        stderr = "".join(stderr_parts)
        output = stdout + stderr
        result = {
            "success": exit_code == 0 and not timed_out,
            "stdout": stdout,
            "stderr": stderr,
            "exit_code": exit_code,
            "output": output,
            "cwd": str(cwd),
        }
        if timed_out:
            if is_dev_server:
                result["success"] = True
                result["note"] = (
                    "Backboard stopped this long-running dev-server command after the startup window. "
                    "Use the captured output to verify whether it started cleanly."
                )
            else:
                result["error"] = f"Command timed out after {timeout_s:.0f}s."

        await self._tool_update(
            tool_id,
            "completed" if result["success"] else "failed",
            [_content_item(_result_text(result))],
            meta={"terminal_exit": {"terminal_id": terminal_id, "exit_code": exit_code}},
        )
        return result

    async def _terminate_process(self, proc: asyncio.subprocess.Process) -> None:
        if proc.returncode is not None:
            return
        try:
            if os.name != "nt":
                os.killpg(proc.pid, signal.SIGTERM)
            else:
                proc.terminate()
            await asyncio.wait_for(proc.wait(), timeout=2)
        except Exception:
            with contextlib.suppress(Exception):
                if os.name != "nt":
                    os.killpg(proc.pid, signal.SIGKILL)
                else:
                    proc.kill()
            with contextlib.suppress(Exception):
                await proc.wait()

    def _compute_file_change(self, name: str, args: dict[str, Any]) -> tuple[Path, str | None, str]:
        raw_path = _path_arg(args)
        if not raw_path:
            raise ValueError(f"{name} requires a file path.")
        path = self._resolve_path(raw_path)
        old_text = path.read_text(encoding="utf-8") if path.exists() else None

        if name == "write":
            content = _content_arg(args)
            if content is None:
                raise ValueError("write requires content.")
            return path, old_text, content

        if name == "delete_file":
            if old_text is None:
                raise ValueError(f"{path} does not exist.")
            return path, old_text, ""

        if old_text is None:
            raise ValueError(f"{path} does not exist.")
        old_string = args.get("old_string") or args.get("old_str") or args.get("search") or args.get("find")
        new_string = args.get("new_string") or args.get("new_str") or args.get("replace") or args.get("replacement")
        if not isinstance(old_string, str) or new_string is None:
            raise ValueError("edit requires old_string and new_string.")
        new_string = str(new_string)
        replace_all = bool(args.get("replace_all") or args.get("all"))
        occurrences = old_text.count(old_string)
        if occurrences == 0:
            raise ValueError("old_string was not found.")
        if occurrences > 1 and not replace_all:
            raise ValueError("old_string appears multiple times. Set replace_all to true or provide more context.")
        new_text = old_text.replace(old_string, new_string, -1 if replace_all else 1)
        return path, old_text, new_text

    def _resolve_path(self, raw_path: str) -> Path:
        if not raw_path:
            raise ValueError("Missing path.")
        path = Path(raw_path).expanduser()
        if not path.is_absolute():
            path = self.workspace / path
        resolved = path.resolve(strict=False)
        try:
            resolved.relative_to(self.workspace)
        except ValueError as exc:
            raise ValueError(f"Path is outside the workspace: {resolved}") from exc
        return resolved

    async def _write_file_via_ide(self, path: Path, content: str) -> None:
        started = self._loop_time()
        try:
            await self.server.request(
                "fs/write_text_file",
                {"sessionId": self.session_id, "path": str(path), "content": content},
            )
        except Exception:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")
        finally:
            self._add_timing("file_write_ms", started)

    async def _request_tool_permission(
        self,
        tool_id: str,
        title: str,
        kind: str,
        content: list[dict[str, Any]],
        raw_input: dict[str, Any],
    ) -> bool:
        response = await self.server.request(
            "session/request_permission",
            {
                "sessionId": self.session_id,
                "toolCall": {
                    "toolCallId": tool_id,
                    "title": title,
                    "kind": kind,
                    "status": "pending",
                    "content": content,
                    "rawInput": raw_input,
                },
                "options": [
                    {"optionId": "allow_once", "name": "Allow", "kind": "allow_once"},
                    {"optionId": "reject_once", "name": "Reject", "kind": "reject_once"},
                ],
            },
        )
        return (_selected_permission_option(response) or "").startswith("allow")

    async def _emit_plan_from_todos(self, source: dict[str, Any]) -> None:
        todos = source.get("todos") if isinstance(source, dict) else None
        if not isinstance(todos, list):
            return

        entries = []
        for todo in todos:
            if not isinstance(todo, dict):
                continue
            content = str(todo.get("content") or todo.get("title") or todo.get("name") or "").strip()
            if not content:
                continue
            status = str(todo.get("status") or "pending").strip()
            if status == "cancelled":
                continue
            if status not in {"pending", "in_progress", "completed"}:
                status = "pending"
            entries.append(
                {
                    "content": content,
                    "priority": "medium",
                    "status": status,
                }
            )

        if entries:
            await self._update({"sessionUpdate": "plan", "entries": entries})

    def _display_path(self, path: Path | str) -> str:
        candidate = Path(path).expanduser()
        try:
            resolved = candidate.resolve(strict=False)
            return str(resolved.relative_to(self.workspace))
        except Exception:
            return str(path)

    def _display_raw_path(self, raw_path: str) -> str:
        path = Path(raw_path).expanduser()
        if not path.is_absolute():
            return raw_path
        return self._display_path(path)

    def _tool_progress(self, name: str, args: dict[str, Any]) -> str:
        path = _path_arg(args)
        if path:
            display_path = self._display_raw_path(path)
            action = {
                "write": "Writing",
                "edit": "Editing",
                "search_replace": "Editing",
                "delete_file": "Deleting",
                "read_file": "Reading",
                "list_dir": "Listing",
                "create_directory": "Preparing directory",
                "edit_notebook": "Editing notebook",
            }.get(name, "Working on")
            line_count = ""
            content = _content_arg(args)
            if isinstance(content, str) and name == "write":
                line_count = f" ({len(content.splitlines())} lines)"
            return f"{action} `{display_path}`{line_count}."
        if name in {"grep", "glob", "glob_file_search", "codebase_search"}:
            return "Searching the workspace."
        if name == "todo_write":
            return "Updating the visible task plan."
        if name == "task":
            description = str(args.get("description") or "focused subtask").strip()
            return f"Running subtask: {description}."
        if name in SHELL_TOOLS:
            command = _extract_shell_command(name, args).splitlines()[0][:80]
            return f"Preparing to run `{command}`."
        return f"Running `{name}`."

    def _tool_phase(self, name: str, args: dict[str, Any]) -> str:
        if name in {"write", "edit", "search_replace", "delete_file", "edit_notebook"}:
            return "preparing file changes"
        if name in SHELL_TOOLS:
            return "preparing command"
        if name == "task":
            return "running subtask"
        if name in {"grep", "glob", "glob_file_search", "codebase_search"}:
            return "searching workspace"
        if name == "todo_write":
            return "updating plan"
        return f"running {name}"

    async def _agent_text(self, text: str) -> None:
        if not text:
            return
        await self._update({"sessionUpdate": "agent_message_chunk", "content": _text_block(text)})

    async def _agent_thought(self, text: str) -> None:
        if not text:
            return
        await self._update({"sessionUpdate": "agent_thought_chunk", "content": _text_block(text)})

    async def _tool_call(
        self,
        tool_id: str,
        title: str,
        kind: str,
        status: str,
        content: list[dict[str, Any]],
        raw_input: dict[str, Any],
        meta: dict[str, Any] | None = None,
        locations: list[dict[str, Any]] | None = None,
    ) -> None:
        update: dict[str, Any] = {
            "sessionUpdate": "tool_call",
            "toolCallId": tool_id,
            "title": title,
            "kind": kind,
            "status": status,
            "content": content,
            "rawInput": raw_input,
        }
        if locations:
            update["locations"] = locations
        if meta:
            update["_meta"] = meta
        await self._update(update)

    async def _tool_update(
        self,
        tool_id: str,
        status: str,
        content: list[dict[str, Any]],
        meta: dict[str, Any] | None = None,
        locations: list[dict[str, Any]] | None = None,
    ) -> None:
        update: dict[str, Any] = {
            "sessionUpdate": "tool_call_update",
            "toolCallId": tool_id,
            "status": status,
            "content": content,
        }
        if locations:
            update["locations"] = locations
        if meta:
            update["_meta"] = meta
        await self._update(update)

    async def _usage(self, chunk: dict[str, Any]) -> None:
        input_tokens = int(chunk.get("input_tokens") or 0)
        output_tokens = int(chunk.get("output_tokens") or 0)
        if not input_tokens and not output_tokens and not self._speed_meta():
            return
        used = int(
            chunk.get("used_tokens")
            or chunk.get("context_tokens")
            or chunk.get("total_tokens")
            or input_tokens + output_tokens
        )
        size = int(
            chunk.get("context_limit")
            or chunk.get("context_window")
            or chunk.get("max_context_tokens")
            or self.context_window_tokens
            or DEFAULT_CONTEXT_WINDOW
        )
        if used < 0 or size <= 0:
            return
        cost = self._record_usage_cost(input_tokens, output_tokens, chunk)
        update = {
            "sessionUpdate": "usage_update",
            "used": used,
            "size": size,
            "_meta": {"backboard_speed": self._speed_meta()},
        }
        if cost is not None:
            update["cost"] = {"amount": cost, "currency": "USD"}
        await self._update(
            update
        )

    def _record_usage_cost(self, input_tokens: int, output_tokens: int, chunk: dict[str, Any]) -> float | None:
        turn_cost = self._extract_server_cost(chunk)
        if turn_cost is None:
            with contextlib.suppress(Exception):
                turn_cost = self.pricing.cost_for_turn(
                    self.provider or config.default_provider,
                    self.model or config.default_model,
                    input_tokens,
                    output_tokens,
                )
        if turn_cost is None:
            return None
        self.session_total_cost = round(max(0.0, self.session_total_cost + float(turn_cost)), 6)
        return self.session_total_cost

    def _extract_server_cost(self, chunk: dict[str, Any]) -> float | None:
        for key in ("amount_deducted_usd", "cost_usd", "turn_cost_usd", "cost"):
            value = chunk.get(key)
            if isinstance(value, dict):
                value = value.get("amount") or value.get("usd")
            if isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0:
                return float(value)
            if isinstance(value, str):
                with contextlib.suppress(ValueError):
                    parsed = float(value)
                    if parsed >= 0:
                        return parsed
        return None

    async def _update(self, update: dict[str, Any]) -> None:
        with contextlib.suppress(RuntimeError):
            self._last_visible_event = asyncio.get_running_loop().time()
        await self.server.notify("session/update", {"sessionId": self.session_id, "update": update})

    def _extract_prompt_text(self, blocks: list[dict[str, Any]]) -> str:
        parts: list[str] = []
        for block in blocks:
            block_type = block.get("type")
            if block_type == "text":
                parts.append(str(block.get("text") or ""))
            elif block_type == "resource_link":
                parts.append(str(block.get("uri") or block.get("name") or ""))
            elif block_type == "resource":
                resource = block.get("resource") or {}
                if isinstance(resource, dict):
                    text = resource.get("text") or resource.get("contents") or resource.get("content")
                    uri = resource.get("uri")
                    if uri:
                        parts.append(f"\nContext: {uri}\n{text or ''}")
                    elif text:
                        parts.append(str(text))
            else:
                parts.append(json.dumps(block, ensure_ascii=False))
        return "\n".join(part for part in parts if part)

    def _tool_title(self, name: str, args: dict[str, Any]) -> str:
        path = _path_arg(args)
        if path:
            display_path = self._display_raw_path(path)
            action = {
                "write": "Writing",
                "edit": "Editing",
                "search_replace": "Editing",
                "delete_file": "Deleting",
                "read_file": "Reading",
                "list_dir": "Listing",
                "create_directory": "Creating directory",
                "edit_notebook": "Editing notebook",
            }.get(name, name)
            return f"{action} `{display_path}`"
        if name in SHELL_TOOLS:
            command = _extract_shell_command(name, args).splitlines()[0][:80]
            return f"Running `{command}`"
        if name == "todo_write":
            return "Updating plan"
        if name == "task":
            description = str(args.get("description") or "focused subtask").strip()
            return f"Running subtask: {description}"
        return name

    def _shell_output(self, result: dict[str, Any]) -> str:
        pieces = []
        for key in ("output", "stdout", "stderr", "message", "error"):
            value = result.get(key) if isinstance(result, dict) else None
            if value:
                pieces.append(str(value))
        return _truncate("\n".join(pieces) if pieces else _result_text(result))

    def _shell_exit_code(self, result: dict[str, Any]) -> int:
        if not isinstance(result, dict):
            return 0
        for key in ("exit_code", "returncode", "return_code"):
            value = result.get(key)
            if isinstance(value, int):
                return value
        success = result.get("success")
        return 0 if success is not False else 1


async def main() -> None:
    await AcpServer().serve()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
