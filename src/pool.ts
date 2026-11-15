import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
	CompleteRequest,
	LoggingLevel,
	Prompt,
	Resource,
	ResourceTemplate,
	ServerCapabilities,
	Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
	PromptListChangedNotificationSchema,
	ResourceListChangedNotificationSchema,
	ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { log } from "./logger.js";
import type { PoolConfig } from "./types.js";

/** Upstream spawn/connect budget; a hung subprocess must not block startup. */
const UPSTREAM_CONNECT_TIMEOUT_MS = 30_000;
/** Per-tick Date.now() cache for cooldown comparisons: one clock sample is
 * shared by every check in the same tick instead of sampling per call. Reset
 * via microtask, so the next tick re-samples. Monotonic enough for cooldown
 * expiry; the warn-path toISOString below still uses a fresh Date. */
let cachedTickNow = 0;
function tickNow(): number {
	if (cachedTickNow === 0) {
		cachedTickNow = Date.now();
		queueMicrotask(() => {
			cachedTickNow = 0;
		});
	}
	return cachedTickNow;
}

type CallResult = {
	content: Array<{ type: "text"; text: string }>;
	isError: boolean;
};

type PromptResult = {
	messages: Array<unknown>;
	description?: string;
};

type ReadResult = {
	contents: Array<unknown>;
};

type RouteError = {
	content: Array<{ type: "text"; text: string }>;
	isError: boolean;
};

type CompleteResult = {
	completion: {
		values: string[];
		total?: number;
		hasMore?: boolean;
	};
};

export type ListChangedKind = "tools" | "prompts" | "resources";

type PreparedCall = { kind: "call"; client: Client; keyIndex: number };
type Prepared = PreparedCall | { kind: "skip" };

// Context7 and ScrapingAnt sometimes return auth/quota failures without MCP's isError flag.
// Match only known error prefixes; ordinary documentation remains untouched.
const UNFLAGGED_ERROR_PREFIX =
	/^(?:Invalid API key\b|Monthly quota reached\b|Rate limited or quota exceeded\b|Rate limit exceeded\b|Spending limit\b|Budget exceeded\b|Credits exhausted\b|Payment required\b|Request failed with status (?:401|402|403|429)\b|SCRAPING FAILED\b)/i;

export class Pool {
	readonly name: string;
	private config: PoolConfig;
	private cursor = 0;
	private client?: Client;
	private cachedTools: Tool[] = [];
	private cachedPrompts: Prompt[] = [];
	private cachedResources: Resource[] = [];
	private cachedTemplates: ResourceTemplate[] = [];
	private upstreamCapabilities?: ServerCapabilities;
	private listChangedListeners = new Set<(kind: ListChangedKind) => void>();
	private started = false;
	private routeLock: Promise<void> = Promise.resolve();
	private cooldowns: number[] = [];
	private rateLimitRes: RegExp[];
	private transientErrorRes: RegExp[] | undefined;
	// Snapshot of process.env at construction; spreading it per spawn re-reads
	// the whole environment object on every upstream start.
	private readonly baseEnv: Record<string, string>;
	// Per-key merged static headers ({...config.headers, ...keyEntry}) for the
	// http/sse transports. Only dynamic per-request headers merge per call.
	private readonly keyHeaders: Record<string, string>[];
	// Catalog hashes cached at first fetch. Failover compares hashes instead
	// of re-serializing every schema; the hash comparison IS the mismatch
	// gate (a detailed diff runs only to build the error message).
	private toolCatalogHash?: string;
	private promptCatalogHash?: string;
	// Compiled uriTemplate matchers, rebuilt with cachedTemplates.
	private templateMatchers: RegExp[] = [];
	// Bumped on every list_changed notification; server.ts memoizes prefixed
	// lists against it.
	private listRevisionValue = 0;
	// Fast-path flag for withSwap: true while no swap section is running or
	// queued. Flipped synchronously, so exactly one contender sees idle.
	private routeLockIdle = true;
	// Queued slow-path waiters. Keeps the flag down across handoffs: while a
	// waiter is queued or running, new callers must queue behind it instead
	// of barging in on the fast path.
	private routeLockWaiters = 0;

