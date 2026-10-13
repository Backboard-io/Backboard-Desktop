/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Opens the API Keys page. Registered by `byokKeys.contribution.ts`. */
export const OPEN_API_KEYS_COMMAND_ID = 'backboard.openApiKeys';
export const BYOK_KEYS_EDITOR_ID = 'workbench.editor.backboardApiKeys';
export const BYOK_KEYS_EDITOR_INPUT_ID = 'workbench.input.backboardApiKeys';
/** Validates, stores and activates a provider key: `(provider: ByokProviderId, key: string) => Promise<void>`. */
export const ADD_PROVIDER_KEY_COMMAND_ID = 'backboard.addProviderKey';
