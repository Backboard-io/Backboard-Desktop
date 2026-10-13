/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventType, isHTMLElement } from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IBackboardBillingService, OPEN_BILLING_COMMAND_ID } from '../common/backboardBilling.js';
import './backboardBillingService.js';
import { BillingPlansView } from './billingPlansView.js';

/** The open overlay in this window, if any. */
const overlay = new MutableDisposable<DisposableStore>();

/**
 * Opens the plans overlay. When onboarding is already showing the plans
 * (or the overlay is open) it only refreshes them.
 */
function openBillingOverlay(accessor: ServicesAccessor): void {
	const billing = accessor.get(IBackboardBillingService);
	void billing.refresh();
	if (overlay.value || BillingPlansView.isShowing) {
		return;
	}

	const layoutService = accessor.get(ILayoutService);
	const instantiationService = accessor.get(IInstantiationService);
	const store = new DisposableStore();
	const previousFocus = layoutService.activeContainer.ownerDocument.activeElement;

	const element = append(layoutService.activeContainer, $('.bb-plans-overlay'));
	element.setAttribute('role', 'dialog');
	element.setAttribute('aria-modal', 'true');
	element.setAttribute('aria-label', localize('billing.aria', "Plans and billing"));
	store.add({ dispose: () => element.remove() });

	const close = () => {
		overlay.clear();
		if (isHTMLElement(previousFocus)) {
			previousFocus.focus();
		}
	};

	const closeButton = append(element, $<HTMLButtonElement>('button.bb-plans-overlay-close'));
	closeButton.type = 'button';
	const closeLabel = localize('billing.close', "Close");
	closeButton.title = closeLabel;
	closeButton.setAttribute('aria-label', closeLabel);
	closeButton.classList.add(...ThemeIcon.asClassNameArray(Codicon.close));
	store.add(addDisposableListener(closeButton, EventType.CLICK, close));
	store.add(addDisposableListener(element, EventType.KEY_DOWN, (event: KeyboardEvent) => {
		if (new StandardKeyboardEvent(event).equals(KeyCode.Escape)) {
			event.preventDefault();
			close();
		}
	}));

	store.add(instantiationService.createInstance(BillingPlansView, element, { mode: 'standalone', onDone: close }));
	overlay.value = store;
	closeButton.focus();
}

registerAction2(class extends Action2 {
	constructor() {
		super({ id: OPEN_BILLING_COMMAND_ID, title: localize2('backboard.openBilling', "Billing"), category: localize2('backboard.category', "Backboard"), f1: true });
	}
	run(accessor: ServicesAccessor): void {
		openBillingOverlay(accessor);
	}
});

MenuRegistry.appendMenuItem(MenuId.AccountsContext, {
	command: { id: OPEN_BILLING_COMMAND_ID, title: localize('backboard.accountBilling', "Billing"), icon: Codicon.creditCard },
	group: '2_settings', order: 3,
});
