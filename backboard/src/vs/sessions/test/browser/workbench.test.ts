/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { Workbench } from '../../browser/workbench.js';
import { Parts } from '../../../workbench/services/layout/browser/layoutService.js';

interface IWorkbenchTestHarness {
	partVisibility: {
		sidebar: boolean;
		auxiliaryBar: boolean;
		editor: boolean;
		panel: boolean;
		sessions: boolean;
	};
	layoutPolicy: {
		viewportClass: {
			get(): 'phone' | 'tablet' | 'desktop';
		};
	};
	storageService: {
		store(...args: unknown[]): void;
	};
	_editorMaximized: boolean;
	_restoreAttachedEditorMaximizedOnShow: boolean;
	setEditorMaximized(maximized: boolean): void;
	setEditorHidden(hidden: boolean): void;
	setAuxiliaryBarHidden(hidden: boolean): void;
	setAuxiliaryBarMaximized(maximized: boolean): boolean;
	_savePartVisibility(): void;
}

suite('Sessions - Workbench', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const restoreAttachedEditorMaximizedState = Reflect.get(Workbench.prototype, 'restoreAttachedEditorMaximizedState') as (this: IWorkbenchTestHarness) => void;
	const setAuxiliaryBarHidden = Reflect.get(Workbench.prototype, 'setAuxiliaryBarHidden') as (this: IWorkbenchTestHarness, hidden: boolean) => void;
	const loadPartVisibility = Reflect.get(Workbench.prototype, '_loadPartVisibility') as (this: IWorkbenchTestHarness, storageService: { get(): string | undefined; remove(): void }) => { editor?: boolean; auxiliaryBar?: boolean; sidebar?: boolean };
	const savePartVisibility = Reflect.get(Workbench.prototype, '_savePartVisibility') as (this: IWorkbenchTestHarness) => void;
	const setEditorHidden = Reflect.get(Workbench.prototype, 'setEditorHidden') as (this: IEditorSplitTestHarness, hidden: boolean) => void;
	const applyEditorSplitSize = Reflect.get(Workbench.prototype, '_applyEditorSplitSize') as (this: IEditorSplitTestHarness) => void;
	const setAuxiliaryBarMaximized = Reflect.get(Workbench.prototype, 'setAuxiliaryBarMaximized') as (this: IAuxiliaryBarMaximizeTestHarness, maximized: boolean) => boolean;
	const requestVisibleAuxiliaryBar = Reflect.get(Workbench.prototype, 'setAuxiliaryBarHidden') as (this: IVisibleAuxiliaryBarTestHarness, hidden: boolean) => void;
	const normalizeSimpleAuxiliaryBarWidth = Reflect.get(Workbench.prototype, 'normalizeSimpleAuxiliaryBarWidth') as (this: ISimpleAuxiliaryBarWidthTestHarness, ensureComfortableWidth?: boolean) => void;
	const createDesktopGridDescriptor = Reflect.get(Workbench.prototype, 'createDesktopGridDescriptor') as (this: IGridDescriptorTestHarness, width: number, height: number) => {
		root: { data: unknown[] };
	};

	interface IEditorSplitTestHarness {
		readonly editorPartView: object;
		readonly auxiliaryBarPartView: object;
		readonly sessionsPartView: object;
		readonly mainContainer: { classList: { toggle(name: string, force: boolean): void } };
		readonly workbenchGrid: {
			getViewSize(view: object): { width: number; height: number };
			setViewVisible(view: object, visible: boolean): void;
			resizeView(view: object, size: { width: number; height: number }): void;
		};
		readonly resizes: { width: number; height: number }[];
		readonly visibilityChanges: boolean[];
		partVisibility: { auxiliaryBar: boolean; editor: boolean };
		_editorMaximized: boolean;
		_hasAppliedInitialEditorSplit: boolean;
		setEditorMaximized(maximized: boolean): void;
		_applyEditorSplitSize(): void;
		_savePartVisibility(): void;
	}

	interface IGridDescriptorTestHarness {
		partVisibility: {
			sidebar: boolean;
			auxiliaryBar: boolean;
			editor: boolean;
			panel: boolean;
			sessions: boolean;
		};
		_savedPartSizes: {
			sidebar?: number;
			auxiliaryBar?: number;
			editor?: number;
			panel?: number;
			sessions?: number;
		};
		layoutPolicy: {
			viewportClass: {
				get(): 'phone' | 'tablet' | 'desktop';
			};
			getPartSizes(width: number, height: number): {
				sideBarSize: number;
				auxiliaryBarSize: number;
				panelSize: number;
				sessionsWidth: number;
			};
		};
	}

	interface IAuxiliaryBarMaximizeTestHarness {
		readonly partsAnimationScheduler: { cancel(): void };
		readonly mainContainer: { classList: { remove(name: string): void } };
		readonly sideBarPartView: object;
		readonly sessionsPartView: object;
		readonly editorPartView: object;
		readonly auxiliaryBarPartView: object;
		readonly panelPartView: object;
		readonly workbenchGrid: {
			isViewMaximized(view: object): boolean;
			isViewVisible(view: object): boolean;
			maximizeView(view: object, excludeViews: readonly object[]): void;
		};
		readonly _onDidChangeAuxiliaryBarMaximized: { fire(): void };
		_auxiliaryBarLastNonMaximizedVisibility: {
			sidebar: boolean;
			sessions: boolean;
			editor: boolean;
			auxiliaryBar: boolean;
			panel: boolean;
		} | undefined;
		isAuxiliaryBarMaximized(): boolean;
		finishPartsAnimation(): void;
	}

	interface IVisibleAuxiliaryBarTestHarness {
		partVisibility: { auxiliaryBar: boolean };
		normalizeSimpleAuxiliaryBarWidth(ensureComfortableWidth?: boolean): void;
	}

	interface ISimpleAuxiliaryBarWidthTestHarness {
		readonly auxiliaryBarPartView: object;
		readonly sideBarPartView: object;
		readonly workbenchGrid: {
			isViewMaximized(view: object): boolean;
			exitMaximizedView(): void;
			getViewSize(view: object): { width: number; height: number };
			resizeView(view: object, size: { width: number; height: number }): void;
		};
		readonly _mainContainerDimension: { width: number; height: number };
		readonly _isOptimusWindow: boolean;
		partVisibility: { sidebar: boolean; auxiliaryBar: boolean; editor: boolean };
	}

	function createEditorSplitHarness(rightWorkColumnWidth: number, overrides?: Partial<Pick<IEditorSplitTestHarness, 'partVisibility' | '_hasAppliedInitialEditorSplit'>>): IEditorSplitTestHarness {
		const editorPartView = {};
		const auxiliaryBarPartView = {};
		const sessionsPartView = {};
		const resizes: { width: number; height: number }[] = [];
		const visibilityChanges: boolean[] = [];
		const editorSize = { width: 0, height: 800 };
		const auxiliaryBarSize = { width: rightWorkColumnWidth, height: 800 };
		return {
			editorPartView,
			auxiliaryBarPartView,
			sessionsPartView,
			mainContainer: { classList: { toggle: () => { } } },
			workbenchGrid: {
				getViewSize: view => {
					if (view === sessionsPartView) {
						return { width: rightWorkColumnWidth, height: 800 };
					}
					if (view === auxiliaryBarPartView) {
						return auxiliaryBarSize;
					}
					return editorSize;
				},
				setViewVisible: (_view, visible) => visibilityChanges.push(visible),
				resizeView: (_view, size) => {
					resizes.push(size);
					if (_view === auxiliaryBarPartView) {
						auxiliaryBarSize.width = size.width;
					} else {
						editorSize.width = size.width;
					}
				},
			},
			resizes,
			visibilityChanges,
			partVisibility: { auxiliaryBar: true, editor: false },
			_editorMaximized: false,
			_hasAppliedInitialEditorSplit: false,
			setEditorMaximized: () => { },
			_applyEditorSplitSize: applyEditorSplitSize,
			_savePartVisibility: () => { },
			...overrides,
		};
	}

	test('sizes editor beside the auxiliary rail the first time the editor is revealed', () => {
		const workbench = createEditorSplitHarness(1000);

		setEditorHidden.call(workbench, false);

		assert.deepStrictEqual({
			editorVisible: workbench.partVisibility.editor,
			appliedSplit: workbench._hasAppliedInitialEditorSplit,
			visibilityChanges: workbench.visibilityChanges,
			resizes: workbench.resizes,
		}, {
			editorVisible: true,
			appliedSplit: true,
			visibilityChanges: [true],
			resizes: [{ width: 240, height: 800 }, { width: 760, height: 800 }],
		});
	});

	test('does not re-apply the even split on later editor reveals', () => {
		const workbench = createEditorSplitHarness(1000, { _hasAppliedInitialEditorSplit: true });

		setEditorHidden.call(workbench, false);

		assert.deepStrictEqual({
			editorVisible: workbench.partVisibility.editor,
			visibilityChanges: workbench.visibilityChanges,
			resizes: workbench.resizes,
		}, {
			editorVisible: true,
			visibilityChanges: [true],
			resizes: [],
		});
	});

	test('clamps the auxiliary rail when sizing the editor split', () => {
		const workbench = createEditorSplitHarness(400);

		setEditorHidden.call(workbench, false);

		assert.deepStrictEqual(workbench.resizes, [{ width: 120, height: 800 }, { width: 280, height: 800 }]);
	});

	test('places editor before auxiliary rail in the right workbench grid', () => {
		const workbench: IGridDescriptorTestHarness = {
			partVisibility: {
				sidebar: true,
				auxiliaryBar: true,
				editor: true,
				panel: false,
				sessions: true,
			},
			_savedPartSizes: {},
			layoutPolicy: {
				viewportClass: { get: () => 'desktop' },
				getPartSizes: width => ({
					sideBarSize: 300,
					auxiliaryBarSize: 340,
					panelSize: 300,
					sessionsWidth: width - 300,
				}),
			},
		};

		const descriptor = createDesktopGridDescriptor.call(workbench, 1400, 900) as {
			root: {
				data: [
					unknown,
					{
						data: [
							{
								data: [
									{ data: { type: Parts } },
									{ data: { type: Parts } },
									{ data: { type: Parts } },
								]
							},
							unknown
						]
					}
				]
			}
		};
		const topRightSection = descriptor.root.data[1].data[0];

		assert.deepStrictEqual(topRightSection.data.map(node => node.data.type), [
			Parts.SESSIONS_PART,
			Parts.EDITOR_PART,
			Parts.AUXILIARYBAR_PART,
		]);
	});

	test('preserves the simple canvas when restoring a narrow desktop grid', () => {
		const workbench: IGridDescriptorTestHarness & { _isOptimusWindow: boolean; } = {
			_isOptimusWindow: false,
			partVisibility: {
				sidebar: false,
				auxiliaryBar: true,
				editor: false,
				panel: false,
				sessions: true,
			},
			_savedPartSizes: { sessions: 100, auxiliaryBar: 560 },
			layoutPolicy: {
				viewportClass: { get: () => 'desktop' },
				getPartSizes: width => ({
					sideBarSize: 300,
					auxiliaryBarSize: 340,
					panelSize: 300,
					sessionsWidth: width,
				}),
			},
		};
		const descriptor = createDesktopGridDescriptor.call(workbench, 660, 880) as {
			root: { data: [unknown, { size: number }, unknown, { size: number }] };
		};

		assert.deepStrictEqual({
			sessionsWidth: descriptor.root.data[1].size,
			auxiliaryBarWidth: descriptor.root.data[3].size,
		}, {
			sessionsWidth: 300,
			auxiliaryBarWidth: 360,
		});
	});

	test('finishes a panel transition before maximizing the auxiliary bar', () => {
		const events: string[] = [];
		const sideBarPartView = {};
		const sessionsPartView = {};
		const editorPartView = {};
		const auxiliaryBarPartView = {};
		const panelPartView = {};
		const workbench = Object.create(Workbench.prototype) as IAuxiliaryBarMaximizeTestHarness;
		Object.assign(workbench, {
			partsAnimationScheduler: { cancel: () => events.push('cancel-animation') },
			mainContainer: { classList: { remove: () => events.push('remove-animation-class') } },
			sideBarPartView,
			sessionsPartView,
			editorPartView,
			auxiliaryBarPartView,
			panelPartView,
			workbenchGrid: {
				isViewMaximized: () => false,
				isViewVisible: () => true,
				maximizeView: () => events.push('maximize'),
			},
			_onDidChangeAuxiliaryBarMaximized: { fire: () => events.push('fire-change') },
		});

		assert.strictEqual(setAuxiliaryBarMaximized.call(workbench, true), true);
		assert.deepStrictEqual(events, ['cancel-animation', 'remove-animation-class', 'maximize', 'fire-change']);
	});

	test('rebalances the simple tool pane when an already-visible mode is requested', () => {
		const calls: (boolean | undefined)[] = [];
		const workbench: IVisibleAuxiliaryBarTestHarness = {
			partVisibility: { auxiliaryBar: true },
			normalizeSimpleAuxiliaryBarWidth: ensureComfortableWidth => calls.push(ensureComfortableWidth),
		};

		requestVisibleAuxiliaryBar.call(workbench, false);

		assert.deepStrictEqual(calls, [true]);
	});

	test('keeps a 300px simple canvas when a stale tool width is restored', () => {
		const auxiliaryBarPartView = {};
		const sideBarPartView = {};
		const resizes: { width: number; height: number }[] = [];
		const workbench: ISimpleAuxiliaryBarWidthTestHarness = {
			auxiliaryBarPartView,
			sideBarPartView,
			_mainContainerDimension: { width: 660, height: 880 },
			_isOptimusWindow: false,
			partVisibility: { sidebar: false, auxiliaryBar: true, editor: false },
			workbenchGrid: {
				isViewMaximized: () => false,
				exitMaximizedView: () => { },
				getViewSize: view => view === auxiliaryBarPartView
					? { width: 560, height: 880 }
					: { width: 0, height: 880 },
				resizeView: (_view, size) => resizes.push(size),
			},
		};

		normalizeSimpleAuxiliaryBarWidth.call(workbench, true);

		assert.deepStrictEqual(resizes, [{ width: 360, height: 880 }]);
	});

	test('restores a maximized simple tool pane when another mode is requested', () => {
		const auxiliaryBarPartView = {};
		const sideBarPartView = {};
		const events: string[] = [];
		let maximized = true;
		const workbench: ISimpleAuxiliaryBarWidthTestHarness = {
			auxiliaryBarPartView,
			sideBarPartView,
			_mainContainerDimension: { width: 660, height: 880 },
			_isOptimusWindow: false,
			partVisibility: { sidebar: false, auxiliaryBar: true, editor: false },
			workbenchGrid: {
				isViewMaximized: () => maximized,
				exitMaximizedView: () => {
					maximized = false;
					events.push('restore');
				},
				getViewSize: view => view === auxiliaryBarPartView
					? { width: 560, height: 880 }
					: { width: 0, height: 880 },
				resizeView: (_view, size) => events.push(`resize:${size.width}`),
			},
		};

		normalizeSimpleAuxiliaryBarWidth.call(workbench, true);

		assert.deepStrictEqual(events, ['restore', 'resize:360']);
	});

	function createWorkbenchHarness(): IWorkbenchTestHarness {
		const workbench: IWorkbenchTestHarness = {
			partVisibility: {
				sidebar: true,
				auxiliaryBar: true,
				editor: true,
				panel: false,
				sessions: true,
			},
			layoutPolicy: {
				viewportClass: {
					get: () => 'desktop',
				},
			},
			storageService: {
				store: () => { },
			},
			_editorMaximized: false,
			_restoreAttachedEditorMaximizedOnShow: false,
			setEditorMaximized: () => { },
			setEditorHidden: () => { },
			setAuxiliaryBarHidden: () => { },
			setAuxiliaryBarMaximized: () => false,
			_savePartVisibility: () => { },
		};
		workbench.setEditorHidden = hidden => {
			workbench.partVisibility.editor = !hidden;
		};
		return workbench;
	}

	test('restores maximized layout before checking auxiliary bar visibility on close', () => {
		const workbench = createWorkbenchHarness();
		const calls: boolean[] = [];
		workbench.setAuxiliaryBarMaximized = maximized => {
			calls.push(maximized);
			workbench.partVisibility.auxiliaryBar = false;
			return true;
		};
		setAuxiliaryBarHidden.call(workbench, true);
		assert.deepStrictEqual(calls, [false]);
	});

	test('restores attached editor maximized state when the auxiliary bar stays visible', () => {
		const maximizedStates: boolean[] = [];
		const workbench = createWorkbenchHarness();
		workbench._editorMaximized = true;
		workbench.setEditorMaximized = maximized => maximizedStates.push(maximized);

		workbench._editorMaximized = false;
		workbench._restoreAttachedEditorMaximizedOnShow = true;
		restoreAttachedEditorMaximizedState.call(workbench);

		assert.deepStrictEqual(maximizedStates, [true]);
		assert.strictEqual(workbench._restoreAttachedEditorMaximizedOnShow, false);
	});

	test('does not restore attached editor maximized state once the auxiliary bar is hidden', () => {
		const maximizedStates: boolean[] = [];
		const workbench = createWorkbenchHarness();
		workbench._editorMaximized = true;
		workbench.setEditorMaximized = maximized => maximizedStates.push(maximized);

		workbench._editorMaximized = false;
		workbench._restoreAttachedEditorMaximizedOnShow = true;
		workbench.partVisibility.auxiliaryBar = false;
		restoreAttachedEditorMaximizedState.call(workbench);

		assert.deepStrictEqual(maximizedStates, []);
		assert.strictEqual(workbench._restoreAttachedEditorMaximizedOnShow, false);
	});

	test('does not restore after the auxiliary bar is hidden and shown again before reopen', () => {
		const maximizedStates: boolean[] = [];
		const workbench = createWorkbenchHarness();
		workbench._editorMaximized = true;
		workbench.setEditorMaximized = maximized => maximizedStates.push(maximized);
		workbench.setAuxiliaryBarHidden = hidden => {
			workbench.partVisibility.auxiliaryBar = !hidden;
		};
		(workbench as IWorkbenchTestHarness & {
			mainContainer: { classList: { toggle(): void } };
			workbenchGrid: { setViewVisible(): void };
			auxiliaryBarPartView: {};
			paneCompositeService: { getActivePaneComposite(): undefined; hideActivePaneComposite(): void; openPaneComposite(): void; getLastActivePaneCompositeId(): undefined };
			viewDescriptorService: { getDefaultViewContainer(): undefined };
		}).mainContainer = { classList: { toggle: () => { } } };
		(workbench as IWorkbenchTestHarness & {
			workbenchGrid: { setViewVisible(): void };
			auxiliaryBarPartView: {};
		}).workbenchGrid = { setViewVisible: () => { } };
		(workbench as IWorkbenchTestHarness & { auxiliaryBarPartView: {} }).auxiliaryBarPartView = {};
		(workbench as IWorkbenchTestHarness & {
			paneCompositeService: { getActivePaneComposite(): undefined; hideActivePaneComposite(): void; openPaneComposite(): void; getLastActivePaneCompositeId(): undefined };
		}).paneCompositeService = {
			getActivePaneComposite: () => undefined,
			hideActivePaneComposite: () => { },
			openPaneComposite: () => { },
			getLastActivePaneCompositeId: () => undefined,
		};
		(workbench as IWorkbenchTestHarness & {
			viewDescriptorService: { getDefaultViewContainer(): undefined };
		}).viewDescriptorService = {
			getDefaultViewContainer: () => undefined,
		};

		workbench._restoreAttachedEditorMaximizedOnShow = true;
		setAuxiliaryBarHidden.call(workbench, true);
		setAuxiliaryBarHidden.call(workbench, false);

		workbench._editorMaximized = false;
		restoreAttachedEditorMaximizedState.call(workbench);

		assert.deepStrictEqual(maximizedStates, []);
		assert.strictEqual(workbench._restoreAttachedEditorMaximizedOnShow, false);
	});

	test('does not restore saved desktop part visibility on phone layout', () => {
		let getCalled = false;
		const workbench = createWorkbenchHarness();
		workbench.layoutPolicy.viewportClass.get = () => 'phone';
		const storageService = {
			get: () => {
				getCalled = true;
				return JSON.stringify({ editor: true, auxiliaryBar: true, sidebar: true });
			},
			remove: () => { },
		};

		const restored = loadPartVisibility.call(workbench, storageService);

		assert.deepStrictEqual(restored, {});
		assert.strictEqual(getCalled, false);
	});

	test('restores saved desktop part visibility outside phone layout', () => {
		const workbench = createWorkbenchHarness();
		workbench.layoutPolicy.viewportClass.get = () => 'desktop';
		const storageService = {
			get: () => JSON.stringify({ editor: true, auxiliaryBar: false, sidebar: false }),
			remove: () => { },
		};

		const restored = loadPartVisibility.call(workbench, storageService);

		assert.deepStrictEqual(restored, { editor: true, auxiliaryBar: false, sidebar: false });
	});

	test('does not persist part visibility on phone layout', () => {
		let storeCalled = false;
		const workbench = createWorkbenchHarness();
		workbench.layoutPolicy.viewportClass.get = () => 'phone';
		workbench.storageService.store = () => {
			storeCalled = true;
		};

		savePartVisibility.call(workbench);

		assert.strictEqual(storeCalled, false);
	});

	const enforceNoEmptyMainEditor = Reflect.get(Workbench.prototype, 'enforceNoEmptyMainEditor') as (this: IEnforceEmptyEditorTestHarness) => void;

	interface IEnforceEmptyEditorTestHarness {
		_isOptimusWindow: boolean;
		partVisibility: { editor: boolean };
		editorGroupService: { mainPart: { groups: { count: number }[] } };
		readonly hiddenCalls: boolean[];
		setEditorHidden(hidden: boolean): void;
	}

	function createEnforceEmptyEditorHarness(options: { isOptimusWindow: boolean; editorVisible: boolean; mainEditorCounts: number[] }): IEnforceEmptyEditorTestHarness {
		const hiddenCalls: boolean[] = [];
		const harness: IEnforceEmptyEditorTestHarness = {
			_isOptimusWindow: options.isOptimusWindow,
			partVisibility: { editor: options.editorVisible },
			editorGroupService: { mainPart: { groups: options.mainEditorCounts.map(count => ({ count })) } },
			hiddenCalls,
			setEditorHidden: hidden => hiddenCalls.push(hidden),
		};
		return harness;
	}

	test('hides the empty main editor area in the simple window', () => {
		const workbench = createEnforceEmptyEditorHarness({ isOptimusWindow: false, editorVisible: true, mainEditorCounts: [0] });

		enforceNoEmptyMainEditor.call(workbench);

		assert.deepStrictEqual(workbench.hiddenCalls, [true]);
	});

	test('keeps the main editor area when it holds editors or is already hidden, and never touches the advanced window', () => {
		const withEditors = createEnforceEmptyEditorHarness({ isOptimusWindow: false, editorVisible: true, mainEditorCounts: [0, 2] });
		const alreadyHidden = createEnforceEmptyEditorHarness({ isOptimusWindow: false, editorVisible: false, mainEditorCounts: [0] });
		const optimusEmpty = createEnforceEmptyEditorHarness({ isOptimusWindow: true, editorVisible: true, mainEditorCounts: [0] });

		enforceNoEmptyMainEditor.call(withEditors);
		enforceNoEmptyMainEditor.call(alreadyHidden);
		enforceNoEmptyMainEditor.call(optimusEmpty);

		assert.deepStrictEqual({
			withEditors: withEditors.hiddenCalls,
			alreadyHidden: alreadyHidden.hiddenCalls,
			optimusEmpty: optimusEmpty.hiddenCalls,
		}, {
			withEditors: [],
			alreadyHidden: [],
			optimusEmpty: [],
		});
	});
});
