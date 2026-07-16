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

  test("tolerates one upstream crashing during startup", async () => {
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

  test("fails when all upstreams crash during startup", async () => {
    const pool = new Pool(
      "test",
      poolConfig({
        keys: [
          { KEY: "a", TEST_CRASH_ON_START: "1" },
          { KEY: "b", TEST_CRASH_ON_START: "1" },
        ],
      }),
    );
    await expect(pool.start()).rejects.toThrow(/all upstreams failed/i);
  });

  test("fails on tool mismatch between upstreams", async () => {
    const pool = new Pool(
      "test",
      poolConfig({
        keys: [
          { KEY: "a" },
          {
            KEY: "b",
            TEST_TOOLS_JSON: JSON.stringify([
              { name: "different-tool", inputSchema: { type: "object" as const } },
            ]),
          },
        ],
      }),
    );
    await expect(pool.start()).rejects.toThrow(/tools mismatch/i);
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
    // key "a" rate-limits every 2nd call (1st, 3rd, 5th… succeed)
    // key "b" always succeeds
    const pool = new Pool(
      "test",
      poolConfig({
        keys: [
          { KEY: "a", TEST_RATE_LIMIT_EVERY_N: "2" },
          { KEY: "b" },
        ],
        cooldownSeconds: 60,
      }),
      100,
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
        cooldownSeconds: 999,
      }),
      100,
    );
    await pool.start();

    const result = await pool.routeCall("echo", {});
    assertCallResult(result);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/rate-limited|exhausted/i);
    await pool.close();
  });

  test("cooldown expiry re-activates rate-limited upstream", async () => {
    // Helper: 1 rate-limited response max, then success.
    // After cooldown, the single upstream re-enters rotation.
    const pool = new Pool(
      "test",
      poolConfig({
        keys: [{ KEY: "a", TEST_RATE_LIMIT_EVERY_N: "1", TEST_RATE_LIMIT_COUNT: "1" }],
        cooldownSeconds: 1,
      }),
      100, // poll cooldowns every 100ms
    );
    await pool.start();

    // First call hits rate limit — upstream becomes rate_limited
    const first = await pool.routeCall("echo", {});
    assertCallResult(first);
    expect(first.isError).toBe(true);

    // Wait for cooldown (cooldownSeconds=1) + poll tolerance
    // Exception: integration test exercising real platform timer behavior
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 1500);
    await promise;

    // After cooldown, upstream is available; second call should succeed
    const second = await pool.routeCall("echo", { msg: "after-cooldown" });
    assertCallResult(second);
    expect(second.isError).toBeUndefined();
    expect(JSON.parse(second.content[0].text)).toEqual({ msg: "after-cooldown" });
    await pool.close();
  });
});
