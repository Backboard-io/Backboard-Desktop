# Browser Screenshot To Chat Flow

## Absolute Documentation Path

`/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/backboard-changes/diagrams/browser-screenshot-to-chat-flow.md`

## Flow Diagram

```text
Sessions titlebar action
    |
    v
workbench.action.sessions.addBrowserAreaScreenshotToChat
    |
    v
SessionBrowserViewContribution opens or reveals BrowserEditorInput
    |
    v
BrowserViewCommandId.AddAreaScreenshotToChat
    |
    v
Browser editor screenshot selection
    |
    v
Selected browser area becomes chat context
```

## Source Files

- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/contrib/browserView/browser/sessionBrowserView.contribution.ts`
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/browserView/electron-browser/features/browserEditorChatFeatures.ts`

## Code Evidence

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/contrib/browserView/browser/sessionBrowserView.contribution.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/contrib/browserView/browser/sessionBrowserView.contribution.ts
import { Codicon } from '../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { BrowserViewCommandId } from '../../../../platform/browserView/common/browserView.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { ViewPaneContainer } from '../../../../workbench/browser/parts/views/viewPaneContainer.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IsAuxiliaryWindowContext } from '../../../../workbench/common/contextkeys.js';
import { Extensions as ViewContainerExtensions, IViewContainersRegistry, IViewsRegistry, ViewContainerLocation, WindowEnablement } from '../../../../workbench/common/views.js';
import { BrowserEditorInput } from '../../../../workbench/contrib/browserView/common/browserEditorInput.js';
import { IBrowserViewWorkbenchService } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { Menus } from '../../../browser/menus.js';
import { IsPhoneLayoutContext, SessionsWelcomeVisibleContext } from '../../../common/contextkeys.js';
import { SESSIONS_BROWSER_VIEW_CONTAINER_ID, SESSIONS_BROWSER_VIEW_ID, SessionsBrowserViewPane } from './sessionBrowserPanel.js';
import { SessionBrowserViewController } from './sessionBrowserView.js';

const browserViewIcon = registerIcon('sessions-browser-view-icon', Codicon.globe, localize2('sessionsBrowserViewIcon', 'View icon of the browser view in the sessions window.').value);
const BrowserEditorOpenContext = ContextKeyExpr.has('browserEditorOpen');

const viewContainerRegistry = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry);

const browserViewContainer = viewContainerRegistry.registerViewContainer({
	id: SESSIONS_BROWSER_VIEW_CONTAINER_ID,
	title: localize2('browser', "Browser"),
	icon: browserViewIcon,
	order: 12,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [SESSIONS_BROWSER_VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: SESSIONS_BROWSER_VIEW_CONTAINER_ID,
	hideIfEmpty: false,
	openCommandActionDescriptor: {
		id: SESSIONS_BROWSER_VIEW_CONTAINER_ID,
		title: localize2('browser', "Browser"),
		mnemonicTitle: localize({ key: 'miBrowser', comment: ['&& denotes a mnemonic'] }, "Bro&&wser"),
		order: 2
	},
	windowEnablement: WindowEnablement.Sessions,
}, ViewContainerLocation.AuxiliaryBar);

const viewsRegistry = Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry);

viewsRegistry.registerViews([{
	id: SESSIONS_BROWSER_VIEW_ID,
	name: localize2('browser', "Browser"),
	containerIcon: browserViewIcon,
	ctorDescriptor: new SyncDescriptor(SessionsBrowserViewPane),
	canToggleVisibility: false,
	canMoveView: false,
	when: ContextKeyExpr.and(IsPhoneLayoutContext.negate()),
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/browserView/electron-browser/features/browserEditorChatFeatures.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/browserView/electron-browser/features/browserEditorChatFeatures.ts
import { localize, localize2 } from '../../../../../nls.js';
import { $ } from '../../../../../base/browser/dom.js';
import { Event } from '../../../../../base/common/event.js';
import { IContextKey, IContextKeyService, ContextKeyExpr, RawContextKey } from '../../../../../platform/contextkey/common/contextkey.js';
import { Action2, registerAction2, MenuId, MenuRegistry } from '../../../../../platform/actions/common/actions.js';
import { ServicesAccessor, IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { KeyMod, KeyCode } from '../../../../../base/common/keyCodes.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IWorkspaceTrustManagementService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { URI } from '../../../../../base/common/uri.js';
import { IChatWidget, IChatWidgetService } from '../../../chat/browser/chat.js';
import { IChatService } from '../../../chat/common/chatService/chatService.js';
import { IChatRequestVariableEntry } from '../../../chat/common/attachments/chatVariableEntries.js';
import { ChatContextKeys } from '../../../chat/common/actions/chatContextKeys.js';
import { IElementData, IElementAncestor, BrowserViewCommandId } from '../../../../../platform/browserView/common/browserView.js';
import { IBrowserViewModel, BrowserViewSharingState } from '../../../browserView/common/browserView.js';
import { BrowserEditorInput } from '../../common/browserEditorInput.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { WorkbenchHoverDelegate } from '../../../../../platform/hover/browser/hover.js';
import { HoverPosition } from '../../../../../base/browser/ui/hover/hoverWidget.js';
import { BrowserEditor, BrowserEditorContribution, BrowserWidgetLocation, IBrowserEditorWidget, BrowserActionCategory, CONTEXT_BROWSER_HAS_ERROR, CONTEXT_BROWSER_HAS_URL, BrowserActionGroup } from '../browserEditor.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { PolicyCategory } from '../../../../../base/common/policy.js';
import product from '../../../../../platform/product/common/product.js';
import { AgentHostEnabledSettingId } from '../../../../../platform/agentHost/common/agentService.js';
import { workbenchConfigurationNodeBase } from '../../../../common/configuration.js';
import { safeSetInnerHtml } from '../../../../../base/browser/domSanitize.js';
import { AgentHostChatToolsEnabledSettingId } from '../browserViewWorkbenchService.js';

// Register tools
import '../tools/browserTools.contribution.js';

/**
 * Format an array of element ancestors into a CSS-selector-like path string.
 */
function formatElementPath(ancestors: readonly IElementAncestor[] | undefined): string | undefined {
	if (!ancestors || ancestors.length === 0) {
		return undefined;
	}

	return ancestors
		.map(ancestor => {
			const classes = ancestor.classNames?.length ? `.${ancestor.classNames.join('.')}` : '';
			const id = ancestor.id ? `#${ancestor.id}` : '';
```

