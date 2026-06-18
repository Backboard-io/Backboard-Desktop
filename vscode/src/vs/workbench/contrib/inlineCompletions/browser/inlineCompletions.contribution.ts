/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { withoutDuplicates } from '../../../../base/common/arrays.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { autorun, observableFromEvent } from '../../../../base/common/observable.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { inlineCompletionProviderGetMatcher, providerIdSchemaUri } from '../../../../editor/contrib/inlineCompletions/browser/controller/commands.js';
import { Extensions, IJSONContributionRegistry } from '../../../../platform/jsonschemas/common/jsonContributionRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';

export class InlineCompletionSchemaContribution extends Disposable implements IWorkbenchContribution {
	public static Id = 'vs.contrib.InlineCompletionSchemaContribution';

	constructor(
		@ILanguageFeaturesService private readonly _languageFeaturesService: ILanguageFeaturesService,
	) {
		super();

		const registry = Registry.as<IJSONContributionRegistry>(Extensions.JSONContribution);
		const inlineCompletionsProvider = observableFromEvent(this,
			this._languageFeaturesService.inlineCompletionsProvider.onDidChange,
			() => this._languageFeaturesService.inlineCompletionsProvider.allNoModel()
		);

		this._register(autorun(reader => {
			const provider = inlineCompletionsProvider.read(reader);
			registry.registerSchema(providerIdSchemaUri, {
				enum: withoutDuplicates(provider.flatMap(p => inlineCompletionProviderGetMatcher(p))),
			}, reader.store);
		}));
	}
}

registerWorkbenchContribution2(InlineCompletionSchemaContribution.Id, InlineCompletionSchemaContribution, WorkbenchPhase.Eventually);
