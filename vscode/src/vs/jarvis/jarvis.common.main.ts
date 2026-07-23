/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//#region --- shared core with the agent-sessions ("Simple") window

import '../sessions/sessions.shared.main.js';

//#endregion


//#region --- Jarvis window specific parts and views

// Replaces the Simple window's paneCompositePartService / sessionsParts /
// sessions.contribution trio: same service surface, Jarvis implementations.
import './browser/jarvisPaneCompositePartService.js';
// TEMP (2.4.17 release build): these two are not implemented yet and don't compile.
// Commented out to unblock the sandbox build; restore when the files exist.
// import './browser/parts/jarvisSessionsParts.js';
// import './contrib/jarvis.contribution.js';

//#endregion
