import { expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replyJsonError } from "../src/http-error.js";

const ROOT = join(import.meta.dir, "..");
const HOST = "127.0.0.1";
const HEALTH_TIMEOUT_MS = 15_000;
const TEST_TIMEOUT_MS = 30_000;

function toolsJson(name: string): string {
	return JSON.stringify([
		{
			name,
			inputSchema: {
				type: "object",
				properties: { marker: { type: "string" } },
				required: ["marker"],
			},
		},
	]);
}

// This cross-process integration test polls for the child server's /health
// endpoint; a fixed sleep cannot signal readiness, so poll with a deadline.
async function waitForHealth(port: number): Promise<boolean> {
	const deadline = Date.now() + HEALTH_TIMEOUT_MS;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`http://${HOST}:${port}/health`);
			if (res.status === 200) {
				await res.text().catch(() => {});
				return true;
			}
		} catch {
			// Not listening yet.
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return false;
}

async function stopChild(child: ChildProcess): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	child.once("exit", () => resolve());
	child.kill("SIGTERM");
	setTimeout(() => {
		child.kill("SIGKILL");
		resolve();
	}, 3_000).unref?.();
	await promise;
}

interface RpcResponse {
	id: number;
	result?: {
		tools?: Array<{ name: string }>;
		content?: Array<{ type: string; text: string }>;
	};
}

function parseSseRpc(text: string): RpcResponse {
	try {
		return JSON.parse(text) as RpcResponse;
	} catch {
		// Fall through to SSE parsing.
	}
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("data:")) continue;
		try {
			return JSON.parse(trimmed.slice("data:".length).trim()) as RpcResponse;
		} catch {
			// Keep scanning data lines.
		}
	}
	throw new Error(
		`no JSON-RPC payload in response body: ${text.slice(0, 200)}`,
	);
}

