import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Pool } from "./pool.js";
import { buildServer } from "./server.js";
import type { PoolConfig } from "./types.js";

function poolConfig(
	poolName: string,
	prompts: unknown,
	extraEnv: Record<string, string> = {},
): PoolConfig {
	return {
		command: "bun",
		args: ["run", "test/helper-server.ts"],
		keys: [
			{
				KEY: poolName,
				TEST_PROMPTS_JSON: JSON.stringify(prompts),
				...extraEnv,
			},
		],
		rateLimitPatterns: ["rate_limit_exceeded"],
	};
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

describe("prompts passthrough", () => {
	test("prompts/list shows pool__ names from two pools", async () => {
		const alpha = new Pool("alpha", poolConfig("alpha", SUMMARIZE));
		const beta = new Pool("beta", poolConfig("beta", TRANSLATE));
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
			const summary = result.prompts.find(
				(p) => p.name === "alpha__summarize",
			);
			expect(summary?.description).toContain("[alpha]");
		} finally {
			await closeAll([alpha, beta], client, server);
		}
	});

	test("prompts/get routes by prefix", async () => {
		const alpha = new Pool("alpha", poolConfig("alpha", SUMMARIZE));
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
		const alpha = new Pool("alpha", poolConfig("alpha", SUMMARIZE));
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
		const alpha = new Pool("alpha", poolConfig("alpha", SUMMARIZE));
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
		const alpha = new Pool("alpha", poolConfig("alpha", SUMMARIZE));
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
			poolConfig("plain", SUMMARIZE, { TEST_NO_PROMPTS: "1" }),
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
