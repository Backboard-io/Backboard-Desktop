# UI Code Excerpts

## Layout Service

```ts
export interface WorkbenchPart {
  id: string;
  minimumWidth: number;
  minimumHeight: number;
  maximumWidth?: number;
  maximumHeight?: number;
  create(parent: HTMLElement): void;
  layout(width: number, height: number): void;
  setVisible(visible: boolean): void;
  saveState(): unknown;
  restoreState(state: unknown): void;
}

export interface ViewRegistry {
  registerViewContainer(container: ViewContainerDescriptor): Disposable;
  registerView(view: ViewDescriptor): Disposable;
  getViews(containerId: string): ViewDescriptor[];
}
```

## Virtualized Surface

```ts
export interface VirtualizedList<T> {
  setItems(items: readonly T[]): void;
  setViewport(top: number, height: number): void;
  reveal(index: number, align: 'top' | 'center' | 'bottom' | 'nearest'): void;
  onDidChangeFocus: Event<{ index: number; item: T }>;
}
```