async function postMcp(
	port: number,
	body: Record<string, unknown>,
): Promise<{ status: number; rpc: RpcResponse }> {
	const res = await fetch(`http://${HOST}:${port}/mcp`, {
		method: "POST",
		headers: {
			Accept: "application/json, text/event-stream",
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});
	const text = await res.text();
	return { status: res.status, rpc: parseSseRpc(text) };
}

// Runs the 8-POST assertion against both server paths: Bun.serve (default)
// and node:http (MCP_POOL_HTTP_NODE=1 escape). Both must behave identically.
for (const mode of ["bun", "node"] as const) {
	test(
		`concurrent --http clients each get their own response (${mode})`,
		async () => {
			const directory = mkdtempSync(join(tmpdir(), `mcp-pool-http-${mode}-`));
			const configFile = join(directory, "config.yaml");
			let child: ChildProcess | undefined;

			writeFileSync(
				configFile,
				`pools:
  alpha:
    command: bun
    args: ["run", "test/helper-server.ts"]
    keys:
      - { TEST_TOOLS_JSON: '${toolsJson("alpha_tool")}' }
    rateLimitPatterns: ["rate_limit_exceeded"]
  beta:
    command: bun
    args: ["run", "test/helper-server.ts"]
    keys:
      - { TEST_TOOLS_JSON: '${toolsJson("beta_tool")}' }
    rateLimitPatterns: ["rate_limit_exceeded"]
`,
			);

			try {
				const basePort =
					18000 + (process.pid % 1000) + (mode === "node" ? 10 : 0);
				let port = -1;
				for (const candidate of [basePort, basePort + 1]) {
					child = spawn(
						"bun",
						[
							"run",
							"src/index.ts",
							"--http",
							"--port",
							String(candidate),
							"--config",
							configFile,
						],
						{
							cwd: ROOT,
							stdio: ["ignore", "pipe", "pipe"],
							env: {
								...process.env,
								...(mode === "node" ? { MCP_POOL_HTTP_NODE: "1" } : {}),
							},
						},
					);
					child.stderr?.resume();
					if (await waitForHealth(candidate)) {
						port = candidate;
						break;
					}
					await stopChild(child);
					child = undefined;
				}
				expect(port).not.toBe(-1);

				const requests: Array<{
					body: Record<string, unknown>;
					check: (rpc: RpcResponse) => void;
				}> = [];
				for (let i = 0; i < 4; i++) {
					const id = 101 + i;
					requests.push({
						body: { jsonrpc: "2.0", id, method: "tools/list", params: {} },
						check: (rpc) => {
							expect(rpc.id).toBe(id);
							const names = (rpc.result?.tools ?? []).map((t) => t.name);
							expect(names).toContain("alpha__alpha_tool");
							expect(names).toContain("beta__beta_tool");
						},
					});
				}
				for (const [index, pool, tool] of [
					[0, "alpha", "alpha_tool"],
					[1, "alpha", "alpha_tool"],
					[0, "beta", "beta_tool"],
					[1, "beta", "beta_tool"],
				] as Array<[number, string, string]>) {
					const id = pool === "alpha" ? 201 + index : 301 + index;
					const marker = `${pool}-marker-${index}`;
					requests.push({
						body: {
							jsonrpc: "2.0",
							id,
							method: "tools/call",
							params: {
								name: `${pool}__${tool}`,
								arguments: { marker },
							},
						},
						check: (rpc) => {
							expect(rpc.id).toBe(id);
							const text = rpc.result?.content?.[0]?.text ?? "";
							expect(JSON.parse(text)).toEqual({ marker });
						},
					});
				}

				const results = await Promise.all(
					requests.map(async (r) => ({
						expected: r.body,
						check: r.check,
						actual: await postMcp(port, r.body),
					})),
				);
				expect(results).toHaveLength(8);
				for (const { check, actual } of results) {
					expect(actual.status).toBe(200);
					check(actual.rpc);
				}
			} finally {
				if (child) await stopChild(child);
				rmSync(directory, { recursive: true, force: true });
			}
		},
		TEST_TIMEOUT_MS,
	);
}

// Large payloads must round-trip intact through the streaming /mcp path:
// runBunHttp hands the upstream body to the response without buffering it,
// so a multi-MB tool result exercises delivery-after-handoff plus the
// close-after-handoff hook. Same assertion on node:http for parity.
for (const mode of ["bun", "node"] as const) {
	test(
		`large tool result round-trips intact (${mode})`,
		async () => {
			const directory = mkdtempSync(
				join(tmpdir(), `mcp-pool-http-big-${mode}-`),
			);
			const configFile = join(directory, "config.yaml");
			let child: ChildProcess | undefined;

			writeFileSync(
				configFile,
				`pools:
  alpha:
    command: bun
    args: ["run", "test/helper-server.ts"]
    keys:
      - { TEST_TOOLS_JSON: '${toolsJson("alpha_tool")}' }
    rateLimitPatterns: ["rate_limit_exceeded"]
`,
			);

			try {
				const basePort =
					18200 + (process.pid % 1000) + (mode === "node" ? 10 : 0);
				let port = -1;
				for (const candidate of [basePort, basePort + 1]) {
					child = spawn(
						"bun",
						[
							"run",
							"src/index.ts",
							"--http",
							"--port",
							String(candidate),
							"--config",
							configFile,
						],
						{
							cwd: ROOT,
							stdio: ["ignore", "pipe", "pipe"],
							env: {
								...process.env,
								...(mode === "node" ? { MCP_POOL_HTTP_NODE: "1" } : {}),
							},
						},
					);
					child.stderr?.resume();
					if (await waitForHealth(candidate)) {
						port = candidate;
						break;
					}
					await stopChild(child);
					child = undefined;
				}
				expect(port).not.toBe(-1);

				const blob = `blob-${"x".repeat(2 * 1024 * 1024)}`;
				const { status, rpc } = await postMcp(port, {
					jsonrpc: "2.0",
					id: 999,
					method: "tools/call",
					params: {
						name: "alpha__alpha_tool",
						arguments: { marker: "big", blob },
					},
				});
				expect(status).toBe(200);
				expect(rpc.id).toBe(999);
				const text = rpc.result?.content?.[0]?.text ?? "";
				expect(JSON.parse(text)).toEqual({ marker: "big", blob });
			} finally {
				if (child) await stopChild(child);
				rmSync(directory, { recursive: true, force: true });
			}
		},
		TEST_TIMEOUT_MS,
	);
}

test("replyJsonError destroys instead of writing when headers already sent", () => {
	const calls: string[] = [];
	const sent = {
		headersSent: true,
		writableEnded: false,
		writeHead(_status: number, _headers: Record<string, string>) {
			calls.push("writeHead");
		},
		end(_body: string) {
			calls.push("end");
		},
		destroy() {
			calls.push("destroy");
		},
	};
	replyJsonError(sent, new Error("boom"));
	expect(calls).toEqual(["destroy"]);
});

test("replyJsonError writes 500 JSON on a fresh response", () => {
	const calls: string[] = [];
	let status = 0;
	let body = "";
	const fresh = {
		headersSent: false,
		writableEnded: false,
		writeHead(s: number, _headers: Record<string, string>) {
			status = s;
			calls.push("writeHead");
		},
		end(b: string) {
			body = b;
			calls.push("end");
		},
		destroy() {
			calls.push("destroy");
		},
	};
	replyJsonError(fresh, new Error("boom"));
	expect(status).toBe(500);
	expect(calls).toEqual(["writeHead", "end"]);
	expect(JSON.parse(body)).toEqual({
		jsonrpc: "2.0",
		error: { code: -32000, message: "Error: boom" },
		id: null,
	});
});
