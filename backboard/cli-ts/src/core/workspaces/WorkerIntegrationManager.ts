import { isAbsolute, relative, resolve, sep } from "node:path";
import { errorMessage } from "../../utils/errors.ts";
import { canonicalLockPath, withPathLocks } from "../../utils/pathLocks.ts";
import type {
	GitIntegrationResult,
	GitWorktreeManager,
} from "./GitWorktreeManager.ts";
import type { WorkerWorkspaceStore } from "./WorkerWorkspaceStore.ts";
import type { WorkerWorkspaceRecord } from "./WorkerWorkspaceTypes.ts";

interface PreparedIntegration {
	record: WorkerWorkspaceRecord;
	ownedPaths: string[];
	ownershipKeys: string[];
}

/** Integrates captured worker results while preserving recoverable conflicts. */
export class WorkerIntegrationManager {
	constructor(
		private readonly git: GitWorktreeManager,
		private readonly store: WorkerWorkspaceStore,
	) {}

	async integrate(
		record: WorkerWorkspaceRecord,
		signal?: AbortSignal,
		onProgress?: (record: WorkerWorkspaceRecord) => void,
	): Promise<WorkerWorkspaceRecord> {
		return (
			(await this.integrateBatch([record], signal, onProgress))[0] ?? record
		);
	}

	/**
	 * Coalesces only results already available to the caller. Every eligible member
	 * crosses the durable `integrating` boundary before the first Git mutation.
	 */
	async integrateBatch(
		records: readonly WorkerWorkspaceRecord[],
		signal?: AbortSignal,
		onProgress?: (record: WorkerWorkspaceRecord) => void,
	): Promise<WorkerWorkspaceRecord[]> {
		if (records.length === 0) return [];
		const results = new Map<string, WorkerWorkspaceRecord>();
		const prepared: PreparedIntegration[] = [];

		for (const record of records) {
			if (
				record.executionStatus !== "completed" ||
				!record.startingCommit ||
				!record.resultCommit
			) {
				results.set(record.workerId, {
					...record,
					integrationStatus: "skipped",
				});
				continue;
			}
			if (signal?.aborted) {
				results.set(record.workerId, {
					...record,
					executionStatus: "cancelled",
					integrationStatus: "skipped",
					error: "Cancelled before integration.",
				});
				continue;
			}
			try {
				const ownedPaths = integrationOwnedPaths(record);
				const ownershipKeys = [
					...new Set(await Promise.all(ownedPaths.map(canonicalLockPath))),
				].sort();
				const integrating = {
					...record,
					integrationStatus: "integrating" as const,
				};
				results.set(record.workerId, integrating);
				prepared.push({ record: integrating, ownedPaths, ownershipKeys });
			} catch (error) {
				results.set(record.workerId, {
					...record,
					integrationStatus: "skipped",
					error: errorMessage(error),
				});
			}
		}

		// This write is deliberately one durable boundary for the whole ready set.
		// A restart can now reconcile any subset Git managed to commit.
		await this.persistMany([...results.values()], onProgress);

		for (const group of groupByCoordinator(prepared)) {
			for (const wave of disjointWaves(group)) {
				const completed = await this.integrateWave(wave, signal);
				for (const record of completed) results.set(record.workerId, record);
				await this.persistMany(completed, onProgress);
			}
		}

		return records.map((record) => results.get(record.workerId) ?? record);
	}

