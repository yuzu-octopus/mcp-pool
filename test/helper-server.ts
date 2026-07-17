#!/usr/bin/env node
/**
 * Test helper MCP server for integration tests.
 * Behaviors controlled via env vars:
 *   TEST_TOOLS_JSON — JSON array of tools (default: echo tool)
 *   TEST_RATE_LIMIT_EVERY_N — return rate-limit error on every Nth call (default: 0 = never)
 *   TEST_RATE_LIMIT_COUNT — max rate-limited responses before returning success (0 = unlimited)
 *   TEST_CRASH_AFTER — crash after N tool calls (default: 0 = never)
 *   TEST_CRASH_ON_START — if set to "1", crash immediately during startup
 *   TEST_TOOL_ERROR_TEXT — error text for rate-limited calls (default: "rate_limit_exceeded")
 */

if (process.env.TEST_CRASH_ON_START === "1") {
  process.exit(1);
}

import { writeFileSync } from "node:fs";

const lifecycleFile = process.env.TEST_LIFECYCLE_FILE;
if (lifecycleFile) {
  writeFileSync(lifecycleFile, "started");
  process.on("exit", () => writeFileSync(lifecycleFile, "closed"));
}

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

let callCount = 0;
let rateLimitCount = 0;

const defaultTools = [
  { name: "echo", inputSchema: { type: "object" as const, properties: { message: { type: "string" } }, required: ["message"] } },
];

function getTools() {
  const raw = process.env.TEST_TOOLS_JSON;
  if (!raw) return defaultTools;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : defaultTools;
  } catch {
    return defaultTools;
  }
}

const rateLimitEveryN = parseInt(process.env.TEST_RATE_LIMIT_EVERY_N || "0", 10);
const rateLimitMax = parseInt(process.env.TEST_RATE_LIMIT_COUNT || "0", 10);
const crashAfter = parseInt(process.env.TEST_CRASH_AFTER || "0", 10);
const errorText = process.env.TEST_TOOL_ERROR_TEXT || "rate_limit_exceeded";

const server = new Server(
  { name: "test-helper-server", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: getTools() };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  callCount++;

  if (crashAfter > 0 && callCount >= crashAfter) {
    process.exit(1);
  }

  const shouldRateLimit = rateLimitEveryN > 0 && callCount % rateLimitEveryN === 0;
  const rateLimitExhausted = rateLimitMax > 0 && rateLimitCount >= rateLimitMax;

  if (shouldRateLimit && !rateLimitExhausted) {
    rateLimitCount++;
    return {
      content: [{ type: "text" as const, text: errorText }],
      isError: true,
    };
  }

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(request.params.arguments ?? {}),
      },
    ],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