	constructor(name: string, config: PoolConfig) {
		this.name = name;
		this.config = config;
		this.cooldowns = config.keys.map(() => 0);
		this.rateLimitRes = config.rateLimitPatterns.map((p) => new RegExp(p));
		this.transientErrorRes = config.transientRetry?.errorPatterns.map(
			(p) => new RegExp(p),
		);
		this.baseEnv = { ...process.env } as Record<string, string>;
		this.keyHeaders = config.keys.map((keyEntry) => ({
			...config.headers,
			...keyEntry,
		}));
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

				const errorText = stringifyContent(result.content);
				if (result.isError || UNFLAGGED_ERROR_PREFIX.test(errorText)) {
					if (this.matchesRateLimit(errorText)) {
						await this.withSwap(() =>
							this.markRateLimited(cooldownSec, prepared),
						);
						continue;
					}

					return result;
				}

				return result;
			} catch (err) {
				const errText = err instanceof Error ? err.message : String(err);
				if (this.matchesRateLimit(errText)) {
					await this.withSwap(() =>
						this.markRateLimited(cooldownSec, prepared),
					);
				} else {
					await this.withSwap(() => this.markFailed(err, prepared));
				}
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
				this.rateLimitRes.some((re) => re.test(errorText)) ||
				!this.transientErrorRes?.some((re) => re.test(errorText))
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

	async routePrompt(
		promptName: string,
		args?: Record<string, string>,
	): Promise<PromptResult | RouteError> {
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
				await this.withSwap(() => this.markFailed(err, prepared));
			}
		}

