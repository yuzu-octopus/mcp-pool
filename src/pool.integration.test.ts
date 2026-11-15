import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Pool } from "./pool.js";
import type { PoolConfig } from "./types.js";

interface CallResult {
	content: Array<{ text: string }>;
	isError?: boolean;
}

function assertCallResult(v: unknown): asserts v is CallResult {
	if (!v || typeof v !== "object" || !("content" in v)) {
		throw new Error("expected CallResult with content");
	}
	if (
		!Array.isArray((v as CallResult).content) ||
		!(v as CallResult).content.every(
			(c: unknown) =>
				c &&
				typeof c === "object" &&
				"text" in (c as Record<string, unknown>) &&
				typeof (c as Record<string, unknown>).text === "string",
		)
	) {
		throw new Error("expected content to be Array<{ text: string }>");
	}
}

function poolConfig(overrides: Partial<PoolConfig> = {}): PoolConfig {
	return {
		command: "bun",
		args: ["run", "test/helper-server.ts"],
		keys: [{ KEY: "a" }],
		rateLimitPatterns: ["rate_limit_exceeded"],
		...overrides,
	};
}

describe("Pool startup", () => {
	test("starts with single upstream and lists tools", async () => {
		const pool = new Pool("test", poolConfig());
		await pool.start();
		const tools = pool.getTools();
		expect(tools.length).toBeGreaterThan(0);
		expect(tools[0].name).toBe("echo");
		await pool.close();
	});

	test("starts with multiple keys", async () => {
		const pool = new Pool(
			"test",
			poolConfig({ keys: [{ KEY: "a" }, { KEY: "b" }] }),
		);
		await pool.start();
		expect(pool.getTools().length).toBeGreaterThan(0);
		await pool.close();
	});

	test("tolerates later key crashing during startup", async () => {
		const pool = new Pool(
			"test",
			poolConfig({
				keys: [{ KEY: "a" }, { KEY: "b", TEST_CRASH_ON_START: "1" }],
			}),
		);
		await pool.start();
		expect(pool.getTools().length).toBeGreaterThan(0);
		await pool.close();
	});

	test("recovers when first key crashes during startup", async () => {
		const pool = new Pool(
			"test",
			poolConfig({
				keys: [{ KEY: "a", TEST_CRASH_ON_START: "1" }, { KEY: "b" }],
			}),
		);
		await pool.start();
		expect(pool.getTools().length).toBeGreaterThan(0);
		await pool.close();
	});

	test("fails when all keys crash during startup", async () => {
		const pool = new Pool(
			"test",
			poolConfig({
				keys: [
					{ KEY: "a", TEST_CRASH_ON_START: "1" },
					{ KEY: "b", TEST_CRASH_ON_START: "1" },
				],
			}),
		);
		await expect(pool.start()).rejects.toThrow(/failed to connect/i);
	});

	test("detects tool mismatch on failover", async () => {
		const pool = new Pool(
			"test",
			poolConfig({
				keys: [
					{ KEY: "a", TEST_RATE_LIMIT_EVERY_N: "1" },
					{
						KEY: "b",
						TEST_TOOLS_JSON: JSON.stringify([
							{
								name: "different-tool",
								inputSchema: { type: "object" as const },
							},
						]),
					},
				],
			}),
		);
		await pool.start();
		const result = await pool.routeCall("echo", {});
		assertCallResult(result);
		expect(result.isError).toBe(true);
		await pool.close();
	});
});

