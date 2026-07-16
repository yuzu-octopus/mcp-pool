import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { PoolConfig, UpstreamState, RoutingStrategy } from "./types.js";
import { log } from "./logger.js";
import { RoundRobinStrategy, DepleteFirstStrategy } from "./strategies.js";

export class Pool {
  readonly name: string;
  private config: PoolConfig;
  private upstreams: UpstreamState[] = [];
  private strategy: RoutingStrategy;
  private cooldownTimer?: ReturnType<typeof setInterval>;
  private cachedTools: Tool[] = [];
  private started = false;
  private cooldownIntervalMs: number;

  constructor(name: string, config: PoolConfig, cooldownIntervalMs = 30_000) {
    this.name = name;
    this.config = config;
    this.cooldownIntervalMs = cooldownIntervalMs;
    this.strategy =
      config.strategy === "round-robin"
        ? new RoundRobinStrategy()
        : new DepleteFirstStrategy();
  }

  async start(): Promise<void> {
    const results = await Promise.allSettled(
      this.config.keys.map(async (envVars, keyIndex) => {
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
        await client.connect(transport);
        const toolsResult = await client.listTools();
        const tools: Tool[] = toolsResult.tools as Tool[];
        return { keyIndex, client, tools };
      }),
    );

    const connected: Array<{ keyIndex: number; client: Client; tools: Tool[] }> = [];

    for (const r of results) {
      if (r.status === "fulfilled") {
        connected.push(r.value);
        log({
          level: "info",
          event: "upstream_start",
          pool: this.name,
          keyIndex: r.value.keyIndex,
        });
      } else {
        log({
          level: "error",
          event: "upstream_error",
          pool: this.name,
          upstream: -1,
          error: r.reason instanceof Error ? r.reason.message : String(r.reason),
        });
      }
    }

    const cleanup = () => Promise.allSettled(connected.map((c) => c.client.close()));

    if (connected.length === 0) {
      throw new Error(
        `Pool "${this.name}": all upstreams failed to connect`,
      );
    }

    const referenceTools = connected[0].tools;
    for (let i = 1; i < connected.length; i++) {
      const mismatch = findToolMismatch(referenceTools, connected[i].tools);
      if (mismatch) {
        log({
          level: "info",
          event: "upstream_tools_mismatch",
          pool: this.name,
          keyIndex: connected[i].keyIndex,
          reason: mismatch,
        });
        await cleanup();
        throw new Error(
          `Pool "${this.name}" key ${connected[i].keyIndex} tools mismatch: ${mismatch}`,
        );
      }
    }
    this.cachedTools = referenceTools;
    this.upstreams = this.config.keys.map((_, keyIndex) => {
      const conn = connected.find((c) => c.keyIndex === keyIndex);
      if (conn) {
        return {
          keyIndex,
          status: "available" as const,
          consecutiveErrors: 0,
          client: conn.client,
          tools: conn.tools,
        };
      }
      return {
        keyIndex,
        status: "dead" as const,
        consecutiveErrors: 0,
        client: null as unknown as Client,
        tools: [],
      };
    });

    this.cooldownTimer = setInterval(() => this.checkCooldowns(), this.cooldownIntervalMs);
    this.started = true;
  }

  async routeCall(
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

    const maxRetries = this.upstreams.length;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const available = this.upstreams.filter((u) => u.status === "available");
      if (available.length === 0) {
        log({
          level: "error",
          event: "all_exhausted",
          pool: this.name,
          available: 0,
          total: this.upstreams.length,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `All ${this.upstreams.length} upstreams for '${this.name}' are rate-limited or dead. Retry after ${this.config.cooldownSeconds}s.`,
            },
          ],
          isError: true,
        };
      }

      const upstream: UpstreamState = this.strategy.select(available);

      if (verbose) {
        log({
          level: "trace",
          event: "call_tool",
          pool: this.name,
          tool: toolName,
          upstream: upstream.keyIndex,
          args,
        });
      }

      try {
        const result = await upstream.client.callTool({
          name: toolName,
          arguments: args,
        });

        // Check for rate-limit error via error text matching
        if (result.isError) {
          const errorText = stringifyContent(result.content);
          const isRateLimited = this.config.rateLimitPatterns.some((pat) =>
            new RegExp(pat).test(errorText),
          );

          if (isRateLimited) {
            this.markRateLimited(upstream);
            this.strategy.record(upstream, "rate_limited");
            log({
              level: "warn",
              event: "rate_limited",
              pool: this.name,
              upstream: upstream.keyIndex,
              cooldownUntil: new Date(upstream.cooldownUntil!).toISOString(),
            });
            continue;
          }

          // Non-rate-limit tool error — return to client, no retry
          upstream.consecutiveErrors = 0;
        this.strategy.record(upstream, "success");
          return result;
        }

        // Success
        upstream.consecutiveErrors = 0;
        this.strategy.record(upstream, "success");
        log({
          level: "trace",
          event: "call_tool",
          pool: this.name,
          tool: toolName,
          upstream: upstream.keyIndex,
          args,
        });
        return result;
      } catch (err) {
        upstream.consecutiveErrors++;
        upstream.status = "dead";
        this.strategy.record(upstream, "error");
        log({
          level: "error",
          event: "upstream_error",
          pool: this.name,
          upstream: upstream.keyIndex,
          error: err instanceof Error ? err.message : String(err),
        });

        if (upstream.consecutiveErrors >= this.config.maxConsecutiveErrors) {
          log({
            level: "error",
            event: "upstream_dead",
            pool: this.name,
            upstream: upstream.keyIndex,
            consecutiveErrors: upstream.consecutiveErrors,
          });
        }

        continue;
      }
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `All ${this.upstreams.length} upstreams for '${this.name}' exhausted after retries.`,
        },
      ],
      isError: true,
    };
  }

  getTools(): Tool[] {
    return this.cachedTools;
  }

  private markRateLimited(upstream: UpstreamState): void {
    upstream.status = "rate_limited";
    upstream.consecutiveErrors++;
    upstream.cooldownUntil = Date.now() + this.config.cooldownSeconds * 1000;
  }

  private checkCooldowns(): void {
    const now = Date.now();
    for (const u of this.upstreams) {
      if (
        u.status === "rate_limited" &&
        u.cooldownUntil != null &&
        now >= u.cooldownUntil
      ) {
        u.status = "available";
        u.consecutiveErrors = 0;
        u.cooldownUntil = undefined;
        log({
          level: "warn",
          event: "cooldown_expired",
          pool: this.name,
          upstream: u.keyIndex,
        });
      }
    }
  }

  async close(): Promise<void> {
    clearInterval(this.cooldownTimer);
    await Promise.allSettled(
      this.upstreams.map((u) => u.client?.close?.()),
    );
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
      return `tool "${name}" missing from upstream B`;
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
