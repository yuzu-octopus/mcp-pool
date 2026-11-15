import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimePaths } from "./ipc.js";

// Guard is evaluated once at import; scrub immediately so spawned CLI
// children in this or later test files run main() normally.
process.env.MCP_POOL_NO_MAIN = "1";
// Dynamic import after env guard skips CLI main.
const { pipedBodyWithFinish } = await import("./index.js");
const { collectSecrets, redactSecrets } = await import("./redact.js");
delete process.env.MCP_POOL_NO_MAIN;

test("redactSecrets hides exact configured values", () => {
	const secrets = collectSecrets({
		keys: [
			{ Authorization: "Bearer tvly-testkey-123" },
			{ "x-api-key": "exa-testkey-456" },
		],
		rateLimitPatterns: ["429"],
	});
	expect(secrets).toContain("Bearer tvly-testkey-123");
	const msg = "failed with Bearer tvly-testkey-123 and exa-testkey-456 inside";
	const out = redactSecrets(msg, secrets);
	expect(out).not.toContain("tvly-testkey-123");
	expect(out).not.toContain("exa-testkey-456");
	expect(out).toContain("[redacted]");
	expect(redactSecrets("plain prose, nothing secret", secrets)).toBe(
		"plain prose, nothing secret",
	);
});

test("pipedBodyWithFinish finishes on success", async () => {
	let done = false;
	const src = new ReadableStream({
		start(c) {
			c.enqueue(new TextEncoder().encode("hello"));
			c.close();
		},
	});
	const out = pipedBodyWithFinish(src, () => {
		done = true;
	});
	const text = await new Response(out).text();
	expect(text).toBe("hello");
	await new Promise((r) => setTimeout(r, 10));
	expect(done).toBe(true);
});

test("pipedBodyWithFinish finishes on mid-stream error", async () => {
	let done = false;
	const src = new ReadableStream({
		start(c) {
			c.enqueue(new TextEncoder().encode("part"));
			c.error(new Error("boom"));
		},
	});
	const out = pipedBodyWithFinish(src, () => {
		done = true;
	});
	await expect(new Response(out).text()).rejects.toThrow();
	await new Promise((r) => setTimeout(r, 10));
	expect(done).toBe(true);
});

test("pipedBodyWithFinish finishes on cancel", async () => {
	let done = false;
	const src = new ReadableStream({
		start(c) {
			c.enqueue(new TextEncoder().encode("x"));
		},
	});
	const out = pipedBodyWithFinish(src, () => {
		done = true;
	});
	await out.cancel();
	await new Promise((r) => setTimeout(r, 10));
	expect(done).toBe(true);
});

// Spawned proxy needs wall clock for socket exit.
test("proxy exits non-zero when the daemon drops first", async () => {
	const directory = mkdtempSync(join(tmpdir(), "mcp-pool-proxy-"));
	const configFile = join(directory, "config.yaml");
	const lifecycle = join(directory, "lifecycle");
	writeFileSync(
		configFile,
		[
			"pools:",
			"  shared:",
			"    command: bun",
			'    args: ["run", "test/helper-server.ts"]',
			"    keys:",
			`      - { TEST_LIFECYCLE_FILE: "${lifecycle}" }`,
			'    rateLimitPatterns: ["rate_limit_exceeded"]',
		].join("\n"),
	);
	const paths = runtimePaths(configFile);
	mkdirSync(paths.dir, { recursive: true });
	let serverSock: { destroy(): void } | null = null;
	const server = createServer((sock) => {
		serverSock = sock;
		sock.on("error", () => {});
	});
	await new Promise((resolve, reject) => {
		server.once("listening", resolve);
		server.once("error", reject);
		server.listen(paths.socket);
	});
	const child = spawn("bun", ["run", "src/index.ts", "--config", configFile], {
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, MCP_POOL_NO_MAIN: "0" },
	});
	try {
		const connected = await new Promise((resolve) => {
			const timer = setTimeout(() => resolve(false), 10000);
			server.once("connection", () => {
				clearTimeout(timer);
				resolve(true);
			});
		});
		expect(connected).toBe(true);
		(serverSock as unknown as { destroy(): void } | null)?.destroy();
		server.close();
		const code = await new Promise((resolve) => {
			const timer = setTimeout(() => resolve("timeout"), 8000);
			child.once("exit", (c) => {
				clearTimeout(timer);
				resolve(c);
			});
		});
		expect(code).not.toBe("timeout");
		expect(typeof code === "number" && code !== 0).toBe(true);
	} finally {
		try {
			child.kill();
		} catch {}
		try {
			server.close();
		} catch {}
		rmSync(directory, { recursive: true, force: true });
	}
}, 30000);
