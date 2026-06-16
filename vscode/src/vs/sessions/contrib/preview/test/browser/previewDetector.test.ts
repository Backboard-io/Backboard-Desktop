/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { constObservable, observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { IFileContent, IFileService } from '../../../../../platform/files/common/files.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IChat, ISession, ISessionFileChange, ISessionWorkspace, SessionStatus } from '../../../../services/sessions/common/session.js';
import { SandboxPreviewDetector } from '../../browser/previewDetector.js';

function makeSession(root: URI, changes: readonly ISessionFileChange[]): ISession {
	const workspace: ISessionWorkspace = {
		uri: root,
		label: 'workspace',
		icon: Codicon.folder,
		folders: [{
			root,
			workingDirectory: root,
			name: 'workspace',
			description: undefined,
		}],
		requiresWorkspaceTrust: false,
		isVirtualWorkspace: false,
	};
	const chat: IChat = {
		resource: URI.parse('file:///session'),
		createdAt: new Date(),
		title: observableValue('title', 'session'),
		updatedAt: observableValue('updatedAt', new Date()),
		status: observableValue('status', SessionStatus.Completed),
		changes: observableValue('changes', changes),
		modelId: observableValue('modelId', undefined),
		mode: observableValue('mode', undefined),
		isArchived: observableValue('isArchived', false),
		isRead: observableValue('isRead', true),
		checkpoints: observableValue('checkpoints', undefined),
		lastTurnEnd: observableValue('lastTurnEnd', new Date()),
		description: observableValue('description', undefined),
	};
	return {
		sessionId: 'test:session',
		resource: chat.resource,
		providerId: 'test',
		sessionType: 'background',
		icon: Codicon.copilot,
		createdAt: chat.createdAt,
		workspace: observableValue('workspace', workspace),
		title: chat.title,
		updatedAt: chat.updatedAt,
		status: chat.status,
		changesets: constObservable([]),
		changes: chat.changes,
		modelId: chat.modelId,
		mode: chat.mode,
		loading: observableValue('loading', false),
		isArchived: chat.isArchived,
		isRead: chat.isRead,
		lastTurnEnd: chat.lastTurnEnd,
		description: chat.description,
		chats: observableValue('chats', [chat]),
		mainChat: constObservable(chat),
		capabilities: { supportsMultipleChats: false },
	};
}

function change(uri: URI): ISessionFileChange {
	return { modifiedUri: uri, insertions: 1, deletions: 0 };
}

suite('SandboxPreviewDetector', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let files: Map<string, string>;
	let detector: SandboxPreviewDetector;
	const root = URI.parse('file:///repo');

	setup(() => {
		files = new Map();
		const instantiationService = new TestInstantiationService();
		instantiationService.stub(IFileService, new class extends mock<IFileService>() {
			override async exists(resource: URI): Promise<boolean> {
				return files.has(resource.toString());
			}
			override async readFile(resource: URI): Promise<IFileContent> {
				const content = files.get(resource.toString());
				if (content === undefined) {
					throw new Error('file not found');
				}
				return { value: VSBuffer.fromString(content) } as IFileContent;
			}
		});
		detector = instantiationService.createInstance(SandboxPreviewDetector);
	});

	test('detects changed static html entry', async () => {
		const index = URI.parse('file:///repo/index.html');
		files.set(index.toString(), '<h1>Hello</h1>');

		const candidate = await detector.detect(makeSession(root, [change(index)]));

		assert.strictEqual(candidate?.kind, 'static-html');
		assert.strictEqual(candidate.entry?.toString(), index.toString());
		assert.strictEqual(candidate.url, index.toString());
	});

	test('detects vite package dev script', async () => {
		const app = URI.parse('file:///repo/app');
		const packageJson = URI.parse('file:///repo/app/package.json');
		const changed = URI.parse('file:///repo/app/src/App.tsx');
		files.set(packageJson.toString(), JSON.stringify({
			scripts: { dev: 'vite --host 0.0.0.0' },
			devDependencies: { vite: '^5.0.0', react: '^18.0.0' },
		}));
		files.set(URI.parse('file:///repo/app/src/App.tsx').toString(), 'export default function App() {}');

		const candidate = await detector.detect(makeSession(root, [change(changed)]));

		assert.strictEqual(candidate?.kind, 'dev-server');
		assert.strictEqual(candidate.cwd.toString(), app.toString());
		assert.strictEqual(candidate.framework, 'Vite');
		assert.strictEqual(candidate.command, 'npm run dev');
		assert.strictEqual(candidate.url, 'http://localhost:5173');
	});

	test('detects next package with explicit port', async () => {
		const packageJson = URI.parse('file:///repo/package.json');
		files.set(packageJson.toString(), JSON.stringify({
			scripts: { dev: 'next dev --port 4000' },
			dependencies: { next: '^15.0.0', react: '^19.0.0' },
		}));
		files.set(URI.parse('file:///repo/pnpm-lock.yaml').toString(), '');

		const candidate = await detector.detect(makeSession(root, [change(packageJson)]));

		assert.strictEqual(candidate?.framework, 'Next.js');
		assert.strictEqual(candidate.command, 'pnpm dev');
		assert.strictEqual(candidate.url, 'http://localhost:4000');
	});

	test('falls back to common frontend package directories', async () => {
		const frontend = URI.parse('file:///repo/frontend');
		const packageJson = URI.parse('file:///repo/frontend/package.json');
		files.set(frontend.toString(), '');
		files.set(packageJson.toString(), JSON.stringify({
			scripts: { dev: 'vite --host 0.0.0.0' },
			devDependencies: { vite: '^5.0.0', react: '^18.0.0' },
		}));

		const candidate = await detector.detect(makeSession(root, [change(URI.parse('file:///repo/README.md'))]));

		assert.strictEqual(candidate?.kind, 'dev-server');
		assert.strictEqual(candidate.cwd.toString(), frontend.toString());
		assert.strictEqual(candidate.framework, 'Vite');
	});

	test('falls back to common frontend static html entry', async () => {
		const frontend = URI.parse('file:///repo/frontend');
		const index = URI.parse('file:///repo/frontend/index.html');
		files.set(frontend.toString(), '');
		files.set(index.toString(), '<h1>Hello</h1>');

		const candidate = await detector.detect(makeSession(root, [change(URI.parse('file:///repo/README.md'))]));

		assert.strictEqual(candidate?.kind, 'static-html');
		assert.strictEqual(candidate.entry?.toString(), index.toString());
	});

	test('ignores backend-only changes without web markers', async () => {
		const candidate = await detector.detect(makeSession(root, [change(URI.parse('file:///repo/server/main.go'))]));

		assert.strictEqual(candidate, undefined);
	});
});
