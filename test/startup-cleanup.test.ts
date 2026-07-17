import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "bun:test";

async function waitForClosed(lifecycleFile: string): Promise<void> {
  if (existsSync(lifecycleFile) && readFileSync(lifecycleFile, "utf8") === "closed") return;

  const directory = dirname(lifecycleFile);
  const closed = Promise.withResolvers<void>();
  const watcher = watch(directory, () => {
    if (existsSync(lifecycleFile) && readFileSync(lifecycleFile, "utf8") === "closed") {
      closed.resolve();
    }
  });

  try {
    // This cross-process integration test needs a bounded real-time wait for fs events.
    await Promise.race([closed.promise, new Promise<void>((resolve) => AbortSignal.timeout(2_000).addEventListener("abort", () => resolve(), { once: true }))]);
  } finally {
    watcher.close();
  }
}

test("closes started pools when a later pool fails startup", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mcp-pool-startup-cleanup-"));
  const configFile = join(directory, "config.yaml");
  const lifecycleFile = join(directory, "lifecycle");
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;

  writeFileSync(
    configFile,
    `pools:
  first:
    command: bun
    args: ["run", "test/helper-server.ts"]
    keys:
      - { TEST_LIFECYCLE_FILE: "${lifecycleFile}" }
    rateLimitPatterns: ["rate_limit_exceeded"]
  second:
    command: bun
    args: ["run", "test/helper-server.ts"]
    keys:
      - { TEST_CRASH_ON_START: "1" }
    rateLimitPatterns: ["rate_limit_exceeded"]
`,
  );

  try {
    transport = new StdioClientTransport({
      command: "bun",
      args: ["run", "src/index.ts", "--config", configFile],
    });
    client = new Client({ name: "startup-cleanup-test", version: "0.1.0" }, { capabilities: {} });

    await expect(client.connect(transport)).rejects.toThrow();
    await waitForClosed(lifecycleFile);
    expect(readFileSync(lifecycleFile, "utf8")).toBe("closed");
  } finally {
    await client?.close().catch(() => {});
    await transport?.close().catch(() => {});
    rmSync(directory, { recursive: true, force: true });
  }
});
