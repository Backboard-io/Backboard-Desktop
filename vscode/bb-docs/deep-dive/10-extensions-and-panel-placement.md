# Extensions, View Containers & Panel Placement

> **Goal of this doc:** explain (1) how VS Code extensions and their UI surfaces work in
> this fork, (2) how the **Backboard / Copilot** surfaces are built, (3) the exact machinery
> that decides whether a panel lives on the **left**, **bottom**, or **right**, and (4) a
> concrete, ready-to-apply design for **pinning the Backboard chat panel to the right and
> pushing every other extension container to the left**.
>
> Every claim carries a `file:line` anchor, verified against branch `f-ide` (July 2026).

---

## 0. TL;DR

- A VS Code extension is a `package.json` manifest + JS entry point. UI is contributed
  declaratively through **`contributes.*`** keys; the workbench reads those and builds the UI.
- Panels are **view containers**. Every container lives in exactly one of three **locations**:
  `Sidebar` (left), `Panel` (bottom), or `AuxiliaryBar` (right). See
  [`ViewContainerLocation`](../../src/vs/workbench/common/views.ts) `views.ts:39`.
- An extension picks a container's *default* location by which key it nests under:
  `viewsContainers.activitybar` → **left**, `viewsContainers.panel` → **bottom**,
  `viewsContainers.secondarySidebar` → **right**. See `viewsExtensionPoint.ts:64-81, 317-324`.
- This fork ships **two** distinct "Backboard" chat surfaces:
  1. **The `backboard` *extension*** (`extensions/backboard/`) — a `webview` view container
     that today registers under **`activitybar`**, i.e. it defaults to the **left** side, in the
     normal **editor window**.
  2. **The Right Workbench** (`src/vs/sessions/contrib/rightWorkbench/`) — a *native core*
     container already pinned to the **right** (`AuxiliaryBar`), only in the **sessions window**.
- User-driven placement (drag a container between left/bottom/right) is persisted by
  `ViewDescriptorService` under the `views.customizations` storage key; the programmatic API is
  `moveViewContainerToLocation(container, location)` — `viewDescriptorService.ts:354`.