describe("Pool routing", () => {
	test("successful tool call returns result", async () => {
		const pool = new Pool("test", poolConfig());
		await pool.start();
		const result = await pool.routeCall("echo", { message: "hello" });
		assertCallResult(result);
		expect(JSON.parse(result.content[0].text)).toEqual({ message: "hello" });
		await pool.close();
	});
	test("never logs raw tool arguments", async () => {
		const pool = new Pool("test", poolConfig());
		const original = console.error;
		const lines: string[] = [];
		console.error = (...values: unknown[]) => lines.push(values.join(" "));

		try {
			await pool.start();
			await pool.routeCall(
				"echo",
				{ credential: "sensitive-test-value" },
				true,
			);
			expect(lines.join("\n")).not.toContain("sensitive-test-value");
		} finally {
			await pool.close();
			console.error = original;
		}
	});

	test("routeCall before start returns error", async () => {
		const pool = new Pool("test", poolConfig());
		const result = await pool.routeCall("echo", {});
		assertCallResult(result);
		expect(result.isError).toBe(true);
	});

	test("all upstreams exhausted returns rate-limited error", async () => {
		const pool = new Pool(
			"test",
			poolConfig({ keys: [{ KEY: "a", TEST_RATE_LIMIT_EVERY_N: "1" }] }),
		);
		await pool.start();
		const result = await pool.routeCall("echo", {});
		assertCallResult(result);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/retry after/i);
		await pool.close();
	});

	test("all keys failing returns unavailable message", async () => {
		const pool = new Pool(
			"test",
			poolConfig({
				keys: [
					{ KEY: "a", TEST_CRASH_AFTER: "1" },
					{ KEY: "b", TEST_CRASH_AFTER: "1" },
				],
			}),
		);
		await pool.start();
		const result = await pool.routeCall("echo", {});
		assertCallResult(result);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/failed to connect|unavailable/i);
		await pool.close();
	});

	test("cooldown prevents immediate retry after exhaustion", async () => {
		const pool = new Pool(
			"test",
			poolConfig({
				keys: [{ KEY: "a", TEST_RATE_LIMIT_EVERY_N: "1" }],
				cooldownSeconds: 60,
			}),
		);
		await pool.start();
		const first = await pool.routeCall("echo", {});
		assertCallResult(first);
		expect(first.isError).toBe(true);
		const second = await pool.routeCall("echo", {});
		assertCallResult(second);
		expect(second.isError).toBe(true);
		expect(second.content[0].text).toMatch(/retry after/i);
		await pool.close();
	});
});

describe("transient retries (007-B)", () => {
	test("real stdio upstream recovers after three transient error results", async () => {
		const pool = new Pool("stdio-transient", {
			...poolConfig({
				keys: [
					{
						TEST_RATE_LIMIT_EVERY_N: "1",
						TEST_RATE_LIMIT_COUNT: "3",
						TEST_TOOL_ERROR_TEXT: "web_search_exa error: fetch failed",
					},
				],
				rateLimitPatterns: ["402"],
			}),
			transientRetry: {
				tools: ["echo"],
				errorPatterns: ["^web_search_exa error: fetch failed$"],
				delaysMs: [0, 0, 0],
			},
		});
		try {
			await pool.start();
			const result = await pool.routeCall("echo", { message: "unchanged" });
			expect(result).toMatchObject({
				content: [{ type: "text", text: '{"message":"unchanged"}' }],
			});
			expect(result).not.toHaveProperty("isError", true);
		} finally {
			await pool.close();
		}
	});
});

