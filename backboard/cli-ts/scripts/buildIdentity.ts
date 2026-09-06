import { sourceBuildInfo } from "../src/config/runtimeIdentity.ts";

/** Embed only explicit non-secret fields; never copy the build environment. */
export async function buildIdentityArgs(): Promise<string[]> {
	const info = {
		...(await sourceBuildInfo()),
		timestamp: new Date().toISOString(),
	};
	return ["--define", `BACKBOARD_BUILD_INFO=${JSON.stringify(info)}`];
}
