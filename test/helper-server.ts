#!/usr/bin/env node
/**
 * Test helper MCP server for integration tests.
 * Behaviors controlled via env vars:
 *   TEST_TOOLS_JSON — JSON array of tools (default: echo tool)
 *   TEST_PROMPTS_JSON — JSON array of prompts (default: none; set TEST_NO_PROMPTS=1 to force none)
 *   TEST_NO_PROMPTS — if "1", offer no prompts capability at all
 *   TEST_RESOURCES_JSON — JSON array of resources {uri, name, mimeType?} (default: none; set TEST_NO_RESOURCES=1 to force none)
 *   TEST_NO_RESOURCES — if "1", offer no resources capability at all
 *   TEST_NO_COMPLETIONS — if "1", offer no completions capability at all
 *   TEST_NO_LOGGING — if "1", offer no logging capability at all
 *   TEST_LOG_LEVEL_FILE — path to write the last logging/setLevel level
 *   TEST_RATE_LIMIT_EVERY_N — return rate-limit error on every Nth call (default: 0 = never)
 *   TEST_RATE_LIMIT_COUNT — max rate-limited responses before returning success (0 = unlimited)
 *   TEST_CRASH_AFTER — crash after N tool calls (default: 0 = never)
 *   TEST_CRASH_ON_START — if set to "1", crash immediately during startup
 *   TEST_TOOL_ERROR_TEXT — error text for rate-limited calls (default: "rate_limit_exceeded")
 */

if (process.env.TEST_CRASH_ON_START === "1") {
	process.exit(1);
}

import { writeFileSync } from "node:fs";

const lifecycleFile = process.env.TEST_LIFECYCLE_FILE;
if (lifecycleFile) {
	writeFileSync(lifecycleFile, "started");
	process.on("exit", () => writeFileSync(lifecycleFile, "closed"));
}

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
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

let callCount = 0;
let rateLimitCount = 0;

const defaultTools = [
	{
		name: "echo",
		inputSchema: {
			type: "object" as const,
			properties: { message: { type: "string" } },
			required: ["message"],
		},
	},
];

function getTools() {
	const raw = process.env.TEST_TOOLS_JSON;
	if (!raw) return defaultTools;
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) && parsed.length > 0 ? parsed : defaultTools;
	} catch {
		return defaultTools;
	}
}