async function startMockHttpMcp(
	handler: (
		headers: Record<string, string | string[] | undefined>,
		toolName: string,
	) =>
		| { status: number; body: string }
		| { content: Array<{ type: "text"; text: string }>; isError?: boolean },
): Promise<{ url: string; close: () => Promise<void> }> {
	const httpServer: HttpServer = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk as Buffer);
		const rawBody = Buffer.concat(chunks).toString("utf-8");
		const parsed = rawBody ? JSON.parse(rawBody) : undefined;

		if (
			parsed?.method === "tools/call" &&
			typeof parsed.params?.name === "string"
		) {
			const outcome = handler(req.headers, parsed.params.name);
			if ("status" in outcome) {
				res.writeHead(outcome.status, { "Content-Type": "application/json" });
				res.end(outcome.body);
				return;
			}
			const accept = req.headers.accept ?? "";
			if (accept.includes("application/json")) {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						jsonrpc: "2.0",
						id: parsed.id ?? null,
						result: outcome,
					}),
				);
				return;
			}
		}

		const mcp = new Server(
			{ name: "mock-http-mcp", version: "0.1.0" },
			{ capabilities: { tools: {} } },
		);
		mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
			tools: [
				{
					name: "scrape",
					description: "Mock scrape tool",
					inputSchema: { type: "object", properties: {} },
				},
			],
		}));
		mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
			const outcome = handler(req.headers, request.params.name);
			if ("status" in outcome) {
				return {
					content: [{ type: "text", text: outcome.body }],
					isError: true,
				};
			}
			return outcome;
		});

		const transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: undefined,
		});
		res.on("close", () => {
			transport.close().catch(() => {});
			mcp.close().catch(() => {});
		});
		await mcp.connect(transport);
		await transport.handleRequest(req, res, parsed);
	});

	const ready = Promise.withResolvers<void>();
	httpServer.listen(0, "127.0.0.1", () => ready.resolve());
	await ready.promise;
	const { port } = httpServer.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}/mcp`,
		close: () => {
			const done = Promise.withResolvers<void>();
			httpServer.close((err) => (err ? done.reject(err) : done.resolve()));
			return done.promise;
		},
	};
}

describe("Pool HTTP transport (007-C)", () => {
	const cleanups: Array<() => Promise<void>> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			const fn = cleanups.pop();
			if (fn) await fn();
		}
	});

	test("fails over on HTTP 429 and unflagged SCRAPING FAILED errors", async () => {
		const seenKeys: string[] = [];
		const mock = await startMockHttpMcp((headers, toolName) => {
			const key = String(headers["x-api-key"] ?? "");
			seenKeys.push(`${key}:${toolName}`);
			if (key === "bad-key") {
				return {
					content: [
						{
							type: "text",
							text: "SCRAPING FAILED (Detail: 'API token is wrong.').",
						},
					],
					isError: false,
				};
			}
			if (key === "rate-limited-key") {
				return {
					status: 429,
					body: JSON.stringify({ error: "Too many requests" }),
				};
			}
			return {
				content: [{ type: "text", text: `ok:${headers["x-custom"]}:${key}` }],
			};
		});
		cleanups.push(mock.close);

		const pool = new Pool("scrapingant", {
			transport: "http",
			url: mock.url,
			headers: { "x-custom": "shared" },
			keys: [
				{ "x-api-key": "bad-key" },
				{ "x-api-key": "rate-limited-key" },
				{ "x-api-key": "good-key" },
			],
			rateLimitPatterns: ["429", "API token is wrong", "Too many requests"],
			cooldownSeconds: 300,
		});
		cleanups.push(() => pool.close());

		await pool.start();
		expect(pool.getTools().map((t) => t.name)).toEqual(["scrape"]);

		const result = (await pool.routeCall("scrape", {})) as {
			content: Array<{ text: string }>;
		};
		expect(result.content[0].text).toBe("ok:shared:good-key");
		expect(seenKeys).toEqual([
			"bad-key:scrape",
			"rate-limited-key:scrape",
			"good-key:scrape",
		]);
	});

	test("returns non-quota SCRAPING FAILED errors without failover", async () => {
		const seenKeys: string[] = [];
		const mock = await startMockHttpMcp((headers) => {
			seenKeys.push(String(headers["x-api-key"] ?? ""));
			return {
				content: [
					{
						type: "text",
						text: "SCRAPING FAILED (Detail: 'Target returned 404 Not Found').",
					},
				],
				isError: false,
			};
		});
		cleanups.push(mock.close);

		const pool = new Pool("scrapingant", {
			transport: "http",
			url: mock.url,
			keys: [{ "x-api-key": "key-1" }, { "x-api-key": "key-2" }],
			rateLimitPatterns: ["API token is wrong", "429"],
			cooldownSeconds: 300,
		});
		cleanups.push(() => pool.close());

		await pool.start();
		const result = (await pool.routeCall("scrape", {})) as {
			content: Array<{ text: string }>;
			isError?: boolean;
		};
		expect(result.content[0].text).toContain("Target returned 404 Not Found");
		expect(seenKeys).toEqual(["key-1"]);
	});
});
