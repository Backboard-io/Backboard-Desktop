/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../../base/browser/dom.js';
import { Button } from '../../../../../../base/browser/ui/button/button.js';
import { renderIcon } from '../../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { IMarkdownString } from '../../../../../../base/common/htmlContent.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../nls.js';
import { IMarkdownRenderer } from '../../../../../../platform/markdown/browser/markdownRenderer.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import { defaultButtonStyles } from '../../../../../../platform/theme/browser/defaultStyles.js';
import { IChatErrorReportDetails, IChatErrorReportService } from '../../../common/chatErrorReporting.js';
import { ChatErrorLevel } from '../../../common/chatService/chatService.js';
import { IChatRendererContent, IChatResponseViewModel, isResponseVM } from '../../../common/model/chatViewModel.js';
import { IChatWidgetService } from '../../chat.js';
import { IChatContentPart, IChatContentPartRenderContext } from './chatContentParts.js';

const $ = dom.$;

export class ChatErrorContentPart extends Disposable implements IChatContentPart {
	public readonly domNode: HTMLElement;

	constructor(
		kind: ChatErrorLevel,
		content: IMarkdownString,
		private readonly errorDetails: IChatRendererContent,
		renderer: IMarkdownRenderer,
		context: IChatContentPartRenderContext | undefined,
		@IChatErrorReportService private readonly chatErrorReportService: IChatErrorReportService,
		@IChatWidgetService private readonly chatWidgetService: IChatWidgetService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super();

		const widget = this._register(new ChatErrorWidget(kind, content, renderer));

		const element = context?.element;
		if (kind === ChatErrorLevel.Error && element && isResponseVM(element) && this.chatErrorReportService.isEnabled()) {
			this.domNode = $('.chat-error-part');
			this.domNode.append(widget.domNode);
			this.renderReportButton(element, content);
		} else {
			this.domNode = widget.domNode;
		}
	}

	private renderReportButton(element: IChatResponseViewModel, content: IMarkdownString): void {
		const details = this.toReportDetails(element, content);

		const buttonContainer = dom.append(this.domNode, $('.chat-buttons-container'));
		const button = this._register(new Button(buttonContainer, { ...defaultButtonStyles, secondary: true }));

		const sentLabel = localize('chat.errorReportSent', "Error Report Sent");
		if (this.chatErrorReportService.hasReported(details.reportKey)) {
			button.label = sentLabel;
			button.enabled = false;
			return;
		}

		const idleLabel = localize('chat.sendErrorReport', "Send Error Report");
		button.label = idleLabel;
		this._register(button.onDidClick(async () => {
			button.enabled = false;
			button.label = localize('chat.sendingErrorReport', "Sending Error Report...");
			try {
				await this.chatErrorReportService.report(details);
				button.label = sentLabel;
			} catch (error) {
				button.label = idleLabel;
				button.enabled = true;
				this.notificationService.error(localize('chat.errorReportFailed', "Failed to send the error report: {0}", error instanceof Error ? error.message : String(error)));
			}
		}));

		// Keep the button in sync when the report is sent elsewhere (e.g. from
		// the notification prompt).
		this._register(this.chatErrorReportService.onDidReport(reportKey => {
			if (reportKey === details.reportKey) {
				button.label = sentLabel;
				button.enabled = false;
			}
		}));

		// Proactively offer to submit the newest error via a notification.
		if (this.errorDetails.kind === 'errorDetails' && this.errorDetails.isLast) {
			this.chatErrorReportService.promptToReport(details);
		}
	}

	private toReportDetails(element: IChatResponseViewModel, content: IMarkdownString): IChatErrorReportDetails {
		const responseErrorDetails = this.errorDetails.kind === 'errorDetails' ? this.errorDetails.errorDetails : undefined;
		return {
			reportKey: `${element.requestId}:${this.errorDetails.kind}`,
			message: content.value,
			code: responseErrorDetails?.code,
			kind: this.errorDetails.kind,
			responseIsIncomplete: responseErrorDetails?.responseIsIncomplete,
			responseIsFiltered: responseErrorDetails?.responseIsFiltered,
			sessionResource: element.sessionResource.toString(),
			requestId: element.requestId,
			agentId: element.agent?.id,
			modelId: this.chatWidgetService.getWidgetBySessionResource(element.sessionResource)?.input.currentLanguageModel,
		};
	}

	hasSameContent(other: IChatRendererContent): boolean {
		return other.kind === this.errorDetails.kind;
	}
}

export class ChatErrorWidget extends Disposable {
	public readonly domNode: HTMLElement;

	constructor(
		kind: ChatErrorLevel,
		content: IMarkdownString,
		renderer: IMarkdownRenderer,
	) {
		super();

		this.domNode = $('.chat-notification-widget');
		this.domNode.tabIndex = 0;
		let icon;
		let iconClass;
		switch (kind) {
			case ChatErrorLevel.Warning:
				icon = Codicon.warning;
				iconClass = '.chat-warning-codicon';
				break;
			case ChatErrorLevel.Error:
				icon = Codicon.error;
				iconClass = '.chat-error-codicon';
				break;
			case ChatErrorLevel.Info:
				icon = Codicon.info;
				iconClass = '.chat-info-codicon';
				break;
		}
		this.domNode.appendChild($(iconClass, undefined, renderIcon(icon)));
		const markdownContent = this._register(renderer.render(content));
		this.domNode.appendChild(markdownContent.element);
	}
}
