#!/usr/bin/env node
import { mkdirSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer, type Server as NetServer } from "node:net";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { LoadedConfig } from "./config.js";
import { ConfigError, loadConfig } from "./config.js";
import type { RuntimePaths } from "./ipc.js";
import {
	clearStatus,
	connectOrSpawn,
	IDLE_GRACE_MS,
	runtimePaths,
	runtimePathsForSocket,
	writeStatus,
} from "./ipc.js";
import { log } from "./logger.js";
import { buildServer, startPools } from "./server.js";
import { SocketTransport } from "./socket-transport.js";

interface Options {
	config?: string;
	verbose: boolean;
	daemon: boolean;
	local: boolean;
	http: boolean;
	port: number;
	host: string;
	socket?: string;
}

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = "127.0.0.1";

function parseArgs(): Options {
	const argv = process.argv.slice(2);
	const options: Options = {
		verbose: false,
		daemon: false,
		local: false,
		http: false,
		port: DEFAULT_PORT,
		host: DEFAULT_HOST,
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--config") options.config = argv[++i];
		else if (arg === "--socket") options.socket = argv[++i];
		else if (arg === "--port") options.port = Number(argv[++i]);
		else if (arg === "--host") options.host = argv[++i];
		else if (arg === "--verbose") options.verbose = true;
		else if (arg === "--daemon") options.daemon = true;
		else if (arg === "--local") options.local = true;
		else if (arg === "--http") options.http = true;
		else throw new Error(`unknown argument: ${arg}`);
	}

	if (Number.isNaN(options.port)) throw new Error("--port requires a number");
	return options;
}

function loadOrExit(path: string | undefined): LoadedConfig {
	try {
		return loadConfig(path);
	} catch (err) {
		if (err instanceof ConfigError) {
			console.error(`mcp-pool: ${err.message}`);
			process.exit(1);
		}
		throw err;
	}
}

/** Default mode: an agent's stdio session, served by the shared daemon. */
async function runProxy(loaded: LoadedConfig, verbose: boolean): Promise<void> {
	const paths = runtimePaths(loaded.path);
	const socket = await connectOrSpawn(paths, loaded.path, verbose);

	// Pure byte pipe. MCP over stdio is newline-delimited JSON and the daemon
	// reads the same framing, so no MCP logic is needed here.
	process.stdin.pipe(socket);
	socket.pipe(process.stdout);

	await new Promise<void>((resolve) => {
		// Agent going away (stdin EOF) ends the daemon-side session.
		process.stdin.on("end", () => socket.end());
		socket.on("close", () => resolve());
	});
}

/** Old behaviour: one standalone process, no sharing. Escape hatch. */
async function runLocal(loaded: LoadedConfig, verbose: boolean): Promise<void> {
	const pools = await startPools(loaded.config.pools);
	const server = buildServer(pools, verbose);
	const transport = new StdioServerTransport();
	await server.connect(transport);

	process.on("SIGINT", async () => {
		await Promise.allSettled(pools.map((p) => p.close()));
		process.exit(0);
	});
	process.on("SIGTERM", async () => {
		await Promise.allSettled(pools.map((p) => p.close()));
		process.exit(0);
	});
}

/**
 * Shared daemon. One process holds one upstream per pool, and every agent
 * connection gets its own MCP session over those same upstreams.
 */
