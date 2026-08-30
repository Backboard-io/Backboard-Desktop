/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DisposableStore, IDisposable } from '../../../util/vs/base/common/lifecycle';
import { ServicesAccessor } from '../../../util/vs/platform/instantiation/common/instantiation';
import * as commands from './commands';

export function create(accessor: ServicesAccessor): IDisposable {
	const disposableStore = new DisposableStore();
	disposableStore.add(commands.register(accessor));

	return disposableStore;
}
