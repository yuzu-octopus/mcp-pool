#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { loadConfig, ConfigError } from "./config.js";
import { Pool } from "./pool.js";
import { log } from "./logger.js";

function parseArgs(): { config?: string; verbose: boolean } {
  const argv = process.argv.slice(2);
  let config: string | undefined;
  let verbose = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--config" && i + 1 < argv.length) {
      config = argv[++i];
    } else if (argv[i] === "--verbose") {
      verbose = true;
    }
  }
  return { config, verbose };
}

async function main(): Promise<void> {
  const { config: configPath, verbose } = parseArgs();

  let loaded;
  try {
    loaded = loadConfig(configPath);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`mcp-pool: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  const poolNames = Object.keys(loaded.config.pools);

  const pools: Pool[] = [];
  try {
    for (const name of poolNames) {
      const pool = new Pool(name, loaded.config.pools[name]);
      await pool.start();
      pools.push(pool);
    }
  } catch (err) {
    await Promise.allSettled(pools.map((pool) => pool.close()));
    throw err;
  }

  const server = new Server(
    { name: "mcp-pool", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools: Array<{
      name: string;
      description?: string;
      inputSchema: {
        type: "object";
        properties?: Record<string, unknown>;
        required?: string[];
      };
    }> = [];

    for (const pool of pools) {
      const poolTools = pool.getTools();
      const prefix = pool.name + "__";
      for (const t of poolTools) {
        tools.push({
          name: prefix + t.name,
          description: t.description
            ? `[${pool.name}] ${t.description}`
            : `[${pool.name}]`,
          inputSchema: t.inputSchema,
        });
      }
    }

    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const fullName = request.params.name;
    const separatorIndex = fullName.indexOf("__");
    if (separatorIndex === -1) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Invalid tool name: "${fullName}". Expected format: {poolName}__{toolName}`,
          },
        ],
        isError: true,
      };
    }

    const poolName = fullName.slice(0, separatorIndex);
    const toolName = fullName.slice(separatorIndex + 2);
    const pool = pools.find((p) => p.name === poolName);

    if (!pool) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Unknown pool: "${poolName}"`,
          },
        ],
        isError: true,
      };
    }

    log({
      level: "info",
      event: "route",
      pool: poolName,
      tool: toolName,
      upstream: -1,
    });
    return await pool.routeCall(toolName, request.params.arguments ?? {}, verbose) as {
      content: Array<{ type: "text"; text: string; annotations?: unknown }>;
      isError?: boolean;
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // On exit, close all pools
  process.on("SIGINT", async () => {
    await Promise.allSettled(pools.map((p) => p.close()));
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await Promise.allSettled(pools.map((p) => p.close()));
    process.exit(0);
  });

  log({
    level: "info",
    event: "upstream_start",
    pool: "mcp-pool",
    keyIndex: 0,
  });
}

main().catch((err) => {
  console.error("mcp-pool fatal:", err);
  process.exit(1);
});