async function runDaemon(
	loaded: LoadedConfig,
	verbose: boolean,
	paths: RuntimePaths,
): Promise<void> {
	// listen() and the status file both need the directory to exist.
	mkdirSync(paths.dir, { recursive: true });

	let pools: Awaited<ReturnType<typeof startPools>>;
	try {
		pools = await startPools(loaded.config.pools);
	} catch (err) {
		// Surface the real reason to whichever proxy is waiting on the socket.
		writeStatus(paths, err instanceof Error ? err.message : String(err));
		throw err;
	}

	let open = 0;
	let shuttingDown = false;
	let idleTimer: NodeJS.Timeout | undefined;
	let server: NetServer | undefined;

	async function shutdown(): Promise<void> {
		if (shuttingDown) return;
		shuttingDown = true;
		clearTimeout(idleTimer);
		server?.close();
		await Promise.allSettled(pools.map((p) => p.close()));
		rmSync(paths.socket, { force: true });
		clearStatus(paths);
		process.exit(0);
	}

	server = createServer((socket) => {
		open++;
		clearTimeout(idleTimer);
		socket.on("error", () => socket.destroy());

		const transport = new SocketTransport(socket);
		const session = buildServer(pools, verbose);

		void session.connect(transport).catch((err: unknown) => {
			log({
				level: "error",
				event: "upstream_error",
				pool: "daemon",
				upstream: 0,
				error: err instanceof Error ? err.message : String(err),
			});
		});

		socket.on("close", () => {
			open--;
			if (open > 0 || shuttingDown) return;

			// Last agent left. A short grace period lets a quick restart (for
			// example /mcp reload) reuse live upstreams instead of re-spawning.
			idleTimer = setTimeout(() => void shutdown(), IDLE_GRACE_MS);
		});
	});

	await new Promise<void>((resolve, reject) => {
		if (!server) {
			reject(new Error("daemon server not created"));
			return;
		}
		server.once("error", (err: NodeJS.ErrnoException) => {
			// Another daemon won the race for this socket. The proxy waiting on it
			// will connect to that one, so exit quietly rather than alarming users.
			if (err.code === "EADDRINUSE") {
				process.exit(0);
			}
			reject(err);
		});
		server.listen(paths.socket, () => {
			server?.off("error", reject);
			resolve();
		});
	});
	clearStatus(paths);
	writeStatus(paths, "ready");
	log({ level: "info", event: "upstream_start", pool: "daemon", keyIndex: 0 });

	process.on("SIGTERM", () => void shutdown());
	process.on("SIGINT", () => void shutdown());
}

/**
 * Web server mode. One stateless Streamable HTTP endpoint serves any number of
 * remote MCP clients over the shared pools.
 */
async function runHttp(
	loaded: LoadedConfig,
	verbose: boolean,
	port: number,
	host: string,
): Promise<void> {
	const pools = await startPools(loaded.config.pools);

	const http = createHttpServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		if (req.method === "POST" && url.pathname === "/mcp") {
			// Stateless transports cannot be reused across HTTP requests. Each MCP
			// session shares the pools, but owns its transport for this response.
			const transport = new StreamableHTTPServerTransport({
				sessionIdGenerator: undefined,
				enableJsonResponse: true,
			});
			const session = buildServer(pools, verbose);
			res.once("close", () => {
				void session.close().catch(() => {});
			});
			void (async () => {
				await session.connect(transport);
				await transport.handleRequest(req, res);
			})().catch(async (err: unknown) => {
				log({
					level: "error",
					event: "http_request_error",
					pool: "http",
					upstream: 0,
					error: err instanceof Error ? err.message : String(err),
				});
				if (!res.headersSent) {
					res.writeHead(500, { "content-type": "application/json" });
					res.end(
						JSON.stringify({
							jsonrpc: "2.0",
							error: { code: -32603, message: "MCP request failed" },
							id: null,
						}),
					);
				} else {
					res.destroy();
				}
				await session.close().catch(() => {});
			});
			return;
		}
		if (
			(req.method === "GET" || req.method === "DELETE") &&
			url.pathname === "/mcp"
		) {
			res.writeHead(405, { allow: "POST" });
			res.end();
			return;
		}
		if (req.method === "GET" && url.pathname === "/health") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ status: "ok", tools: pools.length }));
			return;
		}
		res.writeHead(404, { "content-type": "application/json" });
		res.end(
			JSON.stringify({ error: `no route for ${req.method} ${url.pathname}` }),
		);
	});

	await new Promise<void>((resolve) => http.listen(port, host, resolve));
	log({ level: "info", event: "upstream_start", pool: "http", keyIndex: 0 });

	const shutdown = () => {
		http.close();
		void Promise.allSettled(pools.map((p) => p.close())).then(() =>
			process.exit(0),
		);
	};
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
}

async function main(): Promise<void> {
	const options = parseArgs();

	if (options.daemon) {
		if (!options.socket) throw new Error("--daemon requires --socket");
		await runDaemon(
			loadOrExit(options.config),
			options.verbose,
			runtimePathsForSocket(options.socket),
		);
		return;
	}

	const loaded = loadOrExit(options.config);

	if (options.http) {
		await runHttp(loaded, options.verbose, options.port, options.host);
		return;
	}

	if (options.local) {
		await runLocal(loaded, options.verbose);
		return;
	}

	await runProxy(loaded, options.verbose);
}

main().catch((err) => {
	console.error("mcp-pool fatal:", err);
	process.exit(1);
});
