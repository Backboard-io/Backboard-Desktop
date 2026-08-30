# Welcome Onboarding Updates Extension Points

## Absolute Documentation Path

`/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/welcome-onboarding-updates/features/extension-points.md`

## Extension-Point Diagram

```text
package.json / contribution file
    |
    v
command, menu, view, provider, or service registration
    |
    v
activation and context-key gate
    |
    v
runtime implementation
    |
    v
visible feature behavior
```

## Declarative Extension Points

| Contribution type | Source file | Detail |
|---|---|---|
| Declarative contributions | Source scan | No package-level contribution block surfaced from the selected inventory scan. |

## Runtime Extension Points

- `IMenuService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/welcomeViews/common/newFile.contribution.ts`
- `ICommandService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/welcomeViews/common/newFile.contribution.ts`
- `IContextKeyService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/welcomeViews/common/newFile.contribution.ts`
- `IKeybindingService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/welcomeViews/common/newFile.contribution.ts`
- `IQuickInputService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/welcomeViews/common/newFile.contribution.ts`
- `IInstantiationService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/welcomeViews/common/viewsWelcome.contribution.ts`
- `IBannerService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/emergencyAlert/electron-browser/emergencyAlert.contribution.ts`
- `IRequestService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/emergencyAlert/electron-browser/emergencyAlert.contribution.ts`
- `IProductService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/emergencyAlert/electron-browser/emergencyAlert.contribution.ts`
- `ILogService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/emergencyAlert/electron-browser/emergencyAlert.contribution.ts`
- `IConfigurationService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/issue/browser/issue.contribution.ts`
- `IProductService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/issue/browser/issue.contribution.ts`
- `IIssueFormService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/issue/browser/issue.contribution.ts`
- `IWorkbenchIssueService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/issue/browser/issue.contribution.ts`
- `IScreenshotService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/issue/browser/issue.contribution.ts`
- `IRecordingService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/issue/browser/issue.contribution.ts`
- `IGitHubUploadService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/issue/browser/issue.contribution.ts`
- `IConfigurationService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/issue/electron-browser/issue.contribution.ts`
- `IProcessService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/issue/electron-browser/issue.contribution.ts`
- `IProductService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/issue/electron-browser/issue.contribution.ts`
- `IIssueFormService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/issue/electron-browser/issue.contribution.ts`
- `IWorkbenchIssueService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/issue/electron-browser/issue.contribution.ts`
- `IScreenshotService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/issue/electron-browser/issue.contribution.ts`
- `IRecordingService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/issue/electron-browser/issue.contribution.ts`
- `IGitHubUploadService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/issue/electron-browser/issue.contribution.ts`
- `IConfigurationService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/relauncher/browser/relauncher.contribution.ts`
- `IDialogService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/relauncher/browser/relauncher.contribution.ts`
- `IProductService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/relauncher/browser/relauncher.contribution.ts`
- `IUserDataSyncEnablementService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/relauncher/browser/relauncher.contribution.ts`
- `IUserDataSyncService` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/relauncher/browser/relauncher.contribution.ts`

## Command/Menu Extension Points

- `workbench.action.files.newUntitledFile` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/welcomeViews/common/newFile.contribution.ts`
- `workbench.action.openWalkthrough` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/welcomeGettingStarted/browser/gettingStarted.contribution.ts`
- `workbench.action.welcomeOnboarding2026` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/welcomeOnboarding/browser/welcomeOnboarding.contribution.ts`
- `workbench.action.resetBackboardOnboarding` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/welcomeOnboarding/browser/welcomeOnboarding.contribution.ts`
- `workbench.action.showInteractivePlayground` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/welcomeWalkthrough/browser/walkThrough.contribution.ts`
- `workbench.issue` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/issue/browser/issueService.ts`
- `workbench.action.interactivePlayground.arrowUp` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/welcomeWalkthrough/browser/walkThroughActions.ts`
- `workbench.action.interactivePlayground.arrowDown` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/welcomeWalkthrough/browser/walkThroughActions.ts`
- `workbench.action.interactivePlayground.pageUp` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/welcomeWalkthrough/browser/walkThroughActions.ts`
- `workbench.action.interactivePlayground.pageDown` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/welcomeWalkthrough/browser/walkThroughActions.ts`
- `workbench.action.openIssueReporter` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/issue/common/issue.contribution.ts`
- `workbench.action.troubleshootIssue.start` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/issue/browser/issueTroubleshoot.ts`
- `workbench.action.troubleshootIssue.stop` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/issue/browser/issueTroubleshoot.ts`
- `workbench.action.issueReporter.captureScreenshot` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/issue/electron-browser/issueReporterKeybindings.ts`
- `workbench.action.issueReporter.toggleRecording` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/issue/electron-browser/issueReporterKeybindings.ts`
- `workbench.actions.updateIndicator` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/update/browser/updateTitleBarEntry.ts`
- `workbench.welcomePage.preferReducedMotion` in `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/welcomeGettingStarted/browser/gettingStarted.ts`

## Extension Point Code Evidence

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
				when: IsSessionsWindowContext.negate()
			}
		});
	}
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

					viewContentMap.set(welcome, {
						content: welcome.contents,
						when: ContextKeyExpr.deserialize(welcome.when),
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
	private currentAlertActions: IEmergencyAlert['actions'] | undefined;

	constructor(
		@IBannerService private readonly bannerService: IBannerService,
```

