/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { toDisposable } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { mock } from '../../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { ITextModel } from '../../../../../../editor/common/model.js';
import { IAgentConnection } from '../../../../../../platform/agentHost/common/agentService.js';
import { AgentRewindRequest, IAgentRewindResult } from '../../../../../../platform/agentHost/common/agentRewind.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { IEditorService } from '../../../../../services/editor/common/editorService.js';
import { IFilesConfigurationService } from '../../../../../services/filesConfiguration/common/filesConfigurationService.js';
import { ITextFileService, IResolvedTextFileEditorModel, ITextFileEditorModel, ITextFileEditorModelManager } from '../../../../../services/textfile/common/textfiles.js';
import { AgentHostRewind } from '../../../browser/agentSessions/agentHost/agentHostRewind.js';

suite('AgentHostRewind editor buffers', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	for (const failRefresh of [false, true]) {
		test(`protects unsaved text and refreshes disk models (refresh fails: ${failRefresh})`, async () => {
			const calls: string[] = [];
			const controls: AgentRewindRequest[] = [];
			let text = 'unsaved';
			let refreshFailed = false;
			const result: IAgentRewindResult = { transactionId: 'tx', status: 'prepared', paths: ['/workspace/code.txt'], buffers: [], activeCount: 0 };
			const connection = new class extends mock<IAgentConnection>() {
				override async rewindSession(_session: URI, request: AgentRewindRequest): Promise<IAgentRewindResult> {
					controls.push(request);
					calls.push(request.operation);
					return request.operation === 'recover' ? { ...result, status: 'recovered', activeCount: 1, buffers: [{ path: '/workspace/code.txt', content: 'unsaved', encoding: 'utf8' }] } : result;
				}
			}();
			const model = new class extends mock<ITextFileEditorModel>() {
				override textEditorModel = new class extends mock<ITextModel>() {
					override getValue() { return text; }
					override setValue(value: string) { text = value; }
				}();
				override isDirty(): this is IResolvedTextFileEditorModel & this { return true; }
				override getEncoding() { return 'utf8'; }
				override updatePreferredEncoding() {}
				override hasState() { return false; }
			}();
			const textFiles = new class extends mock<ITextFileService>() {
				override files = new class extends mock<ITextFileEditorModelManager>() {
					override get() { return model; }
					override async resolve() { return model; }
				}();
				override async revert() {
					calls.push('refresh');
					if (failRefresh && !refreshFailed) { refreshFailed = true; throw new Error('model refresh failed'); }
					text = 'disk';
				}
			}();
			const config = new class extends mock<IFilesConfigurationService>() {
				override disableAutoSave() { calls.push('autosave off'); return toDisposable(() => calls.push('autosave restored')); }
				override isReadonly() { return false; }
				override async updateReadonly(_resource: URI | URI[], value: boolean | 'toggle' | 'reset') { calls.push(`readonly ${value}`); }
			}();
			const files = new class extends mock<IFileService>() { override async exists() { return true; } }();
			const rewind = new AgentHostRewind(connection, URI.parse('chat:/test'), textFiles, config, files, new class extends mock<IEditorService>() {}());
			if (failRefresh) {
				await assert.rejects(rewind.restore(undefined), /model refresh failed/);
			} else {
				assert.strictEqual(await rewind.restore(undefined), 0);
			}
			assert.deepStrictEqual(controls.find(control => control.operation === 'commit'), { operation: 'commit', transactionId: 'tx', buffers: [{ path: '/workspace/code.txt', content: 'unsaved', encoding: 'utf8' }] });
			assert.deepStrictEqual({ text, calls }, {
				text: failRefresh ? 'unsaved' : 'disk',
				calls: ['prepare', 'autosave off', 'readonly true', 'commit', 'refresh', ...(failRefresh ? ['recover', 'refresh'] : []), 'acknowledge', 'readonly false', 'autosave restored'],
			});
		});
	}
});
