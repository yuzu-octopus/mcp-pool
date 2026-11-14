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
			// Return the MCP JSON-RPC response directly so handler is called once per request.
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

	await new Promise<void>((resolve) =>
		httpServer.listen(0, "127.0.0.1", () => resolve()),
	);
	const { port } = httpServer.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}/mcp`,
		close: () =>
			new Promise<void>((resolve, reject) =>
				httpServer.close((err) => (err ? reject(err) : resolve())),
			),
	};
}

describe("Pool HTTP transport", () => {
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
