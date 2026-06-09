#!/usr/bin/env python3
"""
Smoke-test Backboard model compatibility with native read/write tool calling.

This script creates one temporary Backboard assistant with minimal read_file and
write tool definitions, creates one thread per model, asks each model to call
both tools, submits synthetic tool outputs, and reports which models fail.
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import os
import queue
import sys
import textwrap
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


PROD_API_URL = "https://app.backboard.io/api"
DEV_API_URL = "https://dev.app.backboard.io/api"
LOCAL_API_URL = "http://localhost:8000"

DEFAULT_MODEL_CATALOG_PROVIDERS = [
    "anthropic",
    "openai",
    "google",
    "xai",
    "deepseek",
    "openrouter",
    "aws-bedrock",
    "cohere",
    "cerebras",
    "mistral",
    "groq",
    "together",
    "fireworks",
    "perplexity",
]

READ_FILE_TOOL = {
    "type": "function",
    "function": {
        "name": "read_file",
        "description": "Read a file. Use target_file or file_path.",
        "parameters": {
            "type": "object",
            "properties": {
                "target_file": {
                    "type": "string",
                    "description": "Path to file, relative to workspace or absolute",
                },
                "file_path": {
                    "type": "string",
                    "description": "Alias for target_file",
                },
                "offset": {
                    "type": "integer",
                    "description": "Starting line number, 1-indexed",
                },
                "limit": {
                    "type": "integer",
                    "description": "Number of lines to read",
                },
            },
            "required": ["target_file"],
        },
    },
}

WRITE_TOOL = {
    "type": "function",
    "function": {
        "name": "write",
        "description": "Write a complete file.",
        "parameters": {
            "type": "object",
            "properties": {
                "file_path": {"type": "string", "description": "Path to file"},
                "contents": {
                    "type": "string",
                    "description": "Complete file contents",
                },
            },
            "required": ["file_path", "contents"],
        },
    },
}

SMOKE_PROMPT = textwrap.dedent(
    """
    You are running a tool-calling compatibility smoke test.

    Do not answer from memory. Use the tools exactly as requested:
    1. First call read_file with target_file set to "README.md".
    2. After you receive the read_file result, call write with file_path set to
       "tmp/backboard-model-tool-smoke.txt" and contents set to "ok\\n".
    3. After you receive the write result, answer with exactly TOOL_SMOKE_DONE.
    """
).strip()


@dataclasses.dataclass(frozen=True)
class Model:
    provider: str
    name: str
    display_name: str | None = None

    @property
    def key(self) -> str:
        return f"{self.provider}/{self.name}"


@dataclasses.dataclass
class ModelResult:
    provider: str
    model: str
    status: str
    error: str | None
    seen_tools: list[str]
    run_id: str | None
    thread_id: str | None
    events: list[str]
    duration_seconds: float


class BackboardApiError(RuntimeError):
    def __init__(self, method: str, url: str, status: int | None, body: str) -> None:
        self.method = method
        self.url = url
        self.status = status
        self.body = body
        status_text = "unknown status" if status is None else str(status)
        super().__init__(f"{method} {url} failed with {status_text}: {body[:500]}")


class BackboardClient:
    def __init__(self, api_url: str, api_key: str, timeout: float) -> None:
        self.api_url = api_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout

    def get_json(self, path: str, params: dict[str, Any] | None = None) -> Any:
        return self._json("GET", path, None, params)

    def post_json(self, path: str, body: dict[str, Any]) -> Any:
        return self._json("POST", path, body, None)

    def post_sse(self, path: str, body: dict[str, Any]):
        url = self._url(path)
        data = json.dumps(body).encode("utf-8")
        request = urllib.request.Request(
            url,
            data=data,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "X-API-Key": self.api_key,
            },
        )
        try:
            response = urllib.request.urlopen(request, timeout=self.timeout)
        except urllib.error.HTTPError as error:
            raise BackboardApiError(
                "POST",
                url,
                error.code,
                error.read().decode("utf-8", errors="replace"),
            ) from error
        except urllib.error.URLError as error:
            raise BackboardApiError("POST", url, None, str(error)) from error

        return self._iter_sse_json(response, url)

    def _json(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None,
        params: dict[str, Any] | None,
    ) -> Any:
        url = self._url(path, params)
        data = None if body is None else json.dumps(body).encode("utf-8")
        request = urllib.request.Request(
            url,
            data=data,
            method=method,
            headers={
                "Content-Type": "application/json",
                "X-API-Key": self.api_key,
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                payload = response.read().decode("utf-8")
        except urllib.error.HTTPError as error:
            raise BackboardApiError(
                method,
                url,
                error.code,
                error.read().decode("utf-8", errors="replace"),
            ) from error
        except urllib.error.URLError as error:
            raise BackboardApiError(method, url, None, str(error)) from error

        if not payload:
            return None
        try:
            return json.loads(payload)
        except json.JSONDecodeError as error:
            raise BackboardApiError(method, url, None, payload[:500]) from error

    def _url(self, path: str, params: dict[str, Any] | None = None) -> str:
        path = path if path.startswith("/") else f"/{path}"
        url = f"{self.api_url}{path}"
        if params:
            url = f"{url}?{urllib.parse.urlencode(params)}"
        return url

    def _iter_sse_json(self, response: Any, url: str):
        with response:
            for raw_line in response:
                line = raw_line.decode("utf-8", errors="replace").strip()
                if not line.startswith("data: "):
                    continue
                payload = line.removeprefix("data: ").strip()
                if not payload or payload == "[DONE]":
                    continue
                try:
                    yield json.loads(payload)
                except json.JSONDecodeError as error:
                    raise BackboardApiError("POST", url, None, payload[:500]) from error


def load_config(config_path: Path) -> dict[str, Any]:
    try:
        with config_path.open("r", encoding="utf-8") as file:
            config = json.load(file)
    except FileNotFoundError:
        return {}
    if str(config.get("env", "")).lower() == "dev" and not config.get("api_url"):
        env_keys = config.setdefault("env_keys", {})
        if "dev" in env_keys and "prod" not in env_keys:
            env_keys["prod"] = env_keys["dev"]
        config["env"] = "prod"
    return config


def config_api_url(config: dict[str, Any]) -> str:
    api_url = os.environ.get("BACKBOARD_API_URL") or config.get("api_url")
    if api_url:
        return str(api_url).rstrip("/")
    env = str(config.get("env") or "prod").lower()
    if env in ("prod", "production"):
        return PROD_API_URL
    if env == "local":
        return LOCAL_API_URL
    return DEV_API_URL


def config_api_key(config: dict[str, Any]) -> str | None:
    api_key = os.environ.get("BACKBOARD_API_KEY") or config.get("api_key")
    if api_key and str(api_key).strip():
        return str(api_key).strip()
    env = str(config.get("env") or "prod").lower()
    env_keys = config.get("env_keys") or {}
    api_key = env_keys.get(env)
    if api_key and str(api_key).strip():
        return str(api_key).strip()
    return None


def normalize_model(raw_model: dict[str, Any]) -> Model | None:
    provider = str(raw_model.get("provider") or "").strip()
    name = str(
        raw_model.get("name") or raw_model.get("id") or raw_model.get("model_id") or ""
    ).strip()
    display_name = raw_model.get("display_name")
    if not provider or not name:
        return None
    return Model(
        provider=provider,
        name=name,
        display_name=str(display_name) if display_name else None,
    )


def is_featherless_model(model: Model) -> bool:
    text = " ".join(
        part.lower()
        for part in (model.provider, model.name, model.display_name or "")
        if part
    )
    return "featherless" in text


def list_models(
    client: BackboardClient,
    catalog_limit: int,
    include_featherless: bool,
    include_provider_scoped: bool,
) -> list[Model]:
    raw_models: list[dict[str, Any]] = []
    response = client.get_json(
        "/models", {"model_type": "llm", "limit": str(catalog_limit)}
    )
    raw_models.extend(response.get("models") or [])

    if include_provider_scoped:
        providers = list(DEFAULT_MODEL_CATALOG_PROVIDERS)
        try:
            provider_response = client.get_json("/models/providers")
            for provider in provider_response.get("providers") or []:
                if provider not in providers:
                    providers.append(provider)
        except Exception as error:
            print(f"warning: failed to list providers: {error}", file=sys.stderr)

        for provider in providers:
            try:
                response = client.get_json(
                    "/models",
                    {
                        "provider": provider,
                        "model_type": "llm",
                        "limit": str(catalog_limit),
                    },
                )
                raw_models.extend(response.get("models") or [])
            except Exception as error:
                print(
                    f"warning: failed provider-scoped catalog request for {provider}: {error}",
                    file=sys.stderr,
                )

    models: list[Model] = []
    seen: set[tuple[str, str]] = set()
    for raw_model in raw_models:
        model = normalize_model(raw_model)
        if model is None:
            continue
        key = (model.provider, model.name)
        if key in seen:
            continue
        seen.add(key)
        if not include_featherless and is_featherless_model(model):
            continue
        models.append(model)
    return models


def create_assistant(client: BackboardClient) -> str:
    response = client.post_json(
        "/assistants",
        {
            "name": "Backboard model tool smoke test",
            "description": "Temporary assistant used to test model tool-call compatibility.",
            "tools": [READ_FILE_TOOL, WRITE_TOOL],
        },
    )
    assistant_id = json_string(response, "assistant_id", "id")
    if not assistant_id:
        raise RuntimeError(f"create assistant response did not include an id: {response}")
    return assistant_id


def create_thread(client: BackboardClient, assistant_id: str) -> str:
    response = client.post_json(f"/assistants/{assistant_id}/threads", {})
    thread_id = json_string(response, "thread_id", "id")
    if not thread_id:
        raise RuntimeError(f"create thread response did not include an id: {response}")
    return thread_id


def json_string(value: Any, *keys: str) -> str | None:
    if not isinstance(value, dict):
        return None
    for key in keys:
        candidate = value.get(key)
        if isinstance(candidate, str) and candidate:
            return candidate
    return None


def tool_call_id(raw_call: dict[str, Any]) -> str:
    value = raw_call.get("id") or raw_call.get("tool_call_id")
    if isinstance(value, str) and value:
        return value
    return f"tool-{time.time_ns()}"


def parse_tool_call(raw_call: dict[str, Any]) -> tuple[str, str, dict[str, Any]]:
    function = raw_call.get("function")
    if not isinstance(function, dict):
        function = {}
    name = (
        function.get("name")
        or raw_call.get("name")
        or raw_call.get("function_name")
        or raw_call.get("tool_name")
    )
    if not isinstance(name, str) or not name:
        return tool_call_id(raw_call), "invalid_tool_call", {}

    arguments = (
        function.get("arguments")
        if "arguments" in function
        else raw_call.get("arguments", raw_call.get("args", raw_call.get("input", {})))
    )
    if isinstance(arguments, str):
        try:
            arguments = json.loads(arguments) if arguments.strip() else {}
        except json.JSONDecodeError:
            arguments = {"_raw_arguments": arguments}
    if not isinstance(arguments, dict):
        arguments = {"value": arguments}
    return tool_call_id(raw_call), name, arguments


def tool_output_payload(tool_call_id_value: str, tool_name: str, args: dict[str, Any]) -> dict[str, str]:
    if tool_name == "read_file":
        output = {
            "success": True,
            "path": args.get("target_file") or args.get("file_path") or "README.md",
            "content": "# Backboard model tool smoke test\nSynthetic read_file output.\n",
        }
    elif tool_name == "write":
        output = {
            "success": True,
            "path": args.get("file_path") or "tmp/backboard-model-tool-smoke.txt",
            "message": "Synthetic write accepted; no local file was changed.",
        }
    else:
        output = {
            "success": False,
            "error": f"Unexpected tool `{tool_name}` in smoke test.",
        }
    return {
        "tool_call_id": tool_call_id_value,
        "output": json.dumps(output, separators=(",", ":")),
    }


def test_model(
    client: BackboardClient,
    assistant_id: str,
    model: Model,
    max_tool_rounds: int,
    max_tokens: int | None,
) -> ModelResult:
    started_at = time.monotonic()
    seen_tools: list[str] = []
    events: list[str] = []
    run_id: str | None = None
    thread_id: str | None = None

    try:
        thread_id = create_thread(client, assistant_id)
        stream = client.post_sse(
            "/threads/messages",
            {
                "thread_id": thread_id,
                "content": SMOKE_PROMPT,
                "stream": True,
                "memory": "Off",
                "web_search": "off",
                "llm_provider": model.provider,
                "model_name": model.name,
                **({"max_tokens": max_tokens} if max_tokens else {}),
            },
        )

        tool_rounds = 0
        while True:
            submit_required: tuple[str, list[dict[str, Any]]] | None = None
            for chunk in stream:
                chunk_type = str(chunk.get("type") or "")
                if chunk_type:
                    events.append(chunk_type)

                if chunk_type == "run_started":
                    run_id = json_string(chunk, "run_id", "id") or run_id
                elif chunk_type in ("run_failed", "error"):
                    return result(
                        model,
                        "run_failed",
                        chunk_error(chunk),
                        seen_tools,
                        run_id,
                        thread_id,
                        events,
                        started_at,
                    )
                elif chunk_type == "tool_submit_required":
                    required_run_id = json_string(chunk, "run_id", "id") or run_id
                    tool_calls = chunk.get("tool_calls") or []
                    if not required_run_id:
                        return result(
                            model,
                            "tool_protocol_error",
                            "tool_submit_required did not include run_id",
                            seen_tools,
                            run_id,
                            thread_id,
                            events,
                            started_at,
                        )
                    submit_required = (required_run_id, tool_calls)
                    break
                elif chunk_type == "run_ended":
                    status = chunk.get("status")
                    tool_calls = chunk.get("tool_calls")
                    if status == "requires_action" and tool_calls:
                        required_run_id = json_string(chunk, "run_id", "id") or run_id
                        if not required_run_id:
                            return result(
                                model,
                                "tool_protocol_error",
                                "requires_action run_ended did not include run_id",
                                seen_tools,
                                run_id,
                                thread_id,
                                events,
                                started_at,
                            )
                        submit_required = (required_run_id, tool_calls)
                        break
                    return final_model_result(
                        model, seen_tools, run_id, thread_id, events, started_at
                    )

            if submit_required is None:
                return final_model_result(
                    model, seen_tools, run_id, thread_id, events, started_at
                )

            tool_rounds += 1
            if tool_rounds > max_tool_rounds:
                return result(
                    model,
                    "too_many_tool_rounds",
                    f"exceeded {max_tool_rounds} tool rounds",
                    seen_tools,
                    run_id,
                    thread_id,
                    events,
                    started_at,
                )

            required_run_id, tool_calls = submit_required
            outputs = []
            for raw_call in tool_calls:
                if not isinstance(raw_call, dict):
                    continue
                call_id, name, args = parse_tool_call(raw_call)
                seen_tools.append(name)
                outputs.append(tool_output_payload(call_id, name, args))

            if not outputs:
                return result(
                    model,
                    "tool_protocol_error",
                    f"no parseable tool calls in {tool_calls!r}",
                    seen_tools,
                    run_id,
                    thread_id,
                    events,
                    started_at,
                )

            stream = client.post_sse(
                f"/threads/{thread_id}/runs/{required_run_id}/submit-tool-outputs?stream=true",
                {"tool_outputs": outputs},
            )
    except Exception as error:
        return result(
            model,
            "http_error" if isinstance(error, BackboardApiError) else "exception",
            f"{error}\n{traceback.format_exc(limit=4)}",
            seen_tools,
            run_id,
            thread_id,
            events,
            started_at,
        )


def final_model_result(
    model: Model,
    seen_tools: list[str],
    run_id: str | None,
    thread_id: str | None,
    events: list[str],
    started_at: float,
) -> ModelResult:
    missing = [tool for tool in ("read_file", "write") if tool not in seen_tools]
    if missing:
        return result(
            model,
            "missing_tool_calls",
            f"missing expected tool calls: {', '.join(missing)}",
            seen_tools,
            run_id,
            thread_id,
            events,
            started_at,
        )
    unexpected = [tool for tool in seen_tools if tool not in ("read_file", "write")]
    if unexpected:
        return result(
            model,
            "unexpected_tool_calls",
            f"unexpected tool calls: {', '.join(unexpected)}",
            seen_tools,
            run_id,
            thread_id,
            events,
            started_at,
        )
    return result(model, "ok", None, seen_tools, run_id, thread_id, events, started_at)


def result(
    model: Model,
    status: str,
    error: str | None,
    seen_tools: list[str],
    run_id: str | None,
    thread_id: str | None,
    events: list[str],
    started_at: float,
) -> ModelResult:
    return ModelResult(
        provider=model.provider,
        model=model.name,
        status=status,
        error=error,
        seen_tools=seen_tools,
        run_id=run_id,
        thread_id=thread_id,
        events=events,
        duration_seconds=round(time.monotonic() - started_at, 3),
    )


def chunk_error(chunk: dict[str, Any]) -> str:
    for key in ("error", "message", "status_details"):
        value = chunk.get(key)
        if isinstance(value, str) and value:
            return value
        if value is not None:
            return json.dumps(value, sort_keys=True)
    return json.dumps(chunk, sort_keys=True)


def select_models(
    models: list[Model],
    requested_models: list[str],
    requested_providers: list[str],
    limit: int | None,
) -> list[Model]:
    if requested_models:
        requested = set(requested_models)
        models = [model for model in models if model.key in requested or model.name in requested]
    if requested_providers:
        providers = set(requested_providers)
        models = [model for model in models if model.provider in providers]
    if limit is not None:
        models = models[:limit]
    return models


def print_summary(results: list[ModelResult]) -> None:
    counts: dict[str, int] = {}
    for item in results:
        counts[item.status] = counts.get(item.status, 0) + 1

    print("\nSummary:")
    for status, count in sorted(counts.items()):
        print(f"  {status}: {count}")

    failures = [item for item in results if item.status != "ok"]
    if failures:
        print("\nFailures:")
        for item in failures:
            print(
                f"  {item.provider}/{item.model}: {item.status}"
                f" tools={item.seen_tools or '-'}"
            )
            if item.error:
                first_line = item.error.splitlines()[0]
                print(f"    {first_line[:240]}")


def write_json_report(path: Path, results: list[ModelResult]) -> None:
    payload = [dataclasses.asdict(item) for item in results]
    with path.open("w", encoding="utf-8") as file:
        json.dump(payload, file, indent=2, sort_keys=True)
        file.write("\n")


def worker(
    work_queue: queue.Queue[Model],
    result_queue: queue.Queue[ModelResult],
    client: BackboardClient,
    assistant_id: str,
    max_tool_rounds: int,
    max_tokens: int | None,
) -> None:
    while True:
        try:
            model = work_queue.get_nowait()
        except queue.Empty:
            return
        try:
            result_item = test_model(
                client, assistant_id, model, max_tool_rounds, max_tokens
            )
            result_queue.put(result_item)
        finally:
            work_queue.task_done()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Test Backboard model compatibility with read_file and write tools.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=textwrap.dedent(
            """
            Examples:
              script/backboard-model-tool-smoke-test.py --limit 10
              script/backboard-model-tool-smoke-test.py --provider openai --provider anthropic
              script/backboard-model-tool-smoke-test.py --model openai/gpt-4o --json-output /tmp/model-tool-report.json
            """
        ),
    )
    parser.add_argument("--api-url", help="Backboard API URL. Defaults to config/env.")
    parser.add_argument("--api-key", help="Backboard API key. Defaults to BACKBOARD_API_KEY/config.")
    parser.add_argument(
        "--config",
        type=Path,
        default=Path.home() / ".backboard_ide" / "config.json",
        help="Backboard config path.",
    )
    parser.add_argument(
        "--provider",
        action="append",
        default=[],
        help="Only test this provider. Can be repeated.",
    )
    parser.add_argument(
        "--model",
        action="append",
        default=[],
        help="Only test this model name or provider/model. Can be repeated.",
    )
    parser.add_argument("--limit", type=int, help="Maximum number of selected models to test.")
    parser.add_argument(
        "--catalog-limit",
        type=int,
        default=15000,
        help="Limit sent to /models catalog requests.",
    )
    parser.add_argument(
        "--include-featherless",
        action="store_true",
        help="Include Featherless models. Defaults to excluded.",
    )
    parser.add_argument(
        "--skip-provider-scoped",
        action="store_true",
        help="Only use the global /models catalog request.",
    )
    parser.add_argument(
        "--concurrency",
        type=int,
        default=4,
        help="Number of model checks to run concurrently.",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=120.0,
        help="HTTP timeout in seconds per request.",
    )
    parser.add_argument(
        "--max-tool-rounds",
        type=int,
        default=4,
        help="Maximum tool submit rounds per model.",
    )
    parser.add_argument(
        "--max-tokens",
        type=int,
        default=512,
        help="Optional max_tokens value for the model request. Set 0 to omit.",
    )
    parser.add_argument(
        "--json-output",
        type=Path,
        help="Write detailed JSON report to this path.",
    )
    parser.add_argument(
        "--count-only",
        action="store_true",
        help="Only count selected models; do not create an assistant or call models.",
    )
    parser.add_argument(
        "--list-models",
        action="store_true",
        help="Print selected provider/model identifiers before exiting or testing.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    config = load_config(args.config)
    api_url = (args.api_url or config_api_url(config)).rstrip("/")
    api_key = args.api_key or config_api_key(config)
    if not api_key:
        print(
            "error: Backboard API key not found. Set BACKBOARD_API_KEY, pass --api-key, "
            f"or configure {args.config}.",
            file=sys.stderr,
        )
        return 2

    client = BackboardClient(api_url, api_key, args.timeout)
    print(f"Listing models from {api_url}...", file=sys.stderr)
    models = list_models(
        client,
        args.catalog_limit,
        include_featherless=args.include_featherless,
        include_provider_scoped=not args.skip_provider_scoped,
    )
    models = select_models(models, args.model, args.provider, args.limit)
    if not models:
        print("error: no models selected", file=sys.stderr)
        return 2

    if args.list_models:
        for model in models:
            print(model.key)

    if args.count_only:
        print(f"\nSelected {len(models)} models.")
        return 0

    print(f"Selected {len(models)} models.", file=sys.stderr)
    assistant_id = create_assistant(client)
    print(f"Created smoke-test assistant {assistant_id}.", file=sys.stderr)

    work_queue: queue.Queue[Model] = queue.Queue()
    result_queue: queue.Queue[ModelResult] = queue.Queue()
    for model in models:
        work_queue.put(model)

    workers = max(1, min(args.concurrency, len(models)))
    threads = [
        threading.Thread(
            target=worker,
            args=(
                work_queue,
                result_queue,
                client,
                assistant_id,
                args.max_tool_rounds,
                args.max_tokens or None,
            ),
            daemon=True,
        )
        for _ in range(workers)
    ]

    for thread in threads:
        thread.start()

    results: list[ModelResult] = []
    completed = 0
    while completed < len(models):
        item = result_queue.get()
        completed += 1
        results.append(item)
        marker = "PASS" if item.status == "ok" else "FAIL"
        print(
            f"[{completed}/{len(models)}] {marker} {item.provider}/{item.model} "
            f"{item.status} tools={item.seen_tools or '-'}",
            flush=True,
        )

    for thread in threads:
        thread.join(timeout=0.1)

    results.sort(key=lambda item: (item.provider, item.model))
    if args.json_output:
        write_json_report(args.json_output, results)
        print(f"\nWrote JSON report to {args.json_output}")
    print_summary(results)
    return 1 if any(item.status != "ok" for item in results) else 0


if __name__ == "__main__":
    raise SystemExit(main())
