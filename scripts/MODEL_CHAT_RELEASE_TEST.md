# Live model chat release gate

Publishing Sandbox or Stable `latest` through `upload_s3_ide_release.sh` now mounts
the signed DMG read-only, extracts an installed copy, verifies its chat runtime
is byte-identical to the DMG, and runs its `backboard-cli-ts` chat bridge before
any upload. A failure stops publication. Dry runs do not make model requests.

The default coverage is the runtime default model, a small OpenAI model, Claude
Haiku, Gemini Flash, and the OpenRouter DeepSeek Flash alias. Models are checked
against the live catalog. This is representative routing coverage, not a claim
that every model in the catalog works. A second pass tests every Claude subscription model returned by the signed-in
Claude Code catalog. BYOK, ChatGPT subscriptions, and rendered UI behavior are not covered.

Each selected model runs in a fresh process with a temporary workspace. API
routes use a temporary home; Claude subscription tests retain the real home so
Claude Code can use its existing login (credentials are never copied).
Two real chat turns must complete, emit visible streaming text, and return a
random token from conversation context. Errors, timeouts, missing models, blank
replies, tool attempts, and lost context fail the gate. API credentials come from
`BACKBOARD_API_KEY` or the existing `~/.backboard_ide/config.json`; they are never
written to reports. These requests consume normal model usage.

Manual use:

```sh
python3 scripts/test_model_chats.py --app '/path/to/Backboard Studio.app' \
  --report /tmp/chat-report.json
```

Repeat `--model provider/name` to test a specific set; omit it for release coverage.
`--list-models` lists the available text model IDs without sending chat messages.
Reports include the packaged runtime SHA-256, tested models, duration and pass status.
They are saved beside each release DMG as `model-chat-smoke.json` and
`model-chat-smoke-claude-subscription.json`. Subscription mode can also be run
manually with `--claude-subscription`. Missing Claude login fails publication.

The signed CLI requires `com.apple.security.cs.allow-jit` for the Claude SDK’s
shared memory. Package validation checks this entitlement, and live subscription
chats exercise it in the signed executable.

Offline assertion checks:

```sh
python3 -m unittest discover -s scripts -p test_model_chats_test.py
```
