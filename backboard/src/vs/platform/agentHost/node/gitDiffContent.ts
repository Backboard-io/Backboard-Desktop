/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The `git-blob:` URI helpers moved to `common/gitBlobUri.ts` so browser-side
// clients (e.g. the per-turn fs-watch edit fallback) can build these URIs too.
// This module re-exports them so existing node-side imports keep working.
export { buildGitBlobUri, parseGitBlobUri, type IGitBlobUriFields } from '../common/gitBlobUri.js';
