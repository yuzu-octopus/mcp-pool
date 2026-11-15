import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { runtimePaths } from "./ipc.js";

process.env.MCP_POOL_NO_MAIN = "1";
// Dynamic import after env guard skips CLI main.
const { pipedBodyWithFinish, redactSecrets } = await import("./index.js");

test("redactSecrets hides keys and tokens", () => {
	const key = "sk-" + "test1234567890abcdef";
	const msg = "failed with " + key + " and Bearer abcdef12345 and api-key = secret123";
	const out = redactSecrets(msg);
	expect(out).not.toContain(key);
	expect(out).not.toContain("abcdef12345");
	expect(out).not.toContain("secret123");
	expect(out).toContain("[redacted]");
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
	writeFileSync(configFile, ["pools:", "  shared:", "    command: bun", "    args: [\"run\", \"test/helper-server.ts\"]", "    keys:", "      - { TEST_LIFECYCLE_FILE: \"" + lifecycle + "\" }", "    rateLimitPatterns: [\"rate_limit_exceeded\"]"].join("\n"));
	const paths = runtimePaths(configFile);
	mkdirSync(paths.dir, { recursive: true });
	let serverSock = null;
	const server = createServer((sock) => {
		serverSock = sock;
		sock.on("error", () => {});
	});
	await new Promise((resolve, reject) => {
		server.once("listening", resolve);
		server.once("error", reject);
		server.listen(paths.socket);
	});
	const child = spawn("bun", ["run", "src/index.ts", "--config", configFile], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, MCP_POOL_NO_MAIN: "0" } });
	try {
		const connected = await new Promise((resolve) => {
			const timer = setTimeout(() => resolve(false), 10000);
			server.once("connection", () => {
				clearTimeout(timer);
				resolve(true);
			});
		});
		expect(connected).toBe(true);
		if (serverSock) {
			serverSock.destroy();
		}
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
		} catch {
		}
		try {
			server.close();
		} catch {
		}
		rmSync(directory, { recursive: true, force: true });
	}
}, 30000);
