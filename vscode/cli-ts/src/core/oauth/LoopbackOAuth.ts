import { spawn } from "node:child_process";
import { createServer, type RequestListener, type Server } from "node:http";
import os from "node:os";

export async function listenOnLoopback(
	host: string,
	port: number,
	handler: RequestListener,
): Promise<Server> {
	return await new Promise<Server>((resolve, reject) => {
		const server = createServer(handler);
		const onError = (err: Error) => {
			server.off("listening", onListening);
			server.close();
			reject(err);
		};
		const onListening = () => {
			server.off("error", onError);
			resolve(server);
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(port, host);
	});
}

export async function openDefaultBrowser(url: URL | string): Promise<void> {
	const value = url.toString();
	const platform = os.platform();
	const command =
		platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
	const args = platform === "win32" ? ["/c", "start", "", value] : [value];

	await new Promise<void>((resolve, reject) => {
		const child = spawn(command, args, {
			detached: true,
			stdio: "ignore",
		});
		child.once("error", reject);
		child.once("spawn", () => {
			child.unref();
			resolve();
		});
	});
}

export function isNodeError(value: unknown): value is NodeJS.ErrnoException {
	return value instanceof Error && "code" in value;
}
