/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { TimeoutTimer } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { extname } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { FileOperationResult, IFileService, toFileOperationResult } from '../../../files/common/files.js';
import { createDecorator } from '../../../instantiation/common/instantiation.js';
import { ILogService } from '../../../log/common/log.js';
import { ITelemetryService } from '../../../telemetry/common/telemetry.js';
import { AgentSession } from '../../common/agentService.js';
import { computeChunkedEditSurvival, computeWholeFileEditSurvival } from './editSurvivalTracker.js';

/**
 * Parameters describing a single completed tool-driven file edit that the
 * agent host wants to follow over time.
 *
 * Only first-party edit tools that go through `FileEditTracker` produce
 * these — file modifications from shell tools like `Bash` are not
 * observable here.
 *
 * Notebook tools (`NotebookEdit`) are skipped by the launcher for now
 * to avoid the complexity of scoring against notebook JSON. We may
 * revisit when we have a notebook-aware tracker.
 */
export interface IEditSurvivalReporterLaunchParams {
	/** Full session URI string (e.g. `claude:/abc123`). */
	readonly sessionUri: string;
	readonly turnId: string;
	readonly toolCallId: string;
	/** Absolute file path on the agent host's local file system. */
	readonly filePath: string;
	/** File content snapshotted before the tool ran (empty for creates). */
	readonly beforeText: string;
	/** File content after the tool ran (the AI's output). */
	readonly afterText: string;
	/** Whether the tool created a new file (no prior content existed). */
	readonly isCreate: boolean;
	/**
	 * The model that produced this edit (e.g. `claude-sonnet-4.5`,
	 * `gpt-5-mini`). Used to slice survival telemetry by model in
	 * dashboards. Expected to always be populated in practice (Claude
	 * reads it off every assistant message; Copilot tracks the session's
	 * last-seen model via setModel and onUsage). The field is optional
	 * so a missing model can't suppress the survival sample, but
	 * `undefined` here is a bug -- the resulting event is emitted with
	 * `modelId=''` and the caller is expected to log a warning.
	 */
	readonly modelId?: string;
	/**
	 * The explicit text chunks the AI wrote, extracted from the tool
	 * input (e.g. `Edit.new_string`, each `MultiEdit.edits[*].new_string`,
	 * or `Write.content`). When provided, the reporter computes
	 * `survivalRateFourGram` with the chunked, search-within math -- so
	 * the score does not decay as the file grows around the chunks.
	 *
	 * In practice every known file-edit tool produces chunks (see the
	 * coverage invariant in `editChunkExtractor.ts`). Omitting or
	 * passing an empty array is a safety-net path for unknown / drifted
	 * tool shapes; the reporter then falls back to whole-file scoring
	 * and tags the telemetry event with `scoringMode='whole-file'`.
	 */
	readonly aiChunks?: readonly string[];
}

export const IEditSurvivalReporterFactory = createDecorator<IEditSurvivalReporterFactory>('editSurvivalReporterFactory');

/**
 * A live edit-survival sample schedule.
 *
 * Reporters expose their lifecycle so both their creating tracker and the
 * process-wide factory can stop retaining them once their final sample has
 * run. `retainedTextChars` is diagnostic/accounting state, not telemetry.
 */
export interface IEditSurvivalReporter extends IDisposable {
	readonly onDidDispose: Event<void>;
	readonly isDisposed: boolean;
	readonly retainedTextChars: number;
}

/**
 * Launches background reporters that sample the on-disk file after a tool
 * edit and emit edit-survival telemetry over the next 15 minutes.
 */
export interface IEditSurvivalReporterFactory {
	readonly _serviceBrand: undefined;
	/**
	 * Begin tracking a single file edit. The returned disposable can be
	 * used to cancel sampling early; otherwise the reporter cleans itself
	 * up after the final 15-minute sample.
	 */
	launch(params: IEditSurvivalReporterLaunchParams): IEditSurvivalReporter;
}

