import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Pool } from "./pool.js";
import { buildServer } from "./server.js";
import type { PoolConfig } from "./types.js";

function poolConfig(poolName: string, env: Record<string, string>): PoolConfig {
	return {
		command: "bun",
		args: ["run", "test/helper-server.ts"],
		keys: [{ KEY: poolName, ...env }],
		rateLimitPatterns: ["rate_limit_exceeded"],
	};
}

function promptsEnv(prompts: unknown): Record<string, string> {
	return { TEST_PROMPTS_JSON: JSON.stringify(prompts) };
}

function resourcesEnv(resources: unknown): Record<string, string> {
	return { TEST_RESOURCES_JSON: JSON.stringify(resources) };
}

const SUMMARIZE = [
	{
		name: "summarize",
		description: "Summarize text",
		arguments: [{ name: "text", description: "Text", required: true }],
	},
];

const TRANSLATE = [
	{
		name: "translate",
		description: "Translate text",
		arguments: [{ name: "text", description: "Text", required: true }],
	},
];

const RES_A = [{ uri: "exa://doc-1", name: "doc", mimeType: "text/plain" }];
const RES_B = [{ uri: "fire://item-9", name: "item", mimeType: "text/plain" }];

async function startClient(
	pools: Pool[],
): Promise<{ client: Client; server: Server }> {
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	const server = buildServer(pools, false);
	await server.connect(serverTransport);
	const client = new Client(
		{ name: "test-client", version: "0.0.0" },
		{ capabilities: {} },
	);
	await client.connect(clientTransport);
	return { client, server };
}

async function closeAll(
	pools: Pool[],
	client: Client,
	server: Server,
): Promise<void> {
	await client.close().catch(() => {});
	await server.close().catch(() => {});
	await Promise.all(pools.map((p) => p.close()));
}

function assertErrorResult(v: unknown): asserts v is {
	content: Array<{ text: string }>;
	isError: boolean;
} {
	if (!v || typeof v !== "object" || !("content" in v)) {
		throw new Error("expected error result with content");
	}
}

