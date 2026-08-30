# Ai Chat Inline Assistance UI Code Excerpts

## Absolute Documentation Path

`/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/bb-docs/ai-chat-inline-assistance/ui/code-excerpts.md`

## Reading Order

```text
1. Start with contribution or manifest files.
2. Follow commands and menus into services/actions.
3. Read view/widget/browser files for DOM and layout.
4. Read media CSS for spacing, density, focus, hover, and overflow.
5. Return to README.md for the feature summary.
```

## Literal Code Excerpts

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
		}
	}
}

registerEditorContribution(PromptCodingAgentActionContribution.ID, PromptCodingAgentActionContribution, EditorContributionInstantiation.AfterFirstRender);
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
	readonly fetchedAt: number;
}

type IStoredBrowserPluginCache = Record<string, IBrowserPluginCacheEntry>;

/**
 * Browser implementation of {@link IPluginGitService}.
 *
 * `git` is not available in the browser, so plugin contents are reconstructed
 * from the GitHub REST API: `/git/trees/{sha}?recursive=1` for the listing and
 * `/git/blobs/{blob_sha}` for each file's bytes. Both live on `api.github.com`,
 * which is the only GitHub host that handles CORS with auth headers - the
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
	tryHandleCommand(
		request: IClaudeSlashCommandRequest,
		stream: vscode.ChatResponseStream,
		token: CancellationToken
	): Promise<IClaudeSlashCommandResult>;

	/**
	 * Get all registered command names.
	 */
	getRegisteredCommands(): readonly string[];
}
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
	}
}

function makeRequest(prompt: string, command?: string): IClaudeSlashCommandRequest {
	return { prompt, command };
}

describe('ClaudeSlashCommandService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let service: ClaudeSlashCommandService;
	let stream: MockChatResponseStream;
```

### /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/agentsVoice/browser/agentsVoice.contribution.ts

```ts
// Source: /Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode/src/vs/workbench/contrib/agentsVoice/browser/agentsVoice.contribution.ts
import './transcriptsView/voiceTranscripts.contribution.js';

import { Disposable } from '../../../../base/common/lifecycle.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import * as nls from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Extensions as ConfigurationExtensions, ConfigurationScope, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ContextKeyExpr, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IAgentsVoiceWindowService, AgentsVoiceStorageKeys } from '../common/agentsVoice.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import {
	VoiceEnabledClassification, VoiceEnabledEvent,
	VoiceDisabledClassification, VoiceDisabledEvent,
} from '../../chat/browser/voiceClient/voiceTelemetry.js';
import { mainWindow } from '../../../../base/browser/window.js';

// --- Context Keys ---

const AGENTS_VOICE_WINDOW_VISIBLE = new RawContextKey<boolean>('agentsVoiceWindowVisible', false);
export const AGENTS_VOICE_WIDGET_FOCUSED = new RawContextKey<boolean>('agentsVoiceWidgetFocused', false);

// --- Context Key Binding ---

class AgentsVoiceContextKeyContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.agentsVoiceContextKey';

	constructor(
		@IAgentsVoiceWindowService private readonly agentsVoiceWindowService: IAgentsVoiceWindowService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();

		const contextKey = AGENTS_VOICE_WINDOW_VISIBLE.bindTo(contextKeyService);
		contextKey.set(this.agentsVoiceWindowService.isOpen);

		this._register(this.agentsVoiceWindowService.onDidChangeOpen(isOpen => {
			contextKey.set(isOpen);
		}));
	}
```

## Follow-Up Search Commands

```sh
cd '/Users/erintomorri/Desktop/Backboard/IDE/Espri-API/ide/vscode'
rg -n "MenuId\.|registerAction2|CommandsRegistry|appendMenuItem|registerWorkbenchContribution2|WorkbenchPhase|registerSingleton" 'src/vs/workbench/contrib/agentsVoice' 'src/vs/workbench/contrib/chat' 'src/vs/workbench/contrib/inlineChat' 'src/vs/workbench/contrib/inlineCompletions' 'src/vs/workbench/contrib/speech' 'src/vs/workbench/services/chat' 'src/vs/workbench/services/inlineCompletions' 'src/vs/workbench/services/aiEmbeddingVector' 'src/vs/workbench/services/aiRelatedInformation' 'src/vs/workbench/services/aiSettingsSearch' 'src/vs/platform/agentPlugins' 'extensions/copilot'
rg -n "\.(css|scss)|class=|codicon|ThemeIcon|ActionViewItem|render|layout" 'src/vs/workbench/contrib/agentsVoice' 'src/vs/workbench/contrib/chat' 'src/vs/workbench/contrib/inlineChat' 'src/vs/workbench/contrib/inlineCompletions' 'src/vs/workbench/contrib/speech' 'src/vs/workbench/services/chat' 'src/vs/workbench/services/inlineCompletions' 'src/vs/workbench/services/aiEmbeddingVector' 'src/vs/workbench/services/aiRelatedInformation' 'src/vs/workbench/services/aiSettingsSearch' 'src/vs/platform/agentPlugins' 'extensions/copilot'
```

