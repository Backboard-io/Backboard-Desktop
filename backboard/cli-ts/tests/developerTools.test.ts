import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wouldPromptForDeveloperTools } from "../src/core/platform/developerTools.ts";

let bin: string;

beforeEach(async () => {
	bin = await mkdtemp(join(tmpdir(), "devtools-test-"));
	await writeFile(join(bin, "git"), "#!/bin/sh\n", "utf8");
	await chmod(join(bin, "git"), 0o755);
});

afterEach(async () => {
	await rm(bin, { recursive: true, force: true });
});

describe("wouldPromptForDeveloperTools", () => {
	it("only flags Command Line Tools stubs resolved from /usr/bin", async () => {
		expect({
			gitFromOtherInstall: await wouldPromptForDeveloperTools(
				"git",
				`${bin}:/usr/bin`,
			),
			notAStub: await wouldPromptForDeveloperTools("ls", "/bin:/usr/bin"),
			notOnPath: await wouldPromptForDeveloperTools(
				"git",
				bin.replace("devtools", "absent"),
			),
		}).toEqual({
			gitFromOtherInstall: false,
			notAStub: false,
			notOnPath: false,
		});
	});
});