		return unavailableError(this.name, maxKeys);
	}

	async routeRead(uri: string): Promise<ReadResult | RouteError> {
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
				const result = await prepared.client.readResource({ uri });
				return result as ReadResult;
			} catch (err) {
				// Reads are not rate-limited: fail over once, then error.
				await this.withSwap(() => this.markFailed(err, prepared));
			}
		}

		return unavailableError(this.name, maxKeys);
	}

	async routeSubscribe(uri: string): Promise<RouteError | null> {
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
				await prepared.client.subscribeResource({ uri });
				return null;
			} catch (err) {
				await this.withSwap(() => this.markFailed(err, prepared));
			}
		}

		return unavailableError(this.name, maxKeys);
	}

	async routeUnsubscribe(uri: string): Promise<RouteError | null> {
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
				await prepared.client.unsubscribeResource({ uri });
				return null;
			} catch (err) {
				await this.withSwap(() => this.markFailed(err, prepared));
			}
		}

		return unavailableError(this.name, maxKeys);
	}

	/**
	 * Serializes only the section that mutates cursor/cooldowns/client. The
	 * in-flight callTool runs outside it.
	 */
	private async withSwap<T>(fn: () => T | Promise<T>): Promise<T> {
		// Waiters guard the handoff: a releaser that wakes a queued caller
		// must leave the flag down, otherwise an already-queued continuation
		// positioned behind the releaser but ahead of the waiter would see
		// idle and barge in on the fast path while the waiter also proceeds.
		if (this.routeLockIdle && this.routeLockWaiters === 0) {
			// Fast path: the lock is uncontended, so run inline without extra
			// promise allocations or microtask hops. The flag flip is
			// synchronous, so a concurrent caller can only take the queued
			// path below; FIFO ordering is preserved through routeLock.
			this.routeLockIdle = false;
			const next = Promise.withResolvers<void>();
			this.routeLock = next.promise;
			try {
				return await fn();
			} finally {
				if (this.routeLockWaiters === 0) this.routeLockIdle = true;
				next.resolve();
			}
		}
		this.routeLockWaiters++;
		const prev = this.routeLock;
		const next = Promise.withResolvers<void>();
		this.routeLock = next.promise;
		try {
			await prev;
			this.routeLockIdle = false;
			return await fn();
		} finally {
			this.routeLockWaiters--;
			if (this.routeLockWaiters === 0) this.routeLockIdle = true;
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

		if (this.cooldowns[this.cursor] > tickNow()) {
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
		this.cooldowns[keyIndex] = tickNow() + cooldownSec * 1000;
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

	async routeComplete(
		params: CompleteRequest["params"],
	): Promise<CompleteResult | RouteError> {
		if (!this.started) {
			return unavailableError(this.name, this.config.keys.length);
		}
		const maxKeys = this.config.keys.length;
		let lastError: string | null = null;
		for (let attempt = 0; attempt < maxKeys; attempt++) {
			const prepared = await this.withSwap(() => this.prepareNext());
			if (prepared.kind === "skip") continue;
			try {
				const result = await prepared.client.complete(params);
				return result as CompleteResult;
			} catch (err) {
				lastError = err instanceof Error ? err.message : String(err);
				await this.withSwap(() => this.markFailed(err, prepared));
			}
		}
		if (lastError) {
			return {
				content: [
					{
						type: "text" as const,
						text: `All ${maxKeys} keys for '${this.name}' failed: ${lastError}`,
					},
				],
				isError: true,
			};
		}
		return unavailableError(this.name, this.config.keys.length);
	}

	async routeSetLevel(level: LoggingLevel): Promise<RouteError | null> {
		if (!this.started) {
			return unavailableError(this.name, this.config.keys.length);
		}
		const maxKeys = this.config.keys.length;
		for (let attempt = 0; attempt < maxKeys; attempt++) {
			const prepared = await this.withSwap(() => this.prepareNext());
			if (prepared.kind === "skip") continue;
			try {
				await prepared.client.setLoggingLevel(level);
				return null;
			} catch (err) {
				await this.withSwap(() => this.markFailed(err, prepared));
			}
		}
		return unavailableError(this.name, this.config.keys.length);
	}

	/** Subscribe to upstream list_changed notifications for this pool. */
	onListChanged(listener: (kind: ListChangedKind) => void): () => void {
		this.listChangedListeners.add(listener);
		return () => {
			this.listChangedListeners.delete(listener);
		};
	}

	/** Count of active list_changed subscriptions (teardown invariant). */
	listChangedListenerCount(): number {
		return this.listChangedListeners.size;
	}

	/** Test seam: simulate an upstream list_changed notification. */
	debugFireListChanged(kind: ListChangedKind): void {
		this.fireListChanged(kind);
	}

	private fireListChanged(kind: ListChangedKind): void {
		this.listRevisionValue++;
		for (const listener of this.listChangedListeners) {
			listener(kind);
		}
	}

	private exhaustedError(): CallResult {
		const maxKeys = this.config.keys.length;
		const now = tickNow();
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

	getPrompts(): Prompt[] {
		return this.cachedPrompts;
	}

	getResources(): Resource[] {
		return this.cachedResources;
	}

	getResourceTemplates(): ResourceTemplate[] {
		return this.cachedTemplates;
	}

	getUpstreamCapabilities(): ServerCapabilities | undefined {
		return this.upstreamCapabilities;
	}

	/** Monotonic list_changed revision for memoized prefixed-list caches. */
	listChangedRevision(): number {
		return this.listRevisionValue;
	}

	/**
	 * Template fallback: concrete URI matching a cached `uriTemplate` with
	 * `{param}` placeholders. Exact URIs are served by the server-side
	 * uriToPool map; this scan runs only for URIs the map misses.
	 */
	resolveTemplateForUri(uri: string): Pool | undefined {
		if (this.templateMatchers.length === 0) return undefined;
		return this.templateMatchers.some((re) => re.test(uri)) ? this : undefined;
	}

	async close(): Promise<void> {
		await this.closeCurrent();
	}

	private matchesRateLimit(text: string): boolean {
		return this.rateLimitRes.some((re) => re.test(text));
	}

	private createTransport(keyIndex: number): Transport {
		const mode = this.config.transport ?? "stdio";
		// Static headers merged once per Pool in the constructor; only the
		// dynamic per-request EventSource headers merge per call below.
		const headers = this.keyHeaders[keyIndex];
		if (mode === "http") {
			if (!this.config.url) {
				throw new Error(
					`Pool "${this.name}": url is required for http transport`,
				);
			}
			return new StreamableHTTPClientTransport(new URL(this.config.url), {
				requestInit: { headers },
			});
		}
		if (mode === "sse") {
			if (!this.config.url) {
				throw new Error(
					`Pool "${this.name}": url is required for sse transport`,
				);
			}
			return new SSEClientTransport(new URL(this.config.url), {
				requestInit: { headers },
				eventSourceInit: {
					fetch: (input, init) =>
						fetch(input, {
							...init,
							headers: {
								...Object.fromEntries(new Headers(init?.headers).entries()),
								...headers,
							},
						}),
				},
			});
		}
		if (!this.config.command) {
			throw new Error(
				`Pool "${this.name}": command is required for stdio transport`,
			);
		}
		return new StdioClientTransport({
			command: this.config.command,
			args: this.config.args ?? [],
			env: {
				...this.baseEnv,
				...this.config.env,
				...this.config.keys[keyIndex],
			} as Record<string, string>,
			cwd: this.config.cwd,
		});
	}

	private async spawnUpstream(keyIndex: number): Promise<void> {
		const transport = this.createTransport(keyIndex);

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
		let resources: Resource[] = [];
		let templates: ResourceTemplate[] = [];
		try {
			const handshake = await Promise.race([
				client.connect(transport).then(async () => {
					const caps = client.getServerCapabilities();
					const [toolRes, promptRes, resRes, tmplRes] = await Promise.all([
						client.listTools(),
						caps?.prompts ? client.listPrompts().catch(() => null) : null,
						caps?.resources ? client.listResources().catch(() => null) : null,
						caps?.resources
							? client.listResourceTemplates().catch(() => null)
							: null,
					]);
					return {
						tools: toolRes,
						prompts: promptRes,
						resources: resRes,
						templates: tmplRes,
						caps,
					};
				}),
				timeout,
			]);
			tools = (handshake.tools?.tools ?? []) as Tool[];
			prompts = (handshake.prompts?.prompts ?? []) as Prompt[];
			resources = (handshake.resources?.resources ?? []) as Resource[];
			templates = (handshake.templates?.resourceTemplates ??
				[]) as ResourceTemplate[];
			this.upstreamCapabilities = handshake.caps;
			client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
				this.fireListChanged("tools");
			});
			client.setNotificationHandler(PromptListChangedNotificationSchema, () => {
				this.fireListChanged("prompts");
			});
			client.setNotificationHandler(
				ResourceListChangedNotificationSchema,
				() => {
					this.fireListChanged("resources");
				},
			);
		} catch (err) {
			await client.close().catch(() => {});
			throw err;
		} finally {
			onTimeout?.();
		}

		// Hash-gated mismatch checks: the first fetch stores one canonical
		// hash per catalog; failover serializes only the new catalog and
		// compares. The comparison IS the gate — nothing is skipped. The
		// per-item diff runs only to build the error message on mismatch.
		const toolHash = hashToolCatalog(tools);
		if (this.cachedTools.length > 0) {
			if (toolHash !== this.toolCatalogHash) {
				const mismatch = findToolMismatch(this.cachedTools, tools);
				await client.close();
				throw new Error(
					`Pool "${this.name}" key ${keyIndex} tools mismatch: ${mismatch ?? "catalog changed"}`,
				);
			}
		} else {
			this.cachedTools = tools;
			this.toolCatalogHash = toolHash;
		}

		const promptHash = hashPromptCatalog(prompts);
		if (this.cachedPrompts.length > 0) {
			if (promptHash !== this.promptCatalogHash) {
				const mismatch = findPromptMismatch(this.cachedPrompts, prompts);
				await client.close();
				throw new Error(
					`Pool "${this.name}" key ${keyIndex} prompts mismatch: ${mismatch ?? "catalog changed"}`,
				);
			}
		} else {
			this.cachedPrompts = prompts;
			this.promptCatalogHash = promptHash;
		}

		if (this.cachedResources.length > 0) {
			const mismatch = findResourceMismatch(this.cachedResources, resources);
			if (mismatch) {
				await client.close();
				throw new Error(
					`Pool "${this.name}" key ${keyIndex} resources mismatch: ${mismatch}`,
				);
			}
		} else {
			this.cachedResources = resources;
		}

		if (this.cachedTemplates.length > 0) {
			const mismatch = findTemplateMismatch(this.cachedTemplates, templates);
			if (mismatch) {
				await client.close();
				throw new Error(
					`Pool "${this.name}" key ${keyIndex} resource templates mismatch: ${mismatch}`,
				);
			}
		} else {
			this.cachedTemplates = templates;
			this.templateMatchers = templates.map((t) =>
				templateToRegExp(t.uriTemplate),
			);
		}

		// Catalogs populate on first fetch and never change after (failover
		// re-verifies them), so bump the revision on every successful spawn:
		// memoized list caches observe availability this way, and a failover
		// spawn costs at most one cheap rebuild.
		this.listRevisionValue++;
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

function unavailableError(poolName: string, maxKeys: number): RouteError {
	return {
		content: [
			{
				type: "text" as const,
				text: `All ${maxKeys} keys for '${poolName}' failed to connect or are unavailable.`,
			},
		],
		isError: true,
	};
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

function findResourceMismatch(a: Resource[], b: Resource[]): string | null {
	const mapA = new Map(a.map((r) => [r.uri, r]));
	const mapB = new Map(b.map((r) => [r.uri, r]));

	if (mapA.size !== mapB.size) {
		return `resource count mismatch: ${mapA.size} vs ${mapB.size}`;
	}

	for (const [uri, resA] of mapA) {
		const resB = mapB.get(uri);
		if (!resB) {
			return `resource "${uri}" missing from upstream`;
		}
		if (resA.name !== resB.name || resA.mimeType !== resB.mimeType) {
			return `resource "${uri}" metadata mismatch`;
		}
	}

	return null;
}

function findTemplateMismatch(
	a: ResourceTemplate[],
	b: ResourceTemplate[],
): string | null {
	const mapA = new Map(a.map((t) => [t.uriTemplate, t]));
	const mapB = new Map(b.map((t) => [t.uriTemplate, t]));

	if (mapA.size !== mapB.size) {
		return `resource template count mismatch: ${mapA.size} vs ${mapB.size}`;
	}

	for (const [uriTemplate, tmplA] of mapA) {
		const tmplB = mapB.get(uriTemplate);
		if (!tmplB) {
			return `resource template "${uriTemplate}" missing from upstream`;
		}
		if (tmplA.name !== tmplB.name || tmplA.mimeType !== tmplB.mimeType) {
			return `resource template "${uriTemplate}" metadata mismatch`;
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

/**
 * Canonical catalog hash: sorted (name, schema) pairs in one JSON string.
 * Equivalent to the findToolMismatch gate (same names, same schemas), but
 * computed once per catalog instead of per-tool stringify on both sides.
 */
function hashToolCatalog(tools: Tool[]): string {
	return JSON.stringify(
		tools
			.map((t) => [t.name, t.inputSchema] as [string, Tool["inputSchema"]])
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
	);
}

/** Canonical catalog hash for prompts; equivalent to findPromptMismatch. */
function hashPromptCatalog(prompts: Prompt[]): string {
	return JSON.stringify(
		prompts
			.map((p) => [p.name, p.arguments ?? []] as [string, unknown])
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
	);
}

/**
 * Compile a `uriTemplate` with `{param}` placeholders into a matcher for
 * concrete URIs. Placeholders match one non-empty path segment-ish run;
 * literal parts match exactly.
 */
function templateToRegExp(template: string): RegExp {
	const src = template
		.split(/(\{[^}]*\})/g)
		.map((part) =>
			part.startsWith("{")
				? "[^/?#]+"
				: part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
		)
		.join("");
	return new RegExp(`^${src}$`);
}
