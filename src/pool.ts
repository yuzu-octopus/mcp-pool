import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { log } from "./logger.js";
import type { PoolConfig } from "./types.js";

/** Upstream spawn/connect budget; a hung subprocess must not block startup. */
const UPSTREAM_CONNECT_TIMEOUT_MS = 30_000;

type CallResult = {
	content: Array<{ type: "text"; text: string }>;
	isError: boolean;
};

type PreparedCall = { kind: "call"; client: Client; keyIndex: number };
type Prepared = PreparedCall | { kind: "skip" };

// Context7 sometimes returns auth/quota failures without MCP's isError flag.
// Match only known error prefixes; ordinary documentation remains untouched.
const UNFLAGGED_ERROR_PREFIX =
	/^(?:Invalid API key\b|Monthly quota reached\b|Rate limited or quota exceeded\b|Rate limit exceeded\b|Spending limit\b|Budget exceeded\b|Credits exhausted\b|Payment required\b|Request failed with status (?:401|402|403|429)\b)/i;

export class Pool {
	readonly name: string;
	private config: PoolConfig;
	private cursor = 0;
	private client?: Client;
	private cachedTools: Tool[] = [];
	private started = false;
	private routeLock: Promise<void> = Promise.resolve();
	private cooldowns: number[] = [];

	constructor(name: string, config: PoolConfig) {
		this.name = name;
		this.config = config;
		this.cooldowns = config.keys.map(() => 0);
	}

	async start(): Promise<void> {
		const maxKeys = this.config.keys.length;
		for (let attempt = 0; attempt < maxKeys; attempt++) {
			try {
				await this.spawnUpstream(this.cursor);
				break;
			} catch (err) {
				log({
					level: "error",
					event: "upstream_error",
					pool: this.name,
					upstream: this.cursor,
					error: err instanceof Error ? err.message : String(err),
				});
				this.cursor = (this.cursor + 1) % maxKeys;
				if (attempt === maxKeys - 1) {
					throw new Error(
						`Pool "${this.name}": all ${maxKeys} key(s) failed to connect`,
					);
				}
			}
		}
		this.started = true;
	}

	async routeCall(
		toolName: string,
		args: Record<string, unknown>,
		verbose?: boolean,
	): Promise<unknown> {
		if (!this.started) {
			return {
				content: [
					{ type: "text" as const, text: `Pool "${this.name}" not started` },
				],
				isError: true,
			};
		}

		const maxKeys = this.config.keys.length;
		const cooldownSec = this.config.cooldownSeconds ?? 300;

		for (let attempt = 0; attempt < maxKeys; attempt++) {
			// Only the swap window is serialized; the call itself runs unlocked, so
			// a slow web fetch no longer queues every other caller behind it.
			const prepared = await this.withSwap(() => this.prepareNext());
			if (prepared.kind === "skip") continue;

			if (verbose) {
				log({
					level: "trace",
					event: "call_tool",
					pool: this.name,
					tool: toolName,
					upstream: prepared.keyIndex,
				});
			}

			try {
				const result = await this.callWithTransientRetry(
					prepared,
					toolName,
					args,
				);

				if (
					result.isError ||
					UNFLAGGED_ERROR_PREFIX.test(stringifyContent(result.content))
				) {
					const errorText = stringifyContent(result.content);
					const isRateLimited = this.config.rateLimitPatterns.some((pat) =>
						new RegExp(pat).test(errorText),
					);

					if (isRateLimited) {
						await this.withSwap(() =>
							this.markRateLimited(cooldownSec, prepared),
						);
						continue;
					}

					return result;
				}

				return result;
			} catch (err) {
				await this.withSwap(() => this.markFailed(err, prepared));
			}
		}

		return this.exhaustedError();
	}

	/** Replay only explicitly opted-in tools; quota failures keep normal failover. */
	private async callWithTransientRetry(
		prepared: PreparedCall,
		toolName: string,
		args: Record<string, unknown>,
	) {
		const policy = this.config.transientRetry;
		for (let attempt = 0; ; attempt++) {
			const result = await prepared.client.callTool({
				name: toolName,
				arguments: args,
			});
			const errorText = stringifyContent(result.content);
			if (
				!result.isError ||
				!policy?.tools.includes(toolName) ||
				attempt >= policy.delaysMs.length ||
				this.config.rateLimitPatterns.some((pattern) =>
					new RegExp(pattern).test(errorText),
				) ||
				!policy.errorPatterns.some((pattern) =>
					new RegExp(pattern).test(errorText),
				)
			)
				return result;

			const delayMs = policy.delaysMs[attempt];
			log({
				level: "warn",
				event: "transient_retry",
				pool: this.name,
				tool: toolName,
				upstream: prepared.keyIndex,
				attempt: attempt + 1,
				delayMs,
			});
			// Never hold the swap mutex during backoff or retry a client replaced
			// by another caller's quota/transport failure.
			await sleep(delayMs);
			if (this.client !== prepared.client) {
				throw new Error("Upstream replaced during transient retry");
			}
		}
	}

	/**
	 * Serializes only the section that mutates cursor/cooldowns/client. The
	 * in-flight callTool runs outside it.
	 */
	private async withSwap<T>(fn: () => T | Promise<T>): Promise<T> {
		const prev = this.routeLock;
		const next = Promise.withResolvers<void>();
		this.routeLock = next.promise;
		await prev;

		try {
			return await fn();
		} finally {
			next.resolve();
		}
	}

