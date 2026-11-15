#!/usr/bin/env node
import { mkdirSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer, type Server as NetServer } from "node:net";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { defineCommand, runCommand } from "citty";
import packageJson from "../package.json" with { type: "json" };
import type { LoadedConfig } from "./config.js";
import { ConfigError, loadConfig } from "./config.js";
import { replyJsonError } from "./http-error.js";
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
import type { Pool } from "./pool.js";
import { buildServer, startPools } from "./server.js";
import { SocketTransport } from "./socket-transport.js";

class UsageError extends Error {}

const USAGE = `mcp-pool — MCP Key Pool Proxy (v${packageJson.version})

Usage: mcp-pool [--config <path>] [--verbose] [--local | --http | --daemon]

Modes (default: shared-daemon proxy over stdio):
  (default)        Connect stdio to the shared daemon for this config (spawns it if needed)
  --local          Standalone single-process server, no sharing
  --http           Streamable HTTP endpoint at http://<host>:<port>/mcp (GET /health)
  --daemon         Internal: run as the shared daemon (requires --socket)

Options:
  --config <path>  Config file (default search: ./mcp-pool.yaml, ./.mcp-pool.yaml, ~/.config/mcp-pool/mcp-pool.yaml)
  --socket <path>  Daemon socket (with --daemon)
  --port <n>       HTTP port (default: 3000, with --http)
  --host <h>       HTTP host (default: 127.0.0.1, with --http)
  --verbose        Per-request trace logs (JSON lines on stderr)
  --help, -h       Show this help
  --version        Print version and exit`;

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = "127.0.0.1";

// citty parses non-strict (unknown flags are ignored), so reject anything
// outside the known flag set to keep the old hand-rolled parser's behavior.
const TAKES_VALUE: Record<string, true> = {
	"--config": true,
	"--socket": true,
	"--port": true,
	"--host": true,
};
const KNOWN_FLAG: Record<string, true> = {
	"--verbose": true,
	"--daemon": true,
	"--local": true,
	"--http": true,
	"--help": true,
	"-h": true,
	"--version": true,
};
function scanRawArgs(rawArgs: string[]): void {
	for (let i = 0; i < rawArgs.length; i++) {
		const arg = rawArgs[i];
		const name = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
		if (TAKES_VALUE[name]) {
			if (!arg.includes("=")) i++;
			continue;
		}
		if (KNOWN_FLAG[arg]) continue;
		throw new UsageError(`unknown argument: ${arg}`);
	}
}

