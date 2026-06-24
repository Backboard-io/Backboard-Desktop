# Backboard IDE Feature Documentation

This folder documents the user-visible feature surface of this VS Code based Backboard IDE workspace.

Every feature folder follows the same contract:

- `ui/README.md` - visible screens, controls, panels, menus, and state indicators.
- `ui/source-inventory.md`, `ui/screen-map.md`, `ui/code-excerpts.md` - full UI source paths, ASCII surface maps, and literal source excerpts.
- `ux/README.md` - user flows, expected behavior, empty/error/loading states, and accessibility concerns.
- `ux/journeys.md`, `ux/states-and-errors.md`, `ux/validation-playbook.md` - user journeys, state/error matrices, and repeatable validation steps.
- `endpoints/README.md` - command IDs, settings, URI/file/protocol surfaces, extension contribution points, services, and network endpoints where the feature actually has them.
- `endpoints/endpoint-registry.md`, `endpoints/commands-settings-services.md`, `endpoints/risk-boundaries.md` - endpoint registries, command/settings/service tables, and boundary risk notes.
- `features/README.md` - detailed capability inventory, source anchors, boundaries, and notable dependencies.
- `features/implementation-map.md`, `features/ownership-and-files.md`, `features/extension-points.md` - implementation architecture, full file ownership, and extension/contribution points.

In this repository, "endpoint" does not mean HTTP only. Most VS Code features are local extension/workbench surfaces. Endpoint coverage therefore includes command IDs, configuration keys, URI handlers, filesystem locations, service interfaces, task/debug/notebook providers, MCP server definitions, and external HTTP endpoints only when source code shows them.

## Audit Snapshot

The current `bb-docs` audit covers:

- 29 feature folders.
- 526 Markdown files.
- 2,587 fenced code blocks.
- 998 ASCII `text` diagrams/blocks.
- 19,235 full absolute path mentions.
- 0 broken Markdown links.
- 0 unresolved absolute path mentions.
- 0 unfinished-marker hits in the final scan.

Additional root indexes:

- `source-crosswalk.md` maps source directories and built-in extensions to feature folders.
- `source-file-index.md` lists resolved absolute source paths per feature.
- `deep-documentation-matrix.md` counts source paths, candidate files, and docs per feature.
- `ascii-architecture-atlas.md` gives repository-level ASCII maps.
- `validation.md` records the review commands and validation contract.

## Feature Folders

| Feature folder | Coverage |
|---|---|
| `accessibility-localization-themes` | Accessibility help/signals, language packs, themes, icons, style overrides, and user-facing visual/a11y polish. |
| `accounts-authentication-secrets` | Account menu, authentication providers, credential storage, encryption, GitHub/Microsoft auth extensions, and auth-related prompts. |
| `ai-chat-inline-assistance` | Workbench chat, inline chat, inline completions, voice surfaces, Backboard Chat extension contributions, chat participants, and language-model tools. |
| `agent-sessions-window` | Dedicated Agents Window under `src/vs/sessions`, session providers, session grid, changes, worktrees, and mobile session UX. |
| `agents-editor-right-aux-backboard-copilot` | Agents Window editor layout, right auxiliary panel behavior, Backboard custom webview implementation, and Copilot native chat/session implementation. |
| `backboard-agent-bridge` | Backboard extension, bridge binary, Backboard webview panel, OAuth, model refresh, updates, Optimus panel commands, and local state. |
| `backboard-changes` | Current Backboard-related worktree diffs, recent commit timeline, exact paths, code excerpts, and ASCII diagrams describing what changed and why. |
| `built-in-language-support` | Built-in language, grammar, snippet, validation, task, theme, notebook renderer, and syntax extensions under `extensions/`. |
| `comments-review` | Comments, review threads, review action flows, and chat-assisted review commands. |
| `debugging` | Debug view, launch/run controls, breakpoints, debug console, debug adapter integration, auto-launch, and server-ready support. |
| `diff-merge-history` | Diff editors, multi-diff editor, merge editor, bulk edit, edit sessions, local history, and file change review. |
| `editor-language-intelligence` | Code editor, code actions, formatting, folding, inlay hints, hierarchy views, language status, language detection, and Emmet integration. |
| `extension-authoring-api` | Commands, menus, extension host/API surfaces, extension development helpers, and extension contribution validation. |
| `extensions-marketplace` | Extensions view, extension management, recommendations, enablement, update/install flows, and built-in extension management. |
| `files-workspaces-explorer` | Explorer/files, openers, workspaces, workspace trust-adjacent workspace flows, file services, and URI-backed editors. |
| `markdown-preview-docs` | Markdown preview, Mermaid, Markdown math, prompt/instruction markdown support, and markdown custom editors/renderers. |
| `mcp-tools-customizations` | MCP servers, MCP config files, AI customization editor, prompts/skills/agents/hooks, tools, and custom model/tool surfaces. |
| `modern-ide-system-blueprint` | Production-grade greenfield IDE system blueprint covering architecture, editor core, files, language intelligence, rendering, extensions, terminal/search/debug, state, input, performance, security, developer experience, and failure recovery. |
| `notebooks-interactive` | Notebook editor, interactive window, IPYNB serializer, REPL notebooks, renderers, and notebook chat/tooling. |
| `performance-telemetry-diagnostics` | Process explorer, performance contribution, telemetry, edit telemetry, issue diagnostics, logs used for diagnosis, and policy/export diagnostics. |
| `problems-output-logs` | Problems/markers, output channels, logs views, task/problem matchers, and diagnostic presentation. |
| `remote-tunnels-network` | Remote connection UI, remote tunnels, forwarded ports, browser views, external URI handling, metered connection, and tunnel forwarding. |
| `search-navigation` | Search view, search editor, quick access, outline/navigation surfaces, references view, and search-result documents. |
| `settings-keybindings-profiles-sync` | Settings editor, keybindings, profiles, settings sync, policy export touch points, and preference editing. |
| `source-control-git-github` | SCM view, Git extension, GitHub extension, authentication touch points, source control decoration, commit workflows, and edit-session continuation. |
| `terminal-tasks` | Integrated terminal, shell integration, terminal suggest, terminal quick fixes, external terminal, and task providers. |
| `testing` | Test explorer, test controller API surfaces, test run UX, debug/run integration, and test-related chat assists. |
| `webviews-custom-editors-media` | Webviews, webview panels/views, custom editors, simple browser, image/media preview, and image carousel. |
| `welcome-onboarding-updates` | Welcome pages, walkthroughs, onboarding, splash, banners, surveys, emergency alerts, relaunch/update prompts, and issue entry points. |

## Source Anchors

Primary source inventory came from:

- `src/vs/workbench/contrib/*` for workbench features.
- `src/vs/workbench/services/*` and `src/vs/platform/*` for shared services and platform endpoints.
- `src/vs/editor/*` for editor primitives.
- `src/vs/sessions/*` for the Agents Window.
- `extensions/*/package.json` and selected extension source folders for built-in extension contributions.
- `extensions/backboard/*` and `extensions/copilot/*` for Backboard-specific AI/chat/bridge behavior.
- `bb-docs/modern-ide-system-blueprint/*` for the greenfield system reconstruction blueprint.

See `source-crosswalk.md` for the source-directory to documentation-folder mapping.

## Accuracy Rules

- Network endpoints are listed only when the checked source contains concrete URLs or URL construction.
- Internal services are described as service/API surfaces, not public HTTP endpoints.
- Folder names are stable and lower-case so the docs can be linked from issue templates, release notes, and QA checklists.
- When a source area is shared across multiple user features, the crosswalk assigns one primary folder and individual docs call out secondary dependencies.
