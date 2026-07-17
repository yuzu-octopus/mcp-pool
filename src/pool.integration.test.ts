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
  if (
    !Array.isArray((v as CallResult).content) ||
    !(v as CallResult).content.every(
      (c: unknown) => c && typeof c === "object" && "text" in (c as Record<string, unknown>) && typeof (c as Record<string, unknown>).text === "string",
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
    const pool = new Pool("test", poolConfig({ keys: [{ KEY: "a" }, { KEY: "b" }] }));
    await pool.start();
    expect(pool.getTools().length).toBeGreaterThan(0);
    await pool.close();
  });

  test("tolerates later key crashing during startup", async () => {
    const pool = new Pool(
      "test",
      poolConfig({ keys: [{ KEY: "a" }, { KEY: "b", TEST_CRASH_ON_START: "1" }] }),
    );
    await pool.start();
    expect(pool.getTools().length).toBeGreaterThan(0);
    await pool.close();
  });

  test("recovers when first key crashes during startup", async () => {
    const pool = new Pool(
      "test",
      poolConfig({ keys: [{ KEY: "a", TEST_CRASH_ON_START: "1" }, { KEY: "b" }] }),
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
  test("never logs raw tool arguments", async () => {
    const pool = new Pool("test", poolConfig());
    const original = console.error;
    const lines: string[] = [];
    console.error = (...values: unknown[]) => lines.push(values.join(" "));

    try {
      await pool.start();
      await pool.routeCall("echo", { credential: "sensitive-test-value" }, true);
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
      poolConfig({ keys: [{ KEY: "a", TEST_RATE_LIMIT_EVERY_N: "1" }], cooldownSeconds: 60 }),
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
