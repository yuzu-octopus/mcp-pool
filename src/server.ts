import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
	CallToolRequestSchema,
	GetPromptRequestSchema,
	ListPromptsRequestSchema,
	ListToolsRequestSchema,
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

/**
 * Builds an MCP server bound to one set of pools. Callers create one of these
 * per connection so every client gets its own session over shared pools.
 */
export function buildServer(pools: Pool[], verbose: boolean): Server {
	const hasPrompts = pools.some(
		(pool) => pool.getUpstreamCapabilities()?.prompts !== undefined,
	);
	const server = new Server(
		{ name: "mcp-pool", version: packageJson.version },
		{
			capabilities: {
				tools: {},
				...(hasPrompts ? { prompts: { listChanged: true } } : {}),
			},
		},
	);

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

	return server;
}
