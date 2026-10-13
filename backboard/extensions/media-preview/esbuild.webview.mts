/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import { cp } from 'node:fs/promises';
import { run } from '../esbuild-webview-common.mts';

const root = import.meta.dirname;
const pdfjs = path.join(root, 'node_modules', 'pdfjs-dist');
await run({
	entryPoints: {
		pdfPreview: path.join(root, 'preview-src', 'pdfPreview.ts'),
		'pdf.worker': path.join(pdfjs, 'legacy', 'build', 'pdf.worker.mjs'),
	},
	srcDir: path.join(root, 'preview-src'),
	outdir: path.join(root, 'pdf-preview-out'),
	additionalOptions: { loader: { '.svg': 'dataurl', '.gif': 'dataurl' } },
}, process.argv, async outdir => {
	await Promise.all(['cmaps', 'standard_fonts', 'wasm', 'iccs'].map(folder => cp(path.join(pdfjs, folder), path.join(outdir, folder), { recursive: true })));
	await cp(path.join(pdfjs, 'LICENSE'), path.join(outdir, 'PDFJS-LICENSE'));
});
