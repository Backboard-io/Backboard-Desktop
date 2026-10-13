/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { decodeBase64, VSBuffer } from '../../../../../base/common/buffer.js';
import { Event } from '../../../../../base/common/event.js';
import { Disposable, IDisposable } from '../../../../../base/common/lifecycle.js';
import { ResourceMap, ResourceSet } from '../../../../../base/common/map.js';
import { newWriteableStream, ReadableStreamEvents } from '../../../../../base/common/stream.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { createFileSystemProviderError, FileSystemProviderCapabilities, FileSystemProviderErrorCode, FileType, IFileService, IFileSystemProvider, IFileSystemProviderWithFileAtomicReadCapability, IFileSystemProviderWithFileReadStreamCapability, IFileSystemProviderWithFileReadWriteCapability, IStat } from '../../../../../platform/files/common/files.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { ChatResponseResource } from '../model/chatModel.js';
import { IChatService, IChatToolInvocation, IChatToolInvocationSerialized } from '../chatService/chatService.js';
import { isToolResultInputOutputDetails } from '../tools/languageModelToolsService.js';

export const IChatResponseResourceFileSystemProvider = createDecorator<IChatResponseResourceFileSystemProvider>('chatResponseResourceFileSystemProvider');

export interface IChatResponseResourceFileSystemProvider extends IFileSystemProvider {
	readonly _serviceBrand: undefined;

	/**
	 * Associates arbitrary data with a URI in the chat response resource filesystem.
	 * The data is scoped to the given session and automatically cleaned up when
	 * the session is disposed.
	 * Returns a URI that can later be read via the file service.
	 */
	associate(sessionResource: URI, data: Uint8Array | { base64: string }, name?: string): URI;
}

const maxChatResponseResourceBytes = 16 * 1024 * 1024;
const maxAssociatedSessionBytes = 64 * 1024 * 1024;
const maxAssociatedGlobalBytes = 256 * 1024 * 1024;
const maxAssociatedSessionResources = 64;
const maxAssociatedGlobalResources = 256;

interface IAssociatedResourceData {
	readonly data: Uint8Array;
	readonly byteLength: number;
}

