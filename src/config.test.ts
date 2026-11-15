import { describe, expect, test } from "bun:test";
import { unlinkSync, writeFileSync } from "node:fs";
import {
	ConfigError,
	ConfigFileSchema,
	loadConfig,
	PoolConfigSchema,
} from "./config.js";

function tmpYaml(content: string): string {
	const path = `/tmp/mcp-pool-test-${Math.random().toString(36).slice(2)}.yaml`;
	writeFileSync(path, content);
	return path;
}

describe("PoolConfigSchema", () => {
	test("missing rateLimitPatterns fails", () => {
		const result = PoolConfigSchema.safeParse({
			command: "npx",
			args: ["-y", "test-server"],
			keys: [{ API_KEY: "abc" }],
		});
		expect(result.success).toBe(false);
	});

	test("empty keys fails", () => {
		const result = PoolConfigSchema.safeParse({
			command: "npx",
			args: [],
			keys: [],
			rateLimitPatterns: ["rate_limit"],
		});
		expect(result.success).toBe(false);
	});

	test("invalid regex in rateLimitPatterns fails", () => {
		const result = PoolConfigSchema.safeParse({
			command: "npx",
			args: [],
			keys: [{ KEY: "val" }],
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
			expect(result.error.issues[0].message).toMatch(
				/strategy.*lazy failover/i,
			);
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
			expect(result.error.issues[0].message).toMatch(
				/maxConsecutiveErrors.*unsupported/i,
			);
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
		expect(result.data.rateLimitPatterns).toEqual([
			"rate_limit_exceeded",
			"too many requests",
		]);
		expect(result.data.cooldownSeconds).toBe(300);
	});

	test("transient retry requires tools, valid patterns and bounded delays", () => {
		const base = {
			command: "echo",
			args: [],
			keys: [{ KEY: "test" }],
			rateLimitPatterns: ["402"],
		};
		const policy = {
			tools: ["search"],
			errorPatterns: ["^fetch failed$"],
			delaysMs: [250, 750, 1500],
		};
		expect(
			PoolConfigSchema.parse({ ...base, transientRetry: policy })
				.transientRetry,
		).toEqual(policy);
		expect(PoolConfigSchema.parse(base).transientRetry).toBeUndefined();
		for (const invalid of [
			{ ...policy, tools: [] },
			{ ...policy, errorPatterns: [] },
			{ ...policy, errorPatterns: ["[invalid"] },
			{ ...policy, delaysMs: [] },
			{ ...policy, delaysMs: [-1] },
			{ ...policy, delaysMs: [0.5] },
			{ ...policy, delaysMs: [10001] },
			{ ...policy, delaysMs: [0, 0, 0, 0, 0, 0] },
		]) {
			expect(
				PoolConfigSchema.safeParse({ ...base, transientRetry: invalid })
					.success,
			).toBe(false);
		}
	});
	test("accepts http and sse transports with url and headers", () => {
		const httpResult = PoolConfigSchema.safeParse({
			transport: "http",
			url: "https://api.scrapingant.com/mcp",
			headers: { "X-Client": "mcp-pool" },
			keys: [{ "x-api-key": "key-one" }],
			rateLimitPatterns: ["401|429"],
		});
		expect(httpResult.success).toBe(true);
		if (httpResult.success) {
			expect(httpResult.data.transport).toBe("http");
			expect(httpResult.data.url).toBe("https://api.scrapingant.com/mcp");
		}

		const sseResult = PoolConfigSchema.safeParse({
			transport: "sse",
			url: "https://example.com/sse",
			keys: [{ Authorization: "Bearer token" }],
			rateLimitPatterns: ["401|429"],
		});
		expect(sseResult.success).toBe(true);
	});

	test("validates transport-specific fields", () => {
		expect(
			PoolConfigSchema.safeParse({
				transport: "http",
				keys: [{ "x-api-key": "k" }],
				rateLimitPatterns: ["429"],
			}).success,
		).toBe(false);

		expect(
			PoolConfigSchema.safeParse({
				transport: "http",
				url: "https://example.com/mcp",
				command: "echo",
				keys: [{ "x-api-key": "k" }],
				rateLimitPatterns: ["429"],
			}).success,
		).toBe(false);

		expect(
			PoolConfigSchema.safeParse({
				command: "echo",
				url: "https://example.com/mcp",
				keys: [{ KEY: "k" }],
				rateLimitPatterns: ["429"],
			}).success,
		).toBe(false);

		const stdioWithEnv = PoolConfigSchema.safeParse({
			command: "webscraping-ai-mcp",
			env: { WEBSCRAPING_AI_ENABLE_CONTENT_SANDBOXING: "true" },
			keys: [{ WEBSCRAPING_AI_API_KEY: "k" }],
			rateLimitPatterns: ["403|429"],
		});
		expect(stdioWithEnv.success).toBe(true);
		if (stdioWithEnv.success) {
			expect(stdioWithEnv.data.args).toEqual([]);
			expect(stdioWithEnv.data.env).toEqual({
				WEBSCRAPING_AI_ENABLE_CONTENT_SANDBOXING: "true",
			});
		}
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
		expect(() => loadConfig("/tmp/nonexistent-pool-config.yaml")).toThrow(
			ConfigError,
		);
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

	test("expands environment references in values", () => {
		process.env._TEST_POOL_KEY = "expanded-secret";
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
		delete process.env._TEST_POOL_KEY;
		unlinkSync(path);
	});
});
