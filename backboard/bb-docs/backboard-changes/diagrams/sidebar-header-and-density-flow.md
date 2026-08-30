# Sidebar Header And Density Flow

## Flow Diagram

```text
SidebarPart.create(parent)
    |
    v
super.create(parent)
    |
    v
create .sidebar-activity-navigation-header
    |
    v
setHeaderArea(navigation)
    |
    v
compact action buttons render above title content

Agents Window auxiliary sizing
    |
    +--> minimum width lowered
    +--> restored width floor lowered
    L--> proportional width takes less editor space
```

## Source Files

- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/browser/parts/sidebar/sidebarPart.ts`
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/browser/parts/sidebar/media/sidebarpart.css`
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/browser/parts/auxiliaryBarPart.ts`
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/browser/workbench.ts`
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/browser/media/style.css`

## Code Evidence

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/browser/parts/sidebar/sidebarPart.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/browser/parts/sidebar/sidebarPart.ts
import './media/sidebarpart.css';
import './sidebarActions.js';
import { $, addDisposableListener, append, EventType } from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ActivityBarPosition, IWorkbenchLayoutService, LayoutSettings, Parts, Position as SideBarPosition } from '../../../services/layout/browser/layoutService.js';
import { SidebarFocusContext, ActiveViewletContext } from '../../../common/contextkeys.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { contrastBorder } from '../../../../platform/theme/common/colorRegistry.js';
import { SIDE_BAR_TITLE_FOREGROUND, SIDE_BAR_TITLE_BORDER, SIDE_BAR_BACKGROUND, SIDE_BAR_FOREGROUND, SIDE_BAR_BORDER, SIDE_BAR_DRAG_AND_DROP_BACKGROUND, ACTIVITY_BAR_BADGE_BACKGROUND, ACTIVITY_BAR_BADGE_FOREGROUND, ACTIVITY_BAR_TOP_FOREGROUND, ACTIVITY_BAR_TOP_ACTIVE_BORDER, ACTIVITY_BAR_TOP_INACTIVE_FOREGROUND, ACTIVITY_BAR_TOP_DRAG_AND_DROP_BORDER } from '../../../common/theme.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { AnchorAlignment } from '../../../../base/browser/ui/contextview/contextview.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { LayoutPriority } from '../../../../base/browser/ui/grid/grid.js';
import { assertReturnsDefined } from '../../../../base/common/types.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../../common/views.js';
import { AbstractPaneCompositePart, CompositeBarPosition } from '../paneCompositePart.js';
import { ActivityBarCompositeBar, ActivitybarPart } from '../activitybar/activitybarPart.js';
import { ActionsOrientation } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { HoverPosition } from '../../../../base/browser/ui/hover/hoverWidget.js';
import { IPaneCompositeBarOptions } from '../paneCompositeBar.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Action2, IMenuService, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Separator } from '../../../../base/common/actions.js';
import { ToggleActivityBarVisibilityActionId } from '../../actions/layoutActions.js';
import { localize, localize2 } from '../../../../nls.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { VisibleViewContainersTracker } from '../visibleViewContainersTracker.js';
import { Extensions } from '../../panecomposite.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';

export class SidebarPart extends AbstractPaneCompositePart {

	static readonly activeViewletSettingsKey = 'workbench.sidebar.activeviewletid';

	//#region IView

	readonly minimumWidth: number = 170;
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/browser/parts/sidebar/media/sidebarpart.css

```css
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/browser/parts/sidebar/media/sidebarpart.css
.monaco-workbench.nosidebar > .part.sidebar {
	display: none !important;
	visibility: hidden !important;
}

.monaco-workbench .part.sidebar .title-actions .actions-container {
	justify-content: flex-end;
}

.monaco-workbench .part.sidebar .title-actions .action-item {
	margin-right: 4px;
}

.monaco-workbench .part.sidebar > .title {
	background-color: var(--vscode-sideBarTitle-background);
}

.monaco-workbench .part.sidebar > .sidebar-activity-navigation-header {
	display: flex;
	align-items: center;
	justify-content: center;
	height: 100%;
	padding: 0;
	gap: 2px;
	box-sizing: border-box;
	background-color: var(--vscode-sideBarTitle-background);
}

.monaco-workbench .part.sidebar.pane-composite-part > .sidebar-activity-navigation-header.header {
	border-bottom: none !important;
}

.monaco-workbench .part.sidebar > .title {
	border-top: none !important;
	border-bottom: none !important;
}

