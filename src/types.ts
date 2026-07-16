import { type Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * PoolConfig: one pool = one upstream MCP server type with N keys.
 */
export interface PoolConfig {
  command: string;
  args: string[];
  keys: Record<string, string>[];
  strategy: "round-robin" | "deplete-first";
  cooldownSeconds: number;
  rateLimitPatterns: string[];
  maxConsecutiveErrors: number;
  cwd?: string;
}

/**
 * ConfigFile: top-level shape of pools.yaml.
 */
export interface ConfigFile {
  pools: Record<string, PoolConfig>;
}

/**
 * UpstreamState tracks one upstream instance (one key, one subprocess).
 */
export interface UpstreamState {
  keyIndex: number;
  status: "available" | "rate_limited" | "dead";
  cooldownUntil?: number;
  consecutiveErrors: number;
  client: Client;
  tools: Tool[];
}

/**
 * RoutingStrategy — pluggable interface for picking an upstream.
 */
export interface RoutingStrategy {
  select(available: UpstreamState[]): UpstreamState;
  record(upstream: UpstreamState, outcome: "success" | "rate_limited" | "error"): void;
}

/**
 * Structured log event types.
 */
export type LogEvent =
  | { level: "info"; event: "upstream_start"; pool: string; keyIndex: number }
  | { level: "info"; event: "upstream_tools_mismatch"; pool: string; keyIndex: number; reason: string }
  | { level: "info"; event: "route"; pool: string; tool: string; upstream: number; strategy: string }
  | { level: "warn"; event: "rate_limited"; pool: string; upstream: number; cooldownUntil: string }
  | { level: "warn"; event: "cooldown_expired"; pool: string; upstream: number }
  | { level: "error"; event: "all_exhausted"; pool: string; available: number; total: number }
  | { level: "error"; event: "upstream_dead"; pool: string; upstream: number; consecutiveErrors: number }
  | { level: "error"; event: "upstream_error"; pool: string; upstream: number; error: string }
  | { level: "trace"; event: "call_tool"; pool: string; tool: string; upstream: number; args: unknown };
