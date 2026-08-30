# Mcp Tools Customizations Screen Map

## Absolute Documentation Path

`/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/mcp-tools-customizations/ui/screen-map.md`

## Visual Surface Diagram

```text
+--------------------------------------------------------------------------------+
| Workbench Shell                                                                 |
| +----------------+ +-------------------------------+ +------------------------+ |
| | Activity/Side   | | Editor, view, notebook, or    | | Auxiliary or panel     | |
| | Bar Surface     | | webview surface for           | | surface when feature   | |
| |                | | Mcp Tools Customizations      | | owns secondary context | |
| +----------------+ +-------------------------------+ +------------------------+ |
| Command Palette -> menus -> context keys -> source files listed below           |
+--------------------------------------------------------------------------------+
```

## Screen Responsibilities

- Entry surface: command palette, menu contribution, view container, editor contribution, or extension contribution connected to `mcp-tools-customizations`.
- Primary interaction: the user sees state through files listed in the UI source inventory and triggers behavior through the endpoint registry.
- Secondary interaction: context menus, toolbar buttons, title actions, quick access, hover affordances, or status entries routed through workbench services.
- Layout responsibility: any CSS/DOM file in the table below controls density, overflow, focus visibility, and responsive constraints.

## UI Surface Files

- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/mcp/browser/mcp.contribution.ts` - Workbench contribution entry point: registers actions, views, services, or lifecycle hooks.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/mcp/browser/mcp.view.contribution.ts` - Workbench contribution entry point: registers actions, views, services, or lifecycle hooks.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/mcp/browser/mcpAddContextContribution.ts` - Workbench contribution entry point: registers actions, views, services, or lifecycle hooks.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/mcp/browser/mcpGatewayToolBrokerContribution.ts` - Workbench contribution entry point: registers actions, views, services, or lifecycle hooks.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/mcp/electron-browser/mcp.contribution.ts` - Workbench contribution entry point: registers actions, views, services, or lifecycle hooks.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/mcp/electron-browser/mcpGatewayToolBrokerContribution.ts` - Workbench contribution entry point: registers actions, views, services, or lifecycle hooks.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/chat/browser/aiCustomization/aiCustomizationManagement.contribution.ts` - Workbench contribution entry point: registers actions, views, services, or lifecycle hooks.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/mcp/browser/mcpElicitationService.ts` - Service boundary: owns state, dependency injection, events, or cross-feature contracts.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/mcp/browser/mcpGatewayService.ts` - Service boundary: owns state, dependency injection, events, or cross-feature contracts.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/mcp/browser/mcpWorkbenchService.ts` - Service boundary: owns state, dependency injection, events, or cross-feature contracts.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/mcp/electron-browser/mcpGatewayService.ts` - Service boundary: owns state, dependency injection, events, or cross-feature contracts.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/services/mcp/browser/mcpGalleryManifestService.ts` - Service boundary: owns state, dependency injection, events, or cross-feature contracts.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/services/mcp/browser/mcpWorkbenchManagementService.ts` - Service boundary: owns state, dependency injection, events, or cross-feature contracts.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/services/mcp/electron-browser/mcpGalleryManifestService.ts` - Service boundary: owns state, dependency injection, events, or cross-feature contracts.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/services/mcp/electron-browser/mcpWorkbenchManagementService.ts` - Service boundary: owns state, dependency injection, events, or cross-feature contracts.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/chat/browser/aiCustomization/aiCustomizationWorkspaceService.ts` - Service boundary: owns state, dependency injection, events, or cross-feature contracts.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/chat/browser/aiCustomization/customizationCreatorService.ts` - Service boundary: owns state, dependency injection, events, or cross-feature contracts.
- `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/chat/browser/aiCustomization/customizationHarnessService.ts` - Service boundary: owns state, dependency injection, events, or cross-feature contracts.

## Screen State Checklist

| State | What must be visible | Source anchor |
|---|---|---|
| Empty | Clear entry affordance or quiet absence when the feature is unavailable. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/copilot/src/extension/chatSessions/claude/vscode-node/claudeSlashCommandService.ts` |
| Loading | Progress, disabled action, view welcome, spinner, or deferred activation state. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/copilot/src/extension/chatSessions/claude/vscode-node/test/claudeSlashCommandService.spec.ts` |
| Ready | Primary command/view/editor surface accepts input or displays content. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/mcp/browser/mcp.contribution.ts` |
| Error | Failure should route through notification, marker, inline message, log, or disabled context. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/mcp/browser/mcp.view.contribution.ts` |

## UI Code Anchors

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/copilot/src/extension/chatSessions/claude/vscode-node/claudeSlashCommandService.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/copilot/src/extension/chatSessions/claude/vscode-node/claudeSlashCommandService.ts
import * as vscode from 'vscode';
import { ILogService } from '../../../../platform/log/common/logService';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { Disposable } from '../../../../util/vs/base/common/lifecycle';
import { createDecorator, IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { getClaudeSlashCommandRegistry, IClaudeSlashCommandHandler } from './slashCommands/claudeSlashCommandRegistry';

export interface IClaudeSlashCommandRequest {
	readonly prompt: string;
	readonly command: string | undefined;
}

// Import all slash command handlers to trigger self-registration
import './slashCommands/index';

export interface IClaudeSlashCommandResult {
	handled: boolean;
	result?: vscode.ChatResult;
}

export interface IClaudeSlashCommandService {
	readonly _serviceBrand: undefined;

	/**
	 * Try to handle a slash command from the user's request.
	 *
	 * Checks `request.command` first (VS Code slash command), then falls back to
	 * parsing a `/command` pattern from `request.prompt`.
	 *
	 * @param request - The user's request containing prompt and optional command
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/copilot/src/extension/chatSessions/claude/vscode-node/test/claudeSlashCommandService.spec.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/copilot/src/extension/chatSessions/claude/vscode-node/test/claudeSlashCommandService.spec.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../util/common/test/testUtils';
import { CancellationToken } from '../../../../../util/vs/base/common/cancellation';
import { IInstantiationService } from '../../../../../util/vs/platform/instantiation/common/instantiation';
import { createExtensionUnitTestingServices } from '../../../../test/node/services';
import { MockChatResponseStream } from '../../../../test/node/testHelpers';
import { ClaudeSlashCommandService, IClaudeSlashCommandRequest } from '../claudeSlashCommandService';
import { IClaudeSlashCommandHandler, IClaudeSlashCommandHandlerCtor } from '../slashCommands/claudeSlashCommandRegistry';

// Wire test handler ctors through the registry so the service populates its cache naturally
const mockGetRegistry = vi.fn<() => readonly IClaudeSlashCommandHandlerCtor[]>().mockReturnValue([]);
vi.mock('../slashCommands/claudeSlashCommandRegistry', async importOriginal => {
	const actual = await importOriginal<typeof import('../slashCommands/claudeSlashCommandRegistry')>();
	return { ...actual, getClaudeSlashCommandRegistry: () => mockGetRegistry() };
});

class TestHooksHandler implements IClaudeSlashCommandHandler {
	static handleSpy = vi.fn<IClaudeSlashCommandHandler['handle']>().mockResolvedValue({});
	readonly commandName = 'hooks';
	readonly description = 'Test hooks handler';

	handle(args: string, stream: vscode.ChatResponseStream | undefined, token: CancellationToken): Promise<vscode.ChatResult | void> {
		return TestHooksHandler.handleSpy(args, stream, token);
	}
}

class TestMemoryHandler implements IClaudeSlashCommandHandler {
	static handleSpy = vi.fn<IClaudeSlashCommandHandler['handle']>().mockResolvedValue({});
	readonly commandName = 'memory';
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/mcp/browser/mcp.contribution.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/mcp/browser/mcp.contribution.ts
import { localize } from '../../../../nls.js';
import { registerAction2 } from '../../../../platform/actions/common/actions.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import * as jsonContributionRegistry from '../../../../platform/jsonschemas/common/jsonContributionRegistry.js';
import { mcpAccessConfig, McpAccessValue } from '../../../../platform/mcp/common/mcpManagement.js';
import { IQuickAccessRegistry, Extensions as QuickAccessExtensions } from '../../../../platform/quickinput/common/quickAccess.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { IConfigurationMigrationRegistry, Extensions as ConfigurationMigrationExtensions, ConfigurationKeyValuePairs } from '../../../common/configuration.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { EditorExtensions } from '../../../common/editor.js';
import { mcpSchemaId } from '../../../services/configuration/common/configuration.js';
import { ChatContextKeys } from '../../chat/common/actions/chatContextKeys.js';
import { ExtensionMcpDiscovery } from '../common/discovery/extensionMcpDiscovery.js';
import { InstalledMcpServersDiscovery } from '../common/discovery/installedMcpServersDiscovery.js';
import { mcpDiscoveryRegistry } from '../common/discovery/mcpDiscovery.js';
import { RemoteNativeMpcDiscovery } from '../common/discovery/nativeMcpRemoteDiscovery.js';
import { PluginMcpDiscovery } from '../common/discovery/pluginMcpDiscovery.js';
import { CursorWorkspaceMcpDiscoveryAdapter } from '../common/discovery/workspaceMcpDiscoveryAdapter.js';
import { WorkspaceDotMcpDiscovery } from '../common/discovery/workspaceDotMcpDiscovery.js';
import { McpCommandIds } from '../common/mcpCommandIds.js';
import { mcpServerSchema } from '../common/mcpConfiguration.js';
import { McpContextKeysController } from '../common/mcpContextKeys.js';
import { IMcpDevModeDebugging, McpDevModeDebugging } from '../common/mcpDevMode.js';
import { McpLanguageModelToolContribution } from '../common/mcpLanguageModelToolContribution.js';
import { McpRegistry } from '../common/mcpRegistry.js';
import { IMcpRegistry } from '../common/mcpRegistryTypes.js';
import { IMcpSandboxService, McpSandboxService } from '../common/mcpSandboxService.js';
import { McpResourceFilesystem } from '../common/mcpResourceFilesystem.js';
```