describe("resources passthrough", () => {
	test("resources/list shows prefixed names and verbatim URIs", async () => {
		const alpha = new Pool("alpha", poolConfig("alpha", resourcesEnv(RES_A)));
		const beta = new Pool("beta", poolConfig("beta", resourcesEnv(RES_B)));
		await alpha.start();
		await beta.start();
		const { client, server } = await startClient([alpha, beta]);
		try {
			expect(client.getServerCapabilities()?.resources).toEqual({
				subscribe: true,
				listChanged: true,
			});
			const result = await client.listResources();
			const byName: Record<string, string> = {};
			for (const r of result.resources) byName[r.name] = r.uri;
			expect(byName.alpha__doc).toBe("exa://doc-1");
			expect(byName.beta__item).toBe("fire://item-9");
		} finally {
			await closeAll([alpha, beta], client, server);
		}
	});

	test("templates/list prefixes name and keeps uriTemplate verbatim", async () => {
		const alpha = new Pool(
			"alpha",
			poolConfig("alpha", resourcesEnv([{ uri: "exa://x", name: "x" }])),
		);
		await alpha.start();
		const { client, server } = await startClient([alpha]);
		try {
			const templates = await client.listResourceTemplates();
			expect(templates.resourceTemplates.length).toBeGreaterThan(0);
			expect(templates.resourceTemplates[0].name).toBe("alpha__x");
			expect(templates.resourceTemplates[0].uriTemplate).toBe(
				"exa://docs/{id}",
			);
		} finally {
			await closeAll([alpha], client, server);
		}
	});

	test("resources/read routes via URI map, verbatim URI upstream", async () => {
		const alpha = new Pool("alpha", poolConfig("alpha", resourcesEnv(RES_A)));
		await alpha.start();
		const { client, server } = await startClient([alpha]);
		try {
			const result = await client.readResource({ uri: "exa://doc-1" });
			const text = JSON.stringify(result.contents);
			expect(text).toContain("exa://doc-1");
			expect(text).toContain("hello from doc");
		} finally {
			await closeAll([alpha], client, server);
		}
	});

	test("resources/read routes to the pool that owns the URI", async () => {
		const alpha = new Pool("alpha", poolConfig("alpha", resourcesEnv(RES_A)));
		const beta = new Pool("beta", poolConfig("beta", resourcesEnv(RES_B)));
		await alpha.start();
		await beta.start();
		const { client, server } = await startClient([alpha, beta]);
		try {
			const fromAlpha = await client.readResource({ uri: "exa://doc-1" });
			expect(JSON.stringify(fromAlpha.contents)).toContain("hello from doc");
			const fromBeta = await client.readResource({ uri: "fire://item-9" });
			expect(JSON.stringify(fromBeta.contents)).toContain("hello from item");
		} finally {
			await closeAll([alpha, beta], client, server);
		}
	});

	test("unknown URI read errors", async () => {
		const alpha = new Pool("alpha", poolConfig("alpha", resourcesEnv(RES_A)));
		await alpha.start();
		const { client, server } = await startClient([alpha]);
		try {
			await expect(client.readResource({ uri: "exa://nope" })).rejects.toThrow(
				/Unknown resource/,
			);
		} finally {
			await closeAll([alpha], client, server);
		}
	});

	test("subscribe/unsubscribe round-trip", async () => {
		const alpha = new Pool("alpha", poolConfig("alpha", resourcesEnv(RES_A)));
		await alpha.start();
		const { client, server } = await startClient([alpha]);
		try {
			await client.subscribeResource({ uri: "exa://doc-1" });
			await client.unsubscribeResource({ uri: "exa://doc-1" });
		} finally {
			await closeAll([alpha], client, server);
		}
	});

	test("subscribe to unknown URI errors", async () => {
		const alpha = new Pool("alpha", poolConfig("alpha", resourcesEnv(RES_A)));
		await alpha.start();
		const { client, server } = await startClient([alpha]);
		try {
			await expect(
				client.subscribeResource({ uri: "exa://nope" }),
			).rejects.toThrow(/Unknown resource/);
		} finally {
			await closeAll([alpha], client, server);
		}
	});

	test("resources capability absent when no pool offers resources", async () => {
		const plain = new Pool(
			"plain",
			poolConfig("plain", {
				...promptsEnv([]),
				TEST_NO_RESOURCES: "1",
			}),
		);
		await plain.start();
		expect(plain.getResources()).toEqual([]);
		const { client, server } = await startClient([plain]);
		try {
			expect(client.getServerCapabilities()?.resources).toBeUndefined();
		} finally {
			await closeAll([plain], client, server);
		}
	});

	test("resource cache mismatch on failover surfaces error", async () => {
		const pool = new Pool("test", {
			command: "bun",
			args: ["run", "test/helper-server.ts"],
			keys: [
				{ KEY: "a", TEST_RESOURCES_JSON: JSON.stringify(RES_A) },
				{ KEY: "b", TEST_RESOURCES_JSON: JSON.stringify(RES_B) },
			],
			rateLimitPatterns: ["rate_limit_exceeded"],
		});
		await pool.start();
		expect(pool.getResources().map((r) => r.uri)).toEqual(["exa://doc-1"]);
		// Unknown URI read throws, forcing failover onto key1, whose divergent
		// resources must be rejected by mismatch validation.
		const result = await pool.routeRead("exa://unknown");
		assertErrorResult(result);
		expect(result.isError).toBe(true);
		expect(pool.getResources().map((r) => r.uri)).toEqual(["exa://doc-1"]);
		await pool.close();
	});

	test("template cache mismatch on mimeType drift surfaces error", async () => {
		const PLAIN = [{ uri: "exa://doc-1", name: "doc", mimeType: "text/plain" }];
		const HTML = [{ uri: "exa://doc-1", name: "doc", mimeType: "text/html" }];
		const pool = new Pool("test", {
			command: "bun",
			args: ["run", "test/helper-server.ts"],
			keys: [
				{ KEY: "a", TEST_RESOURCES_JSON: JSON.stringify(PLAIN) },
				{ KEY: "b", TEST_RESOURCES_JSON: JSON.stringify(HTML) },
			],
			rateLimitPatterns: ["rate_limit_exceeded"],
		});
		await pool.start();
		expect(pool.getResourceTemplates().map((t) => t.mimeType)).toEqual([
			"text/plain",
		]);
		const result = await pool.routeRead("exa://unknown");
		assertErrorResult(result);
		expect(result.isError).toBe(true);
		expect(pool.getResourceTemplates().map((t) => t.mimeType)).toEqual([
			"text/plain",
		]);
		await pool.close();
	});

	test("complete fails over to healthy key when first key crashes", async () => {
		const pool = new Pool("test", {
			command: "bun",
			args: ["run", "test/helper-server.ts"],
			keys: [
				{ KEY: "a", TEST_CRASH_ON_START: "1" },
				{ KEY: "b", ...promptsEnv(SUMMARIZE) },
			],
			rateLimitPatterns: ["rate_limit_exceeded"],
		});
		await pool.start();
		const result = await pool.routeComplete({
			ref: { type: "ref/prompt", name: "summarize" },
			argument: { name: "text", value: "hel" },
		});
		expect("isError" in result && result.isError).not.toBe(true);
		await pool.close();
	});
});