export class ChatResponseResourceFileSystemProvider extends Disposable implements
	IChatResponseResourceFileSystemProvider,
	IFileSystemProviderWithFileReadWriteCapability,
	IFileSystemProviderWithFileAtomicReadCapability,
	IFileSystemProviderWithFileReadStreamCapability {

	declare readonly _serviceBrand: undefined;

	public readonly onDidChangeCapabilities = Event.None;
	public readonly onDidChangeFile = Event.None;

	public readonly capabilities: FileSystemProviderCapabilities = FileSystemProviderCapabilities.None
		| FileSystemProviderCapabilities.Readonly
		| FileSystemProviderCapabilities.PathCaseSensitive
		| FileSystemProviderCapabilities.FileReadStream
		| FileSystemProviderCapabilities.FileAtomicRead
		| FileSystemProviderCapabilities.FileReadWrite;

	/** In-memory store for data associated via {@link associate}, keyed by URI. */
	private readonly _associated = new ResourceMap<IAssociatedResourceData>();

	/** Tracks which associated URIs belong to which session, for cleanup on dispose. */
	private readonly _sessionAssociations = new ResourceMap<ResourceSet>();
	private readonly _sessionAssociationBytes = new ResourceMap<number>();
	private _associatedBytes = 0;

	constructor(
		@IChatService private readonly chatService: IChatService,
		@IFileService private readonly _fileService: IFileService
	) {
		super();
		this._register(this.chatService.onDidDisposeSession(e => {
			for (const sessionResource of e.sessionResources) {
				const uris = this._sessionAssociations.get(sessionResource);
				if (uris) {
					for (const uri of uris) {
						const associated = this._associated.get(uri);
						if (associated) {
							this._associatedBytes -= associated.byteLength;
							this._associated.delete(uri);
						}
					}
					this._sessionAssociations.delete(sessionResource);
					this._sessionAssociationBytes.delete(sessionResource);
				}
			}
		}));
	}

	associate(sessionResource: URI, data: Uint8Array | { base64: string }, name?: string): URI {
		const byteLength = data instanceof Uint8Array ? data.byteLength : Math.ceil(data.base64.length * 3 / 4);
		const sessionBytes = this._sessionAssociationBytes.get(sessionResource) ?? 0;
		const sessionResources = this._sessionAssociations.get(sessionResource)?.size ?? 0;
		if (byteLength > maxChatResponseResourceBytes
			|| sessionBytes + byteLength > maxAssociatedSessionBytes
			|| this._associatedBytes + byteLength > maxAssociatedGlobalBytes
			|| sessionResources >= maxAssociatedSessionResources
			|| this._associated.size >= maxAssociatedGlobalResources) {
			throw createFileSystemProviderError('Chat response resource storage limit exceeded', FileSystemProviderErrorCode.FileTooLarge);
		}
		// Decode once at association time. Keeping the base64 string until first
		// read can use substantially more memory than the resulting byte array and
		// makes the budget underestimate retained heap.
		const storedData = data instanceof Uint8Array ? data : decodeBase64(data.base64).buffer;

		const id = generateUuid();
		const uri = URI.from({
			scheme: ChatResponseResource.scheme,
			path: `/assoc/${id}` + (name ? `/${name}` : ''),
		});
		this._associated.set(uri, { data: storedData, byteLength: storedData.byteLength });
		this._associatedBytes += storedData.byteLength;
		this._sessionAssociationBytes.set(sessionResource, sessionBytes + storedData.byteLength);

		let set = this._sessionAssociations.get(sessionResource);
		if (!set) {
			set = new ResourceSet();
			this._sessionAssociations.set(sessionResource, set);
		}
		set.add(uri);

		return uri;
	}

	readFile(resource: URI): Promise<Uint8Array> {
		return Promise.resolve(this.lookupURI(resource));
	}

	readFileStream(resource: URI): ReadableStreamEvents<Uint8Array> {
		const stream = newWriteableStream<Uint8Array>(data => VSBuffer.concat(data.map(data => VSBuffer.wrap(data))).buffer);
		Promise.resolve(this.lookupURI(resource)).then(v => stream.end(v));
		return stream;
	}

	async stat(resource: URI): Promise<IStat> {
		const r = await this.lookupURI(resource);
		return {
			type: FileType.File,
			ctime: 0,
			mtime: 0,
			size: r.length,
		};
	}

	delete(): Promise<void> {
		throw createFileSystemProviderError('fs is readonly', FileSystemProviderErrorCode.NoPermissions);
	}

	watch(): IDisposable {
		return Disposable.None;
	}

	mkdir(): Promise<void> {
		throw createFileSystemProviderError('fs is readonly', FileSystemProviderErrorCode.NoPermissions);
	}

	readdir(): Promise<[string, FileType][]> {
		return Promise.resolve([]);
	}

	rename(): Promise<void> {
		throw createFileSystemProviderError('fs is readonly', FileSystemProviderErrorCode.NoPermissions);
	}

	writeFile(): Promise<void> {
		throw createFileSystemProviderError('fs is readonly', FileSystemProviderErrorCode.NoPermissions);
	}

	private findMatchingInvocation(uri: URI) {
		const parsed = ChatResponseResource.parseUri(uri);
		if (!parsed) {
			throw createFileSystemProviderError(`File not found`, FileSystemProviderErrorCode.FileNotFound);
		}
		const { sessionResource, toolCallId, index } = parsed;
		const session = this.chatService.getSession(sessionResource);
		if (!session) {
			throw createFileSystemProviderError(`File not found`, FileSystemProviderErrorCode.FileNotFound);
		}

		const requests = session.getRequests();
		for (let k = requests.length - 1; k >= 0; k--) {
			const req = requests[k];
			const tc = req.response?.entireResponse.value.find((r): r is IChatToolInvocation | IChatToolInvocationSerialized => (r.kind === 'toolInvocation' || r.kind === 'toolInvocationSerialized') && r.toolCallId === toolCallId);
			if (tc) {
				return { result: tc, index };
			}
		}

		throw createFileSystemProviderError(`File not found`, FileSystemProviderErrorCode.FileNotFound);
	}

	private lookupURI(uri: URI): Uint8Array | Promise<Uint8Array> {
		const associated = this._associated.get(uri);
		if (associated) {
			return associated.data;
		}

		const { result, index } = this.findMatchingInvocation(uri);
		const details = IChatToolInvocation.resultDetails(result);
		if (!isToolResultInputOutputDetails(details)) {
			throw createFileSystemProviderError(`Tool does not have I/O`, FileSystemProviderErrorCode.FileNotFound);
		}

		const part = details.output.at(index);
		if (!part) {
			throw createFileSystemProviderError(`Tool does not have part`, FileSystemProviderErrorCode.FileNotFound);
		}

		if (part.type === 'ref') {
			return this._fileService.readFile(part.uri, { limits: { size: maxChatResponseResourceBytes } }).then(r => r.value.buffer);
		}

		// Tool-result URIs do not pass through associate(), so enforce the same
		// per-resource ceiling before allocating a decoded copy. Without this, one
		// malformed or unexpectedly large tool part can transiently duplicate an
		// arbitrary-size base64 string and exhaust the renderer heap.
		if (part.isText) {
			if (part.value.length > maxChatResponseResourceBytes) {
				throw createFileSystemProviderError('Chat response resource storage limit exceeded', FileSystemProviderErrorCode.FileTooLarge);
			}
			const encoded = new TextEncoder().encode(part.value);
			if (encoded.byteLength > maxChatResponseResourceBytes) {
				throw createFileSystemProviderError('Chat response resource storage limit exceeded', FileSystemProviderErrorCode.FileTooLarge);
			}
			return encoded;
		}

		const estimatedByteLength = Math.ceil(part.value.length * 3 / 4);
		if (estimatedByteLength > maxChatResponseResourceBytes) {
			throw createFileSystemProviderError('Chat response resource storage limit exceeded', FileSystemProviderErrorCode.FileTooLarge);
		}
		const decoded = decodeBase64(part.value).buffer;
		if (decoded.byteLength > maxChatResponseResourceBytes) {
			throw createFileSystemProviderError('Chat response resource storage limit exceeded', FileSystemProviderErrorCode.FileTooLarge);
		}
		return decoded;
	}
}

export class ChatResponseResourceWorkbenchContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'chatResponseResourceWorkbenchContribution';

	constructor(
		@IChatResponseResourceFileSystemProvider chatResponseResourceFsProvider: IChatResponseResourceFileSystemProvider,
		@IFileService fileService: IFileService,
	) {
		super();
		this._register(fileService.registerProvider(ChatResponseResource.scheme, chatResponseResourceFsProvider));
	}
}
