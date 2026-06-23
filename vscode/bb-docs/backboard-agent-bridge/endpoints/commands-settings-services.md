# Backboard Agent Bridge Commands, Settings, Services

## Absolute Documentation Path

`/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/backboard-agent-bridge/endpoints/commands-settings-services.md`

## Commands

- No direct entries surfaced from the selected inventory scan.

## Menu IDs

- No direct entries surfaced from the selected inventory scan.

## Configuration Keys

- `workbench.contrib.optimusEditorResolver` from `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/optimus/electron-browser/optimus.contribution.ts`
- `promptOpenWith.optimus.displayName` from `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/optimus/electron-browser/optimus.contribution.ts`
- `workbench.contrib.optimusEditorOpen` from `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/optimus/electron-browser/optimus.contribution.ts`
- `workbench.editor.optimus` from `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/optimus/electron-browser/optimusEditor.ts`
- `workbench.editor.optimus` from `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/optimus/electron-browser/optimusEditorInput.ts`
- `m2.5` from `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/media/icons/arrow_down10.svg`
- `m11.75` from `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/media/icons/code.svg`
- `m5.015` from `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/backboard/media/icons/eraser.svg`

## Workbench And Platform Services

- `IInstantiationService` from `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/optimus/electron-browser/optimus.contribution.ts`
- `IEditorResolverService` from `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/optimus/electron-browser/optimus.contribution.ts`
- `IEditorService` from `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/optimus/electron-browser/optimus.contribution.ts`
- `IStorageService` from `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/optimus/electron-browser/optimusEditor.ts`
- `ITelemetryService` from `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/optimus/electron-browser/optimusEditor.ts`
- `IThemeService` from `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/optimus/electron-browser/optimusEditor.ts`

## ASCII Endpoint Topology

```text
Backboard Agent Bridge
|
|-- Commands and actions
|   L-- command IDs above
|-- Menus and context keys
|   L-- MenuId entries above
|-- Settings
|   L-- configuration keys above
L-- Services
    L-- injected I*Service dependencies above
```

## Search Commands

```sh
cd '/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode'
rg -n "registerAction2|CommandsRegistry|MenuRegistry|MenuId\.|configuration|createDecorator|registerSingleton|I[A-Z][A-Za-z0-9]+Service" 'src/vs/workbench/contrib/optimus' 'extensions/backboard'
```