describe("prompts passthrough", () => {
	test("prompts/list shows pool__ names from two pools", async () => {
		const alpha = new Pool("alpha", poolConfig("alpha", promptsEnv(SUMMARIZE)));
		const beta = new Pool("beta", poolConfig("beta", promptsEnv(TRANSLATE)));
		await alpha.start();
		await beta.start();
		const { client, server } = await startClient([alpha, beta]);
		try {
			expect(client.getServerCapabilities()?.prompts).toEqual({
				listChanged: true,
			});
			const result = await client.listPrompts();
			const names = result.prompts.map((p) => p.name).sort();
			expect(names).toEqual(["alpha__summarize", "beta__translate"]);
			const summary = result.prompts.find((p) => p.name === "alpha__summarize");
			expect(summary?.description).toContain("[alpha]");
		} finally {
			await closeAll([alpha, beta], client, server);
		}
	});

	test("prompts/get routes by prefix", async () => {
		const alpha = new Pool("alpha", poolConfig("alpha", promptsEnv(SUMMARIZE)));
		await alpha.start();
		const { client, server } = await startClient([alpha]);
		try {
			const result = await client.getPrompt({
				name: "alpha__summarize",
				arguments: { text: "hello" },
			});
			const text = JSON.stringify(result.messages);
			expect(text).toContain("summarize");
			expect(text).toContain("hello");
		} finally {
			await closeAll([alpha], client, server);
		}
	});

	test("unknown pool in prompt name errors", async () => {
		const alpha = new Pool("alpha", poolConfig("alpha", promptsEnv(SUMMARIZE)));
		await alpha.start();
		const { client, server } = await startClient([alpha]);
		try {
			await expect(
				client.getPrompt({ name: "nope__summarize" }),
			).rejects.toThrow(/Unknown pool/);
		} finally {
			await closeAll([alpha], client, server);
		}
	});

	test("unknown prompt in known pool errors", async () => {
		const alpha = new Pool("alpha", poolConfig("alpha", promptsEnv(SUMMARIZE)));
		await alpha.start();
		const { client, server } = await startClient([alpha]);
		try {
			await expect(client.getPrompt({ name: "alpha__nope" })).rejects.toThrow(
				/Unknown prompt/,
			);
		} finally {
			await closeAll([alpha], client, server);
		}
	});

	test("missing separator errors", async () => {
		const alpha = new Pool("alpha", poolConfig("alpha", promptsEnv(SUMMARIZE)));
		await alpha.start();
		const { client, server } = await startClient([alpha]);
		try {
			await expect(client.getPrompt({ name: "summarize" })).rejects.toThrow(
				/Invalid prompt name/,
			);
		} finally {
			await closeAll([alpha], client, server);
		}
	});

	test("prompts capability absent when no pool offers prompts", async () => {
		const plain = new Pool(
			"plain",
			poolConfig("plain", { TEST_NO_PROMPTS: "1" }),
		);
		await plain.start();
		expect(plain.getPrompts()).toEqual([]);
		const { client, server } = await startClient([plain]);
		try {
			expect(client.getServerCapabilities()?.prompts).toBeUndefined();
		} finally {
			await closeAll([plain], client, server);
		}
	});

	test("prompt cache mismatch on failover surfaces error", async () => {
		const pool = new Pool("test", {
			command: "bun",
			args: ["run", "test/helper-server.ts"],
			keys: [
				{ KEY: "a", TEST_PROMPTS_JSON: JSON.stringify(SUMMARIZE) },
				{ KEY: "b", TEST_PROMPTS_JSON: JSON.stringify(TRANSLATE) },
			],
			rateLimitPatterns: ["rate_limit_exceeded"],
		});
		await pool.start();
		expect(pool.getPrompts().map((p) => p.name)).toEqual(["summarize"]);
		// Unknown prompt makes the helper throw, forcing failover onto key1,
		// whose divergent prompts must be rejected by mismatch validation.
		const result = await pool.routePrompt("nonexistent");
		assertErrorResult(result);
		expect(result.isError).toBe(true);
		expect(pool.getPrompts().map((p) => p.name)).toEqual(["summarize"]);
		await pool.close();
	});
});

