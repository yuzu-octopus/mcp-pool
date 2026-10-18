import { expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Pool } from "./pool.js";

const success = { content: [{ type: "text", text: "healthy key" }] };
const budgetError = {
	content: [{ type: "text", text: "402 Budget exceeded" }],
	isError: true,
};

interface PoolState {
	cursor: number;
	client?: Client;
	cooldowns: number[];
	spawnUpstream: (keyIndex: number) => Promise<void>;
	closeCurrent: () => Promise<void>;
}

function harness(failingCall: () => Promise<unknown>) {
	const pool = new Pool("regression", {
		command: "unused",
		args: [],
		keys: [{ TEST_KEY: "exhausted" }, { TEST_KEY: "healthy" }],
		rateLimitPatterns: ["402|Budget|Invalid API key|quota"],
		cooldownSeconds: 300,
	});
	// Stub only subprocess I/O; routeCall and its swap mutex remain real.
	const state = pool as unknown as PoolState;
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

test("sequential budget error falls back to the healthy key", async () => {
	const { pool, spawned } = harness(async () => budgetError);
	await pool.start();
	expect(await pool.routeCall("search", {})).toEqual(success);
	expect(spawned).toEqual([0, 1]);
});

test("parallel budget errors never cool down an unused replacement key", async () => {
	const allEntered = Promise.withResolvers<void>();
	let entered = 0;
	const { pool, state, spawned, closed } = harness(async () => {
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
	const { pool, spawned, closed } = harness(async () => {
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

test("cooldown diagnostics distinguish quota/auth errors from rate limits", async () => {
	const { pool, state } = harness(async () => budgetError);
	await pool.start();
	state.cooldowns = [Date.now() + 300_000, Date.now() + 300_000];
	expect(JSON.stringify(await pool.routeCall("search", {}))).toContain("quota");
});

test("known unflagged Context7 auth errors allow configured failover", async () => {
	const { pool, spawned } = harness(async () => ({
		content: [{ type: "text", text: "Invalid API key. Check your key." }],
	}));
	await pool.start();
	expect(await pool.routeCall("resolve-library-id", {})).toEqual(success);
	expect(spawned).toEqual([0, 1]);
});

test("documentation mentioning auth errors is returned without failover", async () => {
	const docs = {
		content: [{ type: "text", text: "Guide: handle Invalid API key and 402." }],
	};
	const { pool, spawned } = harness(async () => docs);
	await pool.start();
	expect(await pool.routeCall("query-docs", {})).toEqual(docs);
	expect(spawned).toEqual([0]);
});

test("unflagged Context7 monthly quota message switches to the next key", async () => {
	const { pool, spawned } = harness(async () => ({
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
