/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { resolveUserProfileSkillLocations } from '../../node/shared/userProfileSkills.js';

suite('user profile skills', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('resolves the provider-neutral .agents roots when skills exist', () => {
		const locations = resolveUserProfileSkillLocations('/home/test', path => path === '/home/test/.agents/skills');
		assert.strictEqual(locations?.agentsRoot.fsPath, '/home/test/.agents');
		assert.strictEqual(locations?.skillsRoot.fsPath, '/home/test/.agents/skills');
	});

	test('does not register a missing profile skill root', () => {
		assert.strictEqual(resolveUserProfileSkillLocations('/home/test', () => false), undefined);
	});
});
