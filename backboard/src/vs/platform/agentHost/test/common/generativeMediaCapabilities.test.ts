/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { describeVideoModel, parseVideoModelDescription, videoModelCapabilities, videoModelSummary } from '../../common/generativeMediaCapabilities.js';

suite('Generative media capabilities', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads a catalog row, summarizes it for people and round-trips it for Canvas', () => {
		const aleph = videoModelCapabilities({
			id: 'runway/aleph-2',
			supports_video_input: true,
			architecture: { input_modalities: ['text', 'image', 'video'] },
			supported_durations: null,
			supported_resolutions: null,
			supported_aspect_ratios: ['16:9', '9:16'],
			generate_audio: false,
			pricing_skus: { cents_per_second_output: '28', minimum_cents_per_generation: '56' },
		});
		const veo = videoModelCapabilities({
			supports_video_input: false,
			architecture: { input_modalities: ['text', 'image'] },
			supported_durations: [8, 4, 6],
			supported_resolutions: ['720p', '1080p'],
			supported_frame_images: ['first_frame'],
			generate_audio: true,
			pricing_skus: { duration_seconds_with_audio: '0.40', duration_seconds_without_audio: '0.20', video_tokens: '0.1' },
		});

		assert.deepStrictEqual([aleph, veo], [
			{ acceptsVideo: true, acceptsImage: true, durations: [], resolutions: [], aspectRatios: ['16:9', '9:16'], generatesAudio: false, usdPerSecond: 0.28 },
			{ acceptsVideo: false, acceptsImage: true, durations: [4, 6, 8], resolutions: ['720p', '1080p'], aspectRatios: [], generatesAudio: true, usdPerSecond: 0.2 },
		]);
		assert.deepStrictEqual([describeVideoModel(aleph), describeVideoModel(veo)].map(videoModelSummary), ['Edits video', 'Text or image to video · 4–8s · 720p/1080p']);
		assert.deepStrictEqual([parseVideoModelDescription(describeVideoModel(veo)), parseVideoModelDescription('plain text'), videoModelSummary('plain text')], [veo, undefined, 'plain text']);
	});
});
