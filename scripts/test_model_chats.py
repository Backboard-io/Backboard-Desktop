#!/usr/bin/env python3
"""Live release gate: two-turn streamed chats through the packaged IDE bridge.

Uses the existing IDE API credentials without printing them. Each model gets a
fresh temporary workspace/session. Real requests may incur model usage charges.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import queue
import subprocess
import tempfile
import threading
import time
import uuid


class Bridge:
    def __init__(self, binary, cwd, env, timeout):
        self.timeout = timeout
        self.events = queue.Queue()
        self.proc = subprocess.Popen([str(binary), '--serve', '--cwd', cwd],
            cwd=cwd, env={**env, 'BACKBOARD_SESSION_ID': 'release-smoke-' + uuid.uuid4().hex},
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        def read():
            for line in self.proc.stdout:
                try:
                    self.events.put(json.loads(line))
                except ValueError:
                    pass
            self.events.put({'type': 'process:exit'})
        threading.Thread(target=read, daemon=True).start()

    def send(self, **control):
        self.proc.stdin.write(json.dumps(control) + '\n')
        self.proc.stdin.flush()

    def receive(self, until, request_id=None):
        end = time.monotonic() + self.timeout
        records = []
        while True:
            remaining = end - time.monotonic()
            if remaining <= 0:
                raise RuntimeError('Timed out waiting for ' + until)
            try:
                r = self.events.get(timeout=remaining)
            except queue.Empty:
                raise RuntimeError('Timed out waiting for ' + until) from None
            kind = r.get('type')
            if kind in ('process:exit', 'serve:error', 'run:error', 'tool:start', 'input:request', 'client_tool:call'):
                # Do not include raw provider responses or credentials in logs.
                raise RuntimeError('Chat bridge emitted ' + kind)
            records.append(r)
            if kind == until and (request_id is None or r.get('requestId') == request_id):
                return records

    def close(self):
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()
        self.proc.stdin.close()
        self.proc.stdout.close()


def validate_turn(records, expected):
    deltas = ''.join(str(r.get('payload', {}).get('text', '')) for r in records if r.get('type') == 'assistant:delta')
    ends = [r.get('payload', {}).get('status') for r in records if r.get('type') == 'turn:end']
    if ends != ['completed']:
        raise RuntimeError('Chat did not complete successfully')
    if expected not in deltas:
        raise RuntimeError('Streamed response missing expected conversation token')
    return len(deltas)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', required=True)
    parser.add_argument('--model', action='append', help='provider/model; repeat for explicit coverage')
    parser.add_argument('--list-models', action='store_true')
    parser.add_argument('--claude-subscription', action='store_true', help='Test the signed-in Claude.ai subscription instead of API routes')
    parser.add_argument('--timeout', type=int, default=120)
    parser.add_argument('--report', required=True)
    args = parser.parse_args()
    binary = Path(args.app).resolve() / 'Contents/Resources/app/extensions/backboard/bin/backboard-cli-ts'
    if not binary.is_file():
        raise RuntimeError('Packaged chat runtime is missing')
    env = dict(os.environ)
    config_path = Path.home() / '.backboard_ide/config.json'
    config = json.loads(config_path.read_text()) if config_path.exists() else {}
    key = env.get('BACKBOARD_API_KEY') or config.get('api_key') or config.get('apiKey') or config.get('env_keys', {}).get(config.get('env', 'prod'))
    if not key:
        raise RuntimeError('Configure the IDE API key or BACKBOARD_API_KEY before releasing')
    env['BACKBOARD_API_KEY'] = key
    api = env.get('BACKBOARD_API_URL') or config.get('api_url') or config.get('apiUrl')
    if api:
        env['BACKBOARD_API_URL'] = api
    report = {'runtime_sha256': hashlib.sha256(binary.read_bytes()).hexdigest(), 'passed': False, 'results': []}
    report_path = Path(args.report)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with tempfile.TemporaryDirectory(prefix='backboard-chat-smoke-') as tmp:
            # Isolate histories, MCP settings and provider keys from the user's workspace.
            env.update(BACKBOARD_SESSION_ROOT=tmp, BACKBOARD_HOST_MANAGED_KEYS='1')
            if args.claude_subscription:
                env['BACKBOARD_CLAUDE_SUBSCRIPTION'] = '1'
            else:
                env['HOME'] = tmp
            bridge = Bridge(binary, tmp, env, args.timeout)
            try:
                ready = bridge.receive('serve:ready')[-1]['payload']
                bridge.send(op='listModels', requestId='catalog')
                catalog = bridge.receive('serve:models', 'catalog')[-1]['payload']['models']
            finally:
                bridge.close()
            available = {m['provider']+'/'+m['name']: m for m in catalog if m.get('source', 'backboard') == ('subscription' if args.claude_subscription else 'backboard') and m.get('model_type') in ('llm', 'chat', 'text')}
            if args.list_models:
                print(json.dumps({'default': ready['model'], 'models': list(available)}, indent=2))
                return
            models = args.model or [ready['model']]
            if args.claude_subscription and not args.model:
                models = [m for m in available if m.startswith('anthropic-subscription/')]
                if not models:
                    raise RuntimeError('No authenticated Claude subscription models available')
            elif not args.model:
                for provider in ('openai', 'anthropic', 'google'):
                    choices = [m for m in available if m.startswith(provider+'/')]
                    if not choices:
                        raise RuntimeError('No chat models found for required provider ' + provider)
                    # Prefer fast current models; deterministic catalog fallback.
                    choices.sort(key=lambda m: (not any(x in m.lower() for x in ('flash', 'mini', 'haiku')), m))
                    models.append(choices[0])
                models.append('openrouter/~deepseek/deepseek-flash-latest')
            for model in dict.fromkeys(models):
                if model not in available:
                    raise RuntimeError('Required model missing from live catalog: ' + model)
                print('Testing two-turn streamed chat: ' + model, flush=True)
                bridge = Bridge(binary, tmp, env, args.timeout)
                result = {'model': model, 'passed': False}
                report['results'].append(result)
                started = time.monotonic()
                try:
                    bridge.receive('serve:ready')
                    token = 'release_' + uuid.uuid4().hex[:12]
                    prompts = [f'Remember this token for this conversation: {token}. Reply with only that token. Do not use tools.',
                        'What exact token did I give you in my previous message? Reply with only that token. Do not use tools.']
                    for i, prompt in enumerate(prompts):
                        bridge.send(op='submit', requestId='turn-'+str(i), prompt=prompt, model=model, source='subscription' if args.claude_subscription else 'backboard',
                            thinking='off', memory='off', permission='manual', clientTools=[], skills=[], computerUse=False,
                            browserUse=False, imageGeneration=False, videoGeneration=False)
                        validate_turn(bridge.receive('turn:end'), token)
                    result['passed'] = True
                    result['seconds'] = round(time.monotonic()-started, 2)
                    print('PASS ' + model, flush=True)
                finally:
                    bridge.close()
            report['passed'] = True
    finally:
        report_path.write_text(json.dumps(report, indent=2)+'\n')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('FAIL: ' + str(error), flush=True)
        raise SystemExit(1)
