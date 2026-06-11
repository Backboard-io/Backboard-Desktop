/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';

const UTILITY_MODEL_SETTING = 'chat.utilityModel';
const UTILITY_SMALL_MODEL_SETTING = 'chat.utilitySmallModel';

/**
 * Shows a chat input notification in air-gapped BYOK scenarios (no GitHub
 * session) when at least one BYOK model is available but the utility model
 * settings are still defaults. The default utility models require GitHub
 * Copilot access, so without it the utility slots silently fall back and
 * degrade the experience until the user points them at a BYOK model.
 *
 * The notification hides automatically once the user signs in, BYOK models
 * disappear, or both utility settings are configured.
 */
export class ByokUtilityModelNotificationContribution extends Disposable {

	private _notification: vscode.ChatInputNotification | undefined;

	constructor(
		@IAuthenticationService private readonly _authService: IAuthenticationService,
		@IConfigurationService private readonly _configService: IConfigurationService,
	) {
		super();

		this._register(this._authService.onDidAuthenticationChange(() => this._update()));
		this._register(vscode.lm.onDidChangeChatModels(() => this._update()));
		this._register(this._configService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(UTILITY_MODEL_SETTING) || e.affectsConfiguration(UTILITY_SMALL_MODEL_SETTING)) {
				this._update();
			}
		}));

		this._update();
	}

	private async _update(): Promise<void> {
		this._hideNotification();
	}

	private _hideNotification(): void {
		this._notification?.hide();
	}
}
