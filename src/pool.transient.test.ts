import { expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Pool } from "./pool.js";
import type { PoolConfig } from "./types.js";

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

function harness(
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
	const state = pool as unknown as {
		client?: Client;
		cooldowns: number[];
		spawnUpstream: (index: number) => Promise<void>;
		closeCurrent: () => Promise<void>;
	};
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
	const { pool, state, spawned } = harness(async (request) => {
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
	const { pool, spawned } = harness(async () => {
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
] satisfies Array<[string, string, PoolConfig["transientRetry"], unknown]>) {
	test(`${label} is not retried`, async () => {
		let calls = 0;
		const { pool } = harness(async () => {
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
	const { pool, spawned } = harness(
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
	const { pool, spawned } = harness(
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

test("real stdio upstream recovers after three transient error results", async () => {
	const pool = new Pool("stdio-transient", {
		command: "bun",
		args: ["run", "test/helper-server.ts"],
		keys: [
			{
				TEST_RATE_LIMIT_EVERY_N: "1",
				TEST_RATE_LIMIT_COUNT: "3",
				TEST_TOOL_ERROR_TEXT: networkError.content[0].text,
			},
		],
		rateLimitPatterns: ["402"],
		transientRetry: { ...retry, tools: ["echo"] },
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