.monaco-workbench .part.sidebar > .sidebar-activity-navigation-header > .sidebar-activity-navigation-button {
	all: unset;
	box-sizing: border-box;
	display: inline-flex;
	align-items: center;
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/browser/parts/auxiliaryBarPart.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/browser/parts/auxiliaryBarPart.ts
import '../../../workbench/browser/parts/auxiliarybar/media/auxiliaryBarPart.css';
import './media/auxiliaryBarPart.css';
import { localize } from '../../../nls.js';
import { IContextKeyService } from '../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../platform/keybinding/common/keybinding.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { ActiveAuxiliaryContext, AuxiliaryBarFocusContext } from '../../../workbench/common/contextkeys.js';
import { ACTIVITY_BAR_TOP_ACTIVE_BORDER, ACTIVITY_BAR_TOP_DRAG_AND_DROP_BORDER, ACTIVITY_BAR_TOP_FOREGROUND, ACTIVITY_BAR_TOP_INACTIVE_FOREGROUND, PANEL_ACTIVE_TITLE_BORDER, PANEL_ACTIVE_TITLE_FOREGROUND, PANEL_DRAG_AND_DROP_BORDER, PANEL_INACTIVE_TITLE_FOREGROUND, SIDE_BAR_TITLE_BORDER } from '../../../workbench/common/theme.js';
import { agentsPanelBackground, agentsPanelBorder, agentsPanelForeground, agentsBadgeBackground, agentsBadgeForeground } from '../../common/theme.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../../workbench/common/views.js';
import { IExtensionService } from '../../../workbench/services/extensions/common/extensions.js';
import { IWorkbenchLayoutService, Parts } from '../../../workbench/services/layout/browser/layoutService.js';
import { HoverPosition } from '../../../base/browser/ui/hover/hoverWidget.js';
import { IAction } from '../../../base/common/actions.js';
import { assertReturnsDefined } from '../../../base/common/types.js';
import { LayoutPriority } from '../../../base/browser/ui/splitview/splitview.js';
import { AbstractPaneCompositePart, CompositeBarPosition } from '../../../workbench/browser/parts/paneCompositePart.js';
import { Part } from '../../../workbench/browser/part.js';
import { ActionsOrientation, IActionViewItem } from '../../../base/browser/ui/actionbar/actionbar.js';
import { IPaneCompositeBarOptions } from '../../../workbench/browser/parts/paneCompositeBar.js';
import { IMenuService, IMenu, MenuId, MenuItemAction } from '../../../platform/actions/common/actions.js';
import { Menus } from '../menus.js';
import { IHoverService } from '../../../platform/hover/browser/hover.js';
import { DropdownWithPrimaryActionViewItem } from '../../../platform/actions/browser/dropdownWithPrimaryActionViewItem.js';
import { IBaseActionViewItemOptions } from '../../../base/browser/ui/actionbar/actionViewItems.js';
import { getFlatContextMenuActions } from '../../../platform/actions/browser/menuEntryActionViewItem.js';
import { IDisposable, MutableDisposable } from '../../../base/common/lifecycle.js';
import { Extensions } from '../../../workbench/browser/panecomposite.js';
import { mainWindow } from '../../../base/browser/window.js';

/**
 * Auxiliary bar part specifically for agent sessions workbench.
 * This is a simplified version of the AuxiliaryBarPart for agent session contexts.
 */
export class AuxiliaryBarPart extends AbstractPaneCompositePart {

	static readonly activeViewSettingsKey = 'workbench.agentsession.auxiliarybar.activepanelid';
	static readonly pinnedViewsKey = 'workbench.agentsession.auxiliarybar.pinnedPanels';
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/browser/workbench.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/browser/workbench.ts
import { DeferredPromise, RunOnceScheduler } from '../../base/common/async.js';
import { isFullscreen, onDidChangeFullscreen, isChrome, isFirefox, isSafari } from '../../base/browser/browser.js';
import { mark } from '../../base/common/performance.js';
import { onUnexpectedError, setUnexpectedErrorHandler } from '../../base/common/errors.js';
import { isWindows, isLinux, isWeb, isNative, isMacintosh } from '../../base/common/platform.js';
import { Parts, Position, PanelAlignment, IWorkbenchLayoutService, SINGLE_WINDOW_PARTS, MULTI_WINDOW_PARTS, IPartVisibilityChangeEvent, positionToString } from '../../workbench/services/layout/browser/layoutService.js';
import { ILayoutOffsetInfo } from '../../platform/layout/browser/layoutService.js';
import { Part } from '../../workbench/browser/part.js';
import { Direction, ISerializableView, ISerializedGrid, ISerializedLeafNode, ISerializedNode, IViewSize, Orientation, SerializableGrid } from '../../base/browser/ui/grid/grid.js';
import { IEditorGroupsService } from '../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../workbench/services/editor/common/editorService.js';
import { IPaneCompositePartService } from '../../workbench/services/panecomposite/browser/panecomposite.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../workbench/common/views.js';
import { ILogService } from '../../platform/log/common/log.js';
import { IInstantiationService, refineServiceDecorator, ServicesAccessor } from '../../platform/instantiation/common/instantiation.js';
import { ITitleService } from '../../workbench/services/title/browser/titleService.js';
import { mainWindow, CodeWindow } from '../../base/browser/window.js';
import { coalesce } from '../../base/common/arrays.js';
import { ServiceCollection } from '../../platform/instantiation/common/serviceCollection.js';
import { InstantiationService } from '../../platform/instantiation/common/instantiationService.js';
import { getSingletonServiceDescriptors } from '../../platform/instantiation/common/extensions.js';
import { ILifecycleService, LifecyclePhase, WillShutdownEvent } from '../../workbench/services/lifecycle/common/lifecycle.js';
import { IStorageService, WillSaveStateReason, StorageScope, StorageTarget } from '../../platform/storage/common/storage.js';
import { IConfigurationChangeEvent, IConfigurationService } from '../../platform/configuration/common/configuration.js';
import { IHostService } from '../../workbench/services/host/browser/host.js';
import { IDialogService } from '../../platform/dialogs/common/dialogs.js';
import { INotificationService } from '../../platform/notification/common/notification.js';
import { NotificationService } from '../../workbench/services/notification/common/notificationService.js';
import { IHoverService, WorkbenchHoverDelegate } from '../../platform/hover/browser/hover.js';
import { setHoverDelegateFactory } from '../../base/browser/ui/hover/hoverDelegateFactory.js';
import { setBaseLayerHoverDelegate } from '../../base/browser/ui/hover/hoverDelegate2.js';
import { Registry } from '../../platform/registry/common/platform.js';
import { IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../workbench/common/contributions.js';
import { IEditorFactoryRegistry, EditorExtensions } from '../../workbench/common/editor.js';
import { setARIAContainer } from '../../base/browser/ui/aria/aria.js';
import { FontMeasurements } from '../../editor/browser/config/fontMeasurements.js';
import { createBareFontInfoFromRawSettings } from '../../editor/common/config/fontInfoFromSettings.js';
import { toErrorMessage } from '../../base/common/errorMessage.js';
import { WorkbenchContextKeysHandler } from '../../workbench/browser/contextkeys.js';
import { PixelRatio } from '../../base/browser/pixelRatio.js';
import { AccessibilityProgressSignalScheduler } from '../../platform/accessibilitySignal/browser/progressAccessibilitySignalScheduler.js';
import { setProgressAccessibilitySignalScheduler } from '../../base/browser/ui/progressbar/progressAccessibilitySignal.js';
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/browser/media/style.css

```css
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/sessions/browser/media/style.css
.agent-sessions-workbench .interactive-session .interactive-input-part .chat-editor-container .interactive-input-editor .monaco-editor {
	background-color: transparent !important;
}

/* The `.monaco-editor-background` layer must use a *solid* color (not transparent):
 * the editor reuses this class for the reverse-rounded selection corner pieces,
 * which "carve" the rounded notches out of the selection highlight. With a
 * transparent background those pieces stop covering the selection layer and the
 * corners render as blocky squares. Paint it with the same color the chat input
 * container uses so the editor still visually matches its surroundings. */
.agent-sessions-workbench .interactive-session .interactive-input-part .chat-editor-container .interactive-input-editor .monaco-editor .monaco-editor-background {
	background-color: var(--vscode-agentsChatInput-background) !important;
}
.agent-sessions-workbench .interactive-session .chat-edit-input-container .interactive-input-part .chat-editor-container .interactive-input-editor .monaco-editor .monaco-editor-background {
	background-color: transparent !important;
}

/* Scoped to the chat panel (`.part.sessionspart`) and the chat editor host
 * (`.chat-editor-relative`) to avoid leaking into other chat surfaces such as
 * the inline chat widgets and agent-session hover widget. */
.agent-sessions-workbench .part.sessionspart .interactive-session .interactive-input-part,
.agent-sessions-workbench .chat-editor-relative .interactive-session .interactive-input-part {
	width: 100%;
	max-width: 950px;
	margin: 0 auto;
	display: inherit;
	padding: 4px 32px;
	box-sizing: border-box;
}

/* Make sure when editing we don't give unnecessary padding. */
.agent-sessions-workbench .part.sessionspart .interactive-session .chat-edit-input-container .interactive-input-part,
.agent-sessions-workbench .chat-editor-relative .interactive-session .chat-edit-input-container .interactive-input-part {
	padding: 4px 0;
}

/* Hide shared chat-session option-group pickers in the sessions app active chat UI.
 * The sessions workbench provides its own new-session configuration controls and
 * should not surface the shared workbench chat session pickers here. */
.agent-sessions-workbench .interactive-session .chat-input-toolbars .chat-sessionPicker-container {
	display: none;
}
```

