/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { fuzzyScoreGracefulAggressive } from '../../../../../../base/common/filters.js';

export interface IModelSearchItem {
	readonly identifier: string;
	readonly metadata: {
		readonly id: string;
		readonly name: string;
		readonly family?: string;
		readonly detail?: string;
	};
}

/**
 * Filters and ranks model-picker results. Exact, prefix, and substring matches
 * stay ahead of fuzzy subsequence and adjacent-typo matches.
 */
export function filterAndRankModels<T extends IModelSearchItem>(models: readonly T[], query: string): T[] {
	const normalizedQuery = query.trim().toLowerCase();
	if (!normalizedQuery) {
		return [...models];
	}

	return models
		.map((model, index) => ({ model, index, score: scoreModel(model, normalizedQuery) }))
		.filter((entry): entry is { model: T; index: number; score: number } => entry.score !== undefined)
		.sort((a, b) => b.score - a.score || a.index - b.index)
		.map(entry => entry.model);
}

export function scoreModel(model: IModelSearchItem, query: string): number | undefined {
	const queryVariants = searchVariants(query);
	const fields = [
		model.metadata.name,
		model.metadata.id,
		model.identifier,
		model.metadata.family,
		model.metadata.detail,
	].filter((value): value is string => typeof value === 'string' && value.length > 0);

	let best: number | undefined;
	for (let fieldIndex = 0; fieldIndex < fields.length; fieldIndex++) {
		for (const target of searchVariants(fields[fieldIndex])) {
			for (const pattern of queryVariants) {
				if (!pattern || !target) {
					continue;
				}
				let score: number | undefined;
				if (target === pattern) {
					score = 50_000;
				} else if (target.startsWith(pattern)) {
					score = 40_000 - (target.length - pattern.length);
				} else {
					const substringIndex = target.indexOf(pattern);
					if (substringIndex >= 0) {
						score = 30_000 - substringIndex;
					} else {
						const fuzzy = fuzzyScoreGracefulAggressive(pattern, pattern, 0, target, target, 0, {
							firstMatchCanBeWeak: true,
							boostFullMatch: true,
						});
						if (fuzzy) {
							score = 10_000 + fuzzy[0];
						}
					}
				}
				if (score !== undefined) {
					// Prefer the display name and model id over family/detail matches.
					score -= fieldIndex * 10;
					best = best === undefined ? score : Math.max(best, score);
				}
			}
		}
	}
	return best;
}

function searchVariants(value: string): string[] {
	const lower = value.trim().toLowerCase();
	const words = lower.replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
	const compact = words.replace(/\s/g, '');
	return [...new Set([lower, words, compact])];
}
