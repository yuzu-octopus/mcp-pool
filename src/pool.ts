import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { PoolConfig } from "./types.js";
import { log } from "./logger.js";

export class Pool {
  readonly name: string;
  private config: PoolConfig;
  private cursor = 0;
  private client?: Client;
  private cachedTools: Tool[] = [];
  private started = false;
  private routeLock: Promise<void> = Promise.resolve();
  private cooldowns: number[] = [];

  constructor(name: string, config: PoolConfig) {
    this.name = name;
    this.config = config;
    this.cooldowns = config.keys.map(() => 0);
  }

  async start(): Promise<void> {
    const maxKeys = this.config.keys.length;
    for (let attempt = 0; attempt < maxKeys; attempt++) {
      try {
        await this.spawnUpstream(this.cursor);
        break;
      } catch (err) {
        log({
          level: "error",
          event: "upstream_error",
          pool: this.name,
          upstream: this.cursor,
          error: err instanceof Error ? err.message : String(err),
        });
        this.cursor = (this.cursor + 1) % maxKeys;
        if (attempt === maxKeys - 1) {
          throw new Error(
            `Pool "${this.name}": all ${maxKeys} key(s) failed to connect`,
          );
        }
      }
    }
    this.started = true;
  }

  async routeCall(
    toolName: string,
    args: Record<string, unknown>,
    verbose?: boolean,
  ): Promise<unknown> {
    const prev = this.routeLock;
    const next = Promise.withResolvers<void>();
    this.routeLock = next.promise;
    await prev;

    try {
      return await this.routeCallInner(toolName, args, verbose);
    } finally {
      next.resolve();
    }
  }

  private async routeCallInner(
    toolName: string,
    args: Record<string, unknown>,
    verbose?: boolean,
  ): Promise<unknown> {
    if (!this.started) {
      return {
        content: [{ type: "text" as const, text: `Pool "${this.name}" not started` }],
        isError: true,
      };
    }

    const maxKeys = this.config.keys.length;
    const cooldownSec = this.config.cooldownSeconds ?? 300;

    for (let attempt = 0; attempt < maxKeys; attempt++) {
      // Skip keys still in cooldown
      if (this.cooldowns[this.cursor] > Date.now()) {
        this.cursor = (this.cursor + 1) % maxKeys;
        continue;
      }

      if (!this.client) {
        try {
          await this.spawnUpstream(this.cursor);
        } catch (err) {
          log({
            level: "error",
            event: "upstream_error",
            pool: this.name,
            upstream: this.cursor,
            error: err instanceof Error ? err.message : String(err),
          });
          this.cursor = (this.cursor + 1) % maxKeys;
          continue;
        }
      }

      if (verbose) {
        log({
          level: "trace",
          event: "call_tool",
          pool: this.name,
          tool: toolName,
          upstream: this.cursor,
          args,
        });
      }

      try {
        const result = await this.client!.callTool({
          name: toolName,
          arguments: args,
        });

        if (result.isError) {
          const errorText = stringifyContent(result.content);
          const isRateLimited = this.config.rateLimitPatterns.some((pat) =>
            new RegExp(pat).test(errorText),
          );

          if (isRateLimited) {
            this.cooldowns[this.cursor] = Date.now() + cooldownSec * 1000;
            log({
              level: "warn",
              event: "rate_limited",
              pool: this.name,
              upstream: this.cursor,
              cooldownUntil: new Date(this.cooldowns[this.cursor]).toISOString(),
            });
            await this.closeCurrent();
            this.cursor = (this.cursor + 1) % maxKeys;
            continue;
          }

          return result;
        }

        log({
          level: "trace",
          event: "call_tool",
          pool: this.name,
          tool: toolName,
          upstream: this.cursor,
          args,
        });
        return result;
      } catch (err) {
        log({
          level: "error",
          event: "upstream_error",
          pool: this.name,
          upstream: this.cursor,
          error: err instanceof Error ? err.message : String(err),
        });
        await this.closeCurrent();
        this.cursor = (this.cursor + 1) % maxKeys;
        continue;
      }
    }
    const now = Date.now();
    const active = this.cooldowns.filter((c) => c > now);
    const retryAfter = active.length > 0
      ? Math.ceil((Math.min(...active) - now) / 1000)
      : cooldownSec;
    log({
      level: "error",
      event: "all_exhausted",
      pool: this.name,
      available: 0,
      total: maxKeys,
    });

    return {
      content: [
        {
          type: "text" as const,
          text: `All ${maxKeys} keys for '${this.name}' exhausted. Retry after ${retryAfter}s.`,
        },
      ],
      isError: true,
    };
  }

  getTools(): Tool[] {
    return this.cachedTools;
  }

  async close(): Promise<void> {
    await this.closeCurrent();
  }

  private async spawnUpstream(keyIndex: number): Promise<void> {
    const envVars = this.config.keys[keyIndex];
    const transport = new StdioClientTransport({
      command: this.config.command,
      args: this.config.args,
      env: { ...process.env, ...envVars } as Record<string, string>,
      cwd: this.config.cwd,
    });

    const client = new Client(
      { name: "mcp-pool", version: "0.1.0" },
      { capabilities: {} },
    );

    let tools: Tool[];
    try {
      await client.connect(transport);
      const toolsResult = await client.listTools();
      tools = toolsResult.tools as Tool[];
    } catch (err) {
      await client.close().catch(() => {});
      throw err;
    }

    if (this.cachedTools.length > 0) {
      const mismatch = findToolMismatch(this.cachedTools, tools);
      if (mismatch) {
        await client.close();
        throw new Error(
          `Pool "${this.name}" key ${keyIndex} tools mismatch: ${mismatch}`,
        );
      }
    } else {
      this.cachedTools = tools;
    }

    this.client = client;
    this.cursor = keyIndex;

    log({
      level: "info",
      event: "upstream_start",
      pool: this.name,
      keyIndex,
    });
  }

  private async closeCurrent(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = undefined;
    }
  }
}

function findToolMismatch(a: Tool[], b: Tool[]): string | null {
  const mapA = new Map(a.map((t) => [t.name, t]));
  const mapB = new Map(b.map((t) => [t.name, t]));

  if (mapA.size !== mapB.size) {
    return `tool count mismatch: ${mapA.size} vs ${mapB.size}`;
  }

  for (const [name, toolA] of mapA) {
    const toolB = mapB.get(name);
    if (!toolB) {
      return `tool "${name}" missing from upstream`;
    }
    const schemaA = JSON.stringify(toolA.inputSchema);
    const schemaB = JSON.stringify(toolB.inputSchema);
    if (schemaA !== schemaB) {
      return `tool "${name}" inputSchema mismatch`;
    }
  }

  return null;
}

function stringifyContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c: Record<string, unknown>) => String(c.text ?? "")).join("\n");
  }
  return JSON.stringify(content);
}
