import { Server } from "@modelcontextprotocol/sdk/server/index.js";
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
			if (!uriToPool.has(resource.uri)) uriToPool.set(resource.uri, pool);
		}
		for (const template of pool.getResourceTemplates()) {
			if (!uriToPool.has(template.uriTemplate)) {
				uriToPool.set(template.uriTemplate, pool);
			}
		}
	}
}

/**
 * Builds an MCP server bound to one set of pools. Callers create one of these
 * per connection so every client gets its own session over shared pools.
 */
export function buildServer(pools: Pool[], verbose: boolean): Server {
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

	// Per-build URI→pool map. Verbatim URIs: keyed by the exact upstream
	// `uri`, so a collision across pools would silently pick one — a STOP
	// condition per the plan, not something we paper over here.
	const uriToPool = new Map<string, Pool>();
	seedUriMap(uriToPool, pools);
	function rebuildUriMap(): void {
		uriToPool.clear();
		seedUriMap(uriToPool, pools);
	}

	server.setRequestHandler(ListToolsRequestSchema, async () => {
		const tools: Array<{
			name: string;
			description?: string;
			inputSchema: {
				type: "object";
				properties?: Record<string, unknown>;
				required?: string[];
			};
		}> = [];

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

		return { tools };
	});

	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const split = splitPrefix(request.params.name, "tool");
		if ("error" in split) {
			return {
				content: [{ type: "text" as const, text: split.error }],
				isError: true,
			};
		}

		const pool = pools.find((p) => p.name === split.poolName);

		if (!pool) {
			return {
				content: [
					{ type: "text" as const, text: `Unknown pool: "${split.poolName}"` },
				],
				isError: true,
			};
		}

		log({
			level: "info",
			event: "route",
			pool: split.poolName,
			tool: split.short,
			upstream: -1,
		});

		return (await pool.routeCall(
			split.short,
			request.params.arguments ?? {},
			verbose,
		)) as {
			content: Array<{ type: "text"; text: string; annotations?: unknown }>;
			isError?: boolean;
		};
	});

	if (hasPrompts) {
		server.setRequestHandler(ListPromptsRequestSchema, async () => {
			const prompts: Array<{
				name: string;
				description?: string;
				arguments?: Array<{
					name: string;
					description?: string;
					required?: boolean;
				}>;
			}> = [];

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

			return { prompts };
		});

		server.setRequestHandler(GetPromptRequestSchema, async (request) => {
			const split = splitPrefix(request.params.name, "prompt");
			if ("error" in split) {
				throw new Error(split.error);
			}

			const pool = pools.find((p) => p.name === split.poolName);
			if (!pool) {
				throw new Error(`Unknown pool: "${split.poolName}"`);
			}

			const known = pool.getPrompts().some((p) => p.name === split.short);
			if (!known) {
				throw new Error(
					`Unknown prompt: "${split.short}" in pool "${split.poolName}"`,
				);
			}

			log({
				level: "info",
				event: "route_prompt",
				pool: split.poolName,
				prompt: split.short,
				upstream: -1,
			});

			const result = await pool.routePrompt(
				split.short,
				request.params.arguments,
			);
			if ("isError" in result && result.isError) {
				throw new Error(result.content[0].text);
			}
			return result;
		});
	}

	if (hasResources) {
		server.setRequestHandler(ListResourcesRequestSchema, async () => {
			rebuildUriMap();
			const resources: Array<{
				name: string;
				uri: string;
				description?: string;
				mimeType?: string;
			}> = [];

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

			return { resources };
		});

		server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
			rebuildUriMap();
			const resourceTemplates: Array<{
				name: string;
				uriTemplate: string;
				description?: string;
				mimeType?: string;
			}> = [];

			for (const pool of pools) {
				const prefix = `${pool.name}__`;
				for (const template of pool.getResourceTemplates()) {
					resourceTemplates.push({
						name: prefix + template.name,
						uriTemplate: template.uriTemplate,
						description: template.description
							? `[${pool.name}] ${template.description}`
							: `[${pool.name}]`,
						mimeType: template.mimeType,
					});
				}
			}

			return { resourceTemplates };
		});

		server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
			const pool = uriToPool.get(request.params.uri);
			if (!pool) {
				throw new Error(`Unknown resource: "${request.params.uri}"`);
			}

			log({
				level: "info",
				event: "route_resource",
				pool: pool.name,
				uri: request.params.uri,
				upstream: -1,
			});

			const result = await pool.routeRead(request.params.uri);
			if ("isError" in result && result.isError) {
				throw new Error(result.content[0].text);
			}
			return result;
		});

		server.setRequestHandler(SubscribeRequestSchema, async (request) => {
			const pool = uriToPool.get(request.params.uri);
			if (!pool) {
				throw new Error(`Unknown resource: "${request.params.uri}"`);
			}

			const err = await pool.routeSubscribe(request.params.uri);
			if (err) {
				throw new Error(err.content[0].text);
			}
			return {};
		});

		server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
			const pool =
				uriToPool.get(request.params.uri) ?? findUriPool(request.params.uri);
			if (!pool) {
				throw new Error(`Unknown resource: "${request.params.uri}"`);
			}

			const err = await pool.routeUnsubscribe(request.params.uri);
			if (err) {
				throw new Error(err.content[0].text);
			}
			return {};
		});
	}

	if (hasCompletions) {
		server.setRequestHandler(CompleteRequestSchema, async (request) => {
			const ref = request.params.ref as
				| { type: "ref/prompt"; name: string }
				| { type: "ref/resource"; uri: string };
			let pool: Pool | undefined;
			if (ref.type === "ref/prompt") {
				const split = splitPrefix(ref.name, "prompt");
				if ("error" in split) {
					throw new Error(split.error);
				}
				pool = pools.find((p) => p.name === split.poolName);
				if (!pool) {
					throw new Error(`Unknown pool: "${split.poolName}"`);
				}
				log({
					level: "info",
					event: "route_complete",
					pool: pool.name,
					ref: ref.name,
					upstream: -1,
				});
				const result = await pool.routeComplete({
					...request.params,
					ref: { type: "ref/prompt", name: split.short },
				});
				if ("isError" in result && result.isError) {
					throw new Error(result.content[0].text);
				}
				return result;
			}
			pool = uriToPool.get(ref.uri) ?? findUriPool(ref.uri);
			if (!pool) {
				throw new Error(`Unknown resource: "${ref.uri}"`);
			}
			log({
				level: "info",
				event: "route_complete",
				pool: pool.name,
				ref: ref.uri,
				upstream: -1,
			});
			const result = await pool.routeComplete(request.params);
			if ("isError" in result && result.isError) {
				throw new Error(result.content[0].text);
			}
			return result;
		});
	}

	if (hasLogging) {
		server.setRequestHandler(SetLevelRequestSchema, async (request) => {
			// Shared upstream: best-effort forward to every connected pool.
			await Promise.allSettled(
				pools.map((pool) => pool.routeSetLevel(request.params.level)),
			);
			return {};
		});
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

	function findUriPool(uri: string): Pool | undefined {
		for (const pool of pools) {
			if (pool.resolvePoolForUri(uri)) return pool;
		}
		return undefined;
	}

	return server;
}