	/**
	 * Picks the next usable upstream, spawning one when the pool is idle. Must
	 * run inside withSwap because it mutates shared swap state. "skip" tells the
	 * retry loop to advance to the next key.
	 */
	private async prepareNext(): Promise<Prepared> {
		const maxKeys = this.config.keys.length;

		if (this.cooldowns[this.cursor] > Date.now()) {
			this.cursor = (this.cursor + 1) % maxKeys;
			return { kind: "skip" };
		}

		if (!this.client) {
			try {
				await this.spawnUpstream(this.cursor);
			} catch (err) {
				log({
					level: "error",
					event: "upstream_error",
					pool: this.name,
					upstream: this.cursor,
					error: err instanceof Error ? err.message : String(err),
				});
				this.cursor = (this.cursor + 1) % maxKeys;
				return { kind: "skip" };
			}
		}

		// Capture locally: spawnUpstream may have replaced this.client, and the
		// lock deliberately does not cover the call itself.
		const client = this.client;
		if (!client) {
			this.cursor = (this.cursor + 1) % maxKeys;
			return { kind: "skip" };
		}
		return { kind: "call", client, keyIndex: this.cursor };
	}

	private async markRateLimited(
		cooldownSec: number,
		prepared: PreparedCall,
	): Promise<void> {
		const { keyIndex } = prepared;
		this.cooldowns[keyIndex] = Date.now() + cooldownSec * 1000;
		log({
			level: "warn",
			event: "rate_limited",
			pool: this.name,
			upstream: keyIndex,
			cooldownUntil: new Date(this.cooldowns[keyIndex]).toISOString(),
		});
		// Another request may already have replaced the failing upstream.
		if (this.client === prepared.client) {
			await this.closeCurrent();
			this.cursor = (keyIndex + 1) % this.config.keys.length;
		}
	}

	private async markFailed(
		err: unknown,
		prepared: PreparedCall,
	): Promise<void> {
		log({
			level: "error",
			event: "upstream_error",
			pool: this.name,
			upstream: prepared.keyIndex,
			error: err instanceof Error ? err.message : String(err),
		});
		if (this.client === prepared.client) {
			await this.closeCurrent();
			this.cursor = (prepared.keyIndex + 1) % this.config.keys.length;
		}
	}

	private exhaustedError(): CallResult {
		const maxKeys = this.config.keys.length;
		const now = Date.now();
		const active = this.cooldowns.filter((c) => c > now);

		log({
			level: "error",
			event: "all_exhausted",
			pool: this.name,
			available: 0,
			total: maxKeys,
		});

		if (active.length === 0) {
			return {
				content: [
					{
						type: "text" as const,
						text: `All ${maxKeys} keys for '${this.name}' failed to connect or are unavailable.`,
					},
				],
				isError: true,
			};
		}

		const retryAfter = Math.ceil((Math.min(...active) - now) / 1000);
		return {
			content: [
				{
					type: "text" as const,
					text: `All ${maxKeys} keys for '${this.name}' are cooling down after upstream errors (rate limit, quota, or authentication). Retry after ${retryAfter}s.`,
				},
			],
			isError: true,
		};
	}

	getTools(): Tool[] {
		return this.cachedTools;
	}

	async close(): Promise<void> {
		await this.closeCurrent();
	}

	private async spawnUpstream(keyIndex: number): Promise<void> {
		const envVars = this.config.keys[keyIndex];
		const transport = new StdioClientTransport({
			command: this.config.command,
			args: this.config.args,
			env: { ...process.env, ...envVars } as Record<string, string>,
			cwd: this.config.cwd,
		});

		const client = new Client(
			{ name: "mcp-pool", version: "0.1.0" },
			{ capabilities: {} },
		);

		let onTimeout: (() => void) | undefined;
		const timeout = new Promise<never>((_resolve, reject) => {
			const timer = setTimeout(
				() =>
					reject(
						new Error(
							`upstream did not connect within ${UPSTREAM_CONNECT_TIMEOUT_MS}ms`,
						),
					),
				UPSTREAM_CONNECT_TIMEOUT_MS,
			);
			// Do not let a hung handshake keep the event loop alive.
			timer.unref?.();
			onTimeout = () => clearTimeout(timer);
		});

		let tools: Tool[];
		try {
			const handshake = await Promise.race([
				client.connect(transport).then(() => client.listTools()),
				timeout,
			]);
			tools = handshake.tools as Tool[];
		} catch (err) {
			await client.close().catch(() => {});
			throw err;
		} finally {
			onTimeout?.();
		}

		if (this.cachedTools.length > 0) {
			const mismatch = findToolMismatch(this.cachedTools, tools);
			if (mismatch) {
				await client.close();
				throw new Error(
					`Pool "${this.name}" key ${keyIndex} tools mismatch: ${mismatch}`,
				);
			}
		} else {
			this.cachedTools = tools;
		}

		this.client = client;
		this.cursor = keyIndex;

		log({
			level: "info",
			event: "upstream_start",
			pool: this.name,
			keyIndex,
		});
	}

	private async closeCurrent(): Promise<void> {
		if (this.client) {
			await this.client.close();
			this.client = undefined;
		}
	}
}

function findToolMismatch(a: Tool[], b: Tool[]): string | null {
	const mapA = new Map(a.map((t) => [t.name, t]));
	const mapB = new Map(b.map((t) => [t.name, t]));

	if (mapA.size !== mapB.size) {
		return `tool count mismatch: ${mapA.size} vs ${mapB.size}`;
	}

	for (const [name, toolA] of mapA) {
		const toolB = mapB.get(name);
		if (!toolB) {
			return `tool "${name}" missing from upstream`;
		}
		const schemaA = JSON.stringify(toolA.inputSchema);
		const schemaB = JSON.stringify(toolB.inputSchema);
		if (schemaA !== schemaB) {
			return `tool "${name}" inputSchema mismatch`;
		}
	}

	return null;
}

function stringifyContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((c: Record<string, unknown>) => String(c.text ?? ""))
			.join("\n");
	}
	return JSON.stringify(content);
}