describe("completion + logging + list_changed", () => {
	test("complete routes prompt ref by prefix", async () => {
		const alpha = new Pool("alpha", poolConfig("alpha", promptsEnv(SUMMARIZE)));
		await alpha.start();
		const { client, server } = await startClient([alpha]);
		try {
			expect(client.getServerCapabilities()?.completions).toEqual({});
			const result = await client.complete({
				ref: { type: "ref/prompt", name: "alpha__summarize" },
				argument: { name: "text", value: "hel" },
			});
			expect(result.completion.values[0]).toContain("hello summarize");
		} finally {
			await closeAll([alpha], client, server);
		}
	});

	test("complete routes resource ref via URI map", async () => {
		const alpha = new Pool("alpha", poolConfig("alpha", resourcesEnv(RES_A)));
		await alpha.start();
		const { client, server } = await startClient([alpha]);
		try {
			const result = await client.complete({
				ref: { type: "ref/resource", uri: "exa://doc-1" },
				argument: { name: "q", value: "x" },
			});
			expect(result.completion.values[0]).toContain("hello from doc");
		} finally {
			await closeAll([alpha], client, server);
		}
	});

	test("complete with unknown prompt pool errors", async () => {
		const alpha = new Pool("alpha", poolConfig("alpha", promptsEnv(SUMMARIZE)));
		await alpha.start();
		const { client, server } = await startClient([alpha]);
		try {
			await expect(
				client.complete({
					ref: { type: "ref/prompt", name: "nope__summarize" },
					argument: { name: "text", value: "x" },
				}),
			).rejects.toThrow(/Unknown pool/);
		} finally {
			await closeAll([alpha], client, server);
		}
	});

	test("complete with unknown resource URI errors", async () => {
		const alpha = new Pool("alpha", poolConfig("alpha", resourcesEnv(RES_A)));
		await alpha.start();
		const { client, server } = await startClient([alpha]);
		try {
			await expect(
				client.complete({
					ref: { type: "ref/resource", uri: "exa://nope" },
					argument: { name: "q", value: "x" },
				}),
			).rejects.toThrow(/Unknown resource/);
		} finally {
			await closeAll([alpha], client, server);
		}
	});

	test("completions capability absent when no pool offers it", async () => {
		const plain = new Pool(
			"plain",
			poolConfig("plain", { TEST_NO_COMPLETIONS: "1" }),
		);
		await plain.start();
		const { client, server } = await startClient([plain]);
		try {
			expect(client.getServerCapabilities()?.completions).toBeUndefined();
		} finally {
			await closeAll([plain], client, server);
		}
	});

	test("setLevel reaches upstream (helper records level)", async () => {
		const levelFile = `/tmp/mcp-pool-006-level-${process.pid}.txt`;
		const alpha = new Pool(
			"alpha",
			poolConfig("alpha", { TEST_LOG_LEVEL_FILE: levelFile }),
		);
		await alpha.start();
		const { client, server } = await startClient([alpha]);
		try {
			expect(client.getServerCapabilities()?.logging).toEqual({});
			await client.setLoggingLevel("warning");
			expect(fs.readFileSync(levelFile, "utf8")).toBe("warning");
		} finally {
			await closeAll([alpha], client, server);
			fs.rmSync(levelFile, { force: true });
		}
	});

	test("logging capability absent when no pool offers it", async () => {
		const plain = new Pool(
			"plain",
			poolConfig("plain", { TEST_NO_LOGGING: "1" }),
		);
		await plain.start();
		const { client, server } = await startClient([plain]);
		try {
			expect(client.getServerCapabilities()?.logging).toBeUndefined();
		} finally {
			await closeAll([plain], client, server);
		}
	});

	test("list_changed from upstream surfaces as pool notification", async () => {
		const alpha = new Pool("alpha", poolConfig("alpha", {}));
		await alpha.start();
		const { client, server } = await startClient([alpha]);
		try {
			const seen: string[] = [];
			const { ToolListChangedNotificationSchema } = await import(
				"@modelcontextprotocol/sdk/types.js"
			);
			client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
				seen.push("tools-changed");
			});
			await alpha.debugFireListChanged("tools");
			await new Promise((r) => setTimeout(r, 200));
			expect(seen).toContain("tools-changed");
		} finally {
			await closeAll([alpha], client, server);
		}
	});
});