	async reconcile(
		record: WorkerWorkspaceRecord,
	): Promise<WorkerWorkspaceRecord> {
		if (!record.resultCommit) return record;
		if (await this.git.isAncestor(record.coordinatorCwd, record.resultCommit)) {
			const info = await this.git.inspect(record.coordinatorCwd);
			return this.persist({
				...record,
				integrationStatus: "integrated",
				integrationCommit: info?.head,
				integratedAt: record.integratedAt ?? new Date().toISOString(),
				conflictingFiles: undefined,
				error: undefined,
			});
		}
		if (await this.git.mergeInProgress(record.coordinatorCwd)) {
			// A crash can leave a one-head or octopus worker merge staged. Abort only
			// when this worker's durable result is one of MERGE_HEAD's parents.
			if (
				await this.git.abortWorkerIntegration(
					record.coordinatorCwd,
					record.resultCommit,
				)
			) {
				return this.persist({
					...record,
					integrationStatus: "pending",
					conflictingFiles: undefined,
					error:
						"Recovered an interrupted worker integration; retry is pending.",
				});
			}
			return this.persist({
				...record,
				integrationStatus: "conflict",
				conflictingFiles: await this.git.conflictingFiles(
					record.coordinatorCwd,
				),
			});
		}
		return this.persist({
			...record,
			integrationStatus: "pending",
			conflictingFiles: undefined,
		});
	}

	private async integrateWave(
		wave: readonly PreparedIntegration[],
		signal?: AbortSignal,
	): Promise<WorkerWorkspaceRecord[]> {
		const first = wave[0];
		if (!first) return [];
		const ownedPaths = [...new Set(wave.flatMap((item) => item.ownedPaths))];
		try {
			const batchResult = await withPathLocks(ownedPaths, () =>
				wave.length === 1
					? this.git.integrate({
							coordinatorCwd: first.record.coordinatorCwd,
							startingCommit: first.record.startingCommit ?? "",
							resultCommit: first.record.resultCommit ?? "",
							signal,
						})
					: this.git.integrateBatch({
							coordinatorCwd: first.record.coordinatorCwd,
							results: wave.map(({ record }) => ({
								startingCommit: record.startingCommit ?? "",
								resultCommit: record.resultCommit ?? "",
							})),
							signal,
						}),
			);
			if (batchResult.status === "integrated") {
				return wave.map(({ record }) => integratedRecord(record, batchResult));
			}
			if (wave.length === 1) {
				return [conflictedRecord(first.record, batchResult)];
			}
			// Git has already aborted the failed octopus transaction. Deterministic
			// single-result retries isolate a conflicting path group from unrelated work.
			return this.integrateIndividually(wave, signal);
		} catch (error) {
			return wave.map(({ record }) => ({
				...record,
				...(signal?.aborted ? { executionStatus: "cancelled" as const } : {}),
				integrationStatus: signal?.aborted ? "skipped" : "pending",
				error: errorMessage(error),
			}));
		}
	}

	private async integrateIndividually(
		wave: readonly PreparedIntegration[],
		signal?: AbortSignal,
	): Promise<WorkerWorkspaceRecord[]> {
		const completed: WorkerWorkspaceRecord[] = [];
		for (const item of wave) {
			try {
				const result = await withPathLocks(item.ownedPaths, () =>
					this.git.integrate({
						coordinatorCwd: item.record.coordinatorCwd,
						startingCommit: item.record.startingCommit ?? "",
						resultCommit: item.record.resultCommit ?? "",
						signal,
					}),
				);
				completed.push(
					result.status === "integrated"
						? integratedRecord(item.record, result)
						: conflictedRecord(item.record, result),
				);
			} catch (error) {
				completed.push({
					...item.record,
					...(signal?.aborted ? { executionStatus: "cancelled" as const } : {}),
					integrationStatus: signal?.aborted ? "skipped" : "pending",
					error: errorMessage(error),
				});
			}
		}
		return completed;
	}

	private async persist(
		record: WorkerWorkspaceRecord,
		onProgress?: (record: WorkerWorkspaceRecord) => void,
	): Promise<WorkerWorkspaceRecord> {
		await this.store.upsert(record);
		onProgress?.(record);
		return record;
	}

	private async persistMany(
		records: readonly WorkerWorkspaceRecord[],
		onProgress?: (record: WorkerWorkspaceRecord) => void,
	): Promise<void> {
		if (records.length === 0) return;
		await this.store.upsertMany(records);
		for (const record of records) onProgress?.(record);
	}
}