const NULL_EDIT_SURVIVAL_REPORTER: IEditSurvivalReporter = Object.freeze({
	onDidDispose: Event.None,
	isDisposed: true,
	retainedTextChars: 0,
	dispose() { },
});

/** No-op factory, useful for tests and environments without telemetry. */
export class NullEditSurvivalReporterFactory implements IEditSurvivalReporterFactory {
	readonly _serviceBrand: undefined;
	launch(_params: IEditSurvivalReporterLaunchParams): IEditSurvivalReporter {
		return NULL_EDIT_SURVIVAL_REPORTER;
	}
}

interface IEditSurvivalTelemetryEvent {
	provider: string;
	modelId: string;
	agentSessionId: string;
	turnId: string;
	toolCallId: string;
	fileExtension: string;
	survivalRateFourGram: number;
	survivalRateNoRevert: number;
	scoringMode: string;
	aiChunkCount: number;
	aiCharCount: number;
	timeDelayMs: number;
	didFileGetDeleted: number;
	isCreate: number;
	beforeTextLength: number;
	afterTextLength: number;
	currentTextLength: number;
}

type IEditSurvivalTelemetryClassification = {
	provider: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The provider handling the agent host session.' };
	modelId: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The model that produced the edit, e.g. "claude-sonnet-4.5" or "gpt-5-mini". Empty if the host could not determine the per-edit model.' };
	agentSessionId: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The agent host session identifier.' };
	turnId: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The agent host turn identifier this edit belongs to.' };
	toolCallId: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The tool call identifier that produced the edit.' };
	fileExtension: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The file extension (including the leading dot) of the edited file, or empty if the file has no extension.' };
	survivalRateFourGram: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; isMeasurement: true; comment: 'A number between 0 and 1 representing the share of 4-grams the AI wrote that are still present in the file.' };
	survivalRateNoRevert: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; isMeasurement: true; comment: 'A number between 0 and 1; 1 means the user kept the AI edit and 0 means the user fully reverted it.' };
	scoringMode: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'How survivalRateFourGram was computed: "chunked" (asymmetric, denominator bounded by the AI-written text) or "whole-file" (symmetric, denominator includes the whole file).' };
	aiChunkCount: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; isMeasurement: true; comment: 'Number of distinct AI-written text chunks contributing to chunked scoring (0 when scoringMode is "whole-file").' };
	aiCharCount: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; isMeasurement: true; comment: 'Sum of character lengths of the AI-written chunks (suitable for char-weighted dashboard rollups). Always 0 when scoringMode is "whole-file" because we cannot accurately determine the AI char count from a whole-file snapshot.' };
	timeDelayMs: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; isMeasurement: true; comment: 'Milliseconds since the edit completed when this sample was taken.' };
	didFileGetDeleted: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; isMeasurement: true; comment: '1 if the file could not be read when the sample was taken (deleted or moved), otherwise 0.' };
	isCreate: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; isMeasurement: true; comment: '1 if the tool call created a new file, otherwise 0.' };
	beforeTextLength: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; isMeasurement: true; comment: 'Length in characters of the file content before the AI edit.' };
	afterTextLength: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; isMeasurement: true; comment: 'Length in characters of the file content the AI wrote.' };
	currentTextLength: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; isMeasurement: true; comment: 'Length in characters of the file content at the time of the sample (0 if the file is missing).' };
	owner: 'roblourens';
	comment: 'Tracks how long AI-produced file edits survive in the user\'s file over the 15 minutes following a tool call in an agent host session. No file contents are reported.';
};

/**
 * Schedule of samples (in milliseconds since the edit completed) at
 * which we read the file again and emit a telemetry event. Matches the
 * chat extension's schedule so the resulting data is comparable.
 */
const SAMPLE_SCHEDULE_MS = [0, 5_000, 30_000, 120_000, 300_000, 600_000, 900_000];

class SessionEditSurvivalReporter extends Disposable implements IEditSurvivalReporter {
	private readonly _onDidDispose = this._register(new Emitter<void>());
	readonly onDidDispose = this._onDidDispose.event;

