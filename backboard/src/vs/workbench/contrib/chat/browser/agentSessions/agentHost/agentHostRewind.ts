/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { createTextBufferFactory } from '../../../../../../editor/common/model/textModel.js';
import { localize } from '../../../../../../nls.js';
import { IAgentConnection } from '../../../../../../platform/agentHost/common/agentService.js';
import { IAgentRewindBuffer, IAgentRewindResult } from '../../../../../../platform/agentHost/common/agentRewind.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { IEditorService } from '../../../../../services/editor/common/editorService.js';
import { IFilesConfigurationService } from '../../../../../services/filesConfiguration/common/filesConfigurationService.js';
import { ITextFileService, TextFileEditorModelState } from '../../../../../services/textfile/common/textfiles.js';

/** Coordinates dirty editor buffers with the host's durable filesystem transaction. */
export class AgentHostRewind {
	constructor(
		private readonly connection: IAgentConnection,
		private readonly session: URI,
		@ITextFileService private readonly textFiles: ITextFileService,
		@IFilesConfigurationService private readonly filesConfiguration: IFilesConfigurationService,
		@IFileService private readonly files: IFileService,
		@IEditorService private readonly editors: IEditorService,
	) { }

	async restore(retainedTurnId: string | undefined): Promise<number> {
		if (!this.connection.rewindSession) {
			throw new Error(localize('rewind.unsupported', "This connection does not support file rewind."));
		}
		const prepared = await this.connection.rewindSession(this.session, { operation: 'prepare', retainedTurnId });
		return this.withLockedFiles(prepared.paths, async () => {
			try {
				const buffers: IAgentRewindBuffer[] = [];
				for (const path of prepared.paths) {
					const model = this.textFiles.files.get(URI.file(path));
					if (model?.isDirty()) {
						buffers.push({ path, content: model.textEditorModel.getValue(), encoding: model.getEncoding() });
					}
				}
				const result = await this.connection.rewindSession!(this.session, { operation: 'commit', transactionId: prepared.transactionId, buffers });
				await this.refreshAndAcknowledge(result);
				return result.activeCount;
			} catch (error) {
				// A failed file write or model refresh restores both disk and dirty buffers.
				try {
					const recovered = await this.connection.rewindSession!(this.session, { operation: 'recover', transactionId: prepared.transactionId });
					await this.refreshAndAcknowledge(recovered);
				} catch (recoveryError) {
					throw new Error(localize('rewind.recoveryRequired', "File recovery is required before continuing. {0}", String(recoveryError)), { cause: error });
				}
				throw error;
			}
		});
	}

	async recover(): Promise<number> {
		if (!this.connection.rewindSession) {
			throw new Error(localize('rewind.unsupported', "This connection does not support file rewind."));
		}
		const backup = await this.connection.rewindSession(this.session, { operation: 'inspectRecovery' });
		return this.withLockedFiles(backup.paths, async () => {
			const result = await this.connection.rewindSession!(this.session, { operation: 'recover', transactionId: backup.transactionId });
			await this.refreshAndAcknowledge(result);
			return result.activeCount;
		});
	}

	/** Complete an interrupted editor refresh after reopening the conversation. */
	async resume(): Promise<number> {
		if (!this.connection.rewindSession) {
			throw new Error(localize('rewind.unsupported', "This connection does not support file rewind."));
		}
		const result = await this.connection.rewindSession(this.session, { operation: 'resume' });
		if (result.transactionId) {
			await this.withLockedFiles(result.paths, () => this.refreshAndAcknowledge(result));
		}
		return result.activeCount;
	}

	private async withLockedFiles<T>(paths: readonly string[], operation: () => Promise<T>): Promise<T> {
		const store = new DisposableStore();
		const readonly = new Map<string, boolean>();
		try {
			for (const path of paths) {
				const resource = URI.file(path);
				store.add(this.filesConfiguration.disableAutoSave(resource));
				readonly.set(path, !!this.filesConfiguration.isReadonly(resource));
				await this.filesConfiguration.updateReadonly(resource, true);
				const model = this.textFiles.files.get(resource);
				if (model?.hasState(TextFileEditorModelState.PENDING_SAVE)) {
					await model.joinState(TextFileEditorModelState.PENDING_SAVE);
				}
			}
			return await operation();
		} finally {
			try {
				for (const [path, wasReadonly] of readonly) {
					await this.filesConfiguration.updateReadonly(URI.file(path), wasReadonly);
				}
			} finally {
				store.dispose();
			}
		}
	}

	private async refreshAndAcknowledge(result: IAgentRewindResult): Promise<void> {
		await this.refresh(result);
		await this.connection.rewindSession!(this.session, { operation: 'acknowledge', transactionId: result.transactionId });
	}

	private async refresh(result: IAgentRewindResult): Promise<void> {
		for (const path of result.paths) {
			const resource = URI.file(path);
			await this.textFiles.revert(resource, { force: true });
			if (!await this.files.exists(resource)) {
				await this.editors.closeEditors(this.editors.findEditors(resource));
			}
		}
		for (const buffer of result.buffers) {
			const model = await this.textFiles.files.resolve(URI.file(buffer.path), { contents: createTextBufferFactory(buffer.content) });
			model.updatePreferredEncoding(buffer.encoding);
			model.textEditorModel?.setValue(buffer.content);
		}
	}
}