describe("session teardown + routing robustness (review findings)", () => {
	test("server.close() unregisters all pool list_changed listeners", async () => {
		const alpha = new Pool("alpha", poolConfig("alpha", {}));
		await alpha.start();
		const before = alpha.listChangedListenerCount();
		const { client, server } = await startClient([alpha]);
		try {
			expect(alpha.listChangedListenerCount()).toBeGreaterThan(before);
		} finally {
			await closeAll([alpha], client, server);
		}
		expect(alpha.listChangedListenerCount()).toBe(before);
	});

	test("resources/read falls back to live lookup when map not seeded", async () => {
		const alpha = new Pool("alpha", poolConfig("alpha", resourcesEnv(RES_A)));
		await alpha.start();
		// NOTE: no list call first, so the per-build URI map is empty.
		const { client, server } = await startClient([alpha]);
		try {
			const result = await client.readResource({ uri: "exa://doc-1" });
			expect(JSON.stringify(result)).toContain("doc-1");
		} finally {
			await closeAll([alpha], client, server);
		}
	});

	test("exact URI hits map; template-concrete URI falls back to owner (F10)", async () => {
		const alpha = new Pool("alpha", poolConfig("alpha", resourcesEnv(RES_A)));
		await alpha.start();
		// Helper advertises uriTemplate "exa://docs/{id}".
		expect(alpha.resolveTemplateForUri("exa://docs/123")).toBe(alpha);
		expect(alpha.resolveTemplateForUri("exa://other/9")).toBeUndefined();
		const { client, server } = await startClient([alpha]);
		try {
			// Exact URIs hit the uriToPool map: served verbatim upstream.
			const exact = await client.readResource({ uri: "exa://doc-1" });
			expect(JSON.stringify(exact)).toContain("hello from doc");
			// Template-concrete URIs miss the map and fall back to the owning
			// pool via template match; upstream then fails the read, which
			// proves routing got past the "Unknown resource" gate.
			const err = await client
				.readResource({ uri: "exa://docs/123" })
				.then((): null => null)
				.catch((e: unknown) => e);
			expect(String(err)).toMatch(/failed to connect or are unavailable/);
		} finally {
			await closeAll([alpha], client, server);
		}
	});

	test("prompts/get routes to the pool that owns the prompt", async () => {
		const alpha = new Pool("alpha", poolConfig("alpha", promptsEnv(SUMMARIZE)));
		const beta = new Pool("beta", poolConfig("beta", promptsEnv(TRANSLATE)));
		await alpha.start();
		await beta.start();
		const { client, server } = await startClient([alpha, beta]);
		try {
			const a = await client.getPrompt({
				name: "alpha__summarize",
				arguments: { text: "hi" },
			});
			const b = await client.getPrompt({
				name: "beta__translate",
				arguments: { text: "hi" },
			});
			expect(JSON.stringify(a)).toContain("summarize");
			expect(JSON.stringify(b)).toContain("translate");
			expect(JSON.stringify(a)).not.toContain("translate");
		} finally {
			await closeAll([alpha, beta], client, server);
		}
	});
});

