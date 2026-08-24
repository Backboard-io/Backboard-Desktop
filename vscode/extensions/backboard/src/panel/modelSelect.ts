/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export function renderModelSelectScript(iconBase: string): string {
	return String.raw`
		const iconBase = ${JSON.stringify(iconBase)};
		const providerIconFiles = {
			'anthropic': 'ai_anthropic.svg',
			'aws-bedrock': 'ai_bedrock.svg',
			'bedrock': 'ai_bedrock.svg',
			'deepseek': 'ai_deep_seek.svg',
			'gemini': 'ai_gemini.svg',
			'google': 'ai_google.svg',
			'google-ai': 'ai_google.svg',
			'lm-studio': 'ai_lm_studio.svg',
			'mistral': 'ai_mistral.svg',
			'ollama': 'ai_ollama.svg',
			'openai': 'ai_open_ai.svg',
			'openai-compatible': 'ai_open_ai_compat.svg',
			'openrouter': 'ai_open_router.svg',
			'vercel': 'ai_vercel.svg',
			'xai': 'ai_x_ai.svg'
		};
		const providerDisplayNames = {
			'anthropic': 'Anthropic',
			'aws-bedrock': 'AWS Bedrock',
			'bedrock': 'AWS Bedrock',
			'deepseek': 'DeepSeek',
			'gemini': 'Google',
			'google': 'Google',
			'google-ai': 'Google',
			'lm-studio': 'LM Studio',
			'mistral': 'Mistral',
			'ollama': 'Ollama',
			'openai': 'OpenAI',
			'openai-compatible': 'OpenAI Compatible',
			'openrouter': 'OpenRouter',
			'vercel': 'Vercel',
			'xai': 'xAI'
		};
		const supplementalModels = [
			{ provider: 'openrouter', name: 'openai/gpt-5-chat', displayName: 'GPT-5 Chat', supplemental: true }
		];
		function options() {
			return {
				provider: controls.provider.value,
				model: controls.model.value,
				mode: controls.mode.value,
				intensity: controls.intensity.value,
				imageGeneration: controls.imageGeneration.value,
				voiceMode: controls.voiceMode.value,
				mcpFigma: controls.mcpFigma.checked,
				mcpNotion: controls.mcpNotion.checked,
				mcpGoogle: controls.mcpGoogle.checked
			};
		}
		function saveOptions() {
			vscode.postMessage({ type: 'saveSettings', options: options() });
		}
		function toolName(tool) {
			return tool && tool.function && tool.function.name || tool && (tool.name || tool.tool_name || tool.toolName || tool.function_name || tool.functionName) || 'tool';
		}
		function toolKey(tool) {
			return tool && (tool.id || tool.call_id || tool.callId || tool.tool_call_id || tool.toolCallId) || toolName(tool);
		}
		function toolArgs(tool) {
			const raw = tool && tool.function && tool.function.arguments || tool && (tool.arguments || tool.args || tool.input);
			if (!raw) {
				return {};
			}
			if (typeof raw === 'string') {
				try {
					return JSON.parse(raw);
				} catch {
					return { input: raw };
				}
			}
			return typeof raw === 'object' ? raw : {};
		}
		function renderToolCount() {
			toolCount.textContent = tools.length ? tools.length + ' tools enabled' : 'Tools loading';
		}
		function historyEntryWorkspace(entry) {
			return typeof entry?.currentWorkspace === 'string' && entry.currentWorkspace ? entry.currentWorkspace : '';
		}
		function resolvedCurrentWorkspace() {
			return currentWorkspace || historyEntryWorkspace(activeHistoryEntry()) || historyEntryWorkspace(historyEntries[0]) || '';
		}
		function workspaceLabel() {
			const workspace = resolvedCurrentWorkspace();
			if (!workspace) {
				return '';
			}
			const parts = workspace.split(/[\\/]+/).filter(Boolean);
			return parts[parts.length - 1] || workspace;
		}
		function formatElapsed(ms) {
			const totalSeconds = Math.max(0, Math.floor(ms / 1000));
			const hours = Math.floor(totalSeconds / 3600);
			const minutes = Math.floor((totalSeconds % 3600) / 60);
			const seconds = totalSeconds % 60;
			const two = value => String(value).padStart(2, '0');
			return hours ? hours + ':' + two(minutes) + ':' + two(seconds) : two(minutes) + ':' + two(seconds);
		}
		function updateRunClock() {
			if (!runInProgress || runStartedAt === undefined) {
				if (runClock) {
					runClock.hidden = true;
					runClock.textContent = '00:00';
				}
				return;
			}
			const elapsed = formatElapsed(Date.now() - runStartedAt);
			if (runClock) {
				runClock.hidden = false;
				runClock.textContent = elapsed;
				runClock.title = 'Running for ' + elapsed;
			}
			if (currentPromptClock) {
				currentPromptClock.textContent = elapsed;
				currentPromptClock.title = 'Prompt running for ' + elapsed;
			}
			for (const item of activeToolRows) {
				if (item.duration && item.startedAt !== undefined) {
					item.duration.textContent = formatElapsed(Date.now() - item.startedAt);
				}
			}
		}
		function startRunTimer(startedAt) {
			runStartedAt = typeof startedAt === 'number' ? startedAt : Date.now();
			window.clearInterval(runTimer);
			updateRunClock();
			runTimer = window.setInterval(updateRunClock, 1000);
		}
		function stopRunTimer() {
			if (currentPromptClock && runStartedAt !== undefined) {
				const elapsed = formatElapsed(Date.now() - runStartedAt);
				currentPromptClock.textContent = elapsed;
				currentPromptClock.title = 'Prompt ran for ' + elapsed;
			}
			window.clearInterval(runTimer);
			runTimer = undefined;
			runStartedAt = undefined;
			currentPromptClock = undefined;
			updateRunClock();
		}
		function updateStatus(text) {
			const value = text || 'Ready.';
			for (const node of Array.from(log.querySelectorAll('.statusRow:not(.error)'))) {
				node.remove();
			}
			const workspace = resolvedCurrentWorkspace();
			status.textContent = value === 'Ready.' && workspace ? 'Ready in ' + workspaceLabel() + '.' : value;
			status.title = workspace || value;
		}
			function refreshWorkspaceStatus() {
				const value = status.textContent || 'Ready.';
				updateStatus(value.startsWith('Ready') ? 'Ready.' : value);
			}
			function setAuthenticated(value) {
				authenticated = !!value;
				root.classList.toggle('authRequired', !authenticated);
				prompt.disabled = !authenticated;
				if (!authenticated) {
					closePopover();
					updateStatus('Sign in required.');
				} else if ((status.textContent || '').includes('Sign in required')) {
					updateStatus('Ready.');
				}
				syncComposerButtons();
			}
		function ensureEmptyState() {
			emptyState = document.getElementById('emptyState');
			if (emptyState) {
				return emptyState;
			}
			emptyState = document.createElement('div');
			emptyState.id = 'emptyState';
			emptyState.className = 'emptyState';
			const emptyIcon = document.createElement('div');
			emptyIcon.className = 'emptyIcon';
			emptyIcon.setAttribute('aria-hidden', 'true');
			emptyState.append(emptyIcon);
			const emptyTagline = document.createElement('div');
			emptyTagline.className = 'emptyTagline';
			emptyTagline.textContent = 'Ask anything about your code';
			emptyState.append(emptyTagline);
			const emptyHints = document.createElement('div');
			emptyHints.className = 'emptyHints';
			const hint1 = document.createElement('div');
			hint1.className = 'emptyHint';
			hint1.textContent = 'Try: "Explain this function"';
			const hint2 = document.createElement('div');
			hint2.className = 'emptyHint';
			hint2.textContent = 'Try: "Find bugs in my code"';
			emptyHints.append(hint1, hint2);
			emptyState.append(emptyHints);
			return emptyState;
		}
		function syncEmptyState() {
			const node = ensureEmptyState();
			if (!node.parentElement) {
				log.appendChild(node);
			}
			node.style.display = log.children.length <= 1 ? 'grid' : 'none';
		}
		function removeLegacyChangeArtifacts() {
			for (const node of Array.from(log.querySelectorAll('.fileCard, .reviewWrap, #reviewBlock, .statusRow:not(.error)'))) {
				node.remove();
			}
		}
		function spreadLegacyToolGroups() {
			for (const group of Array.from(log.querySelectorAll('.toolGroup'))) {
				updateToolGroupSummary(group);
			}
		}
		function hasConversationContent() {
			const node = ensureEmptyState();
			return [...log.children].some(child => child !== node);
		}
		function extractMessagesFromLog() {
			return Array.from(log.querySelectorAll('.messageCard')).map(card => {
				const role = card.classList.contains('user')
					? 'user'
					: card.classList.contains('reasoning')
						? 'reasoning'
					: card.classList.contains('assistant')
						? 'assistant'
						: card.classList.contains('error')
							? 'error'
							: 'assistant';
				const content = card.querySelector('.messageText, .reasoningText')?.textContent?.trim() || '';
				return { role, content };
			}).filter(message => message.content);
		}
		function rebuildConversationFromMessages(messages) {
			log.textContent = '';
			log.appendChild(ensureEmptyState());
			currentAssistantCard = undefined;
			activeToolRows = [];
			activeToolGroup = undefined;
			for (const message of Array.isArray(messages) ? messages : []) {
				if (!message || typeof message.content !== 'string' || !message.content.trim()) {
					continue;
				}
				appendMessage(message.role === 'user' ? 'user' : message.role === 'reasoning' ? 'reasoning' : 'assistant', message.content);
			}
			currentAssistantCard = undefined;
			currentReasoningCard = undefined;
			activeToolRows = [];
			activeToolGroup = undefined;
			syncEmptyState();
		}
		function syncRootHeight() {
			if (root instanceof HTMLElement) {
				const viewportHeight = window.visualViewport?.height || window.innerHeight || document.documentElement.clientHeight;
				root.style.height = Math.max(0, Math.floor(viewportHeight)) + 'px';
			}
		}
		function historyTitle(promptText) {
			const words = String(promptText || '').trim().split(/\\s+/).filter(Boolean);
			return words.slice(0, 8).join(' ') || 'Untitled chat';
		}
		function historyTime(value) {
			return new Date(value || Date.now()).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
		}
		const panelStatePersistInterval = 750;
		const activeHistorySaveInterval = 2_000;
		let panelStatePersistTimer = undefined;
		let pendingPanelState = undefined;
		let activeHistorySaveTimer = undefined;
		function flushPanelState() {
			if (panelStatePersistTimer !== undefined) {
				clearTimeout(panelStatePersistTimer);
				panelStatePersistTimer = undefined;
			}
			if (!pendingPanelState) {
				return;
			}
			const state = pendingPanelState;
			pendingPanelState = undefined;
			vscode.postMessage({ type: 'panelState', state });
		}
		function persistPanelState(immediate) {
			panelStateSavedAt = Date.now();
			const persistedWorkspace = resolvedCurrentWorkspace();
			const persistedHistoryEntries = historyEntries.slice(0, 40).map(entry => {
				if (entry?.id === activeHistoryId) {
					return entry;
				}
				// Only the active thread changes. Sending every saved thread's full
				// HTML through the webview bridge made each autosave proportional to
				// the user's entire history. The host merges these summaries with the
				// per-thread snapshots already on disk.
				const { html, messages, outputText, toolOutputs, checkpoints, fileChanges, promptQueue: entryPromptQueue, ...summary } = entry;
				return summary;
			});
			pendingPanelState = {
				activeView,
				activeHistoryId,
				promptQueue,
				currentWorkspace: persistedWorkspace || undefined,
				historyEntries: persistedHistoryEntries,
				savedAt: panelStateSavedAt
			};
			if (immediate) {
				flushPanelState();
			} else if (panelStatePersistTimer === undefined) {
				panelStatePersistTimer = setTimeout(flushPanelState, panelStatePersistInterval);
			}
		}
		function scheduleActiveHistorySave() {
			if (restoringHistory || activeHistorySaveTimer !== undefined) {
				return;
			}
			activeHistorySaveTimer = setTimeout(() => {
				activeHistorySaveTimer = undefined;
				saveActiveHistory();
			}, activeHistorySaveInterval);
		}
		function panelSnapshotTimestamp(state) {
			if (!state || typeof state !== 'object') {
				return 0;
			}
			if (typeof state.savedAt === 'number') {
				return state.savedAt;
			}
			const entries = Array.isArray(state.historyEntries) ? state.historyEntries : [];
			return entries.reduce((max, entry) => Math.max(max, typeof entry?.updatedAt === 'number' ? entry.updatedAt : 0, typeof entry?.startedAt === 'number' ? entry.startedAt : 0), 0);
		}
		function hasPanelSnapshotContent(state) {
			return !!state && typeof state === 'object' && (!!state.activeHistoryId || !!state.promptQueue?.length || !!state.historyEntries?.length);
		}
		function mergeHistoryEntriesPreservingOrder(currentEntries, nextEntries) {
			const nextById = new Map();
			const nextIds = [];
			for (const entry of nextEntries) {
				const id = typeof entry?.id === 'string' ? entry.id : undefined;
				if (!id) {
					continue;
				}
				if (!nextById.has(id)) {
					nextIds.push(id);
				}
				nextById.set(id, entry);
			}
			const merged = [];
			const seen = new Set();
			for (const entry of currentEntries) {
				const id = typeof entry?.id === 'string' ? entry.id : undefined;
				if (id && nextById.has(id) && !seen.has(id)) {
					merged.push(nextById.get(id));
					seen.add(id);
				}
			}
			for (const id of nextIds) {
				if (!seen.has(id)) {
					merged.push(nextById.get(id));
				}
			}
			return merged;
		}
			function activeHistoryEntry() {
				return historyEntries.find(item => item.id === activeHistoryId);
			}
			function historyEntryMatchesWorkspace(entry) {
				const workspace = resolvedCurrentWorkspace();
				return !entry || !entry.currentWorkspace || !workspace || entry.currentWorkspace === workspace;
			}
			function detachActiveHistoryIfWorkspaceChanged() {
				const entry = activeHistoryEntry();
				if (historyEntryMatchesWorkspace(entry)) {
					return false;
				}
				activeHistoryId = undefined;
				promptQueue = [];
				fileChanges = [];
				latestUsage = undefined;
				currentAssistantCard = undefined;
				activeToolRows = [];
				activeToolGroup = undefined;
				log.textContent = '';
				log.appendChild(ensureEmptyState());
				renderQueue();
				renderChangeStack();
				renderCheckpoints();
				renderRecentTabs();
				return true;
			}
			function saveActiveHistory(status) {
				if (activeHistorySaveTimer !== undefined) {
					clearTimeout(activeHistorySaveTimer);
					activeHistorySaveTimer = undefined;
				}
				flushPendingTextAppends();
				if (restoringHistory || !activeHistoryId || (!hasConversationContent() && !promptQueue.length && !fileChanges.length)) {
					return;
				}
				const entry = activeHistoryEntry();
				if (!entry) {
					return;
				}
				entry.html = log.innerHTML;
				entry.messages = extractMessagesFromLog();
				entry.fileChanges = fileChanges.slice(0);
				entry.promptQueue = promptQueue.slice(0);
				entry.currentWorkspace = resolvedCurrentWorkspace() || entry.currentWorkspace;
				entry.updatedAt = Date.now();
				if (status) {
					entry.status = status;
				}
			persistPanelState(!!status);
			if (status) {
				renderRecentTabs();
				renderCheckpoints();
			}
		}
		function renderRecentTabs() {
			if (!recentTabs) {
				return;
			}
			if (inlineHistoryCount) {
				inlineHistoryCount.textContent = String(historyEntries.length);
			}
			recentTabs.textContent = '';
			const entries = historyEntries;
			if (!entries.length) {
				const empty = document.createElement('button');
				empty.className = 'recentTab active';
				empty.type = 'button';
				empty.title = 'New chat';
				const label = document.createElement('span');
				label.className = 'recentTabLabel';
				label.textContent = 'New chat';
				empty.append(label);
				recentTabs.appendChild(empty);
				return;
			}
			for (const entry of entries) {
				const button = document.createElement('div');
				const statusClass = String(entry.status || '').toLowerCase();
				button.className = 'recentTab' + (entry.id === activeHistoryId ? ' active' : '') + (statusClass === 'running' ? ' running' : '');
				button.dataset.historyId = entry.id;
				button.setAttribute('role', 'tab');
				button.setAttribute('aria-selected', entry.id === activeHistoryId ? 'true' : 'false');
				button.tabIndex = 0;
				button.title = entry.title || historyTitle(entry.prompt);
				const label = document.createElement('span');
				label.className = 'recentTabLabel';
				label.textContent = entry.title || historyTitle(entry.prompt);
				const close = document.createElement('button');
				close.className = 'recentTabClose';
				close.type = 'button';
				close.dataset.closeHistoryId = entry.id;
				close.title = 'Close chat';
				close.setAttribute('aria-label', 'Close chat');
				close.appendChild(icon('close'));
				button.append(label, close);
				recentTabs.appendChild(button);
			}
		}
		function renderHistory() {
			if (!historyList || !historyEmpty) {
				return;
			}
			historyList.textContent = '';
			historyEmpty.style.display = historyEntries.length ? 'none' : 'block';
			if (historyCount) {
				historyCount.textContent = String(historyEntries.length);
			}
			if (inlineHistoryCount) {
				inlineHistoryCount.textContent = String(historyEntries.length);
			}
			for (const entry of historyEntries) {
				const button = document.createElement('button');
				button.className = 'historyItem' + (entry.id === activeHistoryId ? ' active' : '');
				button.type = 'button';
				button.dataset.historyId = entry.id;
				const title = document.createElement('div');
				title.className = 'historyItemTitle';
				title.textContent = entry.title || historyTitle(entry.prompt);
				const meta = document.createElement('div');
				meta.className = 'historyItemMeta';
				const time = document.createElement('span');
				time.textContent = historyTime(entry.startedAt);
				const state = document.createElement('span');
				state.className = 'historyItemStatus ' + String(entry.status || '').toLowerCase();
				state.textContent = entry.status || 'Done';
				meta.append(time, state);
				button.append(title, meta);
				historyList.appendChild(button);
			}
			renderRecentTabs();
			renderCheckpoints();
		}
		function renderCheckpoints() {
			if (!checkpointStrip || !checkpointList) {
				return;
			}
			const entry = activeHistoryEntry();
			const checkpoints = Array.isArray(entry?.checkpoints) ? entry.checkpoints : [];
			checkpointList.textContent = '';
			checkpointStrip.classList.toggle('visible', checkpoints.length > 0);
			for (const checkpoint of checkpoints.slice(-8).reverse()) {
				const button = document.createElement('button');
				button.className = 'checkpointButton';
				button.type = 'button';
				button.dataset.checkpointId = checkpoint.id;
				button.title = 'Restore ' + (checkpoint.title || 'Checkpoint');
				button.appendChild(icon('debug-restart'));
				const label = document.createElement('span');
				label.className = 'checkpointLabel';
				label.textContent = checkpoint.title || 'Checkpoint';
				button.appendChild(label);
				checkpointList.appendChild(button);
			}
		}
		function setActiveView(view) {
			activeView = view === 'history' && historyPane ? 'history' : 'chat';
			log.classList.toggle('active', activeView === 'chat');
			historyPane?.classList.toggle('active', activeView === 'history');
			tabButtons.chat?.classList.toggle('active', activeView === 'chat');
			tabButtons.history?.classList.toggle('active', activeView === 'history');
			inlineHistoryButton?.classList.toggle('active', activeView === 'history');
			tabButtons.chat?.setAttribute('aria-selected', activeView === 'chat' ? 'true' : 'false');
			tabButtons.history?.setAttribute('aria-selected', activeView === 'history' ? 'true' : 'false');
			if (activeView === 'history') {
				renderHistory();
			}
			persistPanelState();
		}
		function beginHistoryRun(promptText, suggestedId) {
				const now = Date.now();
				let entry = activeHistoryEntry();
				if (!historyEntryMatchesWorkspace(entry)) {
					activeHistoryId = undefined;
					entry = undefined;
				}
					if (!entry) {
						entry = {
							id: typeof suggestedId === 'string' && suggestedId ? suggestedId : 'chat-' + now + '-' + Math.random().toString(36).slice(2, 8),
							title: historyTitle(promptText),
							prompt: promptText || '',
							currentWorkspace: resolvedCurrentWorkspace() || undefined,
							startedAt: now,
						updatedAt: now,
						status: 'Running',
						html: '',
					fileChanges: [],
					checkpoints: [],
					promptQueue: []
				};
				}
				if (!entry.prompt) {
					entry.prompt = promptText || '';
					entry.title = entry.title || historyTitle(promptText);
				}
					entry.updatedAt = now;
					entry.currentWorkspace = resolvedCurrentWorkspace() || entry.currentWorkspace;
					entry.status = 'Running';
			addCheckpoint(entry, promptText);
			// Update entry in-place instead of moving it to the front
			const existingIndex = historyEntries.findIndex(item => item.id === entry.id);
			if (existingIndex >= 0) {
				historyEntries = [...historyEntries.slice(0, existingIndex), entry, ...historyEntries.slice(existingIndex + 1)].slice(0, 40);
			} else {
				historyEntries = [entry, ...historyEntries].slice(0, 40);
			}
			activeHistoryId = entry.id;
			renderHistory();
			renderRecentTabs();
			persistPanelState();
			return entry.id;
		}
		function addCheckpoint(entry, promptText) {
			const checkpoints = Array.isArray(entry.checkpoints) ? entry.checkpoints : [];
			const title = hasConversationContent() ? 'Before ' + historyTitle(promptText) : 'Start';
			const previous = checkpoints[checkpoints.length - 1];
			const html = log.innerHTML;
			if (previous && previous.html === html && JSON.stringify(previous.promptQueue || []) === JSON.stringify(promptQueue)) {
				return;
			}
			checkpoints.push({
				id: 'cp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
				title,
				createdAt: Date.now(),
				html,
				fileChanges: fileChanges.slice(0),
				promptQueue: promptQueue.slice(0)
			});
			entry.checkpoints = checkpoints.slice(-20);
		}
		function restoreCheckpoint(id) {
			if (runInProgress) {
				updateStatus('Cancel the current run before restoring a checkpoint.');
				return;
			}
			const entry = activeHistoryEntry();
			const checkpoint = (Array.isArray(entry?.checkpoints) ? entry.checkpoints : []).find(item => item.id === id);
			if (!entry || !checkpoint) {
				return;
			}
			saveActiveHistory();
			restoringHistory = true;
			const checkpointMessages = Array.isArray(checkpoint.messages) ? checkpoint.messages : [];
			if (checkpointMessages.length) {
				rebuildConversationFromMessages(checkpointMessages);
			} else {
				log.innerHTML = checkpoint.html || '';
			}
			removeLegacyChangeArtifacts();
			spreadLegacyToolGroups();
			currentAssistantCard = undefined;
			activeToolRows = [];
			activeToolGroup = undefined;
			fileChanges = Array.isArray(checkpoint.fileChanges) ? checkpoint.fileChanges.slice(0) : [];
			promptQueue = normalizePromptQueue(checkpoint.promptQueue);
			entry.html = log.innerHTML;
			entry.messages = extractMessagesFromLog();
			entry.fileChanges = fileChanges.slice(0);
			entry.promptQueue = promptQueue.slice(0);
			entry.status = 'Restored';
			entry.updatedAt = Date.now();
			restoringHistory = false;
			syncEmptyState();
			renderChangeStack();
			renderQueue();
			renderHistory();
			renderRecentTabs();
			renderCheckpoints();
			setActiveView('chat');
			scrollConversation(true);
			persistPanelState();
			updateStatus('Checkpoint restored.');
		}
		function restoreHistoryEntry(id) {
			if (runInProgress && id !== activeHistoryId) {
				updateStatus('Cancel or finish the current run before switching chats.');
				return;
			}
			const entry = historyEntries.find(item => item.id === id);
			if (!entry) {
				return;
			}
			saveActiveHistory();
			restoringHistory = true;
			const entryMessages = Array.isArray(entry.messages) ? entry.messages : [];
			if (entryMessages.length) {
				rebuildConversationFromMessages(entryMessages);
			} else {
				log.innerHTML = entry.html || '';
			}
			removeLegacyChangeArtifacts();
			spreadLegacyToolGroups();
			currentAssistantCard = undefined;
			activeToolRows = [];
			activeToolGroup = undefined;
			fileChanges = Array.isArray(entry.fileChanges) ? entry.fileChanges.slice(0) : [];
			promptQueue = normalizePromptQueue(entry.promptQueue);
			activeHistoryId = entry.id;
			restoringHistory = false;
			syncEmptyState();
			renderChangeStack();
			renderQueue();
			setActiveView('chat');
			scrollConversation(true);
			renderHistory();
			renderRecentTabs();
			renderCheckpoints();
			persistPanelState();
		}
		function closeHistoryEntry(id) {
			if (!id) {
				return;
			}
			if (runInProgress && id === activeHistoryId) {
				updateStatus('Cancel or finish the current run before closing this chat.');
				return;
			}
			const index = historyEntries.findIndex(item => item.id === id);
			if (index < 0) {
				return;
			}
			const wasActive = id === activeHistoryId;
			if (wasActive) {
				saveActiveHistory();
			}
			historyEntries = historyEntries.filter(item => item.id !== id);
			if (wasActive) {
				const next = historyEntries[Math.min(index, historyEntries.length - 1)];
				activeHistoryId = undefined;
				if (next) {
					restoreHistoryEntry(next.id);
				} else {
					clearConversation();
					setActiveView('chat');
				}
			} else {
				renderHistory();
				renderRecentTabs();
				renderCheckpoints();
				persistPanelState();
			}
		}
		function applyPanelStateSnapshot(state, force) {
			if (!hasPanelSnapshotContent(state) || runInProgress) {
				return;
			}
			const snapshotSavedAt = panelSnapshotTimestamp(state);
			if (!force && snapshotSavedAt && panelStateSavedAt && snapshotSavedAt <= panelStateSavedAt) {
				return;
			}
			const nextHistoryEntries = Array.isArray(state.historyEntries) ? state.historyEntries : [];
			const nextActiveHistoryId = typeof state.activeHistoryId === 'string' ? state.activeHistoryId : undefined;
			const nextPromptQueue = normalizePromptQueue(state.promptQueue);
			const nextActiveView = state.activeView === 'history' ? 'history' : 'chat';
			historyEntries = mergeHistoryEntriesPreservingOrder(historyEntries, nextHistoryEntries);
			activeHistoryId = nextActiveHistoryId;
			promptQueue = nextPromptQueue;
			currentWorkspace = typeof state.currentWorkspace === 'string' && state.currentWorkspace ? state.currentWorkspace : currentWorkspace;
			panelStateSavedAt = snapshotSavedAt || Date.now();
			const entry = activeHistoryEntry();
			currentWorkspace = currentWorkspace || historyEntryWorkspace(entry) || historyEntryWorkspace(historyEntries[0]) || currentWorkspace;
			restoringHistory = true;
			if (entry) {
				const entryMessages = Array.isArray(entry.messages) ? entry.messages : [];
				if (entryMessages.length) {
					rebuildConversationFromMessages(entryMessages);
				} else {
					log.innerHTML = entry.html || '';
				}
				removeLegacyChangeArtifacts();
				spreadLegacyToolGroups();
				fileChanges = Array.isArray(entry.fileChanges) ? entry.fileChanges.slice(0) : [];
				promptQueue = entry.promptQueue ? normalizePromptQueue(entry.promptQueue) : promptQueue;
			} else {
				log.innerHTML = '';
				fileChanges = [];
			}
			currentAssistantCard = undefined;
			activeToolRows = [];
			activeToolGroup = undefined;
			restoringHistory = false;
			syncEmptyState();
			renderChangeStack();
			renderQueue();
			renderHistory();
			renderRecentTabs();
			renderCheckpoints();
			setActiveView(nextActiveView);
			scrollConversation(true);
			}
		function startNewChat() {
			if (runInProgress) {
				updateStatus('Cancel or finish the current run before starting a new chat.');
				return;
			}
			closePopover();
			clearConversation();
			setActiveView('chat');
			prompt.focus();
		}
		function setActive(button, active) {
			button.classList.toggle('active', !!active);
		}
			function syncComposerButtons() {
			const hasMode = controls.mode.value !== 'free';
			const hasImage = controls.imageGeneration.value === 'auto';
			setActive(buttons.mode, activePopover === 'reasoning' || hasMode);
			setActive(buttons.model, activePopover === 'model');
			setActive(buttons.image, activePopover === 'image' || hasImage);
			setActive(buttons.voice, activePopover === 'voice' || voiceRecording || controls.voiceMode.value !== 'off');
			buttons.stop.classList.toggle('visible', runInProgress);
			buttons.stop.disabled = !runInProgress || stopRequested;
			buttons.stop.title = stopRequested ? 'Stopping...' : 'Stop generation';
			buttons.stop.setAttribute('aria-label', buttons.stop.title);
				const hasPrompt = prompt.value.trim().length > 0;
				buttons.send.disabled = !authenticated || !hasPrompt;
				buttons.send.classList.toggle('ready', authenticated && hasPrompt);
				buttons.send.title = !authenticated ? 'Sign in required' : runInProgress ? 'Queue prompt' : 'Send';
				buttons.send.setAttribute('aria-label', buttons.send.title);
			}
		function setVoiceRecording(recording) {
			voiceRecording = recording;
			buttons.voice.classList.toggle('recording', recording);
			buttons.voice.title = recording ? 'Stop voice recording' : controls.voiceMode.value === 'off' ? 'Choose voice mode' : 'Start voice recording';
			buttons.voice.setAttribute('aria-label', buttons.voice.title);
			document.querySelector('.composerCard')?.classList.toggle('recording', recording);
			syncComposerButtons();
		}
		function voiceMimeType() {
			if (typeof MediaRecorder === 'undefined') {
				return '';
			}
			return ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/mpeg'].find(type => MediaRecorder.isTypeSupported(type)) || '';
		}
		function stopVoiceStream() {
			if (voiceStream) {
				for (const track of voiceStream.getTracks()) {
					track.stop();
				}
			}
			voiceStream = undefined;
		}
		async function submitVoiceBlob(blob) {
			if (!blob.size) {
				updateStatus('Voice recording stopped. No audio captured.');
				return;
			}
			const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
			const mimeType = blob.type || 'audio/webm';
			const extension = mimeType.includes('mp4') ? 'm4a' : mimeType.includes('mpeg') ? 'mp3' : mimeType.includes('wav') ? 'wav' : 'webm';
			const nextOptions = { ...options(), voiceMode: controls.voiceMode.value === 'stt' ? 'stt' : 'conversation' };
			updateStatus('Sending voice to Backboard.');
				vscode.postMessage({
					type: 'sendVoice',
					prompt: prompt.value.trim(),
					options: nextOptions,
					chatId: activeHistoryId,
					workspace: currentWorkspace,
					audio: {
					data: bytes,
					fileName: 'backboard-voice.' + extension,
					mimeType
				}
			});
			prompt.value = '';
			syncComposerButtons();
		}
		function stopVoiceCapture() {
			if (voiceRecorder && voiceRecorder.state !== 'inactive') {
				voiceRecorder.stop();
				return;
			}
			setVoiceRecording(false);
			stopVoiceStream();
		}
		async function toggleVoiceCapture() {
			if (voiceRecording) {
				stopVoiceCapture();
				return;
			}
			if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
				updateStatus('Microphone recording is not available in this webview.');
				return;
			}
			closePopover();
			voiceChunks = [];
			try {
				voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
				const mimeType = voiceMimeType();
				voiceRecorder = new MediaRecorder(voiceStream, mimeType ? { mimeType } : undefined);
				voiceRecorder.ondataavailable = event => {
					if (event.data?.size) {
						voiceChunks.push(event.data);
					}
				};
				voiceRecorder.onerror = () => {
					updateStatus('Voice recording failed.');
					setVoiceRecording(false);
					stopVoiceStream();
				};
				voiceRecorder.onstop = () => {
					const blob = new Blob(voiceChunks, { type: voiceRecorder?.mimeType || mimeType || 'audio/webm' });
					voiceRecorder = undefined;
					voiceChunks = [];
					setVoiceRecording(false);
					stopVoiceStream();
					void submitVoiceBlob(blob);
				};
				voiceRecorder.start();
				setVoiceRecording(true);
				updateStatus('Recording voice. Click mic again to send.');
			} catch (error) {
				voiceRecorder = undefined;
				voiceChunks = [];
				setVoiceRecording(false);
				stopVoiceStream();
				updateStatus(error instanceof Error && /permission|denied|notallowed/i.test(error.message) ? 'Microphone access denied.' : 'Voice recording could not start.');
			}
		}
		function insertAtCursor(text) {
			const start = prompt.selectionStart || 0;
			const end = prompt.selectionEnd || 0;
			prompt.value = prompt.value.slice(0, start) + text + prompt.value.slice(end);
			prompt.selectionStart = prompt.selectionEnd = start + text.length;
			prompt.focus();
			syncComposerButtons();
		}
		function setSelect(select, value) {
			if ([...select.options].some(option => option.value === value)) {
				select.value = value;
			}
		}
		function escapeHtml(value) {
			return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
		}
		function attr(value) {
			return escapeHtml(value);
		}
		function providerKey(provider) {
			const value = String(provider || '').trim().toLowerCase().replace(/_/g, '-');
			if (value.includes('openrouter') || value.includes('open-router')) {
				return 'openrouter';
			}
			if (value.includes('bedrock') || value.includes('amazon') || value === 'aws') {
				return 'aws-bedrock';
			}
			if (value === 'google-ai' || value === 'googleai') {
				return 'google-ai';
			}
			if (value === 'open-ai' || value === 'open-ai-compatible') {
				return value === 'open-ai-compatible' ? 'openai-compatible' : 'openai';
			}
			if (value === 'openai-compatible' || value === 'openai-compat') {
				return 'openai-compatible';
			}
			if (value === 'x-ai' || value === 'x.ai') {
				return 'xai';
			}
			if (value === 'lmstudio') {
				return 'lm-studio';
			}
			return value;
		}
		function providerDisplayName(provider) {
			const key = providerKey(provider);
			return providerDisplayNames[key] || String(provider || 'Other');
		}
		function providerIconFile(provider) {
			const key = providerKey(provider);
			return providerIconFiles[key] || undefined;
		}
		function providerIconHtml(provider, className) {
			const file = providerIconFile(provider);
			if (!file) {
				return '<span class="' + attr(className) + '"><span class="codicon codicon-symbol-misc"></span></span>';
			}
			return '<span class="' + attr(className) + '"><img data-provider-icon="true" src="' + attr(iconBase + '/' + file) + '" alt="" loading="lazy"></span>';
		}
		function unwrapModelIconHtml(value) {
			const prefix = '<span class="modelIcon">';
			const suffix = '</span>';
			return value.startsWith(prefix) && value.endsWith(suffix) ? value.slice(prefix.length, -suffix.length) : value;
		}
		function supplementalModelSource(items) {
			const next = items.slice(0);
			for (const model of supplementalModels) {
				if (!next.some(item => providerKey(item.provider) === providerKey(model.provider))) {
					next.push(model);
				}
			}
			return next;
		}
		function currentModelLabel() {
			const provider = controls.provider.value;
			const selected = modelSource().find(model => model.provider === provider && model.name === controls.model.value);
			return [providerDisplayName(provider), selected?.displayName || selected?.name || controls.model.value].filter(Boolean).join(' / ');
		}
		function currentModel() {
			const provider = controls.provider.value;
			return modelSource().find(model => model.provider === provider && model.name === controls.model.value);
		}
		function isVisibleModel(model) {
			const modelType = String(model?.modelType || model?.model_type || '').trim().toLowerCase();
			return !['featherless', 'elevenlabs', 'eleven-labs', 'speechmatics'].includes(providerKey(model.provider)) && (!modelType || modelType === 'llm');
		}
		function section(title, content) {
			return '<div class="popoverSection"><div class="popoverSectionTitle">' + escapeHtml(title) + '</div>' + content + '</div>';
		}
		function numericModelValue(model, keys) {
			for (const key of keys) {
				const value = model?.[key];
				if (typeof value === 'number' && Number.isFinite(value)) {
					return value;
				}
				if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
					return Number(value);
				}
			}
			return undefined;
		}
		function modelPricePair(model) {
			const explicitInput = numericModelValue(model, ['inputPricePerMillion', 'inputCostPer1mTokens', 'input_cost_per_1m_tokens', 'inputPrice', 'promptPrice', 'promptPricePerMillion']);
			const explicitOutput = numericModelValue(model, ['outputPricePerMillion', 'outputCostPer1mTokens', 'output_cost_per_1m_tokens', 'outputPrice', 'completionPrice', 'completionPricePerMillion']);
			if (explicitInput !== undefined && explicitOutput !== undefined) {
				return [explicitInput, explicitOutput];
			}
			const id = [model?.provider, model?.name, model?.displayName].filter(Boolean).join(' ').toLowerCase().replace(/[._]/g, '-');
			if (id.includes('claude-haiku-4-5') || id.includes('claude-haiku-4.5')) {
				return [1, 5];
			}
			if (id.includes('claude-sonnet-4')) {
				return [3, 15];
			}
			if (id.includes('claude-opus-4-5') || id.includes('claude-opus-4.5') || id.includes('claude-opus-4-6') || id.includes('claude-opus-4-7') || id.includes('claude-opus-4-8')) {
				return [5, 25];
			}
			if (id.includes('claude-opus-4')) {
				return [15, 75];
			}
			return undefined;
		}
		function choice(action, value, label, meta, selected, disabled, extraAttrs, icon) {
			const iconHtml = icon ? '<span class="choiceIcon"><span class="codicon codicon-' + attr(icon) + '"></span></span>' : '';
			return '<button class="choiceRow' + (selected ? ' selected' : '') + (disabled ? ' disabled' : '') + '" type="button" data-action="' + attr(action) + '" data-value="' + attr(value) + '" ' + (disabled ? 'disabled' : '') + ' ' + (extraAttrs || '') + '>' + iconHtml + '<span class="choiceMain"><span class="choiceLabel">' + escapeHtml(label) + '</span>' + (meta ? '<span class="choiceMeta">' + escapeHtml(meta) + '</span>' : '') + '</span>' + (selected ? '<span class="codicon codicon-check"></span>' : '') + '</button>';
		}
		function modelChoice(model, provider, selected) {
			return '<button class="choiceRow modelChoice' + (selected ? ' selected' : '') + '" type="button" data-action="chooseModel" data-value="' + attr(model.name) + '" data-provider="' + attr(provider) + '" data-model="' + attr(model.name) + '">' + providerIconHtml(provider, 'choiceIcon') + '<span class="choiceMain"><span class="choiceLabel">' + escapeHtml(model.displayName || model.name) + '</span><span class="choiceMeta">' + escapeHtml(model.name) + '</span></span>' + (selected ? '<span class="codicon codicon-check"></span>' : '<span class="modelChoiceCheckSpacer"></span>') + '</button>';
		}
		function actionButton(action, label, icon) {
			return '<button class="drawerButton" type="button" data-action="' + attr(action) + '">' + (icon ? '<span class="codicon codicon-' + attr(icon) + '"></span> ' : '') + escapeHtml(label) + '</button>';
		}
		function providerSwitch(provider, active) {
			const icon = providerIconFile(provider) ? '<img data-provider-icon="true" src="' + attr(iconBase + '/' + providerIconFile(provider)) + '" alt="" loading="lazy">' : '<span class="codicon codicon-symbol-misc"></span>';
			return '<button class="providerSwitch' + (active ? ' active' : '') + '" type="button" data-action="toggleProviderFilter" data-provider="' + attr(provider) + '" aria-pressed="' + (active ? 'true' : 'false') + '"><span class="providerSwitchIcon">' + icon + '</span><span class="providerSwitchName">' + escapeHtml(providerDisplayName(provider)) + '</span><span class="providerSwitchToggle" aria-hidden="true">' + (active ? '<span class="codicon codicon-check"></span>' : '') + '</span></button>';
		}
		function modelSource() {
			const fallback = [{ provider: controls.provider.value || 'aws-bedrock', name: controls.model.value || 'anthropic.claude-sonnet-4-6', displayName: controls.model.value || 'anthropic.claude-sonnet-4-6' }];
			return supplementalModelSource(models.length ? models.filter(isVisibleModel) : fallback.filter(isVisibleModel));
		}
`;
}
