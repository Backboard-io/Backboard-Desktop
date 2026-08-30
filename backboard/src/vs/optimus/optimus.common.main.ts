/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//#region --- shared core with the agent-sessions ("Simple") window

import '../sessions/sessions.shared.main.js';

//#endregion


//#region --- Optimus window specific parts and views

// Replaces the Simple window's paneCompositePartService / sessionsParts /
// sessions.contribution trio: same service surface, Optimus implementations.
import './browser/optimusPaneCompositePartService.js';
import './browser/parts/optimusSessionsParts.js';
import './contrib/optimus.contribution.js';

//#endregion
