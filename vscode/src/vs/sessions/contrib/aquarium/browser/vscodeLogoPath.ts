/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Backboard logo silhouette path, replacing the old VS Code mark.
// The aquarium cannot use that SVG file directly because each fish renders the
// logo as live, same-document SVG geometry: fish.ts stores this path in a
// shared <symbol>, then renders clipped <use> slices with staggered CSS
// animations. That keeps the swimming-strip effect, currentColor species
// tinting, and auxiliary-window support while avoiding duplicate path parsing
// per fish.
export const VSCODE_LOGO_PATH = 'M77.21,0h10.1c1.32,0,2.4,1.07,2.4,2.4v216.39c0,1.32-1.07,2.4-2.4,2.4h-10.1c-1.32,0-2.4-1.07-2.4-2.4V2.4c0-1.32,1.07-2.4,2.4-2.4ZM49.87,30.34h10.09c2.65,0,4.8,2.15,4.8,4.8v70.65c0,2.65-2.15,4.8-4.8,4.8h-5.29c-2.65,0-4.8-2.15-4.8-4.8V30.34ZM0,90.8h10.08c2.65,0,4.8,2.15,4.8,4.8v10.2c0,2.65-2.15,4.8-4.8,4.8H4.8c-2.65,0-4.8-2.15-4.8-4.8V90.8ZM99.74,110.59h10.09c2.65,0,4.8,2.15,4.8,4.8v70.65c0,2.65-2.15,4.8-4.8,4.8h-5.29c-2.65,0-4.8-2.15-4.8-4.8v-75.45ZM149.61,110.59h10.09c2.65,0,4.8,2.15,4.8,4.8v10.2c0,2.65-2.15,4.8-4.8,4.8h-5.29c-2.65,0-4.8-2.15-4.8-4.8v-15ZM124.68,110.59h10.09c2.65,0,4.8,2.15,4.8,4.8v40.46c0,2.65-2.15,4.8-4.8,4.8h-5.29c-2.65,0-4.8-2.15-4.8-4.8v-45.26ZM24.94,60.53h10.09c2.65,0,4.8,2.15,4.8,4.8v40.46c0,2.65-2.15,4.8-4.8,4.8h-5.29c-2.65,0-4.8-2.15-4.8-4.8V60.53Z';
