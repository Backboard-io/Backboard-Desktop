/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $ } from '../../../../base/browser/dom.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorGroupsService, IModalEditorPart } from '../../../../workbench/services/editor/common/editorGroupsService.js';

export type RightWorkbenchEditorKind = 'files' | 'review' | 'browser' | 'terminal';

/**
 * A fixed pool of four editor hosts, independent of the number of panel tabs.
 * Native editor groups retain document models and view state, and reuse panes
 * by editor type. Hiding a tool must not close its documents or running shells.
 */
export class RightWorkbenchEditorPool extends Disposable {

	private readonly entries = new Map<RightWorkbenchEditorKind, {
		readonly host: HTMLElement;
		readonly store: DisposableStore;
		part?: IModalEditorPart;
		pending?: Promise<IModalEditorPart>;
	}>();

	constructor(@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService) {
		super();
	}

	getHost(kind: RightWorkbenchEditorKind): HTMLElement {
		let entry = this.entries.get(kind);
		if (!entry) {
			entry = { host: $('.sessions-right-workbench-embedded-editor-host'), store: this._register(new DisposableStore()) };
			this.entries.set(kind, entry);
		}
		return entry.host;
	}

	getPart(host: HTMLElement | undefined): IModalEditorPart | undefined {
		return this.findEntry(host)?.part;
	}

	async acquire(host: HTMLElement): Promise<IModalEditorPart> {
		const entry = this.findEntry(host);
		if (!entry) {
			throw new Error('Unknown right workbench editor host');
		}
		if (entry.part) {
			return entry.part;
		}
		if (!entry.pending) {
			entry.pending = this.editorGroupsService.createModalEditorPart({ embeddedHost: host, maximized: true }).then(part => {
				entry.part = part;
				entry.store.add(Event.once(part.onWillClose)(() => {
					entry.part = undefined;
					entry.store.clear();
				}));
				return part;
			}).finally(() => { entry.pending = undefined; });
		}
		return entry.pending;
	}

	setVisible(host: HTMLElement | undefined, visible: boolean): void {
		const part = this.getPart(host);
		for (const group of part?.groups ?? []) {
			const pane = group.activeEditorPane;
			if (pane instanceof EditorPane && pane.isVisible() !== visible) {
				pane.setVisible(visible);
			}
		}
	}

	async closeEditors(inputs: readonly EditorInput[]): Promise<boolean> {
		for (const entry of this.entries.values()) {
			for (const group of entry.part?.groups ?? []) {
				const editors = inputs.filter(input => group.contains(input));
				if (editors.length && !await group.closeEditors(editors)) {
					return false;
				}
			}
		}
		return true;
	}

	private findEntry(host: HTMLElement | undefined) {
		return host ? [...this.entries.values()].find(entry => entry.host === host) : undefined;
	}

	override dispose(): void {
		for (const entry of this.entries.values()) {
			// The workbench owns document disposal and dirty-file confirmation.
			// Transfer any remaining inputs before releasing this embedded part.
			void (entry.pending ?? Promise.resolve(entry.part)).then(part => part?.close({ mergeAllEditorsToMainPart: true }));
		}
		super.dispose();
	}
}
