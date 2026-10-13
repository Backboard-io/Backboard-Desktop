import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { updatePreparationFailure } from '../updateDiagnostics';

test('preserves disk, signature and mounting errors before the generic footer', () => {
	for (const reason of ['ditto: No space left on device', 'code object is not signed at all', 'hdiutil: attach failed - no mountable file systems']) {
		const message = updatePreparationFailure(`${reason}\n[2026-10-05T13:34:18Z] Update failed for Backboard Studio 3.1.21\n`, '/tmp/update.log');
		assert.ok(message.includes(reason));
		assert.ok(!message.includes('Update failed for Backboard Studio'));
		assert.ok(message.includes('/tmp/update.log'));
	}
});

test('handles unavailable logs and bounds long diagnostic output', () => {
	assert.equal(updatePreparationFailure('', '/tmp/update.log'), 'Update preparation failed. Full log: /tmp/update.log');
	assert.ok(updatePreparationFailure('x'.repeat(10000), '/tmp/update.log').length < 1300);
});
