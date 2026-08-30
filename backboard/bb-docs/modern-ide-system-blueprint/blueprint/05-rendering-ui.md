# Rendering, UI, Layout, Theming, Animation, And GPU Strategy

## System -> UI Rendering

### Module Framework Selection

#### Architectural Decision

Use a retained-mode workbench model with framework-managed components for commands, panes, lists, and forms; use specialized virtualized renderers for editor text, terminal grid, tree views, notebooks, and diff views. The workbench owns layout state explicitly rather than deriving layout from incidental DOM state.

#### Rationale

- The editor requires deterministic viewport rendering and precise text metrics.
- Large trees and search results need virtualization independent of generic component diffing.
- Extensions need stable view APIs that do not expose internal component instances.
- Retained layout state makes restore, tests, and accessibility tree validation deterministic.

### Module Component Hierarchy

```text
WorkbenchRoot
|
|-- TitleBar
|-- ActivityBar
|-- SidebarPart
|   L-- ViewContainer
|       L-- ViewPane
|-- EditorPart
|   L-- EditorGroupView
|       L-- EditorPane
|           |-- CodeEditorWidget
|           |-- CustomEditorFrame
|           L-- WebviewFrame
|-- PanelPart
|-- AuxiliaryBarPart
|-- StatusBar
|-- QuickAccessOverlay
|-- ContextMenuLayer
L-- NotificationsLayer
```

### Module Layout Engine

#### Subsystem Grid And Constraints

```ts
export interface LayoutNode {
  id: string;
  type: 'leaf' | 'split';
  visible: boolean;
  minimumSize: number;
  maximumSize?: number;
  preferredSize?: number;
}

export interface SplitNode extends LayoutNode {
  type: 'split';
  orientation: 'horizontal' | 'vertical';
  children: LayoutNode[];
  ratios: number[];
}

export interface LayoutService {
  getRoot(): SplitNode;
  resize(nodeId: string, delta: number): void;
  setVisible(nodeId: string, visible: boolean): void;
  restore(state: SerializedLayoutState): void;
  serialize(): SerializedLayoutState;
}
```

#### Behavior

- Layout uses constraints first, then ratios, then saved preferred sizes.
- Hidden parts keep last known size for restore.
- Sash drag emits live layout events with throttled expensive child remeasure.
- Editor and terminal viewports remeasure font metrics only when font or zoom changes.

#### Edge Case

If window size is smaller than total minimums, priority order is editor, sidebars, panel, status bar. Low-priority areas collapse into overflow commands instead of overlapping content.

### Module Editor Rendering

#### Subsystem View Model

```ts
export interface EditorViewModel {
  visibleRange: LineRange;
  scrollTop: number;
  scrollLeft: number;
  lineHeight: number;
  glyphMarginWidth: number;
  contentWidth: number;
  getVisibleLines(): RenderLine[];
  applyDecorations(decorations: Decoration[]): void;
}

export interface RenderLine {
  lineNumber: number;
  text: string;
  tokens: TokenSpan[];
  inlineDecorations: InlineDecoration[];
  viewTop: number;
  viewHeight: number;
}
```

#### Behavior

- Only visible lines plus overscan render DOM nodes.
- Horizontal scrolling uses transform for content layers and fixed positioning for gutters.
- Decorations are layered: background, squiggle, inline, glyph margin, overview ruler, minimap.
- Minimap is a canvas renderer fed by token color summaries.

#### GPU Considerations

- Use GPU transforms for scroll layers, not for every line.
- Avoid promoting thousands of line elements to compositor layers.
- Canvas renderers batch minimap and overview updates by animation frame.

### Module Theming

```ts
export interface ThemeToken {
  id: string;
  value: string;
  description: string;
}

export interface ThemeService {
  readonly activeThemeId: string;
  getColor(tokenId: string): string;
  getTokenStyle(scope: string, modifiers: string[]): TokenStyle;
  setTheme(themeId: string): Promise<void>;
  onDidChangeTheme: Event<{ themeId: string }>;
}
```

#### Behavior

- Theme tokens compile to CSS custom properties at the workbench root.
- Token color rules compile into trie-based scope matchers.
- Extensions may contribute theme tokens with namespace prefixes.
- High-contrast mode has required tokens that cannot be undefined.

### Module Animation

#### Behavior

- Animations are disabled when reduced-motion is active.
- Layout-affecting animations are avoided for editor content and terminal grids.
- View open/close animations use opacity and transform only.
- Every animation has a hard maximum duration of 200 ms unless it represents progress.

