import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { writeFileSync, unlinkSync } from "node:fs";
import { PoolConfigSchema, ConfigFileSchema, loadConfig, ConfigError } from "./config.js";

function tmpYaml(content: string): string {
  const path = "/tmp/mcp-pool-test-" + Math.random().toString(36).slice(2) + ".yaml";
  writeFileSync(path, content);
  return path;
}

describe("PoolConfigSchema", () => {
  test("missing rateLimitPatterns fails", () => {
    const result = PoolConfigSchema.safeParse({
      command: "npx",
      args: ["-y", "test-server"],
      keys: [{ API_KEY: "abc" }],
      strategy: "round-robin",
    });
    expect(result.success).toBe(false);
  });

  test("empty keys fails", () => {
    const result = PoolConfigSchema.safeParse({
      command: "npx",
      args: [],
      keys: [],
      strategy: "round-robin",
      rateLimitPatterns: ["rate_limit"],
    });
    expect(result.success).toBe(false);
  });

  test("invalid regex in rateLimitPatterns fails", () => {
    const result = PoolConfigSchema.safeParse({
      command: "npx",
      args: [],
      keys: [{ KEY: "val" }],
      strategy: "round-robin",
      rateLimitPatterns: ["[invalid"],
    });
    expect(result.success).toBe(false);
  });

  test("rejects removed strategy field", () => {
    const result = PoolConfigSchema.safeParse({
      command: "echo",
      args: [],
      keys: [{ API_KEY: "value" }],
      strategy: "round-robin",
      rateLimitPatterns: ["rate_limit"],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(/strategy.*lazy failover/i);
    }
  });

  test("rejects removed maxConsecutiveErrors field", () => {
    const result = PoolConfigSchema.safeParse({
      command: "echo",
      args: [],
      keys: [{ API_KEY: "value" }],
      maxConsecutiveErrors: 3,
      rateLimitPatterns: ["rate_limit"],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(/maxConsecutiveErrors.*unsupported/i);
    }
  });

  test("defaults cooldownSeconds to 300", () => {
    const result = PoolConfigSchema.parse({
      command: "echo",
      args: [],
      keys: [{ API_KEY: "value" }],
      rateLimitPatterns: ["rate_limit"],
    });
    expect(result.cooldownSeconds).toBe(300);
  });

  test("valid config parses correctly", () => {
    const result = PoolConfigSchema.safeParse({
      command: "npx",
      args: ["-y", "@anthropic/mcp-server-brave-search"],
      keys: [{ BRAVE_API_KEY: "key-one" }, { BRAVE_API_KEY: "key-two" }],
      rateLimitPatterns: ["rate_limit_exceeded", "too many requests"],
      cooldownSeconds: "300",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.command).toBe("npx");
    expect(result.data.keys).toHaveLength(2);
    expect(result.data.rateLimitPatterns).toEqual(["rate_limit_exceeded", "too many requests"]);
    expect(result.data.cooldownSeconds).toBe(300);
  });
});

describe("ConfigFileSchema", () => {
  test("valid config file with multiple pools", () => {
    const result = ConfigFileSchema.safeParse({
      pools: {
        "brave-search": {
          command: "npx",
          args: [],
          keys: [{ KEY: "a" }, { KEY: "b" }],
          rateLimitPatterns: ["rate_limit"],
        },
        "exa-search": {
          command: "npx",
          args: [],
          keys: [{ KEY: "c" }],
          rateLimitPatterns: ["exceeded"],
          cooldownSeconds: 600,
        },
      },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(Object.keys(result.data.pools)).toHaveLength(2);
  });
});

describe("loadConfig (YAML loading)", () => {
  test("loads valid YAML file", () => {
    const path = tmpYaml(`
pools:
  test:
    command: echo
    args: []
    keys: [{KEY: "val"}]
    rateLimitPatterns: ["rate_limit"]
`);
    const result = loadConfig(path);
    expect(result.config.pools.test).toBeDefined();
    expect(result.config.pools.test.command).toBe("echo");
    unlinkSync(path);
  });

  test("throws on invalid YAML", () => {
    const path = tmpYaml(`pools:\n  test: [unclosed`);
    expect(() => loadConfig(path)).toThrow(ConfigError);
    unlinkSync(path);
  });

  test("throws on missing file", () => {
    expect(() => loadConfig("/tmp/nonexistent-pool-config.yaml")).toThrow(ConfigError);
  });

  test("throws on validation failure", () => {
    const path = tmpYaml(`
pools:
  test:
    command: echo
    args: []
    keys: []
    rateLimitPatterns: ["rate_limit"]
`);
    expect(() => loadConfig(path)).toThrow(ConfigError);
    unlinkSync(path);
  });

  test("throws when an environment reference is unset", () => {
    const path = tmpYaml(`
pools:
  test:
    command: echo
    args: []
    keys: [{API_KEY: "\${MCP_POOL_MISSING_TEST_KEY}"}]
    rateLimitPatterns: ["rate_limit"]
`);
    expect(() => loadConfig(path)).toThrow(/MCP_POOL_MISSING_TEST_KEY/);
    unlinkSync(path);
  });

  test("expands ${VAR} in values", () => {
    process.env["_TEST_POOL_KEY"] = "expanded-secret";
    const path = tmpYaml(`
pools:
  test:
    command: echo
    args: []
    keys: [{API_KEY: "\${_TEST_POOL_KEY}"}]
    rateLimitPatterns: ["rate_limit"]
`);
    const result = loadConfig(path);
    expect(result.config.pools.test.keys[0].API_KEY).toBe("expanded-secret");
    delete process.env["_TEST_POOL_KEY"];
    unlinkSync(path);
  });
});
