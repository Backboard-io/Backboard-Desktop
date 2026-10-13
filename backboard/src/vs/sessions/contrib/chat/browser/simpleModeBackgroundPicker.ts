/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import './media/simpleModeBackgroundPicker.css';
import * as DOM from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { AnchorPosition } from '../../../../base/common/layout.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { FileAccess } from '../../../../base/common/network.js';
import { localize } from '../../../../nls.js';
import { IContextViewService, IOpenContextView } from '../../../../platform/contextview/browser/contextView.js';
import { simpleModeBackgroundPresets } from './simpleModeBackgroundPresets.js';
import { ISimpleModeBackgroundService } from './simpleModeBackgroundService.js';

export class SimpleModeBackgroundPicker extends Disposable {
	private view: IOpenContextView | undefined;

	constructor(
		@IContextViewService private readonly contextViewService: IContextViewService,
		@ISimpleModeBackgroundService private readonly backgroundService: ISimpleModeBackgroundService,
	) {
		super();
		this._register(toDisposable(() => this.view?.close()));
	}

	toggle(anchor: HTMLElement): void {
		if (this.view) {
			this.view.close();
			return;
		}
		anchor.setAttribute('aria-haspopup', 'dialog');
		anchor.setAttribute('aria-expanded', 'true');
		let focusTarget: HTMLElement | undefined;
		this.view = this.contextViewService.showContextView({
			getAnchor: () => anchor,
			anchorPosition: AnchorPosition.ABOVE,
			focus: () => focusTarget?.focus(),
			onHide: () => {
				this.view = undefined;
				anchor.setAttribute('aria-expanded', 'false');
			},
			render: container => {
				const store = new DisposableStore();
				const root = DOM.append(container, DOM.$('.simple-background-picker', { role: 'dialog', 'aria-label': localize('backgroundPicker.title', "Background") }));
				store.add(toDisposable(() => root.remove()));
				const button = (parent: HTMLElement, className: string, label: string) => DOM.append(parent, DOM.$(`button.${className}`, { type: 'button', 'aria-label': label })) as HTMLButtonElement;
				const heading = DOM.append(root, DOM.$('.simple-background-picker-heading'));
				DOM.append(heading, DOM.$('span', {}, localize('backgroundPicker.title', "Background")));
				const close = button(heading, 'simple-background-picker-icon', localize('backgroundPicker.close', "Close"));
				close.appendChild(renderIcon(Codicon.close));
				const preview = button(root, 'simple-background-picker-preview', '');
				const image = DOM.append(preview, DOM.$('img', { alt: '', draggable: 'false' })) as HTMLImageElement;
				const placeholder = DOM.append(preview, DOM.$('span.simple-background-picker-placeholder'));
				const meta = DOM.append(root, DOM.$('.simple-background-picker-meta'));
				const previous = button(meta, 'simple-background-picker-icon', localize('backgroundPicker.previous', "Previous Background"));
				previous.appendChild(renderIcon(Codicon.chevronLeft));
				const caption = DOM.append(meta, DOM.$('span.simple-background-picker-caption', { 'aria-live': 'polite', 'aria-atomic': 'true' }));
				const next = button(meta, 'simple-background-picker-icon', localize('backgroundPicker.next', "Next Background"));
				next.appendChild(renderIcon(Codicon.chevronRight));
				const filmstrip = DOM.append(root, DOM.$('.simple-background-picker-filmstrip', { role: 'group', 'aria-label': localize('backgroundPicker.choices', "Background Choices") }));
				const apply = button(root, 'simple-background-picker-apply', localize('backgroundPicker.use', "Use Background"));
				const labels = [localize('backgroundPicker.default', "Theme Default"), ...simpleModeBackgroundPresets.map(preset => preset.label), localize('backgroundPicker.custom', "Add Your Own")];
				const current = this.backgroundService.backgroundImage;
				const match = simpleModeBackgroundPresets.findIndex(preset => preset.resource.toString() === current?.toString());
				let index = !current ? 0 : match >= 0 ? match + 1 : labels.length - 1;
				let busy = false;
				const thumbnails = labels.map((label, thumbnailIndex) => {
					const thumbnail = button(filmstrip, 'simple-background-picker-thumbnail', label);
					thumbnail.title = label;
					const preset = simpleModeBackgroundPresets[thumbnailIndex - 1];
					if (preset) {
						DOM.append(thumbnail, DOM.$('img', { src: FileAccess.uriToBrowserUri(preset.resource).toString(true), alt: '', loading: 'lazy', draggable: 'false' }));
					} else {
						thumbnail.appendChild(renderIcon(thumbnailIndex === 0 ? Codicon.colorMode : Codicon.add));
					}
					store.add(DOM.addDisposableListener(thumbnail, 'click', () => show(thumbnailIndex)));
					return thumbnail;
				});
				store.add(DOM.addDisposableListener(filmstrip, 'wheel', (event: WheelEvent) => {
					if (event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) {
						return;
					}
					event.preventDefault();
					const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? filmstrip.clientWidth : 1;
					filmstrip.scrollLeft += event.deltaY * scale;
				}, { passive: false }));
				const show = (newIndex: number) => {
					index = (newIndex + labels.length) % labels.length;
					const firstVisible = Math.min(Math.max(0, index - 2), labels.length - 5);
					filmstrip.scrollTo({ left: thumbnails[firstVisible].offsetLeft, behavior: DOM.getWindow(root).matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
					const preset = simpleModeBackgroundPresets[index - 1];
					image.hidden = !preset;
					if (preset) {
						image.src = FileAccess.uriToBrowserUri(preset.resource).toString(true);
					} else {
						image.removeAttribute('src');
					}
					placeholder.hidden = !!preset;
					DOM.clearNode(placeholder);
					placeholder.appendChild(renderIcon(index === 0 ? Codicon.colorMode : Codicon.add));
					DOM.append(placeholder, DOM.$('span', {}, labels[index]));
					preview.classList.toggle('is-default', index === 0);
					preview.setAttribute('aria-label', labels[index]);
					caption.textContent = localize('backgroundPicker.position', "{0} · {1}/{2}", labels[index], index + 1, labels.length);
					const selected = index === 0 ? !this.backgroundService.backgroundImage : !!preset && preset.resource.toString() === this.backgroundService.backgroundImage?.toString();
					apply.textContent = index === labels.length - 1 ? localize('backgroundPicker.custom', "Add Your Own") : selected ? localize('backgroundPicker.selected', "Selected") : localize('backgroundPicker.use', "Use Background");
					apply.setAttribute('aria-label', apply.textContent);
					apply.disabled = selected || busy;
					for (const [i, thumbnail] of thumbnails.entries()) {
						thumbnail.setAttribute('aria-pressed', String(i === index));
					}
				};
				const select = async () => {
					if (busy) {
						return;
					}
					busy = true;
					apply.disabled = true;
					try {
						if (index === 0) {
							this.backgroundService.clearBackgroundImage();
						} else if (index === labels.length - 1) {
							this.view?.close();
							anchor.focus();
							await this.backgroundService.chooseBackgroundImage();
						} else {
							this.backgroundService.selectPresetBackground(simpleModeBackgroundPresets[index - 1].id);
						}
					} catch (error) {
						onUnexpectedError(error);
					} finally {
						busy = false;
						show(index);
					}
				};
				const dismiss = () => { this.view?.close(); anchor.focus(); };
				store.add(DOM.addDisposableListener(close, 'click', dismiss));
				store.add(DOM.addDisposableListener(previous, 'click', () => show(index - 1)));
				store.add(DOM.addDisposableListener(next, 'click', () => show(index + 1)));
				store.add(DOM.addDisposableListener(preview, 'click', () => void select()));
				store.add(DOM.addDisposableListener(apply, 'click', () => void select()));
				store.add(this.backgroundService.onDidChangeBackgroundImage(() => show(index)));
				store.add(DOM.addDisposableListener(root, 'keydown', (event: KeyboardEvent) => {
					if (event.key === 'Escape') {
						event.preventDefault(); event.stopPropagation(); dismiss();
					}
					if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
						event.preventDefault(); event.stopPropagation(); show(index + (event.key === 'ArrowLeft' ? -1 : 1));
					}
					if (event.key === 'Tab') {
						const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
						const first = buttons[0];
						const last = buttons[buttons.length - 1];
						if (event.shiftKey && root.ownerDocument.activeElement === first) {
							event.preventDefault(); last.focus();
						} else if (!event.shiftKey && root.ownerDocument.activeElement === last) {
							event.preventDefault(); first.focus();
						}
					}
				}));
				store.add(DOM.addDisposableListener(anchor.ownerDocument, 'pointerdown', (event: PointerEvent) => {
					if (!root.contains(event.target as Node) && !anchor.contains(event.target as Node)) {
						this.view?.close();
					}
				}, true));
				show(index);
				focusTarget = preview;
				return store;
			},
		});
	}
}
