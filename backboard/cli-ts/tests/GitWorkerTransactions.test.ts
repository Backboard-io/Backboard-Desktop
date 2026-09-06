import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	GitWorktreeManager,
	runGitCommand,
} from "../src/core/workspaces/GitWorktreeManager.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});

describe("worker integration transaction", () => {
	it("preserves unrelated user staging that appears after merge starts", async () => {
		const fixture = await repository();
		const manager = new GitWorktreeManager(async (cwd, args, options) => {
			const result = await runGitCommand(cwd, args, options);
			if (args[0] === "merge" && args.includes("--no-commit"))
				await stageUserChange(cwd);
			return result;
		});
		await expect(manager.integrate(fixture.input)).rejects.toThrow(
			"merge and index preserved",
		);
		expect(await git(fixture.cwd, ["rev-parse", "HEAD"])).toBe(fixture.start);
		expect(await git(fixture.cwd, ["show", ":user.txt"])).toBe("user work");
		expect(await manager.mergeInProgress(fixture.cwd)).toBe(true);
		expect(
			await manager.abortWorkerIntegration(fixture.cwd, fixture.result),
		).toBe(false);
		expect(await git(fixture.cwd, ["show", ":user.txt"])).toBe("user work");
	});

	it("validates the exact captured tree when staging changes immediately before write-tree", async () => {
		const fixture = await repository();
		const manager = new GitWorktreeManager(async (cwd, args, options) => {
			if (args[0] === "write-tree") await stageUserChange(cwd);
			return runGitCommand(cwd, args, options);
		});
		await expect(manager.integrate(fixture.input)).rejects.toThrow(
			"merge and index preserved",
		);
		expect(await git(fixture.cwd, ["rev-parse", "HEAD"])).toBe(fixture.start);
		expect(await git(fixture.cwd, ["show", ":user.txt"])).toBe("user work");
	});

	it("commits only the verified tree and leaves later user staging untouched", async () => {
		const fixture = await repository();
		const manager = new GitWorktreeManager(async (cwd, args, options) => {
			const result = await runGitCommand(cwd, args, options);
			if (args[0] === "write-tree") await stageUserChange(cwd);
			return result;
		});
		expect((await manager.integrate(fixture.input)).status).toBe("integrated");
		expect(await git(fixture.cwd, ["show", "HEAD:worker.txt"])).toBe(
			"worker work",
		);
		await expect(git(fixture.cwd, ["show", "HEAD:user.txt"])).rejects.toThrow();
		expect(await git(fixture.cwd, ["diff", "--cached", "--name-only"])).toBe(
			"user.txt",
		);
		expect(await git(fixture.cwd, ["show", ":user.txt"])).toBe("user work");
		expect(await manager.mergeInProgress(fixture.cwd)).toBe(false);
	});

	it("refuses to overwrite an externally advanced HEAD during commit publication", async () => {
		const fixture = await repository();
		let external = "";
		const manager = new GitWorktreeManager(async (cwd, args, options) => {
			const result = await runGitCommand(cwd, args, options);
			if (args.includes("commit-tree"))
				external = await advanceHead(cwd, fixture.start);
			return result;
		});
		await expect(manager.integrate(fixture.input)).rejects.toThrow(
			"merge and index preserved",
		);
		expect(await git(fixture.cwd, ["rev-parse", "HEAD"])).toBe(external);
		expect(await readFile(join(fixture.cwd, "worker.txt"), "utf8")).toBe(
			"worker work\n",
		);
		expect(await manager.mergeInProgress(fixture.cwd)).toBe(true);
	});

	it("keeps a durable worker commit and a later external commit when Stop arrives late", async () => {
		const fixture = await repository();
		const abort = new AbortController();
		let external = "";
		let resets = 0;
		const manager = new GitWorktreeManager(async (cwd, args, options) => {
			if (args[0] === "reset") resets++;
			const result = await runGitCommand(cwd, args, options);
			if (args[0] === "update-ref") {
				external = await advanceHead(
					cwd,
					await git(cwd, ["rev-parse", "HEAD"]),
				);
				abort.abort();
			}
			return result;
		});
		const result = await manager.integrate({
			...fixture.input,
			signal: abort.signal,
		});
		expect(result).toMatchObject({ status: "integrated", commit: external });
		expect(await git(fixture.cwd, ["rev-parse", "HEAD"])).toBe(external);
		expect(await manager.isAncestor(fixture.cwd, fixture.result)).toBe(true);
		expect(resets).toBe(0);
		expect(await manager.mergeInProgress(fixture.cwd)).toBe(false);
	});

	it("does not abort a user merge merely because it contains a worker result", async () => {
		const fixture = await repository();
		await git(fixture.cwd, ["merge", "--no-ff", "--no-commit", fixture.result]);
		const manager = new GitWorktreeManager();
		expect(
			await manager.abortWorkerIntegration(fixture.cwd, fixture.result),
		).toBe(false);
		expect(await manager.mergeInProgress(fixture.cwd)).toBe(true);
	});

	it("does not publish to another branch that points at the same starting commit", async () => {
		const fixture = await repository();
		await git(fixture.cwd, ["branch", "other", fixture.start]);
		const manager = new GitWorktreeManager(async (cwd, args, options) => {
			const result = await runGitCommand(cwd, args, options);
			if (args.includes("commit-tree"))
				await git(cwd, ["symbolic-ref", "HEAD", "refs/heads/other"]);
			return result;
		});
		await expect(manager.integrate(fixture.input)).rejects.toThrow(
			"branch changed",
		);
		expect(await git(fixture.cwd, ["rev-parse", "main"])).toBe(fixture.start);
		expect(await git(fixture.cwd, ["rev-parse", "other"])).toBe(fixture.start);
		expect(await git(fixture.cwd, ["symbolic-ref", "HEAD"])).toBe(
			"refs/heads/other",
		);
	});

	it("integrates detached coordinators with an explicit non-dereferencing HEAD update", async () => {
		const fixture = await repository();
		await git(fixture.cwd, ["checkout", "--detach", fixture.start]);
		const manager = new GitWorktreeManager();
		expect((await manager.integrate(fixture.input)).status).toBe("integrated");
		await expect(
			git(fixture.cwd, ["symbolic-ref", "--quiet", "HEAD"]),
		).rejects.toThrow();
		expect(await manager.isAncestor(fixture.cwd, fixture.result)).toBe(true);
		expect(await git(fixture.cwd, ["status", "--porcelain"])).toBe("");
	});
});