export function integrationOwnedPaths(record: WorkerWorkspaceRecord): string[] {
	const root = resolve(record.coordinatorCwd);
	return [...new Set(record.changedFiles)].map((path) => {
		const target = resolve(root, path);
		const relativePath = relative(root, target);
		if (
			relativePath.length === 0 ||
			relativePath === ".." ||
			relativePath.startsWith(`..${sep}`) ||
			isAbsolute(relativePath)
		) {
			throw new Error(
				`Refusing to integrate worker path outside the coordinator workspace: ${path}`,
			);
		}
		return target;
	});
}

function groupByCoordinator(
	prepared: readonly PreparedIntegration[],
): PreparedIntegration[][] {
	const groups = new Map<string, PreparedIntegration[]>();
	for (const item of [...prepared].sort(comparePrepared)) {
		const key = resolve(item.record.coordinatorCwd);
		const group = groups.get(key) ?? [];
		group.push(item);
		groups.set(key, group);
	}
	return [...groups.values()];
}

function disjointWaves(
	prepared: readonly PreparedIntegration[],
): PreparedIntegration[][] {
	const components: Array<{
		items: PreparedIntegration[];
		paths: Set<string>;
	}> = [];
	for (const item of [...prepared].sort(comparePrepared)) {
		const overlaps: number[] = [];
		for (let index = 0; index < components.length; index++) {
			if (
				item.ownershipKeys.some((path) => components[index]?.paths.has(path))
			) {
				overlaps.push(index);
			}
		}
		const component = {
			items: [item],
			paths: new Set(item.ownershipKeys),
		};
		for (const index of overlaps.reverse()) {
			const merged = components.splice(index, 1)[0];
			if (!merged) continue;
			component.items.push(...merged.items);
			for (const path of merged.paths) component.paths.add(path);
		}
		component.items.sort(comparePrepared);
		components.push(component);
	}
	components.sort((a, b) => {
		const firstA = a.items[0];
		const firstB = b.items[0];
		if (!firstA) return firstB ? 1 : 0;
		if (!firstB) return -1;
		return comparePrepared(firstA, firstB);
	});
	const waves: PreparedIntegration[][] = [];
	const depth = Math.max(0, ...components.map(({ items }) => items.length));
	for (let index = 0; index < depth; index++) {
		const wave = components
			.map(({ items }) => items[index])
			.filter((item): item is PreparedIntegration => item !== undefined);
		if (wave.length > 0) waves.push(wave);
	}
	return waves;
}

function comparePrepared(
	a: PreparedIntegration,
	b: PreparedIntegration,
): number {
	const aFinished = a.record.finishedAt
		? Date.parse(a.record.finishedAt)
		: Number.NaN;
	const bFinished = b.record.finishedAt
		? Date.parse(b.record.finishedAt)
		: Number.NaN;
	if (Number.isFinite(aFinished) && Number.isFinite(bFinished)) {
		const difference = aFinished - bFinished;
		if (difference !== 0) return difference;
	} else if (Number.isFinite(aFinished)) {
		return -1;
	} else if (Number.isFinite(bFinished)) {
		return 1;
	}
	return (
		a.record.sequence - b.record.sequence ||
		a.record.workerId.localeCompare(b.record.workerId)
	);
}

function integratedRecord(
	record: WorkerWorkspaceRecord,
	result: GitIntegrationResult,
): WorkerWorkspaceRecord {
	return {
		...record,
		integrationStatus: "integrated",
		integrationCommit: result.commit,
		integratedAt: new Date().toISOString(),
		conflictingFiles: undefined,
		error: undefined,
	};
}

function conflictedRecord(
	record: WorkerWorkspaceRecord,
	result: GitIntegrationResult,
): WorkerWorkspaceRecord {
	return {
		...record,
		integrationStatus: "conflict",
		conflictingFiles: result.conflictingFiles,
		error:
			result.conflictingFiles.length > 0
				? `Integration conflict in ${result.conflictingFiles.join(", ")}`
				: "Integration could not apply cleanly.",
	};
}
