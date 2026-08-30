# Ai Chat Inline Assistance Endpoint Risk Boundaries

## Absolute Documentation Path

`/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/ai-chat-inline-assistance/endpoints/risk-boundaries.md`

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
| Command visibility | Command appears in the wrong context or remains hidden when valid. | Inspect when clauses, context keys, and menu groups. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/chat/browser/promptSyntax/promptCodingAgentActionContribution.ts` |
| Service call | Service dependency is unavailable, delayed, or disposed. | Inspect constructor injection, lifecycle, and Disposable handling. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/chat/browser/pluginGitCommandService.ts` |
| Async boundary | Cancellation, error, or concurrent invocation leaves UI in stale state. | Inspect CancellationToken, promises, event listeners, and finally blocks. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/copilot/src/extension/chatSessions/claude/vscode-node/claudeSlashCommandService.ts` |
| External boundary | Filesystem, network, extension host, browser view, terminal, or secret store returns failure. | Inspect validation, message routing, and recovery UI. | `/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/extensions/copilot/src/extension/chatSessions/claude/vscode-node/test/claudeSlashCommandService.spec.ts` |

## Boundary Code Evidence

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/chat/browser/promptSyntax/promptCodingAgentActionContribution.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/chat/browser/promptSyntax/promptCodingAgentActionContribution.ts
import { Disposable, DisposableMap } from '../../../../../base/common/lifecycle.js';
import { ICodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { registerEditorContribution, EditorContributionInstantiation } from '../../../../../editor/browser/editorExtensions.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { PROMPT_LANGUAGE_ID } from '../../common/promptSyntax/promptTypes.js';
import { PromptCodingAgentActionOverlayWidget } from './promptCodingAgentActionOverlay.js';

export class PromptCodingAgentActionContribution extends Disposable {
	static readonly ID = 'promptCodingAgentActionContribution';

	private readonly _overlayWidgets = this._register(new DisposableMap<ICodeEditor, PromptCodingAgentActionOverlayWidget>());

	constructor(
		private readonly _editor: ICodeEditor,
		@IInstantiationService private readonly _instantiationService: IInstantiationService
	) {
		super();

		this._register(this._editor.onDidChangeModel(() => {
			this._updateOverlayWidget();
		}));

		this._updateOverlayWidget();
	}
	private _updateOverlayWidget(): void {
		const model = this._editor.getModel();

		// Remove existing overlay if present
		this._overlayWidgets.deleteAndDispose(this._editor);

		// Add overlay if this is a prompt file
		if (model && model.getLanguageId() === PROMPT_LANGUAGE_ID) {
			const widget = this._instantiationService.createInstance(PromptCodingAgentActionOverlayWidget, this._editor);
			this._overlayWidgets.set(this._editor, widget);
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/chat/browser/pluginGitCommandService.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/chat/browser/pluginGitCommandService.ts
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { getComparisonKey } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IRequestService } from '../../../../platform/request/common/request.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IAuthenticationService } from '../../../services/authentication/common/authentication.js';
import { IPluginGitService } from '../common/plugins/pluginGitService.js';
import {
	GitHubAuthRequiredError,
	GitHubRateLimitError,
	IGitHubRepoRef,
	fetchAndExtractGitHubRepo,
	parseGitHubCloneUrl,
	resolveGitHubRefToSha,
} from './githubRepoFetcher.js';

/** Storage key for the per-target metadata index used by this service. */
const BROWSER_CACHE_STORAGE_KEY = 'chat.plugins.browserCache.v1';

/**
 * Per-target metadata persisted via {@link IStorageService}. Keyed by the
 * `targetDir.toString()` of the cloned repository so we can answer
 * `revParse('HEAD')` and detect "is the cached snapshot still current?" on
 * `pull()` without an extra GitHub round-trip.
 */
interface IBrowserPluginCacheEntry {
	readonly owner: string;
	readonly repo: string;
	readonly ref?: string;
	readonly sha: string;
```

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
	 * @param stream - Response stream for sending messages to the chat
	 * @param token - Cancellation token
	 * @returns Object indicating whether the command was handled and the result
	 */
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
	readonly description = 'Test memory handler';

	handle(args: string, stream: vscode.ChatResponseStream | undefined, token: CancellationToken): Promise<vscode.ChatResult | void> {
		return TestMemoryHandler.handleSpy(args, stream, token);
```

