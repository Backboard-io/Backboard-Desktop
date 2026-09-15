/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Prevents a slow credential probe from overwriting a newer panel login. */
export class PanelAuthState {
	private revision = 0;
	private alternativeConfigured = false;

	async refresh(hasBackboardCredentials: () => boolean, hasAlternativeCredentials: () => Promise<boolean>): Promise<boolean | undefined> {
		const revision = ++this.revision;
		if (hasBackboardCredentials()) {
			return true;
		}
		const alternative = await hasAlternativeCredentials().catch(() => undefined);
		if (revision !== this.revision) {
			return undefined;
		}
		// A failed probe is not a logout. A successful negative probe is.
		if (typeof alternative === 'boolean') {
			this.alternativeConfigured = alternative;
		}
		return hasBackboardCredentials() || this.alternativeConfigured;
	}
}
