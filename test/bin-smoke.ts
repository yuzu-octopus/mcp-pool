#!/usr/bin/env bun
/**
 * Smoke test: invoke mcp-pool via linked bin, connect as MCP client.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "mcp-pool",
  args: ["--config", "test/smoke.yaml"],
});

const client = new Client(
  { name: "bin-smoke", version: "0.1.0" },
  { capabilities: {} },
);

await client.connect(transport);

const tools = await client.listTools();
const smokeTools = tools.tools.filter((t) => t.name.startsWith("smoke__"));
if (smokeTools.length === 0) throw new Error("no pooled tools via mcp-pool bin");

const result = await client.callTool({ name: "smoke__echo", arguments: { msg: "bin-test" } });
if (result.isError) throw new Error(`call failed: ${JSON.stringify(result.content)}`);

console.error(`bin-smoke: PASSED — ${smokeTools.length} tool(s), echo works`);
await client.close();
