/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../../base/common/event.js';
import { URI } from '../../../../../../base/common/uri.js';
import { mock } from '../../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { workbenchInstantiationService } from '../../../../../test/browser/workbenchTestServices.js';
import { ChatContextUsageWidget } from '../../../browser/widgetHosts/viewPane/chatContextUsageWidget.js';
import { IChatUsage } from '../../../common/chatService/chatService.js';
import { ILanguageModelsService } from '../../../common/languageModels.js';
import { ChatResponseModelChangeReason, IChatModel, IChatRequestModel, IChatResponseModel } from '../../../common/model/chatModel.js';

suite('ChatContextUsageWidget API measurements', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createWidget(): ChatContextUsageWidget {
		const instantiation = workbenchInstantiationService(undefined, store);
		instantiation.stub(ILanguageModelsService, new class extends mock<ILanguageModelsService>() {
			override lookupLanguageModel(): never { throw new Error('API measurements must not use the catalog'); }
			override getModelConfiguration(): never { throw new Error('API measurements must not use configured limits'); }
		}());
		return store.add(instantiation.createInstance(ChatContextUsageWidget));
	}

	function request(sessionId: string, usage?: IChatUsage): IChatRequestModel {
		const changes = store.add(new Emitter<ChatResponseModelChangeReason>());
		const response = new class extends mock<IChatResponseModel>() {
			override usage = usage;
			override isComplete = false;
			override onDidChange = changes.event;
		}();
		return new class extends mock<IChatRequestModel>() {
			override modelId = 'test-model';
			override response = response;
			override session = new class extends mock<IChatModel>() {
				override sessionResource = URI.parse(`chat:/${sessionId}`);
			}();
		}();
	}

	test('shows the API percentage, including zero, instead of billing totals', () => {
		const widget = createWidget();
		const label = () => widget.domNode.querySelector('.percentage-label')?.textContent;
		widget.update(request('one', { kind: 'usage', promptTokens: 95000, completionTokens: 5000, backboardContextUsage: { source: 'backboard-api', usedTokens: 0, contextLimit: 100000, percent: 0 } }));
		assert.strictEqual(label(), '0%');
		widget.update(request('one', { kind: 'usage', promptTokens: 95000, completionTokens: 5000, backboardContextUsage: { source: 'backboard-api', usedTokens: 12000, contextLimit: 100000, percent: 8.5 } }));
		assert.strictEqual(label(), '8.5%');
		widget.update(request('one', { kind: 'usage', promptTokens: 95000, completionTokens: 5000, backboardContextUsage: { source: 'backboard-api', usedTokens: 2000, contextLimit: 100000 } }));
		assert.strictEqual(label(), '2%');
	});

	test('reports unavailable API data and clears stale usage across sessions and rewind', () => {
		const widget = createWidget();
		widget.update(request('one', { kind: 'usage', promptTokens: 95000, completionTokens: 5000, backboardContextUsage: { source: 'backboard-api' } }));
		assert.strictEqual(widget.domNode.getAttribute('aria-label'), 'Context usage unavailable');
		widget.update(request('two'));
		assert.strictEqual(widget.domNode.style.display, 'none');
		widget.update(request('two', { kind: 'usage', promptTokens: 0, completionTokens: 0, backboardContextUsage: { source: 'backboard-api', usedTokens: 10, contextLimit: 100 } }));
		widget.update(undefined);
		assert.strictEqual(widget.domNode.style.display, 'none');
	});
});
