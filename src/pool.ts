import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type {
	Prompt,
	ServerCapabilities,
	Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { log } from "./logger.js";
import type { PoolConfig } from "./types.js";

/** Upstream spawn/connect budget; a hung subprocess must not block startup. */
const UPSTREAM_CONNECT_TIMEOUT_MS = 30_000;

type CallResult = {
	content: Array<{ type: "text"; text: string }>;
	isError: boolean;
};

type PromptResult = {
	messages: Array<unknown>;
	description?: string;
};

type PromptError = {
	content: Array<{ type: "text"; text: string }>;
	isError: boolean;
};

type Prepared = { kind: "call"; client: Client } | { kind: "skip" };

export class Pool {
	readonly name: string;
	private config: PoolConfig;
	private cursor = 0;
	private client?: Client;
	private cachedTools: Tool[] = [];
	private cachedPrompts: Prompt[] = [];
	private upstreamCapabilities?: ServerCapabilities;
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
					upstream: this.cursor,
				});
			}

			try {
				const result = await prepared.client.callTool({
					name: toolName,
					arguments: args,
				});

				if (result.isError) {
					const errorText = stringifyContent(result.content);
					const isRateLimited = this.config.rateLimitPatterns.some((pat) =>
						new RegExp(pat).test(errorText),
					);

					if (isRateLimited) {
						await this.withSwap(() => this.markRateLimited(cooldownSec));
						continue;
					}

					return result;
				}

				return result;
			} catch (err) {
				await this.withSwap(() => this.markFailed(err));
			}
		}

		return this.exhaustedError();
	}

	async routePrompt(
		promptName: string,
		args?: Record<string, string>,
	): Promise<PromptResult | PromptError> {
		if (!this.started) {
			return {
				content: [
					{
						type: "text" as const,
						text: `Pool "${this.name}" not started`,
					},
				],
				isError: true,
			};
		}

		const maxKeys = this.config.keys.length;
		for (let attempt = 0; attempt < maxKeys; attempt++) {
			const prepared = await this.withSwap(() => this.prepareNext());
			if (prepared.kind === "skip") continue;

			try {
				const result = await prepared.client.getPrompt({
					name: promptName,
					arguments: args,
				});
				return result as PromptResult;
			} catch (err) {
				// Prompts are not rate-limited reads: fail over once, then error.
				await this.withSwap(() => this.markFailed(err));
			}
		}

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
		return { kind: "call", client };
	}

	private async markRateLimited(cooldownSec: number): Promise<void> {
		this.cooldowns[this.cursor] = Date.now() + cooldownSec * 1000;
		log({
			level: "warn",
			event: "rate_limited",
			pool: this.name,
			upstream: this.cursor,
			cooldownUntil: new Date(this.cooldowns[this.cursor]).toISOString(),
		});
		await this.closeCurrent();
		this.cursor = (this.cursor + 1) % this.config.keys.length;
	}

	private async markFailed(err: unknown): Promise<void> {
		log({
			level: "error",
			event: "upstream_error",
			pool: this.name,
			upstream: this.cursor,
			error: err instanceof Error ? err.message : String(err),
		});
		await this.closeCurrent();
		this.cursor = (this.cursor + 1) % this.config.keys.length;
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
					text: `All ${maxKeys} keys for '${this.name}' are rate-limited. Retry after ${retryAfter}s.`,
				},
			],
			isError: true,
		};
	}

	getTools(): Tool[] {
		return this.cachedTools;
	}

	getPrompts(): Prompt[] {
		return this.cachedPrompts;
	}

	getUpstreamCapabilities(): ServerCapabilities | undefined {
		return this.upstreamCapabilities;
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
		let prompts: Prompt[] = [];
		try {
			const handshake = await Promise.race([
				client.connect(transport).then(async () => {
					const caps = client.getServerCapabilities();
					const [toolRes, promptRes] = await Promise.all([
						client.listTools(),
						caps?.prompts ? client.listPrompts().catch(() => null) : null,
					]);
					return { tools: toolRes, prompts: promptRes, caps };
				}),
				timeout,
			]);
			tools = (handshake.tools?.tools ?? []) as Tool[];
			prompts = (handshake.prompts?.prompts ?? []) as Prompt[];
			this.upstreamCapabilities = handshake.caps;
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

		if (this.cachedPrompts.length > 0) {
			const mismatch = findPromptMismatch(this.cachedPrompts, prompts);
			if (mismatch) {
				await client.close();
				throw new Error(
					`Pool "${this.name}" key ${keyIndex} prompts mismatch: ${mismatch}`,
				);
			}
		} else {
			this.cachedPrompts = prompts;
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

function findPromptMismatch(a: Prompt[], b: Prompt[]): string | null {
	const mapA = new Map(a.map((p) => [p.name, p]));
	const mapB = new Map(b.map((p) => [p.name, p]));

	if (mapA.size !== mapB.size) {
		return `prompt count mismatch: ${mapA.size} vs ${mapB.size}`;
	}

	for (const [name, promptA] of mapA) {
		const promptB = mapB.get(name);
		if (!promptB) {
			return `prompt "${name}" missing from upstream`;
		}
		const argsA = JSON.stringify(promptA.arguments ?? []);
		const argsB = JSON.stringify(promptB.arguments ?? []);
		if (argsA !== argsB) {
			return `prompt "${name}" arguments mismatch`;
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
