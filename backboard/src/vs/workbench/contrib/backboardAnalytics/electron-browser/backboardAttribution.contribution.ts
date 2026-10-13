/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DeferredPromise } from '../../../../base/common/async.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import product from '../../../../platform/product/common/product.js';
import { IURLService } from '../../../../platform/url/common/url.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { attributionFromQuery, IBackboardAnalyticsService } from '../../../services/backboardAnalytics/common/backboardAnalytics.js';

export const LINK_ATTRIBUTION_COMMAND = 'backboard.analytics.linkAttribution';

/** The browser returns campaign data, never account identity or OAuth tokens. */
export class BackboardAttributionContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.backboardAttribution';
	private pending: { state: string; result: DeferredPromise<boolean> } | undefined;

	constructor(
		@IURLService urlService: IURLService,
		@IOpenerService private readonly opener: IOpenerService,
		@IBackboardAnalyticsService private readonly analytics: IBackboardAnalyticsService,
	) {
		super();
		this._register(CommandsRegistry.registerCommand(LINK_ATTRIBUTION_COMMAND, () => this.link()));
		this._register(urlService.registerHandler({ handleURL: async uri => {
			if (uri.scheme !== product.urlProtocol || uri.authority !== 'attribution' || uri.path !== '/return') { return false; }
			const pending = this.pending;
			if (!pending || new URLSearchParams(uri.query).get('state') !== pending.state) { return true; }
			this.analytics.recordAttribution(attributionFromQuery(uri.query));
			this.pending = undefined;
			await pending.result.complete(true);
			return true;
		} }));
		this._register(toDisposable(() => { void this.pending?.result.complete(false); this.pending = undefined; }));
	}

	private async link(): Promise<boolean> {
		const configured = product.backboardAnalytics?.attributionUrl?.trim();
		if (!configured || !this.analytics.enabled) { return false; }
		if (this.pending) { return this.pending.result.p; }
		let url: URL;
		try { url = new URL(configured); } catch { return false; }
		if (url.protocol !== 'https:') { return false; }
		const pending = this.pending = { state: generateUuid(), result: new DeferredPromise<boolean>() };
		url.searchParams.set('flow', 'studio');
		url.searchParams.set('state', pending.state);
		const timer = setTimeout(() => { if (this.pending === pending) { this.pending = undefined; void pending.result.complete(false); } }, 60000);
		try {
			if (!await this.opener.open(URI.parse(url.toString()), { openExternal: true })) { await pending.result.complete(false); }
			return await pending.result.p;
		} catch { return false; }
		finally { clearTimeout(timer); if (this.pending === pending) { this.pending = undefined; } }
	}
}

registerWorkbenchContribution2(BackboardAttributionContribution.ID, BackboardAttributionContribution, WorkbenchPhase.BlockRestore);
