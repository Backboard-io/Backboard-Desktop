---
title: Tasks - Run Commands in Backboard Studio
description: Run and rerun shell commands from Backboard Studio with task definitions. Supports variables, templates, and language-specific tasks.
---

# Tasks

Backboard Studio supports ways to spawn (and rerun) commands using its integrated [terminal](./terminal.md) to output the results. These commands can read a limited subset of Backboard Studio state (such as a path to the file currently being edited or selected text).

```json [tasks]
[
  {
    "label": "Example task",
    "command": "for i in {1..5}; do echo \"Hello $i/5\"; sleep 1; done",
    //"args": [],
    // Env overrides for the command, will be appended to the terminal's environment from the settings.
    "env": { "foo": "bar" },
    // Current working directory to spawn the command into, defaults to current project root.
    //"cwd": "/path/to/working/directory",
    // Whether to use a new terminal tab or reuse the existing one to spawn the process, defaults to `false`.
    "use_new_terminal": false,
    // Whether to allow multiple instances of the same task to be run, or rather wait for the existing ones to finish, defaults to `false`.
    "allow_concurrent_runs": false,
    // What to do with the terminal pane and tab, after the command was started:
    // * `always` — always show the task's pane, and focus the corresponding tab in it (default)
    // * `no_focus` — always show the task's pane, add the task's tab in it, but don't focus it
    // * `never` — do not alter focus, but still add/reuse the task's tab in its pane
    "reveal": "always",
    // What to do with the terminal pane and tab, after the command has finished:
    // * `never` — Do nothing when the command finishes (default)
    // * `always` — always hide the terminal tab, hide the pane also if it was the last tab in it
    // * `on_success` — hide the terminal tab on task success only, otherwise behaves similar to `always`
    "hide": "never",
    // Which shell to use when running a task inside the terminal.
    // May take 3 values:
    // 1. (default) Use the system's default terminal configuration in /etc/passwd
    //      "shell": "system"
    // 2. A program:
    //      "shell": {
    //        "program": "sh"
    //      }
    // 3. A program with arguments:
    //     "shell": {
    //         "with_arguments": {
    //           "program": "/bin/bash",
    //           "args": ["--login"]
    //         }
    //     }
    "shell": "system",
    // Whether to show the task line in the output of the spawned task, defaults to `true`.
    "show_summary": true,
    // Whether to show the command line in the output of the spawned task, defaults to `true`.
    "show_command": true,
    // Which edited buffers to save before running the task:
    // * `all` — save all edited buffers
    // * `current` — save currently active buffer only
    // * `none` — don't save any buffers
    "save": "none"
    // Represents the tags for inline runnable indicators, or spawning multiple tasks at once.
    // "tags": []
  }
]
```

