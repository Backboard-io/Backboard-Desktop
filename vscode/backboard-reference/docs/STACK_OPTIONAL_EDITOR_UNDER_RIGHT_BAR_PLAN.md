# Stack Optional Editor Under Right Bar Plan

## Goal

Move the existing optional editor area so it sits **under the current right bar / auxiliary panel**, without rewriting the editor and without inventing a new compact auxiliary mode.

The intent is a clean stacked surface:

```text
Before

+----------------------+----------------------+------------------+
| Sessions / Chat      | Optional Editor      | Right Bar        |
|                      | File / Diff / Browser| Files/Changes/etc|
|                      |                      |                  |
+----------------------+----------------------+------------------+
```

```text
After

+----------------------+-----------------------------------------+
| Sessions / Chat      | Right Work Column                       |
|                      | +-------------------------------------+ |
|                      | | Existing Right Bar                  | |
|                      | | Files / Changes / Browser / etc.    | |
|                      | +-------------------------------------+ |
|                      | | Existing Optional Editor            | |
|                      | | File / Diff / Browser / Preview     | |
|                      | |                                     | |
|                      | +-------------------------------------+ |
+----------------------+-----------------------------------------+
```

The optional editor remains the existing `MainEditorPart`. We only change where it is placed in the sessions workbench grid.

## Non-Goals

Do not rewrite the optional editor.

Do not replace `MainEditorPart`.

Do not create a new compact auxiliary mode.

Do not reimplement Files, Changes, Browser, or editor rendering.

Do not change the editor open/close behavior unless layout sizing requires a small adjustment.

## Current Layout

The sessions workbench currently builds this shell in:

```text
src/vs/sessions/browser/workbench.ts
```

The relevant part is `createDesktopGridDescriptor()`.

Current conceptual shape:

```text
root vertical
├─ titlebar
└─ body vertical/horizontal mix
   ├─ sidebar
   └─ right section
      ├─ top right section
      │  ├─ sessionsNode
      │  ├─ editorNode
      │  └─ auxiliaryBarNode
      └─ panelNode
```

The important current line is conceptually:

```ts
data: [sessionsNode, editorNode, auxiliaryBarNode]
```

That produces:

```text
SessionsPart | EditorPart | AuxiliaryBar
```

## Target Layout

We want the editor and right bar to share one right-side column:

```text
root vertical
├─ titlebar
└─ body vertical/horizontal mix
   ├─ sidebar
   └─ right section
      ├─ top right section
      │  ├─ sessionsNode
      │  └─ rightWorkColumn
      │     ├─ auxiliaryBarNode
      │     └─ editorNode
      └─ panelNode
```

Visual:

```text
+----------+----------------------------------------------------+
| Sidebar  | Titlebar                                           |
+----------+----------------------+-----------------------------+
|          | SessionsPart         | RightWorkColumn             |
|          |                      | +-------------------------+ |
|          |                      | | AuxiliaryBar            | |
|          |                      | | current right bar       | |
|          |                      | +-------------------------+ |
|          |                      | | EditorPart              | |
|          |                      | | optional editor area    | |
|          |                      | +-------------------------+ |
+----------+----------------------+-----------------------------+
|          | Panel                                              |
+----------+----------------------------------------------------+
```

## Key Principle

Keep the existing responsibility split:

```text
Right Bar
  Owns navigation/control views:
  - Files
  - Changes
  - Browser launcher/list
  - other auxiliary-bar views

Optional Editor
  Owns opened content:
  - file editors
  - diff editors
  - multi-diff editors
  - browser editors
  - previews
```

Only the geometry changes.

## Existing Open Flow Stays The Same

Files, Changes, and Browser already open content through `IEditorService.openEditor(...)`.

Current behavior:

```text
Files / Changes / Browser
        |
        v
IEditorService.openEditor(...)
        |
        v
sessions workbench sees onWillOpenEditor
        |
        v
setEditorHidden(false)
        |
        v
EditorPart appears beside AuxiliaryBar
```

Target behavior:

```text
Files / Changes / Browser
        |
        v
IEditorService.openEditor(...)
        |
        v
sessions workbench sees onWillOpenEditor
        |
        v
setEditorHidden(false)
        |
        v
EditorPart appears below AuxiliaryBar
```

No Files/Changes/Browser rewrite is required for that.

## Files To Touch

Primary file:

```text
src/vs/sessions/browser/workbench.ts
```

Likely no changes:

```text
src/vs/sessions/browser/parts/editorPart.ts
src/vs/sessions/browser/parts/editorParts.ts
src/vs/sessions/contrib/files/browser/files.contribution.ts
src/vs/sessions/contrib/changes/browser/changes.contribution.ts
src/vs/sessions/contrib/browserView/browser/sessionBrowserView.contribution.ts
```

CSS only if the stacked layout reveals a spacing issue:

```text
src/vs/sessions/browser/parts/media/auxiliaryBarPart.css
src/vs/sessions/browser/parts/media/editorPart.css
```

## Implementation Plan

### 1. Update The Grid Descriptor

In `createDesktopGridDescriptor()`, replace the sibling layout:

```text
sessionsNode | editorNode | auxiliaryBarNode
```

with:

```text
sessionsNode | rightWorkColumn
```

where:

```text
rightWorkColumn
├─ auxiliaryBarNode
└─ editorNode
```

ASCII before:

```text
topRightSection
+----------------+----------------+----------------+
| sessionsNode   | editorNode     | auxiliaryNode  |
+----------------+----------------+----------------+
```

ASCII after:

```text
topRightSection
+----------------+---------------------------------+
| sessionsNode   | rightWorkColumn                 |
|                | +-----------------------------+ |
|                | | auxiliaryBarNode            | |
|                | +-----------------------------+ |
|                | | editorNode                  | |
|                | +-----------------------------+ |
+----------------+---------------------------------+
```