- **The actionable change** ("Backboard on the right, everything else on the left") applies to
  the **editor window** and the **backboard extension** container — see [§7](#7-implementation).

---

## 1. What a VS Code extension actually is

An extension is a folder under `extensions/` (built-in) or installed at runtime, containing:

| Part | Role |
|------|------|
| `package.json` | The **manifest**: identity, `activationEvents`, `main` entry, and the `contributes` block that declares all UI/behavior injected into the workbench. |
| `main` entry (JS) | Code run in the **extension host** process. Exports `activate(context)` / `deactivate()`. |
| `contributes.*` | Declarative extension points: `commands`, `menus`, `keybindings`, `viewsContainers`, `views`, `configuration`, `languages`, `themes`, … |

Extensions run **out of process** in the *extension host* and talk to the workbench through the
`vscode` API (`src/vs/workbench/api/`). They cannot touch workbench internals directly — everything
is mediated through **extension points** (the schema-validated `contributes` keys) and the API.

### The contribution model

Two halves meet in the middle:

1. **Declaration** — an extension lists a `contributes.viewsContainers` / `contributes.views` entry.
2. **Registration** — the workbench's *extension point handler* reads that entry at load time and
   calls the same core registries that built-in core features use.

For views, the handler is
[`ViewsExtensionHandler`](../../src/vs/workbench/api/browser/viewsExtensionPoint.ts). It parses the
manifest and forwards to the core `IViewContainersRegistry` / `IViewsRegistry`. That is the key
insight: **an extension-contributed container and a core-contributed container end up in the exact
same registry** — the only difference is *who* called `registerViewContainer` and *what default
location* they passed.

---

## 2. View containers, views, and the three locations

### 2.1 The location enum

[`src/vs/workbench/common/views.ts:39-51`](../../src/vs/workbench/common/views.ts):

```ts
export const enum ViewContainerLocation {
    Sidebar,        // 0 — primary side bar (LEFT), fronted by the activity bar
    Panel,          // 1 — bottom panel (Terminal, Problems, Output, …)
    AuxiliaryBar,   // 2 — secondary side bar (RIGHT)
}
```

- **Sidebar (left):** Explorer, Search, SCM, Run & Debug, Extensions, and most extension panels.
- **Panel (bottom):** Terminal, Problems, Output, Debug Console.
- **AuxiliaryBar (right):** the "secondary side bar". This is where the Backboard **Right Workbench**
  lives, and where we want the Backboard *extension* chat to live.

### 2.2 Container vs. view

- A **view container** (`IViewContainerDescriptor`, `views.ts:83+`) is the *host* — an icon in the
  activity bar / panel / aux bar that opens a pane composite.
- A **view** (`IViewDescriptor`, `views.ts:~300+`) is an individual pane *inside* a container. A
  container can hold many views (each collapsible), or a single view that is merged with the
  container chrome (`mergeViewWithContainerWhenSingleView`, used by the Right Workbench —
  `rightWorkbench.contribution.ts:28`).

### 2.3 The registries

[`IViewContainersRegistry`](../../src/vs/workbench/common/views.ts) `views.ts:149-203`:

| Method | Purpose |
|--------|---------|
| `registerViewContainer(descriptor, location, options?)` | Register a container at a **default** location (`views.ts:174`). |
| `getViewContainerLocation(container)` | Its registered default location (`views.ts:197`). |
| `getViewContainers(location)` / `getDefaultViewContainers(location)` | Enumerate (`views.ts:192, 202`). |

The concrete store is a `Map<ViewContainerLocation, ViewContainer[]>`
(`views.ts:224`, impl `ViewContainersRegistryImpl` at `views.ts:216-278`).

---

## 3. How placement is decided (and how it's overridden)

The registry above only knows the **default** location. The *effective, live* location — including
user drags and programmatic moves — is owned by
[`ViewDescriptorService`](../../src/vs/workbench/services/views/browser/viewDescriptorService.ts).

### 3.1 Effective location = custom override ?? default

`viewDescriptorService.ts:306-312`:

```ts
getViewContainerLocation(viewContainer): ViewContainerLocation {
    return this.viewContainersCustomLocations.get(viewContainer.id)   // user/programmatic override
        ?? this.getDefaultViewContainerLocation(viewContainer);       // registry default
}

getDefaultViewContainerLocation(viewContainer): ViewContainerLocation {
    return this.viewContainersRegistry.getViewContainerLocation(viewContainer);
}
```

So there are exactly two inputs to "where does this panel show":
1. The **default** the container was registered with (from the registry).
2. An optional **custom override** in `viewContainersCustomLocations`, hydrated from persisted
   `views.customizations` storage and mutated by moves.

### 3.2 The move API

`viewDescriptorService.ts:354-361`:

```ts
moveViewContainerToLocation(viewContainer, location, requestedIndex?, reason?): void {
    if (!this.canMoveViews()) { return; }                 // <-- see §3.4
    this.moveViewContainerToLocationWithoutSaving(viewContainer, location, requestedIndex);
    this.saveViewCustomizations();                        // persists to storage
}
```

`moveViewContainerToLocationWithoutSaving` (`:504+`) updates `viewContainersCustomLocations`, fires
`onDidChangeContainerLocation`, and moves the views. `saveViewCustomizations` (`:658+`) writes the
`views.customizations` JSON to **profile** storage (`StorageScope.PROFILE`, `StorageTarget.USER`),
shaped as:

```ts
interface IViewsCustomizations {
    viewContainerLocations: { [containerId: string]: ViewContainerLocation };
    viewLocations:          { [viewId: string]: string /* containerId */ };
    viewContainerBadgeEnablementStates: { [containerId: string]: boolean };
}
```

On startup / cross-window storage change, the service replays these overrides
(`onDidViewCustomizationsStorageChange`, `:581-648`), moving containers into their saved spots.

### 3.3 Extension containers get their default from the manifest key

[`viewsExtensionPoint.ts:64-81`](../../src/vs/workbench/api/browser/viewsExtensionPoint.ts) defines the
allowed manifest keys, and `:317-324` maps each to a location:

```ts
case 'activitybar':       // → ViewContainerLocation.Sidebar        (LEFT)
case 'panel':             // → ViewContainerLocation.Panel          (BOTTOM)
case 'secondarySidebar':  // → ViewContainerLocation.AuxiliaryBar   (RIGHT)
```

`registerCustomViewContainers` (`:378`) then calls `registerViewContainer(descriptor, location)`.
So an extension chooses its **default** side purely by which key it nests its container under.

### 3.4 Two hard gates: `WindowEnablement` and `canMoveViews`

This fork adds a **second workbench window** — the *Sessions / Agents window*
(`src/vs/sessions/`, see [02-simple-mode-agents.md](02-simple-mode-agents.md)). Two mechanisms
control what shows where, and both matter for our task:

**(a) `WindowEnablement`** — [`views.ts:64-77`](../../src/vs/workbench/common/views.ts):

```ts
export const enum WindowEnablement {
    Editor   = 1,  // only the editor window
    Sessions = 2,  // only the agent/sessions window
    Both     = 3,
}
```

`viewDescriptorService.ts:338-343` gates every container/view by the current window:

```ts
private isEnabled(enablement): boolean {
    if (this.isSessionsWindow) {
        return enablement === WindowEnablement.Sessions || enablement === WindowEnablement.Both;
    }
    return !enablement || enablement === WindowEnablement.Editor || enablement === WindowEnablement.Both;
}
```

Consequences:
- **Extension** containers carry **no** `windowEnablement` (the manifest handler doesn't set one) →
  `!enablement` is true → they appear **only in the editor window**, never in the sessions window.
- The **Right Workbench** is `WindowEnablement.Sessions` (`rightWorkbench.contribution.ts:31,41`) →
  it appears **only in the sessions window**.

**(b) `canMoveViews`** — `viewDescriptorService.ts:350-352`:

```ts
canMoveViews(): boolean { return !this.isSessionsWindow; }
```

In the **sessions window**, `moveViewContainerToLocation` is a **no-op** (`:355` early-returns), and
container drag is disabled. Layout there is instead driven imperatively by the
[`LayoutController`](../../src/vs/sessions/contrib/layout/browser/sessionLayoutController.ts) and
[`SessionsLayoutPolicy`](../../src/vs/sessions/browser/layoutPolicy.ts).

> **Why this matters for the request:** "Backboard on the right, everything else on the left" is
> only a *meaningful, actionable* statement in the **editor window**. In the sessions window the
> Right Workbench is already pinned right, extension containers don't appear at all, and moves are
> blocked. See [§6](#6-reconciling-the-request) and [§7](#7-implementation).

---

## 4. The Backboard / Copilot surfaces

There are two independent chat surfaces. Do not conflate them.

### 4.1 Surface A — the `backboard` **extension** (editor window)

Folder: [`extensions/backboard/`](../../extensions/backboard/). Manifest
[`package.json`](../../extensions/backboard/package.json):

- **Entry:** `main: ./out/extension` → `src/extension.ts` (thin re-export) →
  `src/backboardExtension.ts` (the real `activate`, ~4200 lines). It wires a bridge/CLI subprocess,
  a `BackboardPanelProvider` webview, OAuth, config-file watching, and ~11 commands.
- **Activation:** `onStartupFinished`, `onCommand:backboard.*`, `onUri`
  (`package.json:21-32`).
- **Container** (`package.json:106-113`):

  ```jsonc
  "viewsContainers": {
    "activitybar": [                 // ← defaults to Sidebar (LEFT)
      { "id": "backboard", "title": "​", "icon": "media/blank.svg" }
    ]
  }
  ```

- **View** (`package.json:115-122`):

  ```jsonc
  "views": {
    "backboard": [
      { "id": "backboard.panel", "type": "webview", "name": "​" }
    ]
  }
  ```

So today the Backboard chat webview is a **left-side activity-bar** container with an intentionally
blank icon/title. **This is the container we retarget to the right.**

### 4.2 Surface B — the **Right Workbench** (sessions window)

Folder: [`src/vs/sessions/contrib/rightWorkbench/`](../../src/vs/sessions/contrib/rightWorkbench/).
This is *core* code (not an extension) and is documented in depth in
[08-right-workbench-tabs.md](08-right-workbench-tabs.md). Registration
(`rightWorkbench.contribution.ts:23-42`):

```ts
const rightWorkbenchContainer = viewContainerRegistry.registerViewContainer({
    id: SESSIONS_RIGHT_WORKBENCH_CONTAINER_ID,       // 'workbench.sessions.auxiliaryBar.rightWorkbenchContainer'
    title: localize2('rightWorkbench', "Right Workbench"),
    icon: rightWorkbenchIcon,
    order: 10,
    ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [..., { mergeViewWithContainerWhenSingleView: true }]),
    hideIfEmpty: false,
    windowEnablement: WindowEnablement.Sessions,      // ← sessions window only
}, ViewContainerLocation.AuxiliaryBar, { isDefault: true });  // ← pinned RIGHT
```

- Single view `SESSIONS_RIGHT_WORKBENCH_LAUNCHER_VIEW_ID` → `RightWorkbenchViewPane`, with
  `canToggleVisibility: false`, `canMoveView: false` (`:39-40`).
- The pane draws its own **multi-tab shell** (Review / Terminal / Browser / Files / Launcher) as
  *internal DOM state* — those tabs are **not** separate VS Code views
  (`rightWorkbench.ts:21-23`, tab model in `rightWorkbenchViewPane.ts`).
- It is already, permanently, on the right, and the sessions-window `LayoutController`
  (`sessionLayoutController.ts:351-375`) keeps it opened/visible per session.

### 4.3 What's left of "Copilot"

Per [07-copilot-remnants.md](07-copilot-remnants.md): the right panel imports **nothing** from a
Copilot extension. Surviving `github.copilot.*` strings are late-bound command IDs, setting keys,
and the `copilot-pr` URI scheme (`base/common/network.ts`). "Copilot" in the request is just the
familiar name for "the AI chat panel" — for us that means **Surface A** (the extension) in the
editor window and **Surface B** (Right Workbench) in the sessions window.

---

## 5. Where each thing renders — summary matrix

| Surface / container | Default location | Window(s) it shows in | Movable by user? |
|---|---|---|---|
| `backboard` extension (`backboard.panel` webview) | **Sidebar / left** (`activitybar`) | Editor only (no `windowEnablement`) | Yes (editor window) |
| Explorer / Search / SCM / Run&Debug / Extensions | Sidebar / left | Editor | Yes |
| Other 3rd-party extension containers | left / bottom / right per manifest key | Editor | Yes |
| Terminal / Problems / Output | Panel / bottom | Editor | Yes |
| **Right Workbench** | **AuxiliaryBar / right** | **Sessions only** | **No** (`canMoveViews` false) |
| Sessions list / Changes / Files (sessions core) | per contribution, `WindowEnablement.Sessions` | Sessions only | No |

---

## 6. Reconciling the request

> *"Backboard right panel sticks on the right; all extensions move to the left (except the
> Backboard right panel)."*

- **Sessions window:** already satisfied and immutable. Right Workbench is pinned right; extension
  containers are filtered out entirely by `WindowEnablement`; moves are blocked by `canMoveViews`.
  **Nothing to do**, and nothing *can* be done without weakening those gates.
- **Editor window:** this is where the request bites. Today the Backboard **extension** chat sits on
  the **left** activity bar next to Explorer/Search/etc. To honor the request we must:
  1. Move the `backboard` container to **`AuxiliaryBar`** (right) and keep it there.
  2. Ensure every **other** container defaults/stays in the **Sidebar** (left) — i.e. evict any
     non-Backboard container that would otherwise land in the auxiliary bar.

Two ways to achieve #1's default:

- **Static (preferred, one line):** change the manifest key from `activitybar` to
  `secondarySidebar` so the container's *registered default* is `AuxiliaryBar`
  (`viewsExtensionPoint.ts:74-75,322`). No runtime code, survives fresh profiles.
- **Programmatic (enforced):** a small workbench contribution that calls
  `moveViewContainerToLocation` on startup and re-asserts on `onDidRegister` /
  `onDidChangeContainerLocation`, so the layout is *locked* even against user drags.

Use **both** if you want a right-by-default panel that the user also cannot accidentally drag away.

---

## 7. Implementation

### 7.1 Step 1 — make Backboard default to the right (manifest, static)

In [`extensions/backboard/package.json`](../../extensions/backboard/package.json) `:106-113`, move
the container declaration from `activitybar` to `secondarySidebar`:

```jsonc
"viewsContainers": {
  "secondarySidebar": [
    { "id": "backboard", "title": "​", "icon": "media/blank.svg" }
  ]
}
```

The nested `views."backboard"` block (`:115-122`) is unchanged — views bind to the container by id,
not by location. After this, a **fresh profile** opens the Backboard chat on the right.

> This alone does *not* relocate the container for existing users who already have a persisted
> `views.customizations` override, and it does *not* stop the user (or another extension) from
> putting something else in the aux bar. For a hard guarantee, add Step 2.

### 7.2 Step 2 — lock the layout (workbench contribution, enforced)

Add a small **editor-window-only** contribution that (a) forces `backboard` into the aux bar and
(b) evicts every *other* container out of the aux bar into the sidebar. It no-ops in the sessions
window automatically because `moveViewContainerToLocation` early-returns there
(`viewDescriptorService.ts:355`).

Create `src/vs/workbench/contrib/backboardLayout/browser/backboardLayout.contribution.ts`:

```ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { ViewContainer, ViewContainerLocation } from '../../../common/views.js';

/** The container id contributed by extensions/backboard/package.json. */
const BACKBOARD_CONTAINER_ID = 'workbench.view.extension.backboard';

/**
 * Editor-window layout policy: pin the Backboard chat container to the right
 * (auxiliary bar) and keep every other container out of it (pushed to the left
 * side bar). No-ops in the sessions window, where container moves are disabled.
 */
class BackboardLayoutContribution extends Disposable implements IWorkbenchContribution {

    static readonly ID = 'workbench.contrib.backboardLayout';

    constructor(
        @IViewDescriptorService private readonly viewDescriptorService: IViewDescriptorService,
    ) {
        super();

        this.enforce();

        // Re-assert whenever containers are (de)registered or moved.
        this._register(this.viewDescriptorService.onDidChangeViewContainers(() => this.enforce()));
        this._register(this.viewDescriptorService.onDidChangeContainerLocation(() => this.enforce()));
    }

    private enforce(): void {
        const backboard = this.viewDescriptorService.getViewContainerById(BACKBOARD_CONTAINER_ID);

        // 1. Pin Backboard to the right.
        if (backboard && this.viewDescriptorService.getViewContainerLocation(backboard) !== ViewContainerLocation.AuxiliaryBar) {
            this.viewDescriptorService.moveViewContainerToLocation(backboard, ViewContainerLocation.AuxiliaryBar, undefined, BackboardLayoutContribution.ID);
        }

        // 2. Evict everything else out of the right into the left side bar.
        for (const container of this.viewDescriptorService.getViewContainersByLocation(ViewContainerLocation.AuxiliaryBar)) {
            if (container.id !== BACKBOARD_CONTAINER_ID) {
                this.viewDescriptorService.moveViewContainerToLocation(container, ViewContainerLocation.Sidebar, undefined, BackboardLayoutContribution.ID);
            }
        }
    }
}

registerWorkbenchContribution2(BackboardLayoutContribution.ID, BackboardLayoutContribution, WorkbenchPhase.AfterRestored);
```

Then register the file so it loads with the editor workbench — add an import to
`src/vs/workbench/workbench.common.main.ts` (the shared contributions barrel), next to the other
`contrib/*/browser/*.contribution` imports:

```ts
import './contrib/backboardLayout/browser/backboardLayout.contribution.js';
```

> **Verify the container id.** Extension activity-bar containers are registered with a
> `workbench.view.extension.<id>` prefix by the extension-point handler. Confirm the exact id at
> runtime with the **Developer: Toggle Developer Tools** console:
> `viewDescriptorService.getViewContainers(...)`, or grep the generated id — if the prefix differs
> in this fork, update `BACKBOARD_CONTAINER_ID` accordingly. `getViewContainerById` returning
> `undefined` (extension not yet activated) is handled: the `onDidChangeViewContainers` listener
> re-runs `enforce()` once the container registers.

### 7.3 Notes, trade-offs, edge cases

- **Idempotent & self-healing.** `enforce()` only moves when a container is in the wrong place, so
  the event listeners can't loop. If the user drags Backboard back to the left, it snaps right on
  the next event — that is the "stick" behavior requested. If that feels too aggressive, drop the
  `onDidChangeContainerLocation` listener and keep only startup + registration enforcement, which
  gives "right by default, but user may override".
- **"Extensions to the left" scope.** The contribution treats *left* as the primary Side Bar. It
  deliberately leaves the **bottom Panel** (Terminal/Problems/Output) alone — moving those to the
  left side bar is almost certainly not intended. If you *do* want panel containers on the left
  too, extend the eviction loop to also iterate `getViewContainersByLocation(ViewContainerLocation.Panel)`.
- **Sessions window is untouched.** All moves no-op there (`canMoveViews` false), so the sessions
  Right Workbench and its layout policy are unaffected.
- **Existing users.** Step 2's programmatic enforcement overrides any stale persisted
  `views.customizations`, so it fixes existing profiles too — Step 1 alone would not.
- **Validation.** After changes: `npm run typecheck-client` for the `src/` contribution and
  `npm run gulp compile-extensions` for the `extensions/backboard` manifest change (per
  `.claude/CLAUDE.md`). There are no new user-facing strings to localize.

---

## 8. Key file index

| Concern | File | Anchor |
|---|---|---|
| Location enum | `src/vs/workbench/common/views.ts` | `:39-51` |
| `WindowEnablement` | `src/vs/workbench/common/views.ts` | `:64-77` |
| Container registry | `src/vs/workbench/common/views.ts` | `:149-278` |
| Effective location resolution | `src/vs/workbench/services/views/browser/viewDescriptorService.ts` | `:306-312` |
| Move API | …`viewDescriptorService.ts` | `:354-361` |
| Persist / replay customizations | …`viewDescriptorService.ts` | `:581-648, 658-690` |
| Window gate / move gate | …`viewDescriptorService.ts` | `:338-343, 350-352` |
| Extension → location mapping | `src/vs/workbench/api/browser/viewsExtensionPoint.ts` | `:64-81, 317-324, 378` |
| Backboard extension manifest | `extensions/backboard/package.json` | `:106-122` |
| Backboard extension entry | `extensions/backboard/src/backboardExtension.ts` | `activate` |
| Right Workbench registration | `src/vs/sessions/contrib/rightWorkbench/browser/rightWorkbench.contribution.ts` | `:23-42` |
| Right Workbench pane | `src/vs/sessions/contrib/rightWorkbench/browser/rightWorkbenchViewPane.ts` | class `RightWorkbenchViewPane` |
| Sessions layout controller | `src/vs/sessions/contrib/layout/browser/sessionLayoutController.ts` | `:351-375` |
| Sessions layout policy | `src/vs/sessions/browser/layoutPolicy.ts` | `:117-158` |
