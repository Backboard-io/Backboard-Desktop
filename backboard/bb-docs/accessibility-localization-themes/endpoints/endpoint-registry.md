# Accessibility Localization Themes Endpoint Registry

## Absolute Documentation Path

`/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/accessibility-localization-themes/endpoints/endpoint-registry.md`

## Endpoint Definition

In this codebase, an endpoint is any command ID, action ID, menu contribution, view contribution, extension activation hook, configuration key, service decorator, URL handler, provider registration, or IPC-facing boundary that can be invoked by UI, extension host, workbench service, or user action.

## Command And Action IDs

| Command/action id | Source file |
|---|---|
| `workbench.experimental.styleOverrides` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/styleOverrides/browser/styleOverrides.contribution.ts` |
| `workbench.action.tryNewDefaultThemes` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/themes/browser/themes.contribution.ts` |
| `workbench.action.previewColorTheme` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/themes/browser/themes.contribution.ts` |
| `workbench.action.generateColorTheme` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/themes/browser/themes.contribution.ts` |
| `workbench.action.toggleLockedScrolling` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/scrollLocking/browser/scrollLocking.ts` |
| `workbench.action.holdLockedScrolling` | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/scrollLocking/browser/scrollLocking.ts` |

## Declarative Extension Contributions

| Contribution type | Source file | Detail |
|---|---|---|
| Declarative contributions | Source scan | No package-level contribution block surfaced from the selected inventory scan. |

## Endpoint Flow

```text
UI gesture or extension activation
    |
    v
Command/action/menu/view contribution
    |
    v
Service, controller, provider, or extension host boundary
    |
    v
State update, editor update, terminal/process work, webview message, or filesystem/network operation
    |
    v
User-visible result, cancellation, notification, marker, log, or disabled affordance
```

## Endpoint Code Evidence

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/accessibility/browser/accessibility.contribution.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/accessibility/browser/accessibility.contribution.ts
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { DynamicSpeechAccessibilityConfiguration, registerAccessibilityConfiguration } from './accessibilityConfiguration.js';
import { IWorkbenchContributionsRegistry, WorkbenchPhase, Extensions as WorkbenchExtensions, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { UnfocusedViewDimmingContribution } from './unfocusedViewDimmingContribution.js';
import { AccessibilityStatus } from './accessibilityStatus.js';
import { EditorAccessibilityHelpContribution } from './editorAccessibilityHelp.js';
import { SaveAccessibilitySignalContribution } from '../../accessibilitySignals/browser/saveAccessibilitySignal.js';
import { DiffEditorActiveAnnouncementContribution } from '../../accessibilitySignals/browser/openDiffEditorAnnouncement.js';
import { SpeechAccessibilitySignalContribution } from '../../speech/browser/speechAccessibilitySignal.js';
import { AccessibleViewInformationService, IAccessibleViewInformationService } from '../../../services/accessibility/common/accessibleViewInformationService.js';
import { IAccessibleViewService } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewService } from './accessibleView.js';
import { AccesibleViewHelpContribution, AccesibleViewContributions } from './accessibleViewContributions.js';
import { ExtensionAccessibilityHelpDialogContribution } from './extensionAccesibilityHelp.contribution.js';

registerAccessibilityConfiguration();
registerSingleton(IAccessibleViewService, AccessibleViewService, InstantiationType.Delayed);
registerSingleton(IAccessibleViewInformationService, AccessibleViewInformationService, InstantiationType.Delayed);

const workbenchRegistry = Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench);
workbenchRegistry.registerWorkbenchContribution(EditorAccessibilityHelpContribution, LifecyclePhase.Eventually);
workbenchRegistry.registerWorkbenchContribution(UnfocusedViewDimmingContribution, LifecyclePhase.Restored);

workbenchRegistry.registerWorkbenchContribution(AccesibleViewHelpContribution, LifecyclePhase.Eventually);
workbenchRegistry.registerWorkbenchContribution(AccesibleViewContributions, LifecyclePhase.Eventually);

