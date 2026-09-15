/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isWindows } from '../../../base/common/platform.js';

export const BACKBOARD_SUBSCRIPTIONS_ENABLED = false;

/** Apply to live and cached catalogs before exposing or selecting a model. */
export function isBackboardProviderAvailable(provider: string, _windows = isWindows): boolean {
	return !['openai-subscription', 'anthropic-subscription'].includes(provider.trim().toLowerCase());
}
