---
title: How to Migrate from WebStorm to Backboard Studio
description: "Guide for migrating from WebStorm to Backboard Studio, including settings and keybindings."
---

# How to Migrate from WebStorm to Backboard Studio

This guide covers how to set up Backboard Studio if you're coming from WebStorm, including keybindings, settings, and the differences you should expect as a JavaScript/TypeScript developer.

## Install Backboard Studio

Backboard Studio is available on macOS, Windows, and Linux.

For macOS, you can download it from app.backboard.io/download, or install via Homebrew:

```sh
brew install --cask backboard
```

For Windows, download the installer from app.backboard.io/download, or install via winget:

```sh
winget install Backboard Studio.Backboard Studio
```

For most Linux users, the easiest way to install Backboard Studio is through our installation script:

```sh
curl -f https://app.backboard.io/install.sh | sh
```

After installation, you can launch Backboard Studio from your Applications folder (macOS), Start menu (Windows), or directly from the terminal using:
`backboard .`
This opens the current directory in Backboard Studio.

## Set Up the JetBrains Keymap

If you're coming from WebStorm, the fastest way to feel at home is to use the JetBrains keymap. During onboarding, you can select it as your base keymap. If you missed that step, you can change it anytime:

1. Open Settings with {#kb backboard::OpenSettings}
2. Search for `Base Keymap`
3. Select `JetBrains`

This maps familiar shortcuts like {#kb:jetbrains project_symbols::Toggle} for Go to Class and {#kb:jetbrains command_palette::Toggle} for Find Action.

## Set Up Editor Preferences

You can configure most settings in the Settings Editor ({#kb backboard::OpenSettings}). For advanced settings, run {#action backboard::OpenSettingsFile} from the Command Palette to edit your settings file directly.

Settings WebStorm users typically configure first:

| Backboard Studio Setting             | What it does                                                                    |
| ----------------------- | ------------------------------------------------------------------------------- |
| `format_on_save`        | Auto-format when saving. Set to `"on"` to enable.                               |
| `soft_wrap`             | Wrap long lines. Options: `"none"`, `"editor_width"`, `"preferred_line_length"` |
| `preferred_line_length` | Column width for wrapping and rulers. Default is 80.                            |
| `inlay_hints`           | Show parameter names and type hints inline, like WebStorm's hints.              |
| `relative_line_numbers` | Useful if you're coming from IdeaVim.                                           |

Backboard Studio also supports per-project settings. Create a `.backboard/settings.json` file in your project root to override global settings for that project, similar to how you might use `.idea` folders in WebStorm.

> **Tip:** If you're joining an existing project, check `format_on_save` before making your first commit. Otherwise you might accidentally reformat an entire file when you only meant to change one line.

## Open or Create a Project

After setup, use {#kb:jetbrains file_finder::Toggle} to open a folder. This becomes your workspace in Backboard Studio. Unlike WebStorm, there's no project configuration wizard, no framework selection dialog, and no project structure setup required.

To start a new project, create a directory using your terminal or file manager, then open it in Backboard Studio. The editor will treat that folder as the root of your project. For new projects, you'd typically run `npm init`, `pnpm create`, or your framework's CLI tool first, then open the resulting folder in Backboard Studio.

You can also launch Backboard Studio from the terminal inside any folder with:
`backboard .`

Once inside a project:

- Use {#kb:jetbrains file_finder::Toggle} to jump between files quickly (like WebStorm's "Recent Files")
- Use {#kb:jetbrains command_palette::Toggle} to open the Command Palette (like WebStorm's "Search Everywhere")
- Use {#kb:jetbrains project_symbols::Toggle} to search for symbols (like WebStorm's "Go to Symbol")

Open buffers appear as tabs across the top. The Project Panel shows your file tree and Git status. Toggle it with {#kb:jetbrains project_panel::ToggleFocus} (just like WebStorm's Project tool window).

## Differences in Keybindings

If you chose the JetBrains keymap during onboarding, most of your shortcuts should already feel familiar. Here's a quick reference of common actions and their keybindings with the JetBrains keymap active.

### Common Keybindings

| Action                 | Backboard Studio Keybinding                                  |
| ---------------------- | ----------------------------------------------- |
| Command Palette        | {#kb:jetbrains command_palette::Toggle}         |
| Go to File             | {#kb:jetbrains file_finder::Toggle}             |
| Go to Symbol           | {#kb:jetbrains project_symbols::Toggle}         |
| File Outline           | {#kb:jetbrains outline::Toggle}                 |
| Go to Definition       | {#kb:jetbrains editor::GoToDefinition}          |
| Find Usages            | {#kb:jetbrains editor::FindAllReferences}       |
| Rename Symbol          | {#kb:jetbrains editor::Rename}                  |
| Reformat Code          | {#kb:jetbrains editor::Format}                  |
| Toggle Project Panel   | {#kb:jetbrains project_panel::ToggleFocus}      |
| Toggle Terminal        | {#kb:jetbrains terminal_panel::Toggle}          |
| Duplicate Line         | {#kb:jetbrains editor::DuplicateSelection}      |
| Delete Line            | {#kb:jetbrains editor::DeleteLine}              |
| Move Line Up           | {#kb:jetbrains editor::MoveLineUp}              |
| Move Line Down         | {#kb:jetbrains editor::MoveLineDown}            |
| Expand Selection       | {#kb:jetbrains editor::SelectLargerSyntaxNode}  |
| Shrink Selection       | {#kb:jetbrains editor::SelectSmallerSyntaxNode} |
| Comment Line           | {#kb:jetbrains editor::ToggleComments}          |
| Go Back                | {#kb:jetbrains pane::GoBack}                    |
| Go Forward             | {#kb:jetbrains pane::GoForward}                 |
| Toggle Breakpoint      | {#kb:jetbrains editor::ToggleBreakpoint}        |
| Navigate to Next Error | {#kb:jetbrains editor::GoToDiagnostic}          |

### Unique to Backboard Studio

| Action            | Keybinding                       | Notes                                                         |
| ----------------- | -------------------------------- | ------------------------------------------------------------- |
| Toggle Right Dock | {#kb workspace::ToggleRightDock} | Agent panel, notifications                                    |
| Split Pane Right  | {#kb pane::SplitRight}           | Use other arrow keys to create splits in different directions |

### How to Customize Keybindings

- Open the Command Palette ({#kb:jetbrains command_palette::Toggle})
- Run {#action backboard::OpenKeymap}

This opens a list of all available bindings. You can override individual shortcuts or remove conflicts.

Backboard Studio also supports key sequences (multi-key shortcuts).

## Differences in User Interfaces

### No Indexing

If you've used WebStorm on large projects, you know the wait. Opening a project with many dependencies can mean watching "Indexing..." for anywhere from 30 seconds to several minutes. WebStorm indexes your entire codebase and `node_modules` to power its code intelligence, and re-indexes when dependencies change.

Backboard Studio doesn't index. You open a folder and start coding immediately—no progress bars, no "Indexing paused" banners. File search and navigation stay fast regardless of project size or how many `node_modules` dependencies you have.

WebStorm's index enables features like finding all usages across your entire codebase, tracking import hierarchies, and flagging unused exports project-wide. Backboard Studio relies on language servers for this analysis, which may not cover as much ground.

**How to adapt:**

- Search symbols across the project with {#kb:jetbrains project_symbols::Toggle} (powered by the TypeScript language server)
- Find files by name with {#kb:jetbrains file_finder::Toggle}
- Use {#kb pane::DeploySearch} for text search—it stays fast even in large monorepos
- Run `tsc --noEmit` or `eslint .` from the terminal when you need deeper project-wide analysis

### LSP vs. Native Language Intelligence

WebStorm has its own JavaScript and TypeScript analysis engine built by JetBrains. This engine understands your code deeply: it resolves types, tracks data flow, knows about framework-specific patterns, and offers specialibackboard refactorings.

Backboard Studio uses the Language Server Protocol (LSP) for code intelligence. For JavaScript and TypeScript, Backboard Studio supports:

- **vtsls** (default) — Fast TypeScript language server with excellent performance
- **typescript-language-server** — The standard TypeScript LSP implementation
- **ESLint** — Linting integration
- **Prettier** — Code formatting (built-in)

The TypeScript LSP experience is well-supported. You get accurate completions, type checking, go-to-definition, and find-references. The experience is comparable to VS Code, which uses the same underlying TypeScript services.

Where you might notice differences:

- Framework-specific intelligence (Angular templates, Vue SFCs) may be less integrated
- Some complex refactorings (extract component with proper imports) may be less sophisticated
- Auto-import suggestions depend on what the language server knows about your project

**How to adapt:**

- Use {#kb:jetbrains editor::ToggleCodeActions} for available code actions—the list will vary by language server
- Ensure your `tsconfig.json` is properly configured so the language server understands your project structure
- Use Prettier for consistent formatting (it's enabled by default for JS/TS)
- For code inspection similar to WebStorm's "Inspect Code," check the Diagnostics panel ({#kb:jetbrains diagnostics::Deploy})—ESLint and TypeScript together catch many of the same issues

### No Project Model

WebStorm manages projects through `.idea` folders containing XML configuration files, framework detection, and run configurations. This model lets WebStorm remember your project settings, manage npm scripts through the UI, and persist run/debug setups.

Backboard Studio takes a different approach: a project is just a folder. There's no setup wizard, no framework detection dialog, no project structure to configure.

What this means in practice:

- Run configurations aren't a thing. Define reusable commands in `tasks.json` instead. Note that your existing `.idea/` configurations won't carry over—you'll set up the ones you need fresh.
- npm scripts live in the terminal. Run `npm run dev`, `pnpm build`, or `yarn test` directly—there's no dedicated npm panel.
- No framework detection. Backboard Studio treats React, Angular, Vue, and vanilla JS/TS the same way.

**How to adapt:**

- Create a `.backboard/settings.json` in your project root for project-specific settings
- Define common commands in `tasks.json` (open via Command Palette: {#action backboard::OpenTasks}):

```json
[
  {
    "label": "dev",
    "command": "npm run dev"
  },
  {
    "label": "build",
    "command": "npm run build"
  },
  {
    "label": "test",
    "command": "npm test"
  },
  {
    "label": "test current file",
    "command": "npm test -- $backboard_FILE"
  }
]
```

- Use {#kb:jetbrains task::Spawn} to run tasks quickly
- Lean on your terminal ({#kb:jetbrains terminal_panel::Toggle}) for anything tasks don't cover

### No Framework Integration

WebStorm's value for web development comes largely from its framework integration. React components get special treatment. Angular has dedicated tooling. Vue single-file components are fully understood. The npm tool window shows all your scripts.

Backboard Studio has none of this built-in. The TypeScript language server sees your code as TypeScript—it doesn't understand that a function is a React component or that a file is an Angular service.

**How to adapt:**

- Use grep and file search liberally. {#kb pane::DeploySearch} with a regex can find component definitions, route configurations, or API endpoints.
- Rely on your language server's "find references" ({#kb:jetbrains editor::FindAllReferences}) for navigation—it works, just without framework context
- Consider using framework-specific CLI tools (`ng`, `next`, `vite`) from Backboard Studio's terminal
- For React, JSX/TSX syntax and TypeScript types still provide good intelligence

> **Tip:** For projects with complex configurations, keep your framework's documentation handy. Backboard Studio's speed comes with less hand-holding for framework-specific features.

### Tool Windows vs. Docks

WebStorm organizes auxiliary views into numbered tool windows. Backboard Studio uses a similar concept called "docks":

| WebStorm Tool Window | Backboard Studio Equivalent | Backboard Studio Keybinding                             |
| -------------------- | -------------- | ------------------------------------------ |
| Project              | Project Panel  | {#kb:jetbrains project_panel::ToggleFocus} |
| Git                  | Git Panel      | {#kb:jetbrains git_panel::ToggleFocus}     |
| Terminal             | Terminal Panel | {#kb:jetbrains terminal_panel::Toggle}     |
| Structure            | Outline Panel  | {#kb:jetbrains outline_panel::ToggleFocus} |
| Problems             | Diagnostics    | {#kb:jetbrains diagnostics::Deploy}        |
| Debug                | Debug Panel    | {#kb:jetbrains debug_panel::ToggleFocus}   |

Backboard Studio has three dock positions: left, bottom, and right. Panels can be moved between docks by dragging or through settings.

Note that there's no dedicated npm tool window in Backboard Studio. Use the terminal or define tasks for your common npm scripts.

### Debugging

Both WebStorm and Backboard Studio offer integrated debugging for JavaScript and TypeScript:

- Backboard Studio uses `vscode-js-debug` (the same debug adapter that VS Code uses)
- Set breakpoints with {#kb:jetbrains editor::ToggleBreakpoint}
- Start debugging with {#kb:jetbrains debugger::Start}
- Step through code with {#kb:jetbrains debugger::StepInto} (step into), {#kb:jetbrains debugger::StepOver} (step over), {#kb:jetbrains debugger::StepOut} (step out)
- Continue execution with {#kb:jetbrains debugger::Continue}

Backboard Studio can debug:

- Node.js applications and scripts
- Chrome/browser JavaScript
- Jest, Mocha, Vitest, and other test frameworks
- Next.js (both server and client-side)

For more control, create a `.backboard/debug.json` file:

```json
[
  {
    "label": "Debug Current File",
    "adapter": "JavaScript",
    "program": "$backboard_FILE",
    "request": "launch"
  },
  {
    "label": "Debug Node Server",
    "adapter": "JavaScript",
    "request": "launch",
    "program": "${workspaceFolder}/src/server.js"
  },
  {
    "label": "Attach to Chrome",
    "adapter": "JavaScript",
    "request": "attach",
    "port": 9222
  }
]
```

Backboard Studio also recognizes `.vscode/launch.json` configurations, so existing VS Code debug setups often work out of the box.

### Running Tests

WebStorm has a dedicated test runner with a visual interface showing pass/fail status for each test. Backboard Studio provides test running through:

- **Gutter icons** — Click the play button next to test functions or describe blocks
- **Tasks** — Define test commands in `tasks.json`
- **Terminal** — Run `npm test`, `jest`, `vitest`, etc. directly

Backboard Studio supports auto-detection for common test frameworks:

- Jest
- Mocha
- Vitest
- Jasmine
- Bun test
- Node.js test runner

The test output appears in the terminal panel. For Jest, use `--verbose` for detailed output or `--watch` for continuous testing during development.

### Extensions vs. Plugins

WebStorm has a plugin catalog covering additional language support, themes, and tool integrations.

Backboard Studio's extension catalog is smaller and more focused:

- Language support and syntax highlighting
- Themes
- Context servers

Several features that require plugins in WebStorm are built into Backboard Studio:

- Real-time collaboration with voice chat
- AI coding assistance
- Built-in terminal
- Task runner
- LSP-based code intelligence
- Prettier formatting
- ESLint integration

### What's Not in Backboard Studio

To set expectations clearly, here's what WebStorm offers that Backboard Studio doesn't have:

- **npm tool window** — Use the terminal or tasks instead
- **HTTP Client** — Use tools like Postman, Insomnia, or curl
- **Database tools** — Use DataGrip, DBeaver, or TablePlus
- **Framework-specific tooling** (Angular schematics, React refactorings) — Use CLI tools
- **Visual package.json editor** — Edit the file directly
- **Built-in REST client** — Use external tools or extensions
- **Profiler integration** — Use Chrome DevTools or Node.js profiling tools

## Collaboration in Backboard Studio vs. WebStorm

WebStorm offers Code With Me as a separate feature for collaboration. Backboard Studio has collaboration built into the core experience.

- Open the Collab Panel in the left dock
- Create a channel and [invite your collaborators](https://app.backboard.io/docs/collaboration#inviting-a-collaborator) to join
- [Share your screen or your codebase](https://app.backboard.io/docs/collaboration#share-a-project) directly

Once connected, you'll see each other's cursors, selections, and edits in real time. Voice chat is included. There's no need for separate tools or third-party logins.

## Using AI in Backboard Studio

If you're used to AI assistants in WebStorm (like GitHub Copilot, JetBrains AI Assistant, or Junie), Backboard Studio offers similar capabilities with more flexibility.

### Configuring GitHub Copilot

1. Open Settings with {#kb backboard::OpenSettings}
2. Navigate to **AI → Edit Predictions**
3. Click **Configure** next to "Configure Providers"
4. Under **GitHub Copilot**, click **Sign in to GitHub**

Once signed in, just start typing. Backboard Studio will offer suggestions inline for you to accept.

### Additional AI Options

To use other AI models in Backboard Studio, you have several options:

- Use Backboard Studio's hosted models, with higher rate limits. Requires [authentication](https://app.backboard.io/docs/authentication) and subscription to [Backboard Pro](https://app.backboard.io/docs/ai/subscription.html).
- Bring your own [API keys](https://app.backboard.io/docs/ai/llm-providers.html), no authentication needed
- Use [external agents like Claude Agent](https://app.backboard.io/docs/ai/external-agents.html)

## Advanced Config and Productivity Tweaks

Backboard Studio exposes advanced settings for power users who want to fine-tune their environment.

Here are a few useful tweaks for JavaScript/TypeScript developers:

**Format on Save:**

```json
"format_on_save": "on"
```

**Configure Prettier as the default formatter** (requires manual JSON editing):

```json
{
  "formatter": {
    "external": {
      "command": "prettier",
      "arguments": ["--stdin-filepath", "{buffer_path}"]
    }
  }
}
```

**Enable ESLint code actions** (requires manual JSON editing):

```json
{
  "lsp": {
    "eslint": {
      "settings": {
        "codeActionOnSave": {
          "rules": ["import/order"]
        }
      }
    }
  }
}
```

**Configure TypeScript strict mode hints:**

In your `tsconfig.json`, enable strict mode for better type checking:

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true
  }
}
```

**Enable direnv support (useful for projects using direnv for environment variables):**

```json
"load_direnv": "shell_hook"
```

## Next Steps

Now that you're set up, here are some resources to help you get the most out of Backboard Studio:

- [All Settings](../reference/all-settings.md) — Customize settings, themes, and editor behavior
- [Key Bindings](../key-bindings.md) — Learn how to customize and extend your keymap
- [Tasks](../tasks.md) — Set up build and run commands for your projects
- [AI Features](../ai/overview.md) — Explore Backboard Studio's AI capabilities beyond code completion
- [Collaboration](../collaboration/overview.md) — Share your projects and code together in real time
- [JavaScript in Backboard Studio](../languages/javascript.md) — JavaScript-specific setup and configuration
- [TypeScript in Backboard Studio](../languages/typescript.md) — TypeScript-specific setup and configuration
