/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { equals } from '../../../../base/common/arrays.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ISettableObservable, observableValue, ValueWithChangeEventFromObservable } from '../../../../base/common/observable.js';
import { isEqual } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { isIChatSessionFileChange2 } from '../../../../workbench/contrib/chat/common/chatSessionsService.js';
import { IMultiDiffSourceResolver, IMultiDiffSourceResolverService, IResolvedMultiDiffSource, MultiDiffEditorItem } from '../../../../workbench/contrib/multiDiffEditor/browser/multiDiffSourceResolverService.js';
import { ISessionFileChange } from '../../../services/sessions/common/session.js';

/** Keeps a chat's stacked diff input stable as streamed edits add or update files. */
export class RightWorkbenchReviewSource extends Disposable implements IMultiDiffSourceResolver {
	private readonly id = generateUuid();
	private current: {
		readonly generation: number;
		readonly uri: URI;
		readonly items: ISettableObservable<readonly MultiDiffEditorItem[]>;
		readonly source: IResolvedMultiDiffSource;
	} | undefined;

	constructor(@IMultiDiffSourceResolverService resolverService: IMultiDiffSourceResolverService) {
		super();
		this._register(resolverService.registerResolver(this));
	}

	update(changes: readonly ISessionFileChange[], generation: number): URI {
		if (this.current?.generation !== generation) {
			const items = observableValue<readonly MultiDiffEditorItem[]>(this, []);
			this.current = {
				generation,
				uri: URI.from({ scheme: 'right-workbench-review', path: `/${this.id}/${generation}` }),
				items,
				source: { resources: new ValueWithChangeEventFromObservable(items) },
			};
		}

		const previous = this.current.items.get();
		const byKey = new Map(previous.map(item => [item.getKey(), item]));
		const items = changes.map(change => {
			const modifiedUri = isIChatSessionFileChange2(change) ? change.modifiedUri ?? change.uri : change.modifiedUri;
			const goToFileUri = isIChatSessionFileChange2(change) ? change.uri : change.modifiedUri;
			const item = new MultiDiffEditorItem(change.originalUri, modifiedUri, goToFileUri);
			const existing = byKey.get(item.getKey());
			return existing && isEqual(existing.goToFileUri, goToFileUri) ? existing : item;
		});
		// Avoid publishing line-count-only updates: the existing diff models
		// already observe changes to their text buffers.
		if (!equals(previous, items)) {
			this.current.items.set(items, undefined);
		}
		return this.current.uri;
	}

	canHandleUri(uri: URI): boolean {
		return isEqual(this.current?.uri, uri);
	}

	async resolveDiffSource(uri: URI): Promise<IResolvedMultiDiffSource> {
		if (!this.current || !this.canHandleUri(uri)) {
			throw new Error('The review context has changed');
		}
		return this.current.source;
	}
}
