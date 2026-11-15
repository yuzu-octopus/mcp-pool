#!/usr/bin/env node
/**
 * End-to-end smoke test: starts mcp-pool with test/smoke.yaml,
 * connects as an MCP client, lists tools, calls one.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import packageJson from "../package.json" with { type: "json" };

async function main() {
	console.error("smoke: starting proxy...");

	const transport = new StdioClientTransport({
		command: "bun",
		args: ["run", "src/index.ts", "--config", "test/smoke.yaml", "--verbose"],
	});

	const client = new Client(
		{ name: "smoke-test", version: "0.1.0" },
		{ capabilities: {} },
	);

	await client.connect(transport);
	console.error("smoke: connected");
	if (client.getServerVersion()?.version !== packageJson.version) {
		throw new Error(
			`unexpected server version: ${client.getServerVersion()?.version}, expected ${packageJson.version}`,
		);
	}

	// List tools — should show prefixed names
	const toolsResult = await client.listTools();
	const tools = toolsResult.tools;
	console.error(`smoke: got ${tools.length} tool(s)`);

	const smokeTools = tools.filter((t) => t.name.startsWith("smoke__"));
	if (smokeTools.length === 0) {
		throw new Error("no pooled tools found (expected smoke__ prefix)");
	}
	console.error(`smoke: first tool: ${smokeTools[0].name}`);

	// Call the echo tool
	const callResult = await client.callTool({
		name: "smoke__echo",
		arguments: { message: "smoke-test" },
	});
	console.error(`smoke: call result: ${JSON.stringify(callResult)}`);

	if (callResult.isError) {
		throw new Error(
			`tool call returned error: ${JSON.stringify(callResult.content)}`,
		);
	}
	// --help must print usage and exit 0 without needing a config.
	const helpProc = Bun.spawnSync({
		cmd: ["bun", "run", "src/index.ts", "--help"],
		stdout: "pipe",
		stderr: "pipe",
	});
	const helpText = helpProc.stdout.toString();
	if (helpProc.exitCode !== 0 || !helpText.includes("Usage: mcp-pool")) {
		throw new Error(`--help failed: exit=${helpProc.exitCode}`);
	}
	console.error("smoke: --help OK");
	console.error("smoke: PASSED");
	await client.close();
	process.exit(0);
}

main().catch((err) => {
	console.error("smoke: FAILED —", err);
	process.exit(1);
});
