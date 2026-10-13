/**
 * Some packaged runtimes omit the global SharedArrayBuffer constructor even
 * though their engine supports shared WebAssembly memory. The Claude SDK
 * allocates a buffer during module initialization (including on macOS).
 * Recover the engine's real constructor before importing it; ArrayBuffer is
 * not a substitute because the SDK uses Atomics.wait on this memory.
 */
export function ensureClaudeSdkSharedMemory(): void {
	if (typeof globalThis.SharedArrayBuffer === "function") return;
	try {
		const memory = new WebAssembly.Memory({
			initial: 1,
			maximum: 1,
			shared: true,
		});
		const constructor = memory.buffer.constructor as SharedArrayBufferConstructor;
		const buffer = new constructor(4);
		// Verify shared-memory semantics before exposing the constructor.
		Atomics.wait(new Int32Array(buffer), 0, 0, 0);
		Object.defineProperty(globalThis, "SharedArrayBuffer", {
			value: constructor,
			writable: true,
			configurable: true,
		});
	} catch {
		throw new Error(
			"The bundled agent runtime cannot initialize Claude's shared memory. Update or rebuild Backboard and retry; your Claude sign-in is still saved.",
		);
	}
}