function getPrompts(): Array<{
	name: string;
	description?: string;
	arguments?: Array<{
		name: string;
		description?: string;
		required?: boolean;
	}>;
}> {
	const raw = process.env.TEST_PROMPTS_JSON;
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function getResources(): Array<{
	uri: string;
	name: string;
	mimeType?: string;
}> {
	const raw = process.env.TEST_RESOURCES_JSON;
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

const rateLimitEveryN = parseInt(
	process.env.TEST_RATE_LIMIT_EVERY_N || "0",
	10,
);
const rateLimitMax = parseInt(process.env.TEST_RATE_LIMIT_COUNT || "0", 10);
const crashAfter = parseInt(process.env.TEST_CRASH_AFTER || "0", 10);
const errorText = process.env.TEST_TOOL_ERROR_TEXT || "rate_limit_exceeded";

const offerPrompts = process.env.TEST_NO_PROMPTS !== "1";
const offerResources = process.env.TEST_NO_RESOURCES !== "1";
const offerCompletions = process.env.TEST_NO_COMPLETIONS !== "1";
const offerLogging = process.env.TEST_NO_LOGGING !== "1";

const server = new Server(
	{ name: "test-helper-server", version: "0.1.0" },
	{
		capabilities: {
			tools: {},
			...(offerPrompts ? { prompts: { listChanged: true } } : {}),
			...(offerResources
				? { resources: { subscribe: true, listChanged: true } }
				: {}),
			...(offerCompletions ? { completions: {} } : {}),
			...(offerLogging ? { logging: {} } : {}),
		},
	},
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
	return { tools: getTools() };
});

if (offerPrompts) {
	server.setRequestHandler(ListPromptsRequestSchema, async () => {
		return { prompts: getPrompts() };
	});

	server.setRequestHandler(GetPromptRequestSchema, async (request) => {
		const prompt = getPrompts().find((p) => p.name === request.params.name);
		if (!prompt) {
			throw new Error(`Unknown prompt: "${request.params.name}"`);
		}
		return {
			description: prompt.description,
			messages: [
				{
					role: "user" as const,
					content: {
						type: "text" as const,
						text: `prompt:${prompt.name} args:${JSON.stringify(request.params.arguments ?? {})}`,
					},
				},
			],
		};
	});
}

if (offerResources) {
	server.setRequestHandler(ListResourcesRequestSchema, async () => {
		return { resources: getResources() };
	});

	server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
		return {
			resourceTemplates: getResources().map((r) => ({
				name: r.name,
				uriTemplate: "exa://docs/{id}",
			})),
		};
	});

	server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
		const resource = getResources().find((r) => r.uri === request.params.uri);
		if (!resource) {
			throw new Error(`Unknown resource: "${request.params.uri}"`);
		}
		return {
			contents: [
				{
					uri: resource.uri,
					mimeType: resource.mimeType ?? "text/plain",
					text: `hello from ${resource.name}`,
				},
			],
		};
	});

	server.setRequestHandler(SubscribeRequestSchema, async (request) => {
		const resource = getResources().find((r) => r.uri === request.params.uri);
		if (!resource) {
			throw new Error(`Unknown resource: "${request.params.uri}"`);
		}
		return {};
	});

	server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
		const resource = getResources().find((r) => r.uri === request.params.uri);
		if (!resource) {
			throw new Error(`Unknown resource: "${request.params.uri}"`);
		}
		return {};
	});
}

if (offerCompletions) {
	server.setRequestHandler(CompleteRequestSchema, async (request) => {
		const ref = request.params.ref as
			| { type: "ref/prompt"; name: string }
			| { type: "ref/resource"; uri: string };
		const argValue =
			typeof request.params.argument?.value === "string"
				? request.params.argument.value
				: "";
		if (ref.type === "ref/prompt") {
			const prompt = getPrompts().find((p) => p.name === ref.name);
			if (!prompt) {
				throw new Error(`Unknown prompt: "${ref.name}"`);
			}
			return {
				completion: {
					values: [`hello ${prompt.name} ${argValue}`.trim()],
					total: 1,
					hasMore: false,
				},
			};
		}
		const resource = getResources().find((r) => r.uri === ref.uri);
		if (!resource) {
			throw new Error(`Unknown resource: "${ref.uri}"`);
		}
		return {
			completion: {
				values: [`hello from ${resource.name} ${argValue}`.trim()],
				total: 1,
				hasMore: false,
			},
		};
	});
}

if (offerLogging) {
	server.setRequestHandler(SetLevelRequestSchema, async (request) => {
		const file = process.env.TEST_LOG_LEVEL_FILE;
		if (file) {
			writeFileSync(file, request.params.level);
		}
		return {};
	});
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
	callCount++;

	if (crashAfter > 0 && callCount >= crashAfter) {
		process.exit(1);
	}

	const shouldRateLimit =
		rateLimitEveryN > 0 && callCount % rateLimitEveryN === 0;
	const rateLimitExhausted = rateLimitMax > 0 && rateLimitCount >= rateLimitMax;

	if (shouldRateLimit && !rateLimitExhausted) {
		rateLimitCount++;
		return {
			content: [{ type: "text" as const, text: errorText }],
			isError: true,
		};
	}

	return {
		content: [
			{
				type: "text" as const,
				text: JSON.stringify(request.params.arguments ?? {}),
			},
		],
	};
});

const transport = new StdioServerTransport();
await server.connect(transport);