There are two actions that drive the workflow of using tasks: {#action task::Spawn} and {#action task::Rerun}.
{#action task::Spawn} opens a modal with all available tasks in the current file.
{#action task::Rerun} reruns the most recently spawned task. You can also rerun tasks from the task modal.

By default, rerunning tasks reuses the same terminal (due to the `"use_new_terminal": false` default) but waits for the previous task to finish before starting (due to the `"allow_concurrent_runs": false` default).

Keep `"use_new_terminal": false` and set `"allow_concurrent_runs": true` to allow cancelling previous tasks on rerun.

## Task templates

Tasks can be defined:

- in the global `tasks.json` file; such tasks are available in all Backboard Studio projects you work on. This file is usually located in `~/.config/backboard/tasks.json`. You can edit them by using the {#action backboard::OpenTasks} action.
- in the worktree-specific (local) `.backboard/tasks.json` file; such tasks are available only when working on a project with that worktree included. You can edit worktree-specific tasks by using the {#action backboard::OpenProjectTasks} action.
- on the fly with [oneshot tasks](#oneshot-tasks). These tasks are project-specific and do not persist across sessions.
- by language extension.

## Variables

Backboard Studio tasks act just like your shell; that also means that you can reference environmental variables via sh-esque `$VAR_NAME` syntax. A couple of additional environmental variables are set for your convenience.
These variables allow you to pull information from the current editor and use it in your tasks. The following variables are available:

- `backboard_COLUMN`: current line column
- `backboard_ROW`: current line row
- `backboard_FILE`: absolute path of the currently opened file (e.g. `/Users/my-user/path/to/project/src/main.rs`)
- `backboard_FILENAME`: filename of the currently opened file (e.g. `main.rs`)
- `backboard_DIRNAME`: absolute path of the currently opened file with file name stripped (e.g. `/Users/my-user/path/to/project/src`)
- `backboard_RELATIVE_FILE`: path of the currently opened file, relative to `backboard_WORKTREE_ROOT` (e.g. `src/main.rs`)
- `backboard_RELATIVE_DIR`: path of the currently opened file's directory, relative to `backboard_WORKTREE_ROOT` (e.g. `src`)
- `backboard_STEM`: stem (filename without extension) of the currently opened file (e.g. `main`)
- `backboard_SYMBOL`: currently selected symbol; should match the last symbol shown in a symbol breadcrumb (e.g. `mod tests > fn test_task_contexts`)
- `backboard_SELECTED_TEXT`: currently selected text
- `backboard_LANGUAGE`: language of the currently opened buffer (e.g. `Rust`, `Python`, `Shell Script`)
- `backboard_WORKTREE_ROOT`: absolute path to the root of the current worktree. (e.g. `/Users/my-user/path/to/project`)
- `backboard_MAIN_GIT_WORKTREE`: absolute path to the main git worktree's working directory. For normal checkouts this equals `backboard_WORKTREE_ROOT`; for linked git worktrees this is the original repository's working directory.
- `backboard_CUSTOM_RUST_PACKAGE`: (Rust-specific) name of the parent package of $backboard_FILE source file.

To use a variable in a task, prefix it with a dollar sign (`$`):

```json [tasks]
{
  "label": "echo current file's path",
  "command": "echo $backboard_FILE"
}
```

You can also use verbose syntax that allows specifying a default if a given variable is not available: `${backboard_FILE:default_value}`

These environmental variables can also be used in tasks' `cwd`, `args`, and `label` fields.

### Variable Quoting

When working with paths containing spaces or other special characters, please ensure variables are properly escaped.

For example, instead of this (which will fail if the path has a space):

```json [tasks]
{
  "label": "stat current file",
  "command": "stat $backboard_FILE"
}
```

Provide the following:

```json [tasks]
{
  "label": "stat current file",
  "command": "stat",
  "args": ["$backboard_FILE"]
}
```

Or explicitly include escaped quotes like so:

```json [tasks]
{
  "label": "stat current file",
  "command": "stat \"$backboard_FILE\""
}
```

### Task filtering based on variables

Task definitions with variables which are not present at the moment the task list is determined are filtered out.
For example, the following task will appear in the spawn modal only if there is a text selection:

```json [tasks]
{
  "label": "selected text",
  "command": "echo \"$backboard_SELECTED_TEXT\""
}
```

Set default values to such variables to have such tasks always displayed:

```json [tasks]
{
  "label": "selected text with default",
  "command": "echo \"${backboard_SELECTED_TEXT:no text selected}\""
}
```

## Oneshot tasks

The same task modal opened via {#action task::Spawn} supports arbitrary bash-like command execution: type a command inside the modal text field, and use `opt-enter` to spawn it.

The task modal persists these ad-hoc commands for the duration of the session, {#action task::Rerun} will also rerun such tasks if they were the last ones spawned.

You can also adjust the currently selected task in a modal (`tab` is the default key binding). Doing so will put its command into a prompt that can then be edited & spawned as a oneshot task.

### Ephemeral tasks

You can use the `cmd` modifier when spawning a task via a modal; tasks spawned this way will not have their usage count increased (thus, they will not be respawned with {#action task::Rerun} and they won't have a high rank in the task modal).
The intended use of ephemeral tasks is to stay in the flow with continuous {#action task::Rerun} usage.

### More task rerun control

By default, tasks capture their variables into a context once, and this "resolved task" is being rerun always.

This can be controlled with the `"reevaluate_context"` argument to the task: setting it to `true` will force the task to be reevaluated before each run.

```json [keymap]
{
  "context": "Workspace",
  "bindings": {
    "alt-t": ["task::Rerun", { "reevaluate_context": true }]
  }
}
```

## Custom keybindings for tasks

You can define your own keybindings for your tasks via an additional argument to `task::Spawn`. If you wanted to bind the aforementioned `echo current file's path` task to `alt-g`, you would add the following snippet in your [`keymap.json`](./key-bindings.md) file:

```json [keymap]
{
  "context": "Workspace",
  "bindings": {
    "alt-g": ["task::Spawn", { "task_name": "echo current file's path" }]
  }
}
```

Note that these tasks can also have a 'target' specified to control where the spawned task should show up.
This could be useful for launching a terminal application that you want to use in the center area:

```json [tasks]
// In tasks.json
{
  "label": "start lazygit",
  "command": "lazygit -p $backboard_WORKTREE_ROOT"
}
```

```json [keymap]
// In keymap.json
{
  "context": "Workspace",
  "bindings": {
    "alt-g": [
      "task::Spawn",
      { "task_name": "start lazygit", "reveal_target": "dock" }
    ]
  }
}
```

## Hooks

In addition to being spawned manually, tasks can be configured to run automatically in response to certain Backboard Studio events by adding a hook to the `hooks` field on a task template. A task with a matching hook will be resolved and spawned when that event fires.

The following hooks are currently supported:

- `create_worktree` — runs after Backboard Studio creates a new linked Git worktree, either directly through the CLI or from the [worktree picker](./git.md#git-worktrees). The task is spawned with `backboard_WORKTREE_ROOT` pointing at the newly created worktree and `backboard_MAIN_GIT_WORKTREE` pointing at the original repository's working directory, which makes these hooks well-suited to copying untracked files (such as `.env` files) or running per-worktree setup commands.

Hook tasks are resolved from the same global and worktree-local `tasks.json` files as manually spawned tasks, and multiple tasks may register for the same hook; they all run when the hook fires. A hook task still benefits from the usual task configuration fields — `cwd`, `env`, `reveal`, `hide`, and so on — so you can control how much of the terminal UI is shown while it runs.

```json [tasks]
[
  {
    "label": "copy .env into new worktree",
    "command": "cp",
    "args": ["$backboard_MAIN_GIT_WORKTREE/.env", "$backboard_WORKTREE_ROOT/.env"],
    "hooks": ["create_worktree"],
    "reveal": "no_focus",
    "hide": "on_success"
  }
]
```

Tasks that define `hooks` are still available from the task modal like any other task, so the same template can be reused for manual runs.

## VS Code Task Format

When importing VS Code tasks from `.vscode/tasks.json`, you can omit the `label` field. Backboard Studio automatically generates labels based on the task type:

- **npm tasks**: `npm: <script>` (e.g., `npm: start`)
- **gulp tasks**: `gulp: <task>` (e.g., `gulp: build`)
- **shell tasks**: Uses the `command` string directly (e.g., `echo hello`), or `shell` if the command is empty
- **Tasks without type**: `Untitled Task`

Example task file with auto-generated labels:

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "type": "npm",
      "script": "start"
    },
    {
      "type": "shell",
      "command": "cargo build --release"
    }
  ]
}
```

These tasks appear in the task picker as "npm: start" and "cargo build --release". You can override the generated label by providing an explicit `label` field.

## Binding runnable tags to task templates

Backboard Studio supports overriding the default action for inline runnable indicators via workspace-local and global `tasks.json` file with the following precedence hierarchy:

1. Workspace `tasks.json`
2. Global `tasks.json`
3. Language-provided tag bindings (default).

To tag a task, add the runnable tag name to the `tags` field on the task template:

```json [tasks]
{
  "label": "echo current file's path",
  "command": "echo $backboard_FILE",
  "tags": ["rust-test"]
}
```

In doing so, you can change which task is shown in the runnables indicator.

## Keybindings to run tasks bound to runnables

When you have a task definition that is bound to the runnable, you can quickly run it using [Code Actions](https://app.backboard.io/docs/configuring-languages?#code-actions) that you can trigger either via {#action editor::ToggleCodeActions} command or by the `cmd-.`/`ctrl-.` shortcut. Your task will be the first in the dropdown. The task will run immediately if there are no additional Code Actions for this line.

## Running Bash Scripts

You can run bash scripts directly from Backboard Studio. When you open a `.sh` or `.bash` file, Backboard Studio automatically detects the script as runnable and makes it available in the task picker.

To run a bash script:

1. Open the command palette with {#kb command_palette::Toggle}
2. Search for "task" and select **task: spawn**
3. Select the script from the list

Bash scripts are tagged with `bash-script`, allowing you to filter or reference them in task configurations.

If you need to pass arguments or customize the execution environment, add a task configuration in your `.backboard/tasks.json`:

```json
[
  {
    "label": "run my-script.sh with args",
    "command": "./my-script.sh",
    "args": ["--verbose", "--output=results.txt"],
    "tags": ["bash-script"]
  }
]
```

## Shell Initialization

When Backboard Studio runs a task, it launches the command in a login shell. This ensures your shell's initialization files (`.bash_profile`, `.zshrc`, etc.) are sourced before the task executes.

This behavior gives tasks access to the same environment variables, aliases, and PATH modifications you've configured in your shell profile. If a task fails to find a command that works in your terminal, verify your shell configuration files are properly set up.

To override the shell used for tasks, configure the `terminal.shell` setting:

```json
{
  "terminal": {
    "shell": {
      "program": "/bin/zsh"
    }
  }
}
```

See [Terminal configuration](./terminal.md) for complete shell options.
