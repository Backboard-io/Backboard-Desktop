/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Config } from '../config';
import { Log } from '../common/logger';

export async function ensureBackboardRedirectServer(_logger: Log): Promise<string> {
	return Config.gitHubRedirectUri;
}
