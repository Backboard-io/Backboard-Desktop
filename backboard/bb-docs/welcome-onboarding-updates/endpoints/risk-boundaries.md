# Welcome Onboarding Updates Endpoint Risk Boundaries

## Absolute Documentation Path

`/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/welcome-onboarding-updates/endpoints/risk-boundaries.md`

## Boundary Diagram

```text
trusted UI state
    |
    v
command/action/menu endpoint
    |
    v
service/controller/provider boundary
    |
    +--> workspace trust / profile / remote authority / extension host
    +--> filesystem / terminal / process / network / webview / authentication when present
    +--> notification / marker / log / telemetry when present
    |
    v
visible result
```

## Risk Table

| Boundary | Failure mode | Review action | Source anchor |
|---|---|---|---|
| Command visibility | Command appears in the wrong context or remains hidden when valid. | Inspect when clauses, context keys, and menu groups. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/welcomeViews/common/newFile.contribution.ts` |
| Service call | Service dependency is unavailable, delayed, or disposed. | Inspect constructor injection, lifecycle, and Disposable handling. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/welcomeViews/common/viewsWelcome.contribution.ts` |
| Async boundary | Cancellation, error, or concurrent invocation leaves UI in stale state. | Inspect CancellationToken, promises, event listeners, and finally blocks. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/welcomeViews/common/viewsWelcomeContribution.ts` |
| External boundary | Filesystem, network, extension host, browser view, terminal, or secret store returns failure. | Inspect validation, message routing, and recovery UI. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/emergencyAlert/electron-browser/emergencyAlert.contribution.ts` |

## Boundary Code Evidence

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/welcomeViews/common/newFile.contribution.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/welcomeViews/common/newFile.contribution.ts
import { KeyMod, KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { assertReturnsDefined } from '../../../../base/common/types.js';
import { localize, localize2 } from '../../../../nls.js';
import { ILocalizedString } from '../../../../platform/action/common/action.js';
import { Action2, IMenuService, MenuId, registerAction2, IMenu, MenuRegistry, MenuItemAction } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IsSessionsWindowContext } from '../../../common/contextkeys.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions as WorkbenchExtensions, IWorkbenchContributionsRegistry } from '../../../common/contributions.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';

const builtInSource = localize('Built-In', "Built-In");
const category: ILocalizedString = localize2('Create', 'Create');

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'welcome.showNewFileEntries',
			title: localize2('welcome.newFile', 'New File...'),
			category,
			f1: true,
			precondition: IsSessionsWindowContext.negate(),
			keybinding: {
				primary: KeyMod.Alt + KeyMod.CtrlCmd + KeyMod.WinCtrl + KeyCode.KeyN,
				weight: KeybindingWeight.WorkbenchContrib,
			},
			menu: {
				id: MenuId.MenubarFileMenu,
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/welcomeViews/common/viewsWelcome.contribution.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/welcomeViews/common/viewsWelcome.contribution.ts
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions as WorkbenchExtensions, IWorkbenchContributionsRegistry } from '../../../common/contributions.js';
import { ViewsWelcomeContribution } from './viewsWelcomeContribution.js';
import { ViewsWelcomeExtensionPoint, viewsWelcomeExtensionPointDescriptor } from './viewsWelcomeExtensionPoint.js';
import { ExtensionsRegistry } from '../../../services/extensions/common/extensionsRegistry.js';

const extensionPoint = ExtensionsRegistry.registerExtensionPoint<ViewsWelcomeExtensionPoint>(viewsWelcomeExtensionPointDescriptor);

class WorkbenchConfigurationContribution {
	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		instantiationService.createInstance(ViewsWelcomeContribution, extensionPoint);
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	.registerWorkbenchContribution(WorkbenchConfigurationContribution, LifecyclePhase.Restored);
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/welcomeViews/common/viewsWelcomeContribution.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/welcomeViews/common/viewsWelcomeContribution.ts
import { ViewsWelcomeExtensionPoint, ViewWelcome, ViewIdentifierMap } from './viewsWelcomeExtensionPoint.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions as ViewContainerExtensions, IViewContentDescriptor, IViewsRegistry } from '../../../common/views.js';
import { isProposedApiEnabled } from '../../../services/extensions/common/extensions.js';

const viewsRegistry = Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry);

export class ViewsWelcomeContribution extends Disposable implements IWorkbenchContribution {

	private viewWelcomeContents = new Map<ViewWelcome, IDisposable>();

	constructor(extensionPoint: IExtensionPoint<ViewsWelcomeExtensionPoint>) {
		super();

		extensionPoint.setHandler((_, { added, removed }) => {
			for (const contribution of removed) {
				for (const welcome of contribution.value) {
					const disposable = this.viewWelcomeContents.get(welcome);

					disposable?.dispose();
				}
			}

			const welcomesByViewId = new Map<string, Map<ViewWelcome, IViewContentDescriptor>>();

			for (const contribution of added) {
				for (const welcome of contribution.value) {
					const { group, order } = parseGroupAndOrder(welcome, contribution);
					const precondition = ContextKeyExpr.deserialize(welcome.enablement);

					const id = ViewIdentifierMap[welcome.view] ?? welcome.view;
					let viewContentMap = welcomesByViewId.get(id);
					if (!viewContentMap) {
						viewContentMap = new Map();
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/emergencyAlert/electron-browser/emergencyAlert.contribution.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/emergencyAlert/electron-browser/emergencyAlert.contribution.ts
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IBannerService } from '../../../services/banner/browser/bannerService.js';
import { asJson, IRequestService } from '../../../../platform/request/common/request.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { arch, platform } from '../../../../base/common/process.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { equals } from '../../../../base/common/arrays.js';
import { IntervalTimer } from '../../../../base/common/async.js';
import { mainWindow } from '../../../../base/browser/window.js';

interface IEmergencyAlert {
	readonly commit: string;
	readonly platform?: string;
	readonly arch?: string;
	readonly message: string;
	readonly actions?: ReadonlyArray<{
		readonly label: string;
		readonly href: string;
	}>;
}

interface IEmergencyAlerts {
	readonly alerts: IEmergencyAlert[];
}

const POLLING_INTERVAL = 60 * 60 * 1000; // 1 hour
const BANNER_ID = 'emergencyAlert.banner';

export class EmergencyAlert extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.emergencyAlert';
```