const cli = defineCommand({
	meta: {
		name: "mcp-pool",
		version: packageJson.version,
		description:
			"MCP Key Pool Proxy — pool multiple API keys across upstream MCP servers",
	},
	args: {
		config: {
			type: "string",
			description:
				"Config file (default search: ./mcp-pool.yaml, ./.mcp-pool.yaml, ~/.config/mcp-pool/mcp-pool.yaml)",
		},
		socket: { type: "string", description: "Daemon socket (with --daemon)" },
		port: {
			type: "string",
			description: "HTTP port (with --http)",
			default: String(DEFAULT_PORT),
		},
		host: {
			type: "string",
			description: "HTTP host (with --http)",
			default: DEFAULT_HOST,
		},
		verbose: {
			type: "boolean",
			description: "Per-request trace logs (JSON lines on stderr)",
		},
		daemon: {
			type: "boolean",
			description: "Internal: run as the shared daemon (requires --socket)",
		},
		local: {
			type: "boolean",
			description: "Standalone single-process server, no sharing",
		},
		http: { type: "boolean", description: "Streamable HTTP endpoint" },
		help: { type: "boolean", description: "Show this help", alias: "h" },
		version: { type: "boolean", description: "Print version and exit" },
	},
	async run({ args, rawArgs }) {
		scanRawArgs(rawArgs);
		const port = Number(args.port);
		if (Number.isNaN(port)) throw new UsageError("--port requires a number");

		if (args.help) {
			console.log(USAGE);
			return;
		}

		if (args.version) {
			console.log(packageJson.version);
			return;
		}

		const verbose = args.verbose ?? false;

		if (args.daemon) {
			process.title = "mcp-pool daemon";
			if (!args.socket) throw new UsageError("--daemon requires --socket");
			await runDaemon(
				loadOrExit(args.config),
				verbose,
				runtimePathsForSocket(args.socket),
			);
			return;
		}

		const loaded = loadOrExit(args.config);

		if (args.http) {
			process.title = "mcp-pool http";
			await runHttp(loaded, verbose, port, args.host);
			return;
		}

		if (args.local) {
			process.title = "mcp-pool local";
			await runLocal(loaded, verbose);
			return;
		}

		await runProxy(loaded, verbose);
	},
});

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
		await server.close().catch(() => {});
		await Promise.allSettled(pools.map((p) => p.close()));
		process.exit(0);
	});
	process.on("SIGTERM", async () => {
		await server.close().catch(() => {});
		await Promise.allSettled(pools.map((p) => p.close()));
		process.exit(0);
	});
	process.stdin.on("end", () => {
		void server.close().catch(() => {});
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
			void session.close().catch(() => {});
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
 *
 * Runtime shape: Bun.serve when available (fetch-native SDK transport, no
 * Node<->Web Standard conversion per request), node:http otherwise. The node
 * path stays as the fallback for non-Bun runtimes. Set MCP_POOL_HTTP_NODE=1
 * to force the node:http path for testing.
 */
async function runHttp(
	loaded: LoadedConfig,
	verbose: boolean,
	port: number,
	host: string,
): Promise<void> {
	const pools = await startPools(loaded.config.pools);
	const useBunServer =
		typeof Bun !== "undefined" &&
		typeof Bun.serve === "function" &&
		process.env.MCP_POOL_HTTP_NODE !== "1";
	if (useBunServer) {
		await runBunHttp(pools, verbose, port, host);
	} else {
		await runNodeHttp(pools, verbose, port, host);
	}
}

function listenLog(host: string, port: number): void {
	log({ level: "info", event: "upstream_start", pool: "http", keyIndex: 0 });
	console.error(`mcp-pool http listening on ${host}:${port}`);
}

function closePools(pools: Pool[]): void {
	void Promise.allSettled(pools.map((p) => p.close())).then(() =>
		process.exit(0),
	);
}

/**
 * Fetch-native path: per-request WebStandard transport served by Bun.serve.
 * server.timeout(req, 0) disables Bun's 10s default idle close so slow SSE
 * tool calls are not reset; node:http has no such default.
 */
async function runBunHttp(
	pools: Pool[],
	verbose: boolean,
	port: number,
	host: string,
): Promise<void> {
	const server = Bun.serve({
		port,
		hostname: host,
		fetch: async (req, server) => {
			const url = new URL(req.url);
			if (req.method === "POST" && url.pathname === "/mcp") {
				server.timeout(req, 0);
				const mcp = buildServer(pools, verbose);
				const transport = new WebStandardStreamableHTTPServerTransport({
					sessionIdGenerator: undefined,
				});
				try {
					await mcp.connect(transport);
					const upstreamRes = await transport.handleRequest(req);
					// Buffer the body before closing: close() tears down the
					// transport's SSE streams, so the Response must own its
					// bytes first.
					const body = await upstreamRes.text();
					await mcp.close().catch(() => {});
					return new Response(body, {
						status: upstreamRes.status,
						headers: upstreamRes.headers,
					});
				} catch (err: unknown) {
					return Response.json(
						{
							jsonrpc: "2.0",
							error: { code: -32000, message: String(err) },
							id: null,
						},
						{ status: 500 },
					);
				}
			}
			if (req.method === "GET" && url.pathname === "/health") {
				return Response.json({ status: "ok", tools: pools.length });
			}
			return Response.json(
				{ error: `no route for ${req.method} ${url.pathname}` },
				{ status: 404 },
			);
		},
	});

	listenLog(host, server.port ?? port);
	const shutdown = () => {
		void server.stop();
		closePools(pools);
	};
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
	await new Promise(() => {});
}

/** node:http fallback path: per-request node SDK transport. */
async function runNodeHttp(
	pools: Pool[],
	verbose: boolean,
	port: number,
	host: string,
): Promise<void> {
	const http = createHttpServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		if (req.method === "POST" && url.pathname === "/mcp") {
			const server = buildServer(pools, verbose);
			const transport = new StreamableHTTPServerTransport({
				sessionIdGenerator: undefined,
			});
			void server
				.connect(transport)
				.then(async () => {
					try {
						await transport.handleRequest(req, res);
					} finally {
						await server.close().catch(() => {});
					}
				})
				.catch((err: unknown) => {
					log({
						level: "error",
						event: "upstream_error",
						pool: "http",
						upstream: 0,
						error: err instanceof Error ? err.message : String(err),
					});
					replyJsonError(res, err);
				});
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
	listenLog(host, port);

	const shutdown = () => {
		http.close();
		closePools(pools);
	};
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
}

async function main(): Promise<void> {
	process.title = "mcp-pool";
	try {
		await runCommand(cli, { rawArgs: process.argv.slice(2) });
	} catch (err) {
		if (err instanceof UsageError) {
			console.error(`mcp-pool: error: ${err.message}\n\n${USAGE}`);
			process.exit(2);
		}
		throw err;
	}
}

main().catch((err) => {
	console.error("mcp-pool fatal:", err);
	process.exit(1);
});
