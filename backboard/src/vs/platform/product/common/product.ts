/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { env } from '../../../base/common/process.js';
import { IProductConfiguration } from '../../../base/common/product.js';
import { ISandboxConfiguration } from '../../../base/parts/sandbox/common/sandboxTypes.js';

/**
 * @deprecated It is preferred that you use `IProductService` if you can. This
 * allows web embedders to override our defaults. But for things like `product.quality`,
 * the use is fine because that property is not overridable.
 */
let product: IProductConfiguration;

// Native sandbox environment
const vscodeGlobal = (globalThis as { vscode?: { context?: { configuration(): ISandboxConfiguration | undefined } } }).vscode;
if (typeof vscodeGlobal !== 'undefined' && typeof vscodeGlobal.context !== 'undefined') {
	const configuration: ISandboxConfiguration | undefined = vscodeGlobal.context.configuration();
	if (configuration) {
		product = configuration.product;
	} else {
		throw new Error('Sandbox: unable to resolve product configuration from preload script.');
	}
}
// _VSCODE environment
else if (globalThis._VSCODE_PRODUCT_JSON && globalThis._VSCODE_PACKAGE_JSON) {
	// Obtain values from product.json and package.json-data
	product = globalThis._VSCODE_PRODUCT_JSON as unknown as IProductConfiguration;

	// Running out of sources
	if (env['VSCODE_DEV']) {
		Object.assign(product, {
			nameShort: `${product.nameShort} Dev`,
			nameLong: `${product.nameLong} Dev`,
			dataFolderName: `${product.dataFolderName}-dev`,
			serverDataFolderName: product.serverDataFolderName ? `${product.serverDataFolderName}-dev` : undefined
		});
	}

	// Version is added during built time, but we still
	// want to have it running out of sources so we
	// read it from package.json only when we need it.
	if (!product.version) {
		const pkg = globalThis._VSCODE_PACKAGE_JSON as { version: string };

		Object.assign(product, {
			version: pkg.version
		});
	}
}

// Web environment or unknown
else {

	// Built time configuration (do NOT modify)
	// eslint-disable-next-line local/code-no-dangerous-type-assertions
	product = { /*BUILD->INSERT_PRODUCT_CONFIGURATION*/ } as unknown as IProductConfiguration;

	// Running out of sources
	if (Object.keys(product).length === 0) {
		Object.assign(product, {
			version: '1.104.0-dev',
			nameShort: 'Code - OSS Dev',
			nameLong: 'Code - OSS Dev',
			applicationName: 'code-oss',
			dataFolderName: '.vscode-oss',
			urlProtocol: 'code-oss',
			reportIssueUrl: '',
			licenseName: 'MIT',
			licenseUrl: '',
			serverLicenseUrl: '',
			defaultChatAgent: {
				extensionId: 'backboard.core',
				chatExtensionId: 'backboard.core',
				chatExtensionOutputId: 'Backboard.log',
				chatExtensionOutputExtensionStateCommand: '',
				documentationUrl: 'https://app.backboard.io',
				skusDocumentationUrl: 'https://app.backboard.io',
				publicCodeMatchesUrl: 'https://app.backboard.io',
				managePlanUrl: 'https://app.backboard.io',
				upgradePlanUrl: 'https://app.backboard.io',
				signUpUrl: 'https://app.backboard.io',
				termsStatementUrl: 'https://app.backboard.io/terms',
				privacyStatementUrl: 'https://app.backboard.io/privacy',
				provider: {
					default: {
						id: 'backboard',
						name: 'Backboard',
					},
					enterprise: {
						id: 'backboard',
						name: 'Backboard',
					},
					google: {
						id: 'backboard',
						name: 'Backboard',
					},
					apple: {
						id: 'backboard',
						name: 'Backboard',
					},
				},
				providerExtensionId: '',
				providerUriSetting: 'backboard.apiUrl',
				providerScopes: [],
				entitlementUrl: '',
				entitlementSignupLimitedUrl: '',
				tokenEntitlementUrl: '',
				mcpRegistryDataUrl: '',
				managedSettingsUrl: '',
				chatQuotaExceededContext: 'backboard.chat.quotaExceeded',
				completionsQuotaExceededContext: 'backboard.completions.quotaExceeded',
				walkthroughCommand: '',
				completionsMenuCommand: '',
				chatRefreshTokenCommand: 'backboard.signIn',
				generateCommitMessageCommand: '',
				resolveMergeConflictsCommand: '',
				completionsAdvancedSetting: 'backboard.advanced',
				completionsEnablementSetting: 'backboard.enable',
				nextEditSuggestionsSetting: 'backboard.nextEditSuggestions.enabled',
			}
		});
	}
}

export default product;