registerWorkbenchContribution2(AccessibilityStatus.ID, AccessibilityStatus, WorkbenchPhase.BlockRestore);
registerWorkbenchContribution2(ExtensionAccessibilityHelpDialogContribution.ID, ExtensionAccessibilityHelpDialogContribution, WorkbenchPhase.BlockRestore);
registerWorkbenchContribution2(SaveAccessibilitySignalContribution.ID, SaveAccessibilitySignalContribution, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(SpeechAccessibilitySignalContribution.ID, SpeechAccessibilitySignalContribution, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(DiffEditorActiveAnnouncementContribution.ID, DiffEditorActiveAnnouncementContribution, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(DynamicSpeechAccessibilityConfiguration.ID, DynamicSpeechAccessibilityConfiguration, WorkbenchPhase.AfterRestored);
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/accessibility/browser/accessibleViewContributions.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/accessibility/browser/accessibleViewContributions.ts
import { Disposable } from '../../../../base/common/lifecycle.js';
import { accessibleViewIsShown } from './accessibilityConfiguration.js';
import { AccessibilityHelpAction, AccessibleViewAction } from './accessibleViewActions.js';
import { AccessibleViewType, AccessibleContentProvider, ExtensionContentProvider, IAccessibleViewService } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';

export class AccesibleViewHelpContribution extends Disposable {
	static ID: 'accesibleViewHelpContribution';
	constructor() {
		super();
		this._register(AccessibilityHelpAction.addImplementation(115, 'accessible-view-help', accessor => {
			accessor.get(IAccessibleViewService).showAccessibleViewHelp();
			return true;
		}, accessibleViewIsShown));
	}
}

export class AccesibleViewContributions extends Disposable {
	static ID: 'accesibleViewContributions';
	constructor() {
		super();
		AccessibleViewRegistry.getImplementations().forEach(impl => {
			const implementation = (accessor: ServicesAccessor) => {
				const provider: AccessibleContentProvider | ExtensionContentProvider | undefined = impl.getProvider(accessor);
				if (!provider) {
					return false;
				}
				try {
					accessor.get(IAccessibleViewService).show(provider);
					return true;
				} catch {
					provider.dispose();
					return false;
				}
			};
			if (impl.type === AccessibleViewType.View) {
				this._register(AccessibleViewAction.addImplementation(impl.priority, impl.name, implementation, impl.when));
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/theme-abyss/package.json

```json
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/theme-abyss/package.json
  "license": "MIT",
  "engines": {
    "vscode": "*"
  },
  "categories": ["Themes"],
  "contributes": {
    "themes": [
      {
        "id": "Abyss",
        "label": "%themeLabel%",
        "uiTheme": "vs-dark",
        "path": "./themes/abyss-color-theme.json"
      }
    ]
  },
  "repository": {
    "type": "git",
    "url": "https://github.com/microsoft/vscode.git"
  }
}
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/accessibility/browser/extensionAccesibilityHelp.contribution.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/accessibility/browser/extensionAccesibilityHelp.contribution.ts
import { DisposableMap, IDisposable, DisposableStore, Disposable } from '../../../../base/common/lifecycle.js';
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { AccessibleViewType, ExtensionContentProvider } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { FocusedViewContext } from '../../../common/contextkeys.js';
import { IViewsRegistry, Extensions, IViewDescriptor } from '../../../common/views.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';

export class ExtensionAccessibilityHelpDialogContribution extends Disposable {
	static ID = 'extensionAccessibilityHelpDialogContribution';
	private _viewHelpDialogMap = this._register(new DisposableMap<string, IDisposable>());
	constructor(@IKeybindingService keybindingService: IKeybindingService) {
		super();
		this._register(Registry.as<IViewsRegistry>(Extensions.ViewsRegistry).onViewsRegistered(e => {
			for (const view of e) {
				for (const viewDescriptor of view.views) {
					if (viewDescriptor.accessibilityHelpContent) {
						this._viewHelpDialogMap.set(viewDescriptor.id, registerAccessibilityHelpAction(keybindingService, viewDescriptor));
					}
				}
			}
		}));
		this._register(Registry.as<IViewsRegistry>(Extensions.ViewsRegistry).onViewsDeregistered(e => {
			for (const viewDescriptor of e.views) {
				if (viewDescriptor.accessibilityHelpContent) {
					this._viewHelpDialogMap.get(viewDescriptor.id)?.dispose();
				}
			}
		}));
	}
}

function registerAccessibilityHelpAction(keybindingService: IKeybindingService, viewDescriptor: IViewDescriptor): IDisposable {
	const disposableStore = new DisposableStore();
	const content = viewDescriptor.accessibilityHelpContent?.value;
	if (!content) {
```

