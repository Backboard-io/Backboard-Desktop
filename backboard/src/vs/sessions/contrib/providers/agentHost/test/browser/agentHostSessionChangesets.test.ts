/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import type { Changeset } from '../../../../../../platform/agentHost/common/state/sessionState.js';
import { selectDefaultChangeset } from '../../browser/agentHostSessionChangesets.js';

suite('AgentHost session changesets', () => {
	test('defaults to changes made in this session instead of the branch total', () => {
		const changesets: Changeset[] = [{
			label: 'Branch Changes',
			uriTemplate: 'backboard:/session/changeset/branch',
			changeKind: 'branch',
		}, {
			label: 'All Changes',
			uriTemplate: 'backboard:/session/changeset/session',
			changeKind: 'session',
		}];

		assert.strictEqual(selectDefaultChangeset(changesets), changesets[1]);
	});

	test('falls back to the first producer-defined changeset', () => {
		const changesets: Changeset[] = [{
			label: 'Custom Changes',
			uriTemplate: 'backboard:/session/changeset/custom',
			changeKind: 'custom',
		}];

		assert.strictEqual(selectDefaultChangeset(changesets), changesets[0]);
	});
});
