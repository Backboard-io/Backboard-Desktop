# Simple Backboard Rewire Checklist

Use this as the simple order of operations. Do not move to the next step until the current one works.

## 1. Prove Backboard Works Alone

Make sure the Backboard agent works before rewiring anything else.

Check:

- Backboard provider shows up as `backboard`.
- Session type is `agent-host-backboard`.
- Backboard models load.
- One prompt gets a response.
- One read tool works, like `read_file`.
- One write tool is blocked or allowed correctly based on mode.
- API key is read from:

```text
~/.backboard_ide/config.json
```

Done when:

```text
Backboard can answer and use tools by itself.
```

## 2. Wire Sandbox To Backboard

Make Sandbox/Agents open Backboard instead of Copilot CLI.

Change:

```text
SessionType.CopilotCLI
```

to:

```text
SessionType.AgentHostCopilot
```

where the Sandbox fallback is choosing what to open.

Check:

- Open Sandbox Window opens Backboard.
- Open in Sandbox Window opens Backboard.
- Empty-state Sandbox flow opens Backboard.
- UI says Backboard/Sandbox, not Copilot CLI.

Done when:

```text
Every Sandbox path starts agent-host-backboard.
```

## 3. Wire Normal Chat To Backboard

Now make the regular Chat panel use Backboard.

Best simple approach:

```text
Create a Backboard chat participant or adapter that targets agent-host-backboard.
```

Avoid starting by rewriting all GitHub Copilot internals.

Check:

- New Chat can send a prompt to Backboard.
- Chat model picker shows Backboard models.
- Tool calls show up in Chat.
- Missing API key opens Backboard setup.
- GitHub Copilot sign-in is not required for Backboard.

Done when:

```text
Normal Chat can talk to Backboard end to end.
```

## 4. Update Product Defaults

Only do this after normal Chat works with Backboard.

Update:

```text
product.json
```

Check:

- Default chat agent points to Backboard.
- Setup/sign-in opens Backboard setup.
- No stale `GitHub.copilot-chat` lookup breaks startup.
- Provider copy says Backboard.

Done when:

```text
The product starts with Backboard as the default chat system.
```

## 5. Clean Up UI Text

After the wiring works, clean up names and labels.

Search for:

```text
Copilot CLI
GitHub Copilot
copilotcli
agent-host-copilotcli
github.copilot
GitHub.copilot
```

Check each hit. Do not delete every hit blindly. Some may still be valid if GitHub Copilot remains installed separately.

Done when:

```text
Backboard flows say Backboard everywhere.
```

## 6. Validate After Every Step

Run:

```sh
PATH="/Users/erintomorri/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" ./node_modules/.bin/tsgo --project ./src/tsconfig.json --noEmit --skipLibCheck
```

Then manually check:

- One prompt works.
- One tool call works.
- Missing API key error is clear.
- Cancel still works.
- Reopen session still works.

## Short Version

```text
1. Backboard works alone.
2. Sandbox opens Backboard.
3. Normal Chat opens Backboard.
4. product.json defaults point to Backboard.
5. UI text says Backboard.
6. Compile and smoke test after every step.
```