	private readonly _startTime = Date.now();
	private _samplesTaken = 0;
	private _isDisposed = false;
	private _retainedTextChars: number;
	private _params: IEditSurvivalReporterLaunchParams | undefined;

	constructor(
		params: IEditSurvivalReporterLaunchParams,
		private readonly _fileService: IFileService,
		private readonly _logService: ILogService,
		private readonly _telemetryService: ITelemetryService,
	) {
		super();
		this._params = params;
		this._retainedTextChars = retainedTextChars(params);
		this._scheduleNext();
	}

	get isDisposed(): boolean {
		return this._isDisposed;
	}

	get retainedTextChars(): number {
		return this._retainedTextChars;
	}

	override dispose(): void {
		if (this._isDisposed) {
			return;
		}
		this._isDisposed = true;
		// Drop the potentially multi-megabyte snapshots before notifying owners.
		// A stale external reference to this disposed reporter must not keep file
		// contents alive for the remainder of the session.
		this._params = undefined;
		this._retainedTextChars = 0;
		this._onDidDispose.fire();
		super.dispose();
	}

	private _scheduleNext(): void {
		if (this._isDisposed) {
			return;
		}
		if (this._samplesTaken >= SAMPLE_SCHEDULE_MS.length) {
			this.dispose();
			return;
		}

		const elapsed = Date.now() - this._startTime;
		const delay = Math.max(0, SAMPLE_SCHEDULE_MS[this._samplesTaken] - elapsed);
		const timer = this._register(new TimeoutTimer());
		timer.setIfNotSet(() => this._takeSample(), delay);
	}

	private async _takeSample(): Promise<void> {
		const params = this._params;
		if (!params) {
			return;
		}
		const sampleIndex = this._samplesTaken++;
		const timeDelayMs = SAMPLE_SCHEDULE_MS[sampleIndex];

		try {
			let currentText: string;
			let didFileGetDeleted = false;
			try {
				const content = await this._fileService.readFile(URI.file(params.filePath));
				currentText = content.value.toString();
			} catch (err) {
				// Only treat genuine "file is gone" as a delete event.
				// Other failures (permissions, transient provider hiccups,
				// FILE_TOO_LARGE, etc.) shouldn't bias the telemetry as
				// reverts -- skip this sample and try again next time.
				if (toFileOperationResult(err) === FileOperationResult.FILE_NOT_FOUND) {
					didFileGetDeleted = true;
					currentText = '';
				} else {
					this._logService.warn(`[EditSurvivalReporter] readFile failed for ${params.filePath}, skipping sample: ${err}`);
					this._scheduleNext();
					return;
				}
			}
			if (this._isDisposed) {
				return;
			}

			const aiChunks = params.aiChunks ?? [];
			const useChunked = aiChunks.length > 0;
			const aiCharCount = useChunked ? aiChunks.reduce((sum, c) => sum + c.length, 0) : 0;
			const scores = didFileGetDeleted
				? { fourGram: 0, noRevert: 0 }
				: useChunked
					? computeChunkedEditSurvival(params.beforeText, params.afterText, aiChunks, currentText)
					: computeWholeFileEditSurvival(params.beforeText, params.afterText, currentText);

			this._telemetryService.publicLog2<IEditSurvivalTelemetryEvent, IEditSurvivalTelemetryClassification>(
				'agentHost.trackEditSurvival',
				{
					provider: AgentSession.provider(params.sessionUri) ?? 'unknown',
					modelId: params.modelId ?? '',
					agentSessionId: AgentSession.id(params.sessionUri),
					turnId: params.turnId,
					toolCallId: params.toolCallId,
					fileExtension: extname(params.filePath),
					survivalRateFourGram: scores.fourGram,
					survivalRateNoRevert: scores.noRevert,
					scoringMode: useChunked ? 'chunked' : 'whole-file',
					aiChunkCount: aiChunks.length,
					aiCharCount,
					timeDelayMs,
					didFileGetDeleted: didFileGetDeleted ? 1 : 0,
					isCreate: params.isCreate ? 1 : 0,
					beforeTextLength: params.beforeText.length,
					afterTextLength: params.afterText.length,
					currentTextLength: didFileGetDeleted ? 0 : currentText.length,
				},
			);

			if (didFileGetDeleted) {
				// Once the file is gone all further samples would report
				// the same; stop early.
				this.dispose();
				return;
			}
		} catch (err) {
			this._logService.warn(`[EditSurvivalReporter] sample failed for ${params.filePath}: ${err}`);
		}

		if (!this._isDisposed) {
			this._scheduleNext();
		}
	}
}

