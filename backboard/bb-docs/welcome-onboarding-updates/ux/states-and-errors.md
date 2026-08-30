# Welcome Onboarding Updates States And Error Handling

## Absolute Documentation Path

`/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/welcome-onboarding-updates/ux/states-and-errors.md`

## State Machine

```text
[inactive]
    | contribution registered or extension activated
    v
[available]
    | command/menu/view invoked
    v
[working]
    | success        | cancel        | failure
    v              v               v
[ready]       [cancelled]      [error-recovery]
    |              |               |
    +--------------+---------------+--> [available]
```

## State And Failure Matrix

| Condition | User-facing requirement | Source evidence |
|---|---|---|
| Feature unavailable | Entry point is hidden, disabled, or replaced by guidance. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/welcomeViews/common/newFile.contribution.ts` |
| Async work pending | User sees progress, disabled affordance, or stable layout while work runs. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/welcomeViews/common/viewsWelcome.contribution.ts` |
| Context changes | Menus/actions recompute from context keys and service state. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/welcomeViews/common/viewsWelcomeContribution.ts` |
| Error returns | Error goes to notification, inline message, marker, log, or explicit recovery UI. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/emergencyAlert/electron-browser/emergencyAlert.contribution.ts` |
| Workspace closes | Disposables, listeners, and services release registrations cleanly. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/issue/browser/issue.contribution.ts` |

## Signals To Search

```sh
cd '/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode'
rg -n "CancellationToken|onDid|Disposable|MutableDisposable|notification|dialog|error|warn|logService|contextKey|when:" 'src/vs/workbench/contrib/emergencyAlert' 'src/vs/workbench/contrib/issue' 'src/vs/workbench/contrib/relauncher' 'src/vs/workbench/contrib/splash' 'src/vs/workbench/contrib/surveys' 'src/vs/workbench/contrib/update' 'src/vs/workbench/contrib/welcomeAgentSessions' 'src/vs/workbench/contrib/welcomeBanner' 'src/vs/workbench/contrib/welcomeGettingStarted' 'src/vs/workbench/contrib/welcomeOnboarding' 'src/vs/workbench/contrib/welcomeViews' 'src/vs/workbench/contrib/welcomeWalkthrough'
```

## State Code Anchors

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
				group: '1_new',
				order: 2,
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
						welcomesByViewId.set(id, viewContentMap);
					}
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

	private currentAlertMessage: string | undefined;
```

