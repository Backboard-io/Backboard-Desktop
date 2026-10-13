/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { FileAccess } from '../../../../base/common/network.js';
import { localize } from '../../../../nls.js';

export const simpleModeBackgroundPresets = [
	{ id: 'midnight-peaks', label: localize('background.midnightPeaks', "Midnight Peaks") },
	{ id: 'golden-summit', label: localize('background.goldenSummit', "Golden Summit") },
	{ id: 'digital-forest', label: localize('background.digitalForest', "Digital Forest") },
	{ id: 'birds-in-flight', label: localize('background.birdsInFlight', "Birds in Flight") },
	{ id: 'wild-coast', label: localize('background.wildCoast', "Wild Coast") },
	{ id: 'summer-clouds', label: localize('background.summerClouds', "Summer Clouds") },
	{ id: 'golden-hour', label: localize('background.goldenHour', "Golden Hour") },
	{ id: 'autumn-river', label: localize('background.autumnRiver', "Autumn River") },
	{ id: 'rose-temple', label: localize('background.rose-temple', "Rose Temple") },
	{ id: 'cloud-garden', label: localize('background.cloud-garden', "Cloud Garden") },
	{ id: 'marble-dream', label: localize('background.marble-dream', "Marble Dream") },
	{ id: 'silent-temple', label: localize('background.silent-temple', "Silent Temple") },
	{ id: 'midnight-rotunda', label: localize('background.midnight-rotunda', "Midnight Rotunda") },
	{ id: 'stone-guardians', label: localize('background.stone-guardians', "Stone Guardians") },
	{ id: 'cathedral-light', label: localize('background.cathedral-light', "Cathedral Light") },
].map(preset => ({ ...preset, resource: FileAccess.asFileUri(`vs/sessions/contrib/chat/browser/media/backgrounds/${preset.id}.jpeg`) }));
