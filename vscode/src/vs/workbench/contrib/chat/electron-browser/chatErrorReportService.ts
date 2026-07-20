/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { raceTimeout } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { process } from '../../../../base/parts/sandbox/electron-browser/globals.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { INotificationService, NeverShowAgainScope, Severity } from '../../../../platform/notification/common/notification.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IRequestService } from '../../../../platform/request/common/request.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { IBackboardUserInfo, resolveBackboardUserInfo } from '../browser/backboardUserInfo.js';
import { ChatErrorReportingConfig, IChatErrorReportDetails, IChatErrorReportService } from '../common/chatErrorReporting.js';

const USER_INFO_TIMEOUT = 3000;

/**
 * Desktop implementation: builds the error report and PUTs it as a JSON object
 * to the configured endpoint (an S3 bucket by default). The upload runs in the
 * Electron main process (`net.fetch`) because the S3 endpoint does not allow
 * cross-origin renderer fetches.
 */
export class NativeChatErrorReportService extends Disposable implements IChatErrorReportService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidReport = this._register(new Emitter<string>());
	readonly onDidReport = this._onDidReport.event;

	private readonly reported = new Set<string>();
	private readonly prompted = new Set<string>();

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@INativeHostService private readonly nativeHostService: INativeHostService,
		@IProductService private readonly productService: IProductService,
		@IFileService private readonly fileService: IFileService,
		@IPathService private readonly pathService: IPathService,
		@IRequestService private readonly requestService: IRequestService,
		@INotificationService private readonly notificationService: INotificationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	isEnabled(): boolean {
		return this.configurationService.getValue<boolean>(ChatErrorReportingConfig.Enabled)
			&& !!this.endpoint();
	}

	hasReported(reportKey: string): boolean {
		return this.reported.has(reportKey);
	}

	async report(details: IChatErrorReportDetails): Promise<void> {
		const endpoint = this.endpoint();
		if (!endpoint) {
			throw new Error('No error reporting endpoint is configured.');
		}

		const timestamp = new Date();
		const url = `${endpoint}/${toDatePath(timestamp)}/${toTimeFragment(timestamp)}-${generateUuid().substring(0, 8)}.json`;
		const report = JSON.stringify(await this.buildReport(details, timestamp), undefined, 2);

		this.logService.info(`[ChatErrorReport] uploading error report for request ${details.requestId ?? '(unknown)'} to ${url}`);
		await this.nativeHostService.uploadErrorReport(url, report);
		this.reported.add(details.reportKey);
		this._onDidReport.fire(details.reportKey);
	}

	promptToReport(details: IChatErrorReportDetails): void {
		if (!this.isEnabled() || this.hasReported(details.reportKey) || this.prompted.has(details.reportKey)) {
			return;
		}
		this.prompted.add(details.reportKey);

		this.notificationService.prompt(
			Severity.Error,
			localize('chat.errorReportPrompt', "The last chat request failed. Submit an error report to the {0} team to help fix it?", this.productService.nameShort),
			[{
				label: localize('chat.errorReportPrompt.send', "Send Error Report"),
				run: async () => {
					try {
						await this.report(details);
						this.notificationService.info(localize('chat.errorReportPrompt.sent', "The error report was sent. Thank you!"));
					} catch (error) {
						this.notificationService.error(localize('chat.errorReportPrompt.failed', "Failed to send the error report: {0}", error instanceof Error ? error.message : String(error)));
					}
				}
			}],
			{
				neverShowAgain: {
					id: 'chat.errorReporting.prompt',
					scope: NeverShowAgainScope.APPLICATION,
					isSecondary: true,
				}
			}
		);
	}

	private endpoint(): string {
		const url = this.configurationService.getValue<string>(ChatErrorReportingConfig.Url);
		return typeof url === 'string' ? url.replace(/\/+$/, '') : '';
	}

	private async buildReport(details: IChatErrorReportDetails, timestamp: Date): Promise<object> {
		// Best-effort only — a missing identity must never block an error report.
		let user: IBackboardUserInfo | undefined;
		try {
			user = await raceTimeout(
				resolveBackboardUserInfo(this.fileService, this.pathService, this.requestService, this.logService),
				USER_INFO_TIMEOUT
			);
		} catch (error) {
			this.logService.warn('[ChatErrorReport] failed to resolve user identity for error report', error);
		}

		return {
			schemaVersion: 1,
			timestamp: timestamp.toISOString(),
			error: {
				message: details.message,
				code: details.code,
				kind: details.kind,
				responseIsIncomplete: details.responseIsIncomplete,
				responseIsFiltered: details.responseIsFiltered,
			},
			session: {
				sessionResource: details.sessionResource,
				requestId: details.requestId,
				agentId: details.agentId,
				modelId: details.modelId,
			},
			user: user?.name || user?.email ? { name: user.name, email: user.email } : undefined,
			product: {
				name: this.productService.nameLong,
				version: this.productService.version,
				backboardVersion: this.productService.backboardVersion,
				commit: this.productService.commit,
				quality: this.productService.quality,
			},
			os: {
				platform: process.platform,
				arch: process.arch,
			},
		};
	}
}

function toDatePath(date: Date): string {
	return date.toISOString().substring(0, 10);
}

function toTimeFragment(date: Date): string {
	return date.toISOString().substring(11, 23).replace(/[:.]/g, '-');
}