### 2. Preserve The Existing Editor Node

Keep this node as the same editor node:

```ts
const editorNode: ISerializedLeafNode = {
	type: 'leaf',
	data: { type: Parts.EDITOR_PART },
	size: editorSize,
	visible: this.partVisibility.editor
};
```

Do not replace it with a new part.

Do not create a separate preview/editor container.

### 3. Preserve The Existing Auxiliary Bar Node

Keep the current auxiliary bar part:

```ts
const auxiliaryBarNode: ISerializedLeafNode = {
	type: 'leaf',
	data: { type: Parts.AUXILIARYBAR_PART },
	size: auxiliaryBarSize,
	visible: this.partVisibility.auxiliaryBar
};
```

Only change its parent branch.

### 4. Add A Right Work Column Branch

Add one new branch in the grid descriptor:

```ts
const rightWorkColumn: ISerializedNode = {
	type: 'branch',
	data: [auxiliaryBarNode, editorNode],
	size: rightWorkColumnSize
};
```

The branch orientation must match the existing `SerializableGrid` convention used in the file.

Expected behavior:

```text
auxiliaryBarNode on top
editorNode below
```

### 5. Put Right Work Column Beside Sessions

Replace the top-right section data:

```ts
data: [sessionsNode, editorNode, auxiliaryBarNode]
```

with:

```ts
data: [sessionsNode, rightWorkColumn]
```

Expected result:

```text
SessionsPart | rightWorkColumn
```

### 6. Adjust Size Math Only As Needed

Current size math assumes auxiliary bar and editor are both widths:

```text
rightSectionWidth
  = sessionsWidth + editorWidth + auxiliaryBarWidth
```

Target size math should treat the stacked right column as one width:

```text
rightSectionWidth
  = sessionsWidth + rightWorkColumnWidth
```

Inside the right column:

```text
topRightHeight
  = auxiliaryBarHeight + editorHeight
```

Keep it simple:

```text
rightWorkColumnWidth = saved editor width or existing aux width fallback
auxiliaryBarHeight   = existing/saved auxiliary size if reasonable
editorHeight         = remaining height
```

Do not introduce special compact-mode behavior.

### 7. Update First Editor Reveal Sizing

Current first reveal splits width with sessions:

```ts
this._applyEditorSplitSize(mainAreaWidthBeforeReveal);
```

After stacking, the editor should not take half the main width. It should appear under the right bar.

Minimal adjustment:

```text
on first reveal:
  show editorNode
  keep rightWorkColumn width stable
  give editorNode useful height below auxiliaryBarNode
```

ASCII:

```text
Before editor opens

+----------------------+----------------------+
| SessionsPart         | AuxiliaryBar         |
|                      |                      |
|                      |                      |
+----------------------+----------------------+
```

```text
After editor opens

+----------------------+----------------------+
| SessionsPart         | AuxiliaryBar         |
|                      +----------------------+
|                      | EditorPart           |
|                      |                      |
+----------------------+----------------------+
```

### 8. Keep Existing Hide Behavior

Do not change this behavior:

```text
last main editor closes
        |
        v
areAllGroupsInMainPartEmpty()
        |
        v
setEditorHidden(true)
```

The only visual difference:

```text
Editor disappears from below right bar.
Right bar remains in place.
```

ASCII:

```text
Before close

+----------------------+----------------------+
| SessionsPart         | AuxiliaryBar         |
|                      +----------------------+
|                      | EditorPart           |
|                      | open file/diff/etc.  |
+----------------------+----------------------+
```

```text
After close

+----------------------+----------------------+
| SessionsPart         | AuxiliaryBar         |
|                      |                      |
|                      | no editor below      |
+----------------------+----------------------+
```

## Expected User Experience

### Opening A File

```text
Click file in Files
        |
        v
File opens below right bar
```

```text
+----------------------+----------------------+
| Chat/session         | Files                |
|                      +----------------------+
|                      | App.tsx              |
|                      | code editor          |
+----------------------+----------------------+
```

### Opening Changes

```text
Click changed file or View All Changes
        |
        v
Diff opens below right bar
```

```text
+----------------------+----------------------+
| Chat/session         | Changes              |
|                      +----------------------+
|                      | Session Changes      |
|                      | multi-diff editor    |
+----------------------+----------------------+
```

### Opening Browser

```text
Type port or URL in Browser
        |
        v
Browser editor opens below right bar
```

```text
+----------------------+----------------------+
| Chat/session         | Browser              |
|                      +----------------------+
|                      | localhost preview    |
|                      | browser editor       |
+----------------------+----------------------+
```

## Validation Checklist

Run:

```bash
npm run typecheck-client
```

Manual checks:

- Sessions grid still renders.
- Right bar still opens Files by default.
- Changes view still opens in right bar.
- Browser view still opens in right bar.
- Opening a file reveals editor below right bar.
- Opening a changed file reveals diff below right bar.
- Opening View All Changes reveals multi-diff below right bar.
- Opening Browser reveals browser editor below right bar.
- Closing all editors hides only the editor area.
- Right bar remains visible after editor closes.
- Resizing the stacked right column works.
- Saved/restored layout does not crash.
- Mobile layout still behaves acceptably or keeps its current behavior.

## Main Risk

The main risk is grid sizing, not editor behavior.

The editor itself already works. Files, Changes, and Browser already open editor inputs. The change is mostly about making the grid treat the auxiliary bar and editor as a vertical pair instead of horizontal siblings.

Keep the first pass limited to `workbench.ts`. Only add CSS if the existing parts need small spacing or border adjustments after the move.