describe("failover ownership (007-A)", () => {
	const success = { content: [{ type: "text", text: "healthy key" }] };
	const budgetError = {
		content: [{ type: "text", text: "402 Budget exceeded" }],
		isError: true,
	};

	interface FailoverState {
		cursor: number;
		client?: Client;
		cooldowns: number[];
		spawnUpstream: (keyIndex: number) => Promise<void>;
		closeCurrent: () => Promise<void>;
	}

	function failoverHarness(
		failingCall: () => Promise<unknown>,
		patterns?: string[],
	) {
		const pool = new Pool("regression", {
			command: "unused",
			args: [],
			keys: [{ TEST_KEY: "exhausted" }, { TEST_KEY: "healthy" }],
			rateLimitPatterns: patterns ?? ["402|Budget|Invalid API key|quota"],
			cooldownSeconds: 300,
		});
		const state = pool as unknown as FailoverState;
		const spawned: number[] = [];
		const closed: number[] = [];
		const indices = new Map<Client, number>();
		state.spawnUpstream = async (keyIndex) => {
			spawned.push(keyIndex);
			state.cursor = keyIndex;
			state.client = {
				callTool: keyIndex === 0 ? failingCall : async () => success,
			} as unknown as Client;
			indices.set(state.client, keyIndex);
		};
		state.closeCurrent = async () => {
			if (state.client) closed.push(indices.get(state.client) as number);
			state.client = undefined;
		};
		return { pool, state, spawned, closed };
	}

	test("parallel budget errors never cool down an unused replacement key", async () => {
		const allEntered = Promise.withResolvers<void>();
		let entered = 0;
		const { pool, state, spawned, closed } = failoverHarness(async () => {
			if (++entered === 3) allEntered.resolve();
			await allEntered.promise;
			return budgetError;
		});
		await pool.start();
		const results = await Promise.all(
			Array.from({ length: 3 }, () => pool.routeCall("search", {})),
		);
		expect(results).toEqual([success, success, success]);
		expect(state.cooldowns[1]).toBe(0);
		expect(spawned).toEqual([0, 1]);
		expect(closed).toEqual([0]);
	});

	test("a late transport error cannot close the replacement client", async () => {
		const bothEntered = Promise.withResolvers<void>();
		const lateFailure = Promise.withResolvers<void>();
		let entered = 0;
		const { pool, spawned, closed } = failoverHarness(async () => {
			const call = ++entered;
			if (entered === 2) bothEntered.resolve();
			await bothEntered.promise;
			if (call === 1) return budgetError;
			await lateFailure.promise;
			throw new Error("old client disconnected after swap");
		});
		await pool.start();
		const first = pool.routeCall("search", {});
		const second = pool.routeCall("search", {});
		expect(await first).toEqual(success);
		lateFailure.resolve();
		expect(await second).toEqual(success);
		expect(spawned).toEqual([0, 1]);
		expect(closed).toEqual([0]);
	});

	test("known unflagged Context7 auth errors allow configured failover", async () => {
		const { pool, spawned } = failoverHarness(async () => ({
			content: [{ type: "text", text: "Invalid API key. Check your key." }],
		}));
		await pool.start();
		expect(await pool.routeCall("resolve-library-id", {})).toEqual(success);
		expect(spawned).toEqual([0, 1]);
	});

	test("documentation mentioning auth errors is returned without failover", async () => {
		const docs = {
			content: [
				{ type: "text", text: "Guide: handle Invalid API key and 402." },
			],
		};
		const { pool, spawned } = failoverHarness(async () => docs);
		await pool.start();
		expect(await pool.routeCall("query-docs", {})).toEqual(docs);
		expect(spawned).toEqual([0]);
	});

	test("unflagged Context7 monthly quota message switches to the next key", async () => {
		const { pool, spawned } = failoverHarness(async () => ({
			content: [
				{
					type: "text",
					text: "Monthly quota reached. Upgrade for more requests.",
				},
			],
		}));
		await pool.start();
		expect(await pool.routeCall("resolve-library-id", {})).toEqual(success);
		expect(spawned).toEqual([0, 1]);
	});

	test("unflagged SCRAPING FAILED auth message switches to the next key", async () => {
		const { pool, spawned } = failoverHarness(
			async () => ({
				content: [
					{
						type: "text",
						text: "SCRAPING FAILED (Detail: 'API token is wrong.').",
					},
				],
			}),
			["API token is wrong"],
		);
		await pool.start();
		expect(await pool.routeCall("scrape", {})).toEqual(success);
		expect(spawned).toEqual([0, 1]);
	});

	test("cooldown diagnostics distinguish quota-auth errors from rate limits", async () => {
		const { pool, state } = failoverHarness(async () => budgetError);
		await pool.start();
		state.cooldowns = [Date.now() + 300_000, Date.now() + 300_000];
		expect(JSON.stringify(await pool.routeCall("search", {}))).toContain(
			"quota",
		);
	});

	test("swap sections never overlap under concurrent failovers", async () => {
		const { pool } = failoverHarness(async () => budgetError);
		await pool.start();
		const st = pool as unknown as Record<
			string,
			(fn: () => unknown) => unknown
		>;
		const origSwap = st.withSwap.bind(pool);
		let active = 0;
		let maxActive = 0;
		st.withSwap = async (fn: () => unknown) => {
			const wrapped = async () => {
				active++;
				maxActive = Math.max(maxActive, active);
				try {
					return await fn();
				} finally {
					active--;
				}
			};
			return origSwap(wrapped);
		};
		await Promise.all(
			Array.from({ length: 6 }, () => pool.routeCall("search", {})),
		);
		expect(maxActive).toBe(1);
	});
});

