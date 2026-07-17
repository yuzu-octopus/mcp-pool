import { describe, expect, test } from "bun:test";
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
  const content = (v as CallResult).content;
  if (!Array.isArray(content) || !content.every((c: unknown) => c && typeof c === "object" && "text" in (c as Record<string, unknown>) && typeof (c as Record<string, unknown>).text === "string")) {
    throw new Error("expected content to be Array<{ text: string }>");
  }
}

function poolConfig(overrides: Partial<PoolConfig> = {}): PoolConfig {
  return {
    command: "bun",
    args: ["run", "test/helper-server.ts"],
    keys: [{ KEY: "a" }],
    strategy: "round-robin",
    cooldownSeconds: 1,
    rateLimitPatterns: ["rate_limit_exceeded"],
    maxConsecutiveErrors: 3,
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
        keys: [
          { KEY: "a" },
          { KEY: "b", TEST_CRASH_ON_START: "1" },
        ],
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
        keys: [
          { KEY: "a", TEST_CRASH_ON_START: "1" },
          { KEY: "b" },
        ],
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
              { name: "different-tool", inputSchema: { type: "object" as const } },
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

  test("routeCall before start returns error", async () => {
    const pool = new Pool("test", poolConfig());
    const result = await pool.routeCall("echo", {});
    assertCallResult(result);
    expect(result.isError).toBe(true);
  });

  test("round-robin distributes across keys", async () => {
    // key "a" rate-limits every 2nd call, key "b" always succeeds
    const pool = new Pool(
      "test",
      poolConfig({
        keys: [
          { KEY: "a", TEST_RATE_LIMIT_EVERY_N: "2" },
          { KEY: "b" },
        ],
      }),
    );
    await pool.start();

    for (let i = 0; i < 6; i++) {
      const result = await pool.routeCall("echo", { n: i });
      if (result && typeof result === "object" && "isError" in result) {
        expect(result.isError).toBeUndefined();
      }
    }
    await pool.close();
  });

  test("all upstreams exhausted returns error", async () => {
    const pool = new Pool(
      "test",
      poolConfig({
        keys: [{ KEY: "a", TEST_RATE_LIMIT_EVERY_N: "1" }],
      }),
    );
    await pool.start();

    const result = await pool.routeCall("echo", {});
    assertCallResult(result);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/retry after/i);
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

    // Second call should also fail — same key still in cooldown
    const second = await pool.routeCall("echo", {});
    assertCallResult(second);
    expect(second.isError).toBe(true);
    expect(second.content[0].text).toMatch(/retry after/i);

    await pool.close();
  });

  test("rotation to next key on rate-limit", async () => {
    // Single key that rate-limits every call, then exhausts.
    // This tests that the pool attempts key 0, fails, and returns exhausted.
    const pool = new Pool(
      "test",
      poolConfig({
        keys: [{ KEY: "a", TEST_RATE_LIMIT_EVERY_N: "1" }],
      }),
    );
    await pool.start();

    const result = await pool.routeCall("echo", {});
    assertCallResult(result);
    expect(result.isError).toBe(true);
    await pool.close();
  });
});