async function repository() {
	const cwd = await mkdtemp(join(tmpdir(), "backboard-worker-transaction-"));
	roots.push(cwd);
	await git(cwd, ["init", "-b", "main"]);
	await git(cwd, ["config", "user.name", "Test User"]);
	await git(cwd, ["config", "user.email", "test@example.com"]);
	await writeFile(join(cwd, "base.txt"), "base\n");
	await git(cwd, ["add", "base.txt"]);
	await git(cwd, ["commit", "--no-gpg-sign", "-m", "base"]);
	const start = await git(cwd, ["rev-parse", "HEAD"]);
	await git(cwd, ["checkout", "-b", "worker"]);
	await writeFile(join(cwd, "worker.txt"), "worker work\n");
	await git(cwd, ["add", "worker.txt"]);
	await git(cwd, ["commit", "--no-gpg-sign", "-m", "worker"]);
	const result = await git(cwd, ["rev-parse", "HEAD"]);
	await git(cwd, ["checkout", "main"]);
	return {
		cwd,
		start,
		result,
		input: { coordinatorCwd: cwd, startingCommit: start, resultCommit: result },
	};
}

async function stageUserChange(cwd: string) {
	await writeFile(join(cwd, "user.txt"), "user work\n");
	await git(cwd, ["add", "user.txt"]);
}

async function advanceHead(cwd: string, parent: string): Promise<string> {
	const tree = await git(cwd, ["rev-parse", `${parent}^{tree}`]);
	const commit = await git(cwd, [
		"commit-tree",
		"--no-gpg-sign",
		tree,
		"-p",
		parent,
		"-m",
		"external work",
	]);
	await git(cwd, ["update-ref", "HEAD", commit, parent]);
	return commit;
}

async function git(cwd: string, args: string[]): Promise<string> {
	return (await runGitCommand(cwd, args)).stdout.trim();
}