describe("transient retries (007-B)", () => {
	const networkError = {
		content: [{ type: "text", text: "web_search_exa error: fetch failed" }],
		isError: true,
	};
	const success = { content: [{ type: "text", text: "search results" }] };
	const retry = {
		tools: ["web_search_exa"],
		errorPatterns: ["^web_search_exa error: fetch failed$"],
		delaysMs: [0, 0, 0],
	};

	interface TransientState {
		client?: Client;
		cooldowns: number[];
		spawnUpstream: (index: number) => Promise<void>;
		closeCurrent: () => Promise<void>;
	}

	function transientHarness(
		callTool: (request: unknown) => Promise<unknown>,
		transientRetry?: PoolConfig["transientRetry"],
	) {
		const pool = new Pool("transient", {
			command: "unused",
			args: [],
			keys: [{ KEY: "first" }, { KEY: "replacement" }],
			rateLimitPatterns: ["402"],
			transientRetry,
		});
		const state = pool as unknown as TransientState;
		const spawned: number[] = [];
		state.spawnUpstream = async (index) => {
			spawned.push(index);
			state.client = {
				callTool: index === 0 ? callTool : async () => success,
			} as unknown as Client;
		};
		state.closeCurrent = async () => {
			state.client = undefined;
		};
		return { pool, state, spawned };
	}

	test("transient errors recover on the same key with identical arguments", async () => {
		const calls: unknown[] = [];
		const { pool, state, spawned } = transientHarness(async (request) => {
			calls.push(request);
			return calls.length <= 3 ? networkError : success;
		}, retry);
		await pool.start();
		expect(await pool.routeCall("web_search_exa", { query: "docs" })).toEqual(
			success,
		);
		expect(calls).toEqual(
			Array(4).fill({ name: "web_search_exa", arguments: { query: "docs" } }),
		);
		expect(spawned).toEqual([0]);
		expect(state.cooldowns).toEqual([0, 0]);
	});

	test("retry exhaustion returns the original error without rotating keys", async () => {
		let calls = 0;
		const { pool, spawned } = transientHarness(async () => {
			calls++;
			return networkError;
		}, retry);
		await pool.start();
		expect(await pool.routeCall("web_search_exa", {})).toEqual(networkError);
		expect(calls).toBe(4);
		expect(spawned).toEqual([0]);
	});

	for (const [label, tool, policy, result] of [
		["disabled policy", "web_search_exa", undefined, networkError],
		["unlisted tool", "write", retry, networkError],
		[
			"different error",
			"web_search_exa",
			retry,
			{
				...networkError,
				content: [{ type: "text", text: "certificate expired" }],
			},
		],
		[
			"successful text mentioning errors",
			"web_search_exa",
			retry,
			{ ...networkError, isError: false },
		],
	] as Array<[string, string, PoolConfig["transientRetry"], unknown]>) {
		test(`${label} is not retried`, async () => {
			let calls = 0;
			const { pool } = transientHarness(async () => {
				calls++;
				return result;
			}, policy);
			await pool.start();
			expect(await pool.routeCall(tool, {})).toEqual(result);
			expect(calls).toBe(1);
		});
	}

	test("quota errors still switch keys even if retry patterns overlap", async () => {
		let calls = 0;
		const { pool, spawned } = transientHarness(
			async () => {
				calls++;
				return {
					...networkError,
					content: [{ type: "text", text: "402 Budget exceeded" }],
				};
			},
			{ ...retry, errorPatterns: [".*"] },
		);
		await pool.start();
		expect(await pool.routeCall("web_search_exa", {})).toEqual(success);
		expect(calls).toBe(1);
		expect(spawned).toEqual([0, 1]);
	});

	test("retry waiting does not block concurrent calls or use a replaced client", async () => {
		const entered = Promise.withResolvers<void>();
		let calls = 0;
		const { pool, spawned } = transientHarness(
			async () => {
				calls++;
				if (calls === 1) {
					entered.resolve();
					return networkError;
				}
				return { ...networkError, content: [{ type: "text", text: "402" }] };
			},
			{ ...retry, delaysMs: [30] },
		);
		await pool.start();
		const waiting = pool.routeCall("web_search_exa", {});
		await entered.promise;
		expect(await pool.routeCall("web_search_exa", {})).toEqual(success);
		expect(await waiting).toEqual(success);
		expect(calls).toBe(2);
		expect(spawned).toEqual([0, 1]);
	});
});

describe("perf quick-wins (F5)", () => {
	test("proxied tool call with verbose off emits no route log on stderr", async () => {
		const alpha = new Pool("alpha", poolConfig("alpha", {}));
		await alpha.start();
		const lines: string[] = [];
		const originalError = console.error;
		console.error = (...args: Parameters<typeof console.error>) => {
			lines.push(args.map((arg) => String(arg)).join(" "));
		};
		try {
			const { client, server } = await startClient([alpha]);
			try {
				const result = await client.callTool({
					name: "alpha__echo",
					arguments: { message: "hi" },
				});
				expect(JSON.stringify(result)).toContain("hi");
			} finally {
				await closeAll([alpha], client, server);
			}
		} finally {
			console.error = originalError;
		}
		expect(lines.some((line) => line.includes('"route"'))).toBe(false);
	});
});
