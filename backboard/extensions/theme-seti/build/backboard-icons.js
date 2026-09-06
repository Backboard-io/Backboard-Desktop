/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

// Keep Backboard's visual treatment when refreshing the upstream Seti associations.
module.exports = function applyBackboardIcons(theme) {
	for (const [section, suffix] of [[theme, ''], [theme.light, '_light']]) {
		for (const name of ['folder', 'file', 'markdown', 'json', 'yaml', 'git', 'package', 'pnpm', 'license']) {
			theme.iconDefinitions[`_backboard_${name}${suffix}`] = {
				iconPath: `./backboard/${name}${suffix ? '-light' : ''}.svg`
			};
		}
		const icon = name => `_backboard_${name}${suffix}`;
		// Replace shared definitions so all existing associations inherit the new look.
		for (const [upstream, name] of Object.entries({ default: 'file', markdown: 'markdown', json: 'json', yml: 'yaml', git: 'git', license: 'license' })) {
			theme.iconDefinitions[`_${upstream}${suffix}`] = theme.iconDefinitions[icon(name)];
		}
		section.folder = icon('folder');
		section.folderExpanded = icon('folder');
		section.rootFolder = icon('folder');
		section.rootFolderExpanded = icon('folder');
		section.folderNames = { ...section.folderNames };
		section.folderNamesExpanded = { ...section.folderNamesExpanded };
		for (const [folder, badge] of Object.entries({ apps: 'apps', assets: 'assets', docs: 'docs', '.vscode': 'vscode', scripts: 'scripts' })) {
			const name = `folder-${badge}`;
			theme.iconDefinitions[icon(name)] = { iconPath: `./backboard/${name}${suffix ? '-light' : ''}.svg` };
			section.folderNames[folder] = icon(name);
			section.folderNamesExpanded[folder] = icon(name);
		}
		Object.assign(section.fileExtensions, {
			md: icon('markdown'), markdown: icon('markdown'), json: icon('json'), jsonc: icon('json'),
			yaml: icon('yaml'), yml: icon('yaml')
		});
		Object.assign(section.fileNames, {
			'package.json': icon('package'), 'package-lock.json': icon('package'),
			'pnpm-lock.yaml': icon('pnpm'), 'pnpm-workspace.yaml': icon('pnpm'),
			'contributing.md': icon('markdown'), '.env': icon('file'), '.env.example': icon('file'),
			'.gitignore': icon('git'), '.gitattributes': icon('git')
		});
	}
	const note = 'Backboard icon overrides are maintained in build/backboard-icons.js and icons/backboard/.';
	if (!theme.information_for_contributors.includes(note)) {
		theme.information_for_contributors.push(note);
	}
	return theme;
};
