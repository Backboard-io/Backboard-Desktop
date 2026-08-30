# Comments And Review Features

## Capabilities

- Editor anchored comments and comment threads.
- Thread navigation, resolution, and reply surfaces.
- Chat-assisted code review for staged, unstaged, and file-level changes.
- Review suggestion application, discard, feedback, and continuation flows.

## Boundaries

- GitHub/source-control data is documented under `source-control-git-github`.
- Chat participant/tool behavior is documented under `ai-chat-inline-assistance`.
- Diff review surfaces are documented under `diff-merge-history`.

## Key Source Areas

- `src/vs/workbench/contrib/comments`
- `src/vs/workbench/contrib/chat`
- `extensions/copilot/package.json`

<!-- BB-DEEP-DIVE:START -->
## Deep Implementation Notes

### What This Feature Owns

Comments, review threads, review action flows, and chat-assisted review commands.

### Source Ownership

- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/comments` (exists)

### Source-Level Architecture Sketch

```text
+--------------------+       +----------------------+       +--------------------+
| User action / API  | ----> | Workbench contribution| ----> | Service / provider |
| command/menu/view  |       | Action2, registry,    |       | file, model, auth, |
| or extension point |       | view/editor glue      |       | terminal, remote   |
+--------------------+       +----------------------+       +--------------------+
          ^                              |                              |
          |                              v                              v
          |                    +-------------------+          +-------------------+
          +------------------- | Context / config  | <------- | Events / storage  |
                               +-------------------+          +-------------------+
```

### Representative Code Excerpt

Path:

```text
/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/comments/browser/comments.contribution.ts
```

```ts
import * as nls from '../../../../nls.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import './commentsEditorContribution.js';
import { ICommentService, CommentService, IWorkspaceCommentThreadsEvent } from './commentService.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Disposable, IDisposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { Extensions, IWorkbenchContribution, IWorkbenchContributionsRegistry } from '../../../common/contributions.js';
import { IActivityService, NumberBadge } from '../../../services/activity/common/activity.js';
import { COMMENTS_VIEW_ID } from './commentsTreeViewer.js';
import { CommentThreadState } from '../../../../editor/common/languages.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CONTEXT_KEY_HAS_COMMENTS, CONTEXT_KEY_SOME_COMMENTS_EXPANDED, CommentsPanel } from './commentsView.js';
import { ViewAction } from '../../../browser/parts/views/viewPane.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
```

### How To Extend Safely

1. Start from the source ownership paths above.
2. Use `rg` to find command IDs, context keys, settings, and services before editing.
3. Keep user-facing labels localized through the local source pattern.
4. Register disposables immediately when adding listeners, watchers, providers, or widgets.
5. Add source-level docs here when adding a new command, endpoint, storage file, network URL, or UI surface.
6. Validate the broad surface, not just the changed file: command palette, menu placement, keyboard focus, empty state, error state, and logs.

### Targeted Grep Commands

```sh
rg -n "registerAction2|MenuId|ContextKey|I[A-Z].*Service|configuration|views|commands" src/vs/workbench/contrib/comments
rg -n "localize\(|localize2\(|aria-|title:|tooltip|hover" src/vs/workbench/contrib/comments
```
<!-- BB-DEEP-DIVE:END -->

<!-- BB-VERIFICATION-MATRIX:START -->
## Concrete Verification Matrix

Use this section as a no-shortcuts review grid for Comments Review / features.

| Check | Evidence to collect | Pass condition |
|---|---|---|
| Source owner | Full absolute path from the deep-dive source list | The path exists or the doc explicitly says why it is dynamic/provider-owned. |
| Command/menu wiring | `rg -n "registerAction2|MenuId|CommandsRegistry|contributes|commands" <source paths>` | Every user action has a concrete registration point. |
| Context gating | `rg -n "ContextKey|when:|precondition|activationEvents" <source paths>` | Hidden/conditional UI is explained by a context key, activation event, or capability. |
| User-facing text | `rg -n "localize\(|localize2\(|title:|aria-label|tooltip" <source paths>` | Labels are localized or intentionally extension-manifest owned; icon-only UI has accessible naming. |
| Failure path | `rg -n "showErrorMessage|showWarningMessage|logService|output|reject|throw new Error" <source paths>` | Failures have an observable message, log, output channel, or returned error. |
| State persistence | `rg -n "storage|StorageScope|setItem|getItem|workspaceState|globalState|configuration" <source paths>` | Persisted state has an owner and does not reuse another component's private key. |

ASCII review loop:

```text
Read source path
   |
   v
Find registration ---- no ----> doc missing endpoint detail
   |
  yes
   v
Find state owner ------ no ----> doc missing service/storage detail
   |
  yes
   v
Find user feedback ---- no ----> doc missing UX failure detail
   |
  yes
   v
Feature doc is operationally reviewable
```

Minimum expectation for future edits:

- Add the changed full path.
- Add the changed command, setting, provider, URI, or file endpoint.
- Add a literal code excerpt when the behavior changed.
- Add the before/after user impact.
- Add validation evidence, not just intent.
<!-- BB-VERIFICATION-MATRIX:END -->
