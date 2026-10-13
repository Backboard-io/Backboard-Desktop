/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { fromNow } from '../../../base/common/date.js';
import { isLinuxSnap } from '../../../base/common/platform.js';
import { localize } from '../../../nls.js';
import { IOSProperties } from '../../native/common/native.js';
import { IProductService } from '../../product/common/productService.js';
import { process } from '../../../base/parts/sandbox/electron-browser/globals.js';

export function createNativeAboutDialogDetails(productService: IProductService, osProps: IOSProperties): { title: string; details: string; detailsToCopy: string } {
	// The Backboard product version is shown as the primary version. It is decoupled
	// from the VS Code engine version (`productService.version`), which stays on the
	// `1.x` line for extension compatibility and is surfaced on its own line below.
	let version = productService.backboardVersion ?? productService.version;
	if (productService.target) {
		version = `${version} (${productService.target} setup)`;
	} else if (productService.darwinUniversalAssetId) {
		version = `${version} (Universal)`;
	}

	const getDetails = (useAgo: boolean): string => {
		const commit = productService.commit || 'Unknown';
		const date = productService.date ? `${productService.date}${useAgo ? ' (' + fromNow(new Date(productService.date), true) + ')' : ''}` : 'Unknown';
		const os = `${osProps.type} ${osProps.arch} ${osProps.release}${isLinuxSnap ? ' snap' : ''}`;

		// When a distinct Backboard product version is set, show the VS Code engine
		// version on its own line so both numbers are visible and unambiguous.
		if (productService.backboardVersion) {
			return localize({ key: 'aboutDetailWithEngine', comment: ['Electron, Chromium, Node.js and V8 are product names that need no translation'] },
				"Version: {0}\nVS Code: {1}\nCommit: {2}\nDate: {3}\nElectron: {4}\nElectronBuildId: {5}\nChromium: {6}\nNode.js: {7}\nV8: {8}\nOS: {9}",
				version,
				productService.version,
				commit,
				date,
				process.versions['electron'],
				process.versions['microsoft-build'],
				process.versions['chrome'],
				process.versions['node'],
				process.versions['v8'],
				os
			);
		}

		return localize({ key: 'aboutDetail', comment: ['Electron, Chromium, Node.js and V8 are product names that need no translation'] },
			"Version: {0}\nCommit: {1}\nDate: {2}\nElectron: {3}\nElectronBuildId: {4}\nChromium: {5}\nNode.js: {6}\nV8: {7}\nOS: {8}",
			version,
			commit,
			date,
			process.versions['electron'],
			process.versions['microsoft-build'],
			process.versions['chrome'],
			process.versions['node'],
			process.versions['v8'],
			os
		);
	};

	const details = getDetails(true);
	const detailsToCopy = getDetails(false);

	return {
		title: productService.nameLong,
		details: details,
		detailsToCopy: detailsToCopy
	};
}
