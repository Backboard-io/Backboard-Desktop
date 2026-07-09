/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { TestStorageService } from '../../../../../test/common/workbenchTestServices.js';
import { AgentHostRememberedSessionConfigService } from '../../../browser/agentSessions/agentHost/agentHostRememberedSessionConfig.js';

suite('AgentHostRememberedSessionConfigService', () => {
	const ds = ensureNoDisposablesAreLeakedInTestSuite();

	test('set/get round-trips string values and ignores non-strings and unsafe keys', () => {
		const storage = ds.add(new TestStorageService());
		const service = new AgentHostRememberedSessionConfigService(storage);

		service.set('billing', 'subscription');
		service.set('autoApprove', 'autopilot');
		service.set('isolation', 42); // non-string: ignored
		service.set('__proto__', 'evil'); // unsafe key: ignored

		assert.deepStrictEqual({
			billing: service.get('billing'),
			// getAll() returns a null-prototype map; spread for comparison.
			all: { ...service.getAll() },
		}, {
			billing: 'subscription',
			all: { billing: 'subscription', autoApprove: 'autopilot' },
		});

		// A second service over the same storage sees the same values.
		const rehydrated = new AgentHostRememberedSessionConfigService(storage);
		assert.strictEqual(rehydrated.get('billing'), 'subscription');
	});
});
