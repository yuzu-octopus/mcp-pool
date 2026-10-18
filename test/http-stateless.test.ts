import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("missing port");
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return address.port;
}

test("stateless HTTP supports repeated and concurrent MCP clients", async () => {
	const directory = mkdtempSync(join(tmpdir(), "mcp-pool-http-"));
	const config = join(directory, "config.yaml");
	writeFileSync(
		config,
		`pools:
  shared:
    command: bun
    args: ["run", "test/helper-server.ts"]
    keys: [{KEY: "test"}]
    rateLimitPatterns: ["rate_limit_exceeded"]
`,
	);
	const port = await freePort();
	const base = `http://127.0.0.1:${port}`;
	const child = spawn(
		"bun",
		[
			"run",
			"src/index.ts",
			"--http",
			"--port",
			String(port),
			"--config",
			config,
		],
		{ stdio: "ignore" },
	);
	const exited = new Promise<void>((resolve) =>
		child.once("exit", () => resolve()),
	);
	const clients: Client[] = [];
	try {
		let ready = false;
		for (let i = 0; i < 100; i++) {
			try {
				ready = (await fetch(`${base}/health`)).ok;
			} catch {}
			if (ready) break;
			await Bun.sleep(50);
		}
		expect(ready).toBe(true);
		for (let i = 0; i < 2; i++) {
			const client = new Client({ name: `http-test-${i}`, version: "1" });
			clients.push(client);
			await client.connect(
				new StreamableHTTPClientTransport(new URL(`${base}/mcp`)),
			);
			expect((await client.listTools()).tools[0]?.name).toBe("shared__echo");
		}
		const results = await Promise.all(
			clients.flatMap((client, i) =>
				[0, 1, 2].map((n) =>
					client.callTool({
						name: "shared__echo",
						arguments: { message: `${i}:${n}` },
					}),
				),
			),
		);
		expect(results.every((result) => !result.isError)).toBe(true);
		for (let i = 0; i < results.length; i++) {
			expect(JSON.stringify(results[i])).toContain(
				`${Math.floor(i / 3)}:${i % 3}`,
			);
		}
		expect((await fetch(`${base}/mcp`)).status).toBe(405);
	} finally {
		await Promise.allSettled(clients.map((client) => client.close()));
		child.kill("SIGTERM");
		await exited;
		rmSync(directory, { recursive: true, force: true });
	}
}, 20_000);
