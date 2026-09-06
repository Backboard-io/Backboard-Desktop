/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../browser/parts/media/optimusBackground.css';
import { Disposable } from '../../base/common/lifecycle.js';
import { isHighContrast } from '../../platform/theme/common/theme.js';
import { IThemeService } from '../../platform/theme/common/themeService.js';
import { ISimpleModeBackgroundService } from '../../sessions/contrib/chat/browser/simpleModeBackgroundService.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../workbench/common/contributions.js';
import { ITerminalInstance, ITerminalService } from '../../workbench/contrib/terminal/browser/terminal.js';

/** The shared background picker also controls Advanced's terminal canvas surfaces. */
class OptimusBackgroundContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.optimusBackground';
	private disposed = false;

	constructor(
		@ISimpleModeBackgroundService private readonly backgroundService: ISimpleModeBackgroundService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@IThemeService private readonly themeService: IThemeService,
	) {
		super();
		this._register(backgroundService.onDidChangeBackgroundImage(() => this.updateTerminals()));
		this._register(themeService.onDidColorThemeChange(() => this.updateTerminals()));
		this._register(terminalService.onDidCreateInstance(instance => this.attachTerminal(instance)));
		for (const instance of terminalService.instances) {
			this.attachTerminal(instance);
		}
	}

	private get transparent(): boolean {
		return !!this.backgroundService.backgroundImage && !isHighContrast(this.themeService.getColorTheme().type);
	}

	private attachTerminal(instance: ITerminalInstance): void {
		void instance.xtermReadyPromise.then(xterm => {
			if (!this.disposed && this.terminalService.instances.includes(instance)) {
				xterm?.setTransparentBackground(this.transparent);
			}
		});
	}

	private updateTerminals(): void {
		for (const instance of this.terminalService.instances) {
			instance.xterm?.setTransparentBackground(this.transparent);
		}
	}

	override dispose(): void {
		this.disposed = true;
		for (const instance of this.terminalService.instances) {
			instance.xterm?.setTransparentBackground(false);
		}
		super.dispose();
	}
}

registerWorkbenchContribution2(OptimusBackgroundContribution.ID, OptimusBackgroundContribution, WorkbenchPhase.AfterRestored);
