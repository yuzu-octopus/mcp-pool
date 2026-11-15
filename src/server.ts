import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type {
	CallToolRequest,
	CompleteRequest,
	GetPromptRequest,
	ReadResourceRequest,
	SetLevelRequest,
	SubscribeRequest,
	UnsubscribeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import {
	CallToolRequestSchema,
	CompleteRequestSchema,
	GetPromptRequestSchema,
	ListPromptsRequestSchema,
	ListResourcesRequestSchema,
	ListResourceTemplatesRequestSchema,
	ListToolsRequestSchema,
	ReadResourceRequestSchema,
	SetLevelRequestSchema,
	SubscribeRequestSchema,
	UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import packageJson from "../package.json" with { type: "json" };
import { log } from "./logger.js";
import { Pool } from "./pool.js";
import type { PoolConfig } from "./types.js";

/**
 * Starts every pool concurrently and fails as a group when any fails, closing
 * the ones that did start. Parallel start removes the head-of-line stall where a
 * single hanging upstream delayed every pool behind it.
 */
export async function startPools(
	config: Record<string, PoolConfig>,
): Promise<Pool[]> {
	const pools = Object.entries(config).map(
		([name, poolConfig]) => new Pool(name, poolConfig),
	);
	const settled = await Promise.allSettled(pools.map((pool) => pool.start()));

	const failure = settled.find(
		(result): result is PromiseRejectedResult => result.status === "rejected",
	);
	if (failure) {
		await Promise.allSettled(pools.map((pool) => pool.close()));
		throw failure.reason;
	}

	return pools;
}

function splitPrefix(
	fullName: string,
	kind: "tool" | "prompt",
): { poolName: string; short: string } | { error: string } {
	const separatorIndex = fullName.indexOf("__");
	if (separatorIndex === -1) {
		return {
			error: `Invalid ${kind} name: "${fullName}". Expected format: {poolName}__{${kind}Name}`,
		};
	}
	return {
		poolName: fullName.slice(0, separatorIndex),
		short: fullName.slice(separatorIndex + 2),
	};
}

/** Seed the URI→pool map from each pool's cached lists (post-start). */
function seedUriMap(uriToPool: Map<string, Pool>, pools: Pool[]): void {
	for (const pool of pools) {
		for (const resource of pool.getResources()) {
			if (!uriToPool.has(resource.uri)) {
				uriToPool.set(resource.uri, pool);
			} else {
				log({
					level: "warn",
					event: "resource_uri_collision",
					pool: pool.name,
					uri: resource.uri,
				});
			}
		}
		for (const template of pool.getResourceTemplates()) {
			if (!uriToPool.has(template.uriTemplate)) {
				uriToPool.set(template.uriTemplate, pool);
			} else {
				log({
					level: "warn",
					event: "resource_uri_collision",
					pool: pool.name,
					uri: template.uriTemplate,
				});
			}
		}
	}
}

/**
 * F9: per-pool-set shared request handling.
 *
 * Verified against the SDK before sharing anything: `Protocol.connect`
 * throws when already connected ("use a separate Protocol instance per
 * connection") and one Server holds a single `_transport`, so a single
 * Server instance can NOT serve concurrent HTTP requests — per-request
 * Servers stay. SKIPPED: sharing one Server across requests (unsafe).
 * What IS shared per pool-set (keyed by the pools array identity, which
 * index.ts passes unchanged per request):
 * - the handler function set (registered by reference on each new Server),
 * - the prefixed list payloads + uriToPool map, memoized and invalidated by
 *   per-pool list_changed revisions (Pool.listChangedRevision, bumped on
 *   every notification and every successful upstream spawn).
 */
type PrefixedTool = {
	name: string;
	description?: string;
	inputSchema: {
		type: "object";
		properties?: Record<string, unknown>;
		required?: string[];
	};
};

type PrefixedPrompt = {
	name: string;
	description?: string;
	arguments?: Array<{
		name: string;
		description?: string;
		required?: boolean;
	}>;
};

type PrefixedResource = {
	name: string;
	uri: string;
	description?: string;
	mimeType?: string;
};

type PrefixedResourceTemplate = {
	name: string;
	uriTemplate: string;
	description?: string;
	mimeType?: string;
};

type FreshLists = {
	tools: PrefixedTool[];
	prompts: PrefixedPrompt[];
	resources: PrefixedResource[];
	templates: PrefixedResourceTemplate[];
	uriToPool: Map<string, Pool>;
};

type CachedLists = FreshLists & { revs: number[] };

type PoolSetState = {
	pools: Pool[];
	verbose: boolean;
	poolByName: Map<string, Pool>;
	lists: CachedLists | undefined;
};

const poolSetShared = new WeakMap<
	Pool[],
	{ state: PoolSetState; handlers: PoolSetHandlers }
>();

function getShared(
	pools: Pool[],
	verbose: boolean,
): { state: PoolSetState; handlers: PoolSetHandlers } {
	let shared = poolSetShared.get(pools);
	if (!shared || shared.state.pools.length !== pools.length) {
		const poolByName = new Map<string, Pool>();
		for (const pool of pools) {
			if (!poolByName.has(pool.name)) poolByName.set(pool.name, pool);
		}
		const state: PoolSetState = {
			pools,
			verbose,
			poolByName,
			lists: undefined,
		};
		shared = { state, handlers: createPoolSetHandlers(state) };
		poolSetShared.set(pools, shared);
	}
	shared.state.verbose = verbose;
	return shared;
}

/** Memoized prefixed lists + uri map; rebuilt when any pool rev changes. */
function ensureFreshLists(state: PoolSetState): FreshLists {
	const revs = state.pools.map((pool) => pool.listChangedRevision());
	const cached = state.lists;
	if (
		cached &&
		revs.length === cached.revs.length &&
		revs.every((rev, i) => rev === cached.revs[i])
	) {
		return cached;
	}
	const uriToPool = new Map<string, Pool>();
	seedUriMap(uriToPool, state.pools);
	const lists: CachedLists = {
		revs,
		tools: buildPrefixedTools(state.pools),
		prompts: buildPrefixedPrompts(state.pools),
		resources: buildPrefixedResources(state.pools),
		templates: buildPrefixedTemplates(state.pools),
		uriToPool,
	};
	state.lists = lists;
	return lists;
}

function buildPrefixedTools(pools: Pool[]): PrefixedTool[] {
	const tools: PrefixedTool[] = [];
	for (const pool of pools) {
		const prefix = `${pool.name}__`;
		for (const tool of pool.getTools()) {
			tools.push({
				name: prefix + tool.name,
				description: tool.description
					? `[${pool.name}] ${tool.description}`
					: `[${pool.name}]`,
				inputSchema: tool.inputSchema,
			});
		}
	}
	return tools;
}

function buildPrefixedPrompts(pools: Pool[]): PrefixedPrompt[] {
	const prompts: PrefixedPrompt[] = [];
	for (const pool of pools) {
		const prefix = `${pool.name}__`;
		for (const prompt of pool.getPrompts()) {
			prompts.push({
				name: prefix + prompt.name,
				description: prompt.description
					? `[${pool.name}] ${prompt.description}`
					: `[${pool.name}]`,
				arguments: prompt.arguments,
			});
		}
	}
	return prompts;
}

function buildPrefixedResources(pools: Pool[]): PrefixedResource[] {
	const resources: PrefixedResource[] = [];
	for (const pool of pools) {
		const prefix = `${pool.name}__`;
		for (const resource of pool.getResources()) {
			resources.push({
				name: prefix + resource.name,
				uri: resource.uri,
				description: resource.description
					? `[${pool.name}] ${resource.description}`
					: `[${pool.name}]`,
				mimeType: resource.mimeType,
			});
		}
	}
	return resources;
}

function buildPrefixedTemplates(pools: Pool[]): PrefixedResourceTemplate[] {
	const templates: PrefixedResourceTemplate[] = [];
	for (const pool of pools) {
		const prefix = `${pool.name}__`;
		for (const template of pool.getResourceTemplates()) {
			templates.push({
				name: prefix + template.name,
				uriTemplate: template.uriTemplate,
				description: template.description
					? `[${pool.name}] ${template.description}`
					: `[${pool.name}]`,
				mimeType: template.mimeType,
			});
		}
	}
	return templates;
}

/**
 * F10: template-only fallback for URIs the exact map misses. Exact URIs are
 * served by the memoized uriToPool map; this linear scan runs only for
 * non-exact URIs and matches `{param}` placeholders (never plain resources).
 */
function findTemplatePool(pools: Pool[], uri: string): Pool | undefined {
	for (const pool of pools) {
		if (pool.resolveTemplateForUri(uri)) return pool;
	}
	return undefined;
}

type PoolSetHandlers = ReturnType<typeof createPoolSetHandlers>;

/** Handler set shared by every Server built over the same pools. */
function createPoolSetHandlers(state: PoolSetState) {
	return {
		listTools: async () => {
			return { tools: ensureFreshLists(state).tools };
		},

		callTool: async (request: CallToolRequest) => {
			const split = splitPrefix(request.params.name, "tool");
			if ("error" in split) {
				return {
					content: [{ type: "text" as const, text: split.error }],
					isError: true,
				};
			}

			const pool = state.poolByName.get(split.poolName);

			if (!pool) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Unknown pool: "${split.poolName}"`,
						},
					],
					isError: true,
				};
			}

			if (state.verbose) {
				log({
					level: "info",
					event: "route",
					pool: split.poolName,
					tool: split.short,
					upstream: -1,
				});
			}

			return (await pool.routeCall(
				split.short,
				request.params.arguments ?? {},
				state.verbose,
			)) as {
				content: Array<{ type: "text"; text: string; annotations?: unknown }>;
				isError?: boolean;
			};
		},

		listPrompts: async () => {
			return { prompts: ensureFreshLists(state).prompts };
		},

		getPrompt: async (request: GetPromptRequest) => {
			const split = splitPrefix(request.params.name, "prompt");
			if ("error" in split) {
				throw new Error(split.error);
			}

			const pool = state.poolByName.get(split.poolName);
			if (!pool) {
				throw new Error(`Unknown pool: "${split.poolName}"`);
			}

			const known = pool.getPrompts().some((p) => p.name === split.short);
			if (!known) {
				throw new Error(
					`Unknown prompt: "${split.short}" in pool "${split.poolName}"`,
				);
			}

			if (state.verbose) {
				log({
					level: "info",
					event: "route_prompt",
					pool: split.poolName,
					prompt: split.short,
					upstream: -1,
				});
			}

			const result = await pool.routePrompt(
				split.short,
				request.params.arguments,
			);
			if ("isError" in result && result.isError) {
				throw new Error(result.content[0].text);
			}
			return result;
		},

		listResources: async () => {
			return { resources: ensureFreshLists(state).resources };
		},

		listTemplates: async () => {
			return {
				resourceTemplates: ensureFreshLists(state).templates,
			};
		},

		readResource: async (request: ReadResourceRequest) => {
			const { uriToPool } = ensureFreshLists(state);
			const pool =
				uriToPool.get(request.params.uri) ??
				findTemplatePool(state.pools, request.params.uri);
			if (!pool) {
				throw new Error(`Unknown resource: "${request.params.uri}"`);
			}

			if (state.verbose) {
				log({
					level: "info",
					event: "route_resource",
					pool: pool.name,
					uri: request.params.uri,
					upstream: -1,
				});
			}

			const result = await pool.routeRead(request.params.uri);
			if ("isError" in result && result.isError) {
				throw new Error(result.content[0].text);
			}
			return result;
		},

		subscribe: async (request: SubscribeRequest) => {
			const { uriToPool } = ensureFreshLists(state);
			const pool =
				uriToPool.get(request.params.uri) ??
				findTemplatePool(state.pools, request.params.uri);
			if (!pool) {
				throw new Error(`Unknown resource: "${request.params.uri}"`);
			}

			if (state.verbose) {
				log({
					level: "info",
					event: "route_resource",
					pool: pool.name,
					uri: `subscribe:${request.params.uri}`,
					upstream: -1,
				});
			}

			const err = await pool.routeSubscribe(request.params.uri);
			if (err) {
				throw new Error(err.content[0].text);
			}
			return {};
		},

		unsubscribe: async (request: UnsubscribeRequest) => {
			const { uriToPool } = ensureFreshLists(state);
			const pool =
				uriToPool.get(request.params.uri) ??
				findTemplatePool(state.pools, request.params.uri);
			if (!pool) {
				throw new Error(`Unknown resource: "${request.params.uri}"`);
			}

			if (state.verbose) {
				log({
					level: "info",
					event: "route_resource",
					pool: pool.name,
					uri: `unsubscribe:${request.params.uri}`,
					upstream: -1,
				});
			}

			const err = await pool.routeUnsubscribe(request.params.uri);
			if (err) {
				throw new Error(err.content[0].text);
			}
			return {};
		},

		complete: async (request: CompleteRequest) => {
			const ref = request.params.ref as
				| { type: "ref/prompt"; name: string }
				| { type: "ref/resource"; uri: string };
			let pool: Pool | undefined;
			if (ref.type === "ref/prompt") {
				const split = splitPrefix(ref.name, "prompt");
				if ("error" in split) {
					throw new Error(split.error);
				}
				pool = state.poolByName.get(split.poolName);
				if (!pool) {
					throw new Error(`Unknown pool: "${split.poolName}"`);
				}
				if (state.verbose) {
					log({
						level: "info",
						event: "route_complete",
						pool: pool.name,
						ref: ref.name,
						upstream: -1,
					});
				}
				const result = await pool.routeComplete({
					...request.params,
					ref: { type: "ref/prompt", name: split.short },
				});
				if ("isError" in result && result.isError) {
					throw new Error(result.content[0].text);
				}
				return result;
			}
			const { uriToPool } = ensureFreshLists(state);
			pool = uriToPool.get(ref.uri) ?? findTemplatePool(state.pools, ref.uri);
			if (!pool) {
				throw new Error(`Unknown resource: "${ref.uri}"`);
			}
			if (state.verbose) {
				log({
					level: "info",
					event: "route_complete",
					pool: pool.name,
					ref: ref.uri,
					upstream: -1,
				});
			}
			const result = await pool.routeComplete(request.params);
			if ("isError" in result && result.isError) {
				throw new Error(result.content[0].text);
			}
			return result;
		},

		setLevel: async (request: SetLevelRequest) => {
			// Shared upstream: best-effort forward to every connected pool.
			await Promise.allSettled(
				state.pools.map((pool) => pool.routeSetLevel(request.params.level)),
			);
			return {};
		},
	};
}

/**
 * Builds an MCP server bound to one set of pools. Callers create one of these
 * per connection so every client gets its own session over shared pools.
 */
export function buildServer(pools: Pool[], verbose: boolean): Server {
	// Shared handler set + memoized lists for this pool-set; the Server
	// itself stays per-connection (SDK Protocol forbids sharing it).
	const { handlers } = getShared(pools, verbose);
	const hasPrompts = pools.some(
		(pool) => pool.getUpstreamCapabilities()?.prompts !== undefined,
	);
	const hasResources = pools.some(
		(pool) => pool.getUpstreamCapabilities()?.resources !== undefined,
	);
	const hasCompletions = pools.some(
		(pool) => pool.getUpstreamCapabilities()?.completions !== undefined,
	);
	const hasLogging = pools.some(
		(pool) => pool.getUpstreamCapabilities()?.logging !== undefined,
	);
	const server = new Server(
		{ name: "mcp-pool", version: packageJson.version },
		{
			capabilities: {
				tools: {},
				...(hasPrompts ? { prompts: { listChanged: true } } : {}),
				...(hasResources
					? { resources: { subscribe: true, listChanged: true } }
					: {}),
				...(hasCompletions ? { completions: {} } : {}),
				...(hasLogging ? { logging: {} } : {}),
			},
		},
	);

	server.setRequestHandler(ListToolsRequestSchema, handlers.listTools);
	server.setRequestHandler(CallToolRequestSchema, handlers.callTool);

	if (hasPrompts) {
		server.setRequestHandler(ListPromptsRequestSchema, handlers.listPrompts);
		server.setRequestHandler(GetPromptRequestSchema, handlers.getPrompt);
	}

	if (hasResources) {
		server.setRequestHandler(
			ListResourcesRequestSchema,
			handlers.listResources,
		);
		server.setRequestHandler(
			ListResourceTemplatesRequestSchema,
			handlers.listTemplates,
		);
		server.setRequestHandler(ReadResourceRequestSchema, handlers.readResource);
		server.setRequestHandler(SubscribeRequestSchema, handlers.subscribe);
		server.setRequestHandler(UnsubscribeRequestSchema, handlers.unsubscribe);
	}

	if (hasCompletions) {
		server.setRequestHandler(CompleteRequestSchema, handlers.complete);
	}

	if (hasLogging) {
		server.setRequestHandler(SetLevelRequestSchema, handlers.setLevel);
	}

	// list_changed fan-out: each session subscribes once at build time to the
	// shared pool emitters; deregisters when the session closes so dead
	// sessions stop receiving (and holding) notifications.
	const unsubscribes: Array<() => void> = [];
	for (const pool of pools) {
		unsubscribes.push(
			pool.onListChanged((kind) => {
				if (kind === "tools") {
					void server.sendToolListChanged().catch(() => {});
				} else if (kind === "prompts") {
					void server.sendPromptListChanged().catch(() => {});
				} else {
					void server.sendResourceListChanged().catch(() => {});
				}
			}),
		);
	}
	const originalClose = server.close.bind(server);
	server.close = async () => {
		for (const unsubscribe of unsubscribes) unsubscribe();
		await originalClose();
	};

	return server;
}
