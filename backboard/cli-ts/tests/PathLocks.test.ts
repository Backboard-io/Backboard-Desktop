import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withPathLocks } from "../src/utils/pathLocks.ts";

describe("path locks", () => {
	it("serializes real and symlink aliases of the same file", async () => {
		const root = await mkdtemp(join(tmpdir(), "path-lock-alias-"));
		try {
			const target = join(root, "target.txt");
			const alias = join(root, "alias.txt");
			await writeFile(target, "original", "utf8");
			await symlink(target, alias);
			let active = 0;
			let maxActive = 0;
			const mutate = (path: string) =>
				withPathLocks([path], async () => {
					active++;
					maxActive = Math.max(maxActive, active);
					await Bun.sleep(15);
					active--;
				});

			await Promise.all([mutate(target), mutate(alias)]);

			expect(maxActive).toBe(1);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("serializes new files reached through a symlinked directory", async () => {
		const root = await mkdtemp(join(tmpdir(), "path-lock-parent-alias-"));
		try {
			const targetDirectory = join(root, "target");
			const aliasDirectory = join(root, "alias");
			await mkdir(targetDirectory);
			await symlink(targetDirectory, aliasDirectory);
			let active = 0;
			let maxActive = 0;
			const mutate = (path: string) =>
				withPathLocks([path], async () => {
					active++;
					maxActive = Math.max(maxActive, active);
					await Bun.sleep(15);
					active--;
				});

			await Promise.all([
				mutate(join(targetDirectory, "new.txt")),
				mutate(join(aliasDirectory, "new.txt")),
			]);

			expect(maxActive).toBe(1);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("refuses to lock a dangling symlink as a normal missing path", async () => {
		const root = await mkdtemp(join(tmpdir(), "path-lock-dangling-"));
		try {
			const link = join(root, "link.txt");
			await symlink(join(root, "missing.txt"), link);
			let entered = false;

			await expect(
				withPathLocks([link], async () => {
					entered = true;
				}),
			).rejects.toThrow("dangling symbolic link");
			expect(entered).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
