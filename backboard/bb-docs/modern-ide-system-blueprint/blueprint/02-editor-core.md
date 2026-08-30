# Editor Core Specification

## System -> Editor Core

### Module Text Model

#### Subsystem Buffer Design

The editor stores text as a piece tree backed by immutable original buffers and append-only edit buffers. This supports large files, cheap undo snapshots, incremental line mapping, and low-copy edits.

```ts
export interface TextModel {
  readonly uri: Uri;
  readonly languageId: string;
  readonly versionId: number;
  readonly lineCount: number;
  getText(range?: Range): string;
  getLineContent(lineNumber: number): string;
  getOffsetAt(position: Position): number;
  getPositionAt(offset: number): Position;
  applyEdits(edits: EditOperation[], options: ApplyEditOptions): AppliedEditResult;
  createSnapshot(): TextSnapshot;
  onDidChangeContent: Event<TextContentChangedEvent>;
}

export interface Position { lineNumber: number; column: number; }
export interface Range { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number; }
export interface EditOperation { range: Range; text: string; forceMoveMarkers?: boolean; source?: string; }
export interface TextContentChangedEvent { versionId: number; changes: TextChange[]; eol: '\n' | '\r\n'; isUndoing: boolean; isRedoing: boolean; }
export interface TextChange { range: Range; rangeOffset: number; rangeLength: number; text: string; }
```

#### Behavior

- Offsets are UTF-16 offsets for UI compatibility; encoding conversion happens at file boundaries.
- Edits are normalized, sorted by start offset descending, and rejected if overlapping unless produced by the same multi-cursor transaction.
- Each edit transaction increments `versionId` once.
- The text model is UI-framework independent.

#### Edge Case

Files above the large-file threshold open in large-file mode. Large-file mode disables semantic tokens, minimap, code folding, and full document tokenization until the user explicitly opts in. The buffer still supports navigation, basic search, read-only inspection, and bounded edits when memory allows.

#### Implementation Notes

- Piece tree leaves store length, line feed count, first-line length, and last-line length.
- Maintain a balanced tree with rotations after edit bursts.
- Cache line starts in blocks of 1,024 lines to keep offset-position conversion below 1 ms for common operations.

#### Pseudo-Code Apply Edits

```ts
function applyEdits(model: MutablePieceTreeModel, edits: EditOperation[]): AppliedEditResult {
  const normalized = normalizeAndValidateEdits(model, edits);
  const inverse: EditOperation[] = [];
  model.transaction(() => {
    for (const edit of normalized.descendingByOffset()) {
      const deleted = model.getText(edit.range);
      inverse.push({ range: rangeAfterInsert(edit.range, edit.text), text: deleted });
      model.pieceTree.replace(edit.range, edit.text);
      model.markerTree.updateForEdit(edit.range, edit.text, edit.forceMoveMarkers === true);
    }
    model.versionId++;
    model.emitContentChanged(toChangeEvent(normalized));
  });
  return { inverseEdits: inverse.reverse(), versionId: model.versionId };
}
```

### Module Cursor And Selection

#### Subsystem Multi-Cursor Mechanics

```ts
export interface CursorState {
  selections: Selection[];
  primaryIndex: number;
  preferredColumns: Array<number | undefined>;
}

export interface Selection extends Range {
  selectionStartLineNumber: number;
  selectionStartColumn: number;
  positionLineNumber: number;
  positionColumn: number;
}

export interface CursorController {
  move(command: CursorMoveCommand, context: EditorInputContext): CursorState;
  type(text: string): EditOperation[];
  paste(text: string, mode: 'single' | 'spreadByLine'): EditOperation[];
  addCursor(position: Position): CursorState;
  normalizeSelections(selections: Selection[]): Selection[];
}
```

#### Behavior

- Cursors are stored as selections; collapsed selections are carets.
- Multi-cursor typing creates one edit operation per selection in one transaction.
- Overlapping selections are merged before mutation.
- Vertical cursor movement preserves preferred visual columns across wrapped lines and tabs.
- Word navigation uses language-specific word definitions registered by the language configuration service.

#### Edge Case

If a multi-cursor paste has N cursors and N lines, paste line i into cursor i. Otherwise paste the full text into every cursor. If the paste would exceed memory budget, ask the command service to confirm before mutation.

### Module Tokenization And Highlighting

#### Subsystem Pipeline

```text
Text edit
  -> content change event
  -> invalidate lexical token lines
  -> enqueue tokenizer worker range
  -> merge lexical tokens
  -> enqueue parser tree incremental update
  -> merge semantic tokens from language server when available
  -> resolve theme token colors
  -> emit viewport decoration changes
  -> render visible lines only
```

```ts
export interface TokenizationService {
  registerTokenizer(languageId: string, tokenizer: Tokenizer): Disposable;
  tokenizeViewport(model: TextModel, viewport: LineRange, token: CancellationToken): Promise<TokenLine[]>;
  invalidate(model: TextModel, changes: TextChange[]): void;
}

export interface TokenLine {
  lineNumber: number;
  tokens: TokenSpan[];
  endState: TokenizerState;
}

export interface TokenSpan {
  startColumn: number;
  endColumn: number;
  tokenType: string;
  modifiers: string[];
}
```

#### Behavior

- Lexical tokenization is incremental by line and tokenizer end state.
- Semantic tokenization is optional and merges over lexical tokens by specificity.
- Theme resolution is cached by token type plus modifier set plus theme id.
- Viewport tokenization has priority over background tokenization.

#### Edge Case

If a tokenizer fails for a language, mark that tokenizer disabled for the session, log structured error data, and fall back to plain text tokens. Never let tokenization crash the editor view.

### Module Undo Redo

#### Subsystem Stack Design

```ts
export interface UndoRedoService {
  pushElement(resource: Uri, element: UndoRedoElement): void;
  undo(resource: Uri, token: CancellationToken): Promise<void>;
  redo(resource: Uri, token: CancellationToken): Promise<void>;
  clear(resource: Uri): void;
}

export interface UndoRedoElement {
  label: string;
  beforeVersionId: number;
  afterVersionId: number;
  edits: EditOperation[];
  inverseEdits: EditOperation[];
  cursorBefore: CursorState;
  cursorAfter: CursorState;
  groupId?: string;
}
```

#### Behavior

- Typing groups merge until cursor movement, selection change, command boundary, focus loss, or timeout.
- Cross-file refactors push a workspace undo element with one child per resource.
- Undo restores text and cursor state.
- Redo reapplies original edits and cursor state.

#### Edge Case

If a resource changed externally after the undo element was recorded, the service attempts operational transform only when version ancestry is known. Otherwise it blocks undo and presents a conflict action with diff preview.

