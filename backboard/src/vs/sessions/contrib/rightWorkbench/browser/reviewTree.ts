/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { append, $ } from '../../../../base/browser/dom.js';
import { IListVirtualDelegate } from '../../../../base/browser/ui/list/list.js';
import { ICompressedTreeElement, ICompressedTreeNode } from '../../../../base/browser/ui/tree/compressedObjectTreeModel.js';
import { ICompressibleTreeRenderer } from '../../../../base/browser/ui/tree/objectTree.js';
import { ITreeNode, ITreeSorter } from '../../../../base/browser/ui/tree/tree.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { compareFileNames } from '../../../../base/common/comparers.js';
import { basename, dirname, extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import { IResourceNode, ResourceTree } from '../../../../base/common/resourceTree.js';
import { URI } from '../../../../base/common/uri.js';
import { FileKind } from '../../../../platform/files/common/files.js';
import { localize } from '../../../../nls.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { IResourceLabel, ResourceLabels } from '../../../../workbench/browser/labels.js';

export interface IReviewResource {
	readonly key: string;
	readonly sourceUri: URI;
	readonly status: string;
	/** Drives the row's status badge; resources without one render as modified. */
	readonly kind?: ReviewResourceKind;
	readonly additions?: number;
	readonly deletions?: number;
	/** Opens the resource in the review editor; resolves to false if nothing was shown. */
	open(): Promise<boolean>;
}

export type ReviewResourceKind = 'added' | 'deleted' | 'modified';

export type ReviewTreeElement = IReviewResource | IResourceNode<IReviewResource, void>;

export function isReviewResource(element: ReviewTreeElement): element is IReviewResource {
	return !ResourceTree.isResourceNode(element);
}

/**
 * Groups a flat list of review resources into a folder tree, mirroring the
 * grouping algorithm used by the real changes tree (see changesViewRenderer.ts'
 * buildTreeChildren) but for the lightweight SCM/git fallback resources which
 * don't carry session-changeset-specific data.
 */
export function buildReviewTreeChildren(resources: readonly IReviewResource[]): ICompressedTreeElement<ReviewTreeElement>[] {
	if (resources.length === 0) {
		return [];
	}

	// Root the tree at the deepest common directory. The review panel is a
	// narrow inspection surface, so rendering /Users/name/... for every change
	// wastes most of the rail before the first useful project folder appears.
	let commonRoot = dirname(resources[0].sourceUri);
	while (!resources.every(resource => extUriBiasedIgnorePathCase.isEqualOrParent(resource.sourceUri, commonRoot))) {
		const parent = dirname(commonRoot);
		if (extUriBiasedIgnorePathCase.isEqual(parent, commonRoot)) {
			break;
		}
		commonRoot = parent;
	}

	const resourceTree = new ResourceTree<IReviewResource, void>(undefined, commonRoot, extUriBiasedIgnorePathCase);
	for (const resource of resources) {
		resourceTree.add(resource.sourceUri, resource);
	}

	function convertChildren(parent: IResourceNode<IReviewResource, void>): ICompressedTreeElement<ReviewTreeElement>[] {
		const result: ICompressedTreeElement<ReviewTreeElement>[] = [];
		for (const child of parent.children) {
			if (child.element && child.childrenCount === 0) {
				result.push({ element: child.element, collapsible: false, incompressible: true });
			} else {
				result.push({ element: child, children: convertChildren(child), collapsible: true, collapsed: false });
			}
		}
		return result;
	}

	return convertChildren(resourceTree.root);
}

export class ReviewTreeDelegate implements IListVirtualDelegate<ReviewTreeElement> {
	static readonly ROW_HEIGHT = 24;

	getHeight(_element: ReviewTreeElement): number {
		return ReviewTreeDelegate.ROW_HEIGHT;
	}

	getTemplateId(_element: ReviewTreeElement): string {
		return ReviewTreeRenderer.TEMPLATE_ID;
	}
}

export class ReviewTreeSorter implements ITreeSorter<ReviewTreeElement> {
	compare(a: ReviewTreeElement, b: ReviewTreeElement): number {
		const aIsDirectory = ResourceTree.isResourceNode(a);
		const bIsDirectory = ResourceTree.isResourceNode(b);
		if (aIsDirectory !== bIsDirectory) {
			return aIsDirectory ? -1 : 1;
		}
		const aName = ResourceTree.isResourceNode(a) ? a.name : basename(a.sourceUri);
		const bName = ResourceTree.isResourceNode(b) ? b.name : basename(b.sourceUri);
		return compareFileNames(aName, bName);
	}
}

interface IReviewTreeTemplate {
	readonly label: IResourceLabel;
	readonly stats: HTMLElement;
	readonly additions: HTMLElement;
	readonly deletions: HTMLElement;
	readonly badge: HTMLElement;
	readonly templateDisposables: DisposableStore;
}

export class ReviewTreeRenderer implements ICompressibleTreeRenderer<ReviewTreeElement, void, IReviewTreeTemplate> {
	static readonly TEMPLATE_ID = 'reviewTreeRenderer';
	readonly templateId = ReviewTreeRenderer.TEMPLATE_ID;

	constructor(
		private readonly labels: ResourceLabels,
		@ILabelService private readonly labelService: ILabelService,
	) { }

	renderTemplate(container: HTMLElement): IReviewTreeTemplate {
		const templateDisposables = new DisposableStore();
		const label = templateDisposables.add(this.labels.create(container, { supportHighlights: true }));
		const stats = append(label.element, $('.sessions-right-workbench-review-scm-stats'));
		const additions = append(stats, $('span.sessions-right-workbench-review-scm-additions'));
		const deletions = append(stats, $('span.sessions-right-workbench-review-scm-deletions'));
		const badge = append(label.element, $('span.sessions-right-workbench-review-scm-badge'));
		badge.setAttribute('aria-hidden', 'true');
		return { label, stats, additions, deletions, badge, templateDisposables };
	}

	renderElement(node: ITreeNode<ReviewTreeElement, void>, _index: number, templateData: IReviewTreeTemplate): void {
		const element = node.element;
		if (isReviewResource(element)) {
			const path = this.labelService.getUriLabel(element.sourceUri, { relative: true });
			const title = element.additions !== undefined || element.deletions !== undefined
				? localize('rightWorkbench.reviewFileTitleWithCounts', "{0} · {1} (+{2} -{3})", path, element.status, element.additions ?? 0, element.deletions ?? 0)
				: localize('rightWorkbench.reviewFileTitle', "{0} · {1}", path, element.status);
			templateData.label.setResource({ resource: element.sourceUri, name: basename(element.sourceUri) }, { fileKind: FileKind.FILE, title });
			this.updateStats(templateData, element.additions, element.deletions);
			this.updateBadge(templateData, element.kind ?? 'modified');
		} else {
			templateData.label.setResource({ resource: element.uri, name: element.name }, { fileKind: FileKind.FOLDER });
			this.updateStats(templateData, undefined, undefined);
			this.updateBadge(templateData, undefined);
		}
	}

	renderCompressedElements(node: ITreeNode<ICompressedTreeNode<ReviewTreeElement>, void>, _index: number, templateData: IReviewTreeTemplate): void {
		const compressed = node.element as ICompressedTreeNode<IResourceNode<IReviewResource, void>>;
		const folder = compressed.elements[compressed.elements.length - 1];
		const name = compressed.elements.map(element => element.name);
		templateData.label.setResource({ resource: folder.uri, name }, {
			fileKind: FileKind.FOLDER,
			separator: this.labelService.getSeparator(folder.uri.scheme, folder.uri.authority),
		});
		this.updateStats(templateData, undefined, undefined);
		this.updateBadge(templateData, undefined);
	}

	private updateBadge(templateData: IReviewTreeTemplate, kind: ReviewResourceKind | undefined): void {
		templateData.badge.classList.toggle('empty', !kind);
		templateData.badge.dataset.kind = kind ?? '';
	}

	private updateStats(templateData: IReviewTreeTemplate, additions: number | undefined, deletions: number | undefined): void {
		if (additions === undefined && deletions === undefined) {
			templateData.stats.classList.add('empty');
			templateData.additions.textContent = '';
			templateData.deletions.textContent = '';
			return;
		}
		templateData.stats.classList.remove('empty');
		templateData.additions.textContent = `+${additions ?? 0}`;
		templateData.deletions.textContent = `-${deletions ?? 0}`;
	}

	disposeTemplate(templateData: IReviewTreeTemplate): void {
		templateData.templateDisposables.dispose();
	}
}
