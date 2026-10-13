/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IChatRequestModel } from '../../../../../workbench/contrib/chat/common/model/chatModel.js';
import { ChatQuestionCarouselData } from '../../../../../workbench/contrib/chat/common/model/chatProgressTypes/chatQuestionCarouselData.js';
import { CanvasMediaKind, extractCanvasImageGroups, extractCanvasTurns, formatVideoLength, hasPerReferenceInstructions, ICanvasEditRequest, ICanvasImage, IRightWorkbenchCanvasDelegate, RightWorkbenchCanvas } from '../../browser/rightWorkbenchCanvas.js';
import { CANVAS_EDIT_MODELS } from '../../browser/canvasEdits.js';

function turn(timestamp: number, ...markdown: string[]): IChatRequestModel {
	const value = markdown.map(text => ({ kind: 'markdownContent' as const, content: new MarkdownString(text) }));
	return { timestamp, message: { text: `prompt ${timestamp}` }, response: { timestamp, response: { value } } } as unknown as IChatRequestModel;
}

suite('RightWorkbenchCanvas', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('groups generated images and videos by turn with their saved copies', () => {
		const cwd = URI.file('/work');
		const first = 'https://backboard-prod.s3.ca-central-1.amazonaws.com/generated-image/a.png';
		const second = 'https://backboard-prod.s3.ca-central-1.amazonaws.com/generated-image/b.png';
		const groups = extractCanvasImageGroups([
			turn(1000, `Here you go.\n\n![Surf laptop](${first})\n\nSaved to \`generated-images/generated-aaa.png\`.`),
			turn(2000, `![](${second})`, `Again: ![Surf laptop](${first})`, '![clip](https://x.test/v.mp4) ![bad](javascript:alert(1))'),
			turn(3000, 'No images here.'),
		], cwd);

		assert.deepStrictEqual(groups.map(group => ({
			timestamp: group.timestamp,
			prompt: group.prompt,
			reply: group.reply,
			images: group.images.map(image => ({ label: image.label, kind: image.kind, src: image.src.toString(), localFile: image.localFile?.path })),
		})), [
			{ timestamp: 1000, prompt: 'prompt 1000', reply: 'Here you go.', images: [{ label: 'Surf laptop', kind: 'image', src: first, localFile: '/work/generated-images/generated-aaa.png' }] },
			{
				timestamp: 2000, prompt: 'prompt 2000', reply: 'Again: \n )', images: [
					{ label: 'Generated image 2', kind: 'image', src: second, localFile: undefined },
					{ label: 'clip', kind: 'video', src: 'https://x.test/v.mp4', localFile: undefined },
				]
			},
		]);
	});

	test('skips links that are not generated media: placeholders, quoted examples, and shortened URLs', () => {
		const real = 'https://backboard-prod.s3.ca-central-1.amazonaws.com/generated-video/e147.mp4';
		const groups = extractCanvasImageGroups([
			turn(1000,
				'Renders `![label](url)` and ![label](url) and ![clip](https://backboard-prod.s3.ca-central-1.amazonaws.com/generated-video/e147…mp4)',
				'```md\n![example](https://x.test/example.png)\n```',
				`![Clip](${real})\n\nSaved to \`generated-images/clip.mp4\`.`,
			),
		], URI.file('/work'));

		assert.deepStrictEqual(groups.flatMap(group => group.images.map(image => ({ label: image.label, kind: image.kind, localFile: image.localFile?.path }))), [
			{ label: 'Clip', kind: 'video', localFile: '/work/generated-images/clip.mp4' },
		]);
	});

	test('a clip whose link says "Generated image" is still named as a video', () => {
		const clip = 'https://backboard-prod.s3.ca-central-1.amazonaws.com/generated-video/c.mp4';
		const groups = extractCanvasImageGroups([turn(1000, `![Generated image](${clip}) ![Generated video](https://x.test/still.png)`)], undefined);

		assert.deepStrictEqual(groups.flatMap(group => group.images.map(image => `${image.kind}:${image.label}`)), ['video:Generated video 1', 'image:Generated image 1']);
	});

	test('a clip opens the composer in Video mode, and only its own chat answers the edit', () => {
		const container = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(container);
		const delegate: IRightWorkbenchCanvasDelegate = {
			toDisplayUrl: async () => undefined,
			sendComments: () => { },
			sendEdit: () => { },
			getMediaModel: () => ({ active: true, label: 'Model' }),
		};
		const canvas = store.add(new RightWorkbenchCanvas(container, delegate, new (mock<IContextMenuService>())(), new (mock<IClipboardService>())()));
		const item = (name: string, kind: CanvasMediaKind = 'image'): ICanvasImage => ({ key: `https://x.test/${name}`, src: URI.parse(`https://x.test/${name}`), label: name, kind, localFile: undefined });
		const chat = (key: string, timestamp: number, ...images: ICanvasImage[]) => ({ timestamp, images, source: { key, title: key } });
		try {
			canvas.setGroups([chat('chat-1', 1, item('clip.mp4', 'video'))], 'chat-1');
			canvas.reveal('https://x.test/clip.mp4', 'focused');
			const composer = container.querySelector<HTMLFormElement>('form.sessions-right-workbench-canvas-composer')!;
			const mode = composer.querySelector<HTMLElement>('[data-kind][aria-pressed="true"]')?.dataset.kind;
			composer.querySelector('textarea')!.value = 'make it night';
			composer.dispatchEvent(new Event('submit', { cancelable: true }));
			const shown = () => container.querySelector('.sessions-right-workbench-canvas-rail-thumb[aria-pressed="true"]')?.getAttribute('title');
			// Another chat's media loading in meanwhile is not the result.
			canvas.setGroups([chat('chat-1', 1, item('clip.mp4', 'video')), chat('chat-2', 2, item('other.png'))], 'chat-1');
			const whileWaiting = shown();
			canvas.setGroups([chat('chat-1', 1, item('clip.mp4', 'video')), chat('chat-2', 2, item('other.png')), chat('chat-1', 3, item('night.mp4', 'video'))], 'chat-1');

			assert.deepStrictEqual({ mode, whileWaiting, result: shown() }, {
				mode: 'video',
				whileWaiting: 'clip.mp4, from chat-1',
				result: 'night.mp4, from chat-1',
			});
		} finally {
			container.remove();
		}
	});

	test('a clip opens Edit mode: the edit model, its price, the tools, and the edit request', async () => {
		const container = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(container);
		const edits: ICanvasEditRequest[] = [];
		const delegate: IRightWorkbenchCanvasDelegate = {
			toDisplayUrl: async () => undefined,
			sendComments: () => { },
			sendEdit: () => { },
			getMediaModel: () => ({ active: true, label: 'Model' }),
			getEditModels: tool => CANVAS_EDIT_MODELS[tool],
			runEdit: request => edits.push(request),
		};
		const canvas = store.add(new RightWorkbenchCanvas(container, delegate, new (mock<IContextMenuService>())(), new (mock<IClipboardService>())()));
		const item = (name: string, kind: CanvasMediaKind = 'image'): ICanvasImage => ({ key: `https://x.test/${name}`, src: URI.parse(`https://x.test/${name}`), label: name, kind, localFile: undefined });
		try {
			// Only clips saved on this computer can be edited.
			canvas.setGroups([{ timestamp: 1, images: [{ ...item('clip.mp4', 'video'), localFile: URI.file('/uploads/clip.mp4') }] }], 'chat-1');
			canvas.reveal('https://x.test/clip.mp4', 'focused');
			const composer = container.querySelector<HTMLFormElement>('form.sessions-right-workbench-canvas-composer')!;
			const input = composer.querySelector('textarea')!;
			const text = (selector: string) => composer.querySelector<HTMLElement>(selector)?.textContent;
			const send = composer.querySelector<HTMLButtonElement>('.sessions-right-workbench-canvas-composer-send')!;
			const opened = {
				mode: composer.querySelector<HTMLElement>('[data-kind][aria-pressed="true"]')?.dataset.kind,
				tool: text('.sessions-right-workbench-canvas-composer-tool'),
				model: text('.sessions-right-workbench-canvas-composer-model:not(.sessions-right-workbench-canvas-composer-tool):not(.sessions-right-workbench-canvas-composer-length)'),
				blockedWithoutPrompt: send.disabled,
			};
			input.value = 'make it night';
			input.dispatchEvent(new Event('input'));
			const canSend = !send.disabled;
			composer.querySelector<HTMLButtonElement>('.sessions-right-workbench-canvas-composer-tool')!.click();
			await Promise.resolve();
			const tools = [...composer.querySelectorAll('.sessions-right-workbench-canvas-model-option')].map(option => option.textContent);
			[...composer.querySelectorAll<HTMLButtonElement>('.sessions-right-workbench-canvas-model-option')].find(option => option.textContent === 'Extend Video')!.click();
			const extendLength = composer.querySelector<HTMLButtonElement>('.sessions-right-workbench-canvas-composer-length');
			const extend = { hidden: extendLength?.hidden, label: extendLength?.textContent };
			input.value = 'they keep dancing';
			composer.dispatchEvent(new Event('submit', { cancelable: true }));

			assert.deepStrictEqual({
				opened,
				canSend,
				tools,
				extend,
				edits: edits.map(edit => ({ tool: edit.tool, model: edit.model, prompt: edit.prompt, video: edit.video.label, seconds: edit.seconds })),
				cleared: input.value,
			}, {
				opened: { mode: 'edit', tool: 'Edit Video', model: 'Runway Aleph 2', blockedWithoutPrompt: true },
				canSend: true,
				tools: ['Edit Video', 'Upscale', 'Extend Video'],
				extend: { hidden: false, label: '+5s' },
				edits: [{ tool: 'extend', model: 'black-forest-labs/flux-3-video', prompt: 'they keep dancing', video: 'clip.mp4', seconds: 5 }],
				cleared: '',
			});
		} finally {
			container.remove();
		}
	});

	test('reads each exchange of a chat as a thread turn with its attachments, answer, and media', () => {
		const image = 'https://x.test/a.png';
		const bytes = new Uint8Array([1, 2, 3]);
		const requests = [
			{ id: 'r1', timestamp: 1, message: { text: 'make a dog ' }, variableData: { variables: [{ kind: 'image', id: 'i', name: 'ref.png', value: bytes, mimeType: 'image/png' }, { kind: 'file', id: 'f', name: 'notes.md', value: URI.file('/n') }] }, response: { timestamp: 1, isComplete: true, response: { value: [{ kind: 'markdownContent', content: new MarkdownString(`Here's your **dog**.\n\n![Dog](${image})`) }] } } },
			{ id: 'r2', timestamp: 2, message: { text: 'again' }, variableData: { variables: [] }, response: { timestamp: 2, isComplete: false, response: { value: [] } } },
		] as unknown as IChatRequestModel[];

		assert.deepStrictEqual(extractCanvasTurns(requests, undefined).map(turn => ({
			id: turn.id,
			prompt: turn.prompt,
			attachments: turn.attachments.map(attachment => ({ label: attachment.label, bytes: attachment.data?.length, mimeType: attachment.mimeType })),
			reply: turn.reply,
			media: turn.media.map(item => item.label),
			inProgress: turn.inProgress,
		})), [
			{ id: 'r1', prompt: 'make a dog', attachments: [{ label: 'ref.png', bytes: 3, mimeType: 'image/png' }], reply: `Here's your **dog**.`, media: ['Dog'], inProgress: false },
			{ id: 'r2', prompt: 'again', attachments: [], reply: '', media: [], inProgress: true },
		]);
	});

	test('a running turn exposes the question it waits on, and answering it settles the question', async () => {
		const carousel = new ChatQuestionCarouselData([{ id: 'len', type: 'singleSelect', title: 'How long should the video be?', options: ['5s', '8s'].map(value => ({ id: value, label: value, value })) }], false, 'ask_1');
		const requests = [
			{ id: 'r1', timestamp: 1, message: { text: 'make a video' }, variableData: { variables: [] }, response: { timestamp: 1, isComplete: false, response: { value: [carousel] } } },
		] as unknown as IChatRequestModel[];
		const [turn] = extractCanvasTurns(requests, undefined);
		const container = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(container);
		const delegate: IRightWorkbenchCanvasDelegate = { toDisplayUrl: async () => undefined, sendComments: () => { }, sendEdit: () => { }, getMediaModel: () => undefined };
		const canvas = store.add(new RightWorkbenchCanvas(container, delegate, new (mock<IContextMenuService>())(), new (mock<IClipboardService>())()));
		try {
			const item: ICanvasImage = { key: 'https://x.test/a.png', src: URI.parse('https://x.test/a.png'), label: 'a.png', kind: 'image', localFile: undefined };
			canvas.setGroups([{ timestamp: 1, images: [item] }], 'chat-1');
			canvas.reveal(item.key, 'focused');
			canvas.setThread({ title: 'Chat', turns: [turn] });
			const options = [...container.querySelectorAll<HTMLButtonElement>('.sessions-right-workbench-canvas-question-option')];
			const shown = { question: turn.question === carousel, options: options.map(option => option.textContent) };
			options[1].click();
			const result = await carousel.completion.p;
			assert.deepStrictEqual({ ...shown, used: carousel.isUsed, answers: result.answers }, {
				question: true,
				options: ['5s', '8s'],
				used: true,
				answers: { len: { selectedValue: '8s' } },
			});
		} finally {
			container.remove();
		}
	});

	test('formats video lengths as minutes and seconds', () => {
		assert.deepStrictEqual([formatVideoLength(8.04), formatVideoLength(65), formatVideoLength(Number.NaN), formatVideoLength(0)], ['0:08', '1:05', undefined, undefined]);
	});

	test('focused view shows every item in a filmstrip, names the chat of each item, and sends edits from its composer', async () => {
		const container = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(container);
		const sent: string[] = [];
		const delegate: IRightWorkbenchCanvasDelegate = {
			toDisplayUrl: async () => undefined,
			sendComments: () => { },
			sendEdit: (images, prompt, kind, seconds) => sent.push(`${kind}:${images.map(image => image.label).join('+')}:${prompt}:${seconds}`),
			getMediaModel: kind => ({ active: kind === 'image', label: kind === 'image' ? 'gpt-image-1' : undefined }),
		};
		const canvas = store.add(new RightWorkbenchCanvas(container, delegate, new (mock<IContextMenuService>())(), new (mock<IClipboardService>())()));
		const item = (name: string, kind: CanvasMediaKind = 'image'): ICanvasImage => ({ key: `https://x.test/${name}`, src: URI.parse(`https://x.test/${name}`), label: name, kind, localFile: undefined });
		try {
			canvas.setGroups([
				{ timestamp: 0, images: [item('c.png')], source: { key: 'chat-2', title: 'Logo ideas' } },
				{ timestamp: 1, images: [item('a.png'), item('b.mp4', 'video')] },
			], 'chat-1');
			canvas.reveal('https://x.test/c.png', 'focused');

			const composer = container.querySelector<HTMLFormElement>('form.sessions-right-workbench-canvas-composer')!;
			const input = composer.querySelector('textarea')!;
			const model = () => composer.querySelector('.sessions-right-workbench-canvas-composer-model:not(.sessions-right-workbench-canvas-composer-tool)')!.textContent;
			const imageModel = model();
			const lengthChip = composer.querySelector<HTMLButtonElement>('.sessions-right-workbench-canvas-composer-length')!;
			const lengthHiddenForImage = lengthChip.hidden;
			(composer.querySelector('[data-kind="video"]') as HTMLButtonElement).click();
			lengthChip.click();
			await Promise.resolve();
			const lengths = [...composer.querySelectorAll('.sessions-right-workbench-canvas-model-option')].map(option => option.textContent);
			[...composer.querySelectorAll<HTMLButtonElement>('.sessions-right-workbench-canvas-model-option')].find(option => option.textContent === '8s')!.click();
			const pickedLength = lengthChip.textContent;
			input.value = 'make it snow';
			composer.dispatchEvent(new Event('submit', { cancelable: true }));

			assert.deepStrictEqual({
				rail: [...container.querySelectorAll('.sessions-right-workbench-canvas-rail > *')].map(el => el.getAttribute('title')),
				pressed: container.querySelector('.sessions-right-workbench-canvas-rail-thumb[aria-pressed="true"]')?.getAttribute('title'),
				focusedVideo: !!container.querySelector('.sessions-right-workbench-canvas-rail-thumb video'),
				composerShown: !composer.hidden,
				imageModel,
				videoModel: model(),
				lengthHiddenForImage,
				lengths,
				pickedLength,
				sent,
				lengthAfterSend: lengthChip.textContent,
				cleared: input.value,
			}, {
				rail: ['a.png', 'b.mp4', 'c.png, from Logo ideas'],
				pressed: 'c.png, from Logo ideas',
				focusedVideo: true,
				composerShown: true,
				imageModel: 'gpt-image-1',
				videoModel: 'Choose Model',
				lengthHiddenForImage: true,
				lengths: ['Auto', '5s', '8s', '10s', '15s'],
				pickedLength: '8s',
				sent: ['video:c.png:make it snow:8'],
				lengthAfterSend: 'Auto',
				cleared: '',
			});
		} finally {
			container.remove();
		}
	});
	test('Multi-Select opens the picks together as @image_1, @image_2 and sends them with the prompt', async () => {
		const container = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(container);
		const sent: string[] = [];
		const delegate: IRightWorkbenchCanvasDelegate = {
			toDisplayUrl: async () => undefined,
			sendComments: () => { },
			sendEdit: (images, prompt) => sent.push(`${images.map(image => image.label).join('+')}:${prompt}`),
			getMediaModel: () => ({ active: true, label: 'Model' }),
		};
		const canvas = store.add(new RightWorkbenchCanvas(container, delegate, new (mock<IContextMenuService>())(), new (mock<IClipboardService>())()));
		const item = (name: string): ICanvasImage => ({ key: `https://x.test/${name}`, src: URI.parse(`https://x.test/${name}`), label: name, kind: 'image', localFile: undefined });
		try {
			canvas.setGroups([{ timestamp: 1, images: [item('a.png'), item('b.png'), item('c.png')] }], 'chat-1');
			const pillButton = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('.sessions-right-workbench-canvas-pill-button')].find(button => button.textContent === label)!;
			const tile = (name: string) => container.querySelector<HTMLButtonElement>(`.sessions-right-workbench-canvas-tile[aria-label="${name}"]`)!;
			pillButton('Multi-Select').click();
			tile('c.png').click();
			tile('a.png').click();
			const hint = container.querySelector('.sessions-right-workbench-canvas-pill-hint')?.textContent;
			container.querySelector<HTMLButtonElement>('.sessions-right-workbench-canvas-pill-send')!.click();

			const composer = container.querySelector<HTMLFormElement>('form.sessions-right-workbench-canvas-composer')!;
			const input = composer.querySelector('textarea')!;
			const slots = [...composer.querySelectorAll('.sessions-right-workbench-canvas-composer-slot-name')].map(name => name.textContent);
			// Type "@" and pick the second suggestion with the keyboard.
			input.value = 'swap the sky of @';
			input.selectionStart = input.selectionEnd = input.value.length;
			input.dispatchEvent(new Event('input'));
			const suggestions = [...composer.querySelectorAll('.sessions-right-workbench-canvas-mention-option .name')].map(name => name.textContent);
			input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
			input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
			const afterMention = input.value;
			input.value += 'with @image_1';
			composer.dispatchEvent(new Event('submit', { cancelable: true }));

			assert.deepStrictEqual({ hint, focused: container.querySelector('.sessions-right-workbench-canvas')!.classList.contains('focused'), slots, suggestions, afterMention, sent }, {
				hint: '2 selected',
				focused: true,
				slots: ['@image_1', '@image_2'],
				suggestions: ['@image_1', '@image_2'],
				afterMention: 'swap the sky of @image_2 ',
				sent: ['c.png+a.png:swap the sky of @image_2 with @image_1'],
			});
		} finally {
			container.remove();
		}
	});
	test('the filter keeps recent items of one kind, newest first', () => {
		const container = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(container);
		const delegate: IRightWorkbenchCanvasDelegate = {
			toDisplayUrl: async () => undefined,
			sendComments: () => { },
			sendEdit: () => { },
			getMediaModel: () => undefined,
			filter: { order: 'newest', range: 'week', kind: 'image' },
		};
		const canvas = store.add(new RightWorkbenchCanvas(container, delegate, new (mock<IContextMenuService>())(), new (mock<IClipboardService>())()));
		const item = (name: string, kind: CanvasMediaKind = 'image'): ICanvasImage => ({ key: `https://x.test/${name}`, src: URI.parse(`https://x.test/${name}`), label: name, kind, localFile: undefined });
		const day = 24 * 60 * 60 * 1000;
		try {
			canvas.setGroups([
				{ timestamp: Date.now() - 10 * day, images: [item('old.png')] },
				{ timestamp: Date.now() - 2 * day, images: [item('a.png'), item('clip.mp4', 'video')] },
				{ timestamp: Date.now() - 60 * 60 * 1000, images: [item('new.png')] },
			], 'chat-1');
			assert.deepStrictEqual({
				tiles: [...container.querySelectorAll('.sessions-right-workbench-canvas-tile')].map(tile => tile.getAttribute('aria-label')),
				chip: container.querySelector('.sessions-right-workbench-canvas-filter')?.textContent,
			}, {
				tiles: ['new.png', 'a.png'],
				chip: 'Last 7 Days · Images Only',
			});
		} finally {
			container.remove();
		}
	});
	test('dropping files uploads them and, in the asset view, adds them as the next @image references', async () => {
		const container = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(container);
		const item = (name: string): ICanvasImage => ({ key: `https://x.test/${name}`, src: URI.parse(`https://x.test/${name}`), label: name, kind: 'image', localFile: undefined });
		const received: string[] = [];
		let canvas: RightWorkbenchCanvas | undefined;
		const delegate: IRightWorkbenchCanvasDelegate = {
			toDisplayUrl: async () => undefined,
			sendComments: () => { },
			sendEdit: () => { },
			getMediaModel: () => undefined,
			uploadFiles: async files => {
				received.push(...files.map(file => file.name));
				const uploaded = files.map(file => item(file.name));
				canvas!.setGroups([{ timestamp: 1, images: [item('a.png')] }, { timestamp: 2, images: uploaded }], 'chat-1');
				return uploaded;
			},
		};
		canvas = store.add(new RightWorkbenchCanvas(container, delegate, new (mock<IContextMenuService>())(), new (mock<IClipboardService>())()));
		try {
			canvas.setGroups([{ timestamp: 1, images: [item('a.png')] }], 'chat-1');
			canvas.reveal('https://x.test/a.png', 'focused');
			const root = container.querySelector<HTMLElement>('.sessions-right-workbench-canvas')!;
			const drop = (type: string) => {
				const dataTransfer = new DataTransfer();
				dataTransfer.items.add(new File(['x'], 'sky.png', { type: 'image/png' }));
				dataTransfer.items.add(new File(['x'], 'notes.txt', { type: 'text/plain' }));
				root.dispatchEvent(new DragEvent(type, { dataTransfer, bubbles: true, cancelable: true }));
			};
			drop('dragenter');
			const hinted = root.classList.contains('drop-target');
			drop('drop');
			await new Promise(resolve => setTimeout(resolve, 0));

			assert.deepStrictEqual({
				hinted,
				hintAfterDrop: root.classList.contains('drop-target'),
				received,
				slots: [...container.querySelectorAll('.sessions-right-workbench-canvas-composer-slot')].map(slot => slot.getAttribute('title')),
			}, {
				hinted: true,
				hintAfterDrop: false,
				received: ['sky.png'],
				slots: ['a.png', 'sky.png'],
			});
		} finally {
			container.remove();
		}
	});
	test('dragging a filmstrip thumb onto the chat adds it as the next @image reference', () => {
		const container = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(container);
		const delegate: IRightWorkbenchCanvasDelegate = {
			toDisplayUrl: async () => undefined,
			sendComments: () => { },
			sendEdit: () => { },
			getMediaModel: () => undefined,
		};
		const canvas = store.add(new RightWorkbenchCanvas(container, delegate, new (mock<IContextMenuService>())(), new (mock<IClipboardService>())()));
		const item = (name: string): ICanvasImage => ({ key: `https://x.test/${name}`, src: URI.parse(`https://x.test/${name}`), label: name, kind: 'image', localFile: undefined });
		try {
			canvas.setGroups([{ timestamp: 1, images: [item('a.png'), item('b.png')] }], 'chat-1');
			canvas.reveal('https://x.test/a.png', 'focused');
			const thumb = [...container.querySelectorAll<HTMLElement>('.sessions-right-workbench-canvas-rail-thumb')].find(element => element.title === 'b.png')!;
			const dataTransfer = new DataTransfer();
			thumb.dispatchEvent(new DragEvent('dragstart', { dataTransfer, bubbles: true }));
			const thread = container.querySelector<HTMLElement>('.sessions-right-workbench-canvas-thread')!;
			thread.dispatchEvent(new DragEvent('dragenter', { dataTransfer, bubbles: true, cancelable: true }));
			thread.dispatchEvent(new DragEvent('drop', { dataTransfer, bubbles: true, cancelable: true }));

			assert.deepStrictEqual({
				draggable: thumb.draggable,
				slots: [...container.querySelectorAll('.sessions-right-workbench-canvas-composer-slot')].map(slot => slot.getAttribute('title')),
			}, {
				draggable: true,
				slots: ['a.png', 'b.png'],
			});
		} finally {
			container.remove();
		}
	});
	test('tells per-image instructions apart from one request combining the images', () => {
		assert.deepStrictEqual([
			hasPerReferenceInstructions('@image_1 make it flip the hat\n@image_2 make it throw the ball'),
			hasPerReferenceInstructions('@image_1 flips the hat. @image_2 throws the ball.'),
			hasPerReferenceInstructions('put the hat from @image_1 on @image_2'),
			hasPerReferenceInstructions('@image_1 wearing the hat from @image_2'),
			hasPerReferenceInstructions('@image_1 flip the hat\n@image_1 then wave'),
		], [true, true, false, false, false]);
	});
	test('the thread header shows the chat model and switches it from its menu', async () => {
		const container = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(container);
		let current = 'deepseek';
		const delegate: IRightWorkbenchCanvasDelegate = {
			toDisplayUrl: async () => undefined,
			sendComments: () => { },
			sendEdit: () => { },
			getMediaModel: () => undefined,
			getChatModels: () => ({ models: [{ id: 'deepseek', label: 'DeepSeek V4 Flash' }, { id: 'kimi', label: 'Kimi K3' }], current }),
			setChatModel: id => current = id,
		};
		const canvas = store.add(new RightWorkbenchCanvas(container, delegate, new (mock<IContextMenuService>())(), new (mock<IClipboardService>())()));
		const item = (name: string): ICanvasImage => ({ key: `https://x.test/${name}`, src: URI.parse(`https://x.test/${name}`), label: name, kind: 'image', localFile: undefined });
		try {
			canvas.setGroups([{ timestamp: 1, images: [item('a.png')] }], 'chat-1');
			canvas.reveal('https://x.test/a.png', 'focused');
			canvas.refreshMediaModels();
			const chip = container.querySelector<HTMLButtonElement>('.sessions-right-workbench-canvas-chat-model')!;
			const before = chip.textContent;
			chip.click();
			await Promise.resolve();
			const options = [...container.querySelectorAll<HTMLButtonElement>('.sessions-right-workbench-canvas-model-menu.from-header .sessions-right-workbench-canvas-model-option')];
			const listed = options.map(option => `${option.textContent}${option.getAttribute('aria-selected') === 'true' ? ' ✓' : ''}`);
			options.find(option => option.textContent === 'Kimi K3')!.click();

			assert.deepStrictEqual({ before, listed, current, after: chip.textContent }, {
				before: 'DeepSeek V4 Flash',
				listed: ['DeepSeek V4 Flash ✓', 'Kimi K3'],
				current: 'kimi',
				after: 'Kimi K3',
			});
		} finally {
			container.remove();
		}
	});
});
