/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IViewDescriptorService, ViewContainer, ViewContainerLocation } from '../../../common/views.js';

/**
 * Runtime id of the view container contributed by `extensions/backboard`.
 * Extension containers are registered with a `workbench.view.extension.<id>`
 * prefix by the views extension point.
 */
const BACKBOARD_CONTAINER_ID = 'workbench.view.extension.backboard';

/**
 * Reserves the right (auxiliary bar) for the Backboard chat panel.
 *
 * The Backboard container defaults to the auxiliary bar (via its manifest), and
 * that default is fully user-overridable — moving it via "Move to..." / drag /
 * "Reset Location" persists a custom location that wins over the default. This
 * contribution only keeps the auxiliary bar clear of *other* extensions so that
 * Files, Search, Git, the Extensions view, and every other extension container
 * stay together in the left side bar.
 *
 * User intent is respected: a container is only evicted when its current
 * auxiliary-bar placement is its registered default. If the user has explicitly
 * moved a container into the auxiliary bar, its live location differs from its
 * default and it is left alone.
 *
 * All moves no-op in the sessions window because
 * {@link IViewDescriptorService.moveViewContainerToLocation} early-returns there
 * (`canMoveViews()` is `false`).
 */
export class BackboardLayoutContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.backboardLayout';

	constructor(
		@IViewDescriptorService private readonly viewDescriptorService: IViewDescriptorService,
	) {
		super();

		this.reserveAuxiliaryBarForBackboard();

		// Re-run when containers are registered or removed — e.g. installing an
		// extension mid-session that contributes to the secondary side bar.
		this._register(this.viewDescriptorService.onDidChangeViewContainers(() => this.reserveAuxiliaryBarForBackboard()));
	}

	private reserveAuxiliaryBarForBackboard(): void {
		if (!this.viewDescriptorService.canMoveViews()) {
			return;
		}

		for (const container of this.viewDescriptorService.getViewContainersByLocation(ViewContainerLocation.AuxiliaryBar)) {
			if (container.id === BACKBOARD_CONTAINER_ID) {
				continue;
			}
			if (!this.isAtDefaultLocation(container)) {
				// The user deliberately placed this container on the right; leave it.
				continue;
			}
			this.viewDescriptorService.moveViewContainerToLocation(container, ViewContainerLocation.Sidebar, undefined, BackboardLayoutContribution.ID);
		}
	}

	private isAtDefaultLocation(container: ViewContainer): boolean {
		return this.viewDescriptorService.getViewContainerLocation(container) === this.viewDescriptorService.getDefaultViewContainerLocation(container);
	}
}

registerWorkbenchContribution2(BackboardLayoutContribution.ID, BackboardLayoutContribution, WorkbenchPhase.AfterRestored);