const MAX_TRACKED_FILE_SIZE_CHARS = 5 * 1024 * 1024;

/** Maximum live schedules across all sessions in this agent-host process. */
export const MAX_ACTIVE_EDIT_SURVIVAL_REPORTERS = 32;
/**
 * Aggregate snapshot/chunk budget. JavaScript strings can consume two bytes
 * per character, so this bounds the usual retained payload near 32 MiB.
 * One oversized-but-individually-valid edit is allowed when the registry is
 * otherwise empty, preserving telemetry for an ordinary single large edit.
 */
export const MAX_EDIT_SURVIVAL_RETAINED_TEXT_CHARS = 16 * 1024 * 1024;

function retainedTextChars(params: IEditSurvivalReporterLaunchParams): number {
	return params.beforeText.length
		+ params.afterText.length
		+ (params.aiChunks?.reduce((sum, chunk) => sum + chunk.length, 0) ?? 0);
}

export class EditSurvivalReporterFactory extends Disposable implements IEditSurvivalReporterFactory {
	readonly _serviceBrand: undefined;
	private readonly _activeReporters = new Map<IEditSurvivalReporter, number>();
	private _activeRetainedTextChars = 0;

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@ILogService private readonly _logService: ILogService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
	) {
		super();
	}

	get activeReporterCount(): number {
		return this._activeReporters.size;
	}

	get activeRetainedTextChars(): number {
		return this._activeRetainedTextChars;
	}

	launch(params: IEditSurvivalReporterLaunchParams): IEditSurvivalReporter {
		// Skip notebooks for now: scoring against the on-disk JSON
		// (including output cells) doesn't reflect user intent. We may
		// revisit with a notebook-aware tracker.
		if (extname(params.filePath).toLowerCase() === '.ipynb') {
			return NULL_EDIT_SURVIVAL_REPORTER;
		}
		// Skip very large files to avoid putting pressure on memory and perf.
		if (Math.max(params.beforeText.length, params.afterText.length) > MAX_TRACKED_FILE_SIZE_CHARS) {
			return NULL_EDIT_SURVIVAL_REPORTER;
		}

		const retainedChars = retainedTextChars(params);
		while (this._activeReporters.size > 0 && (
			this._activeReporters.size >= MAX_ACTIVE_EDIT_SURVIVAL_REPORTERS
			|| this._activeRetainedTextChars + retainedChars > MAX_EDIT_SURVIVAL_RETAINED_TEXT_CHARS
		)) {
			// Maps preserve insertion order: shed the oldest schedule first.
			this._activeReporters.keys().next().value?.dispose();
		}

		const reporter = new SessionEditSurvivalReporter(params, this._fileService, this._logService, this._telemetryService);
		this._activeReporters.set(reporter, retainedChars);
		this._activeRetainedTextChars += retainedChars;
		Event.once(reporter.onDidDispose)(() => this._releaseReporter(reporter));
		return reporter;
	}

	private _releaseReporter(reporter: IEditSurvivalReporter): void {
		const retainedChars = this._activeReporters.get(reporter);
		if (retainedChars === undefined) {
			return;
		}
		this._activeReporters.delete(reporter);
		this._activeRetainedTextChars -= retainedChars;
	}

	override dispose(): void {
		for (const reporter of [...this._activeReporters.keys()]) {
			reporter.dispose();
		}
		this._activeReporters.clear();
		this._activeRetainedTextChars = 0;
		super.dispose();
	}
}
