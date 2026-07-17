# mcp-pool agent guide

## What

MCP proxy that pools multiple API keys for rate-limited upstream MCP servers. Spawns 1 upstream subprocess per pool (lazy failover: rotates to next key on rate-limit), exposes tools with `{poolName}__` prefix, routes `tools/call` across available upstreams.

## Key files

| File | Purpose |
|---|---|
| `src/index.ts` | MCP server entry — parses `--config`/`--verbose`, prefixes tools on `list`, strips prefix on `call`, starts all pools |
| `src/pool.ts` | Pool class — lazy failover: `start()` tries each key until one connects (retries across all keys), `routeCall()` retries across keys on rate-limit, `spawnUpstream()` spawns on-demand + validates tool set consistency |
| `src/config.ts` | YAML loading, Zod validation with regex check on `rateLimitPatterns`, `${VAR}` expansion |
| `src/types.ts` | `PoolConfig`, `LogEvent` |
| `src/logger.ts` | Structured JSON logging to stderr |
| `test/helper-server.ts` | Configurable test MCP server (crash/rate-limit/echo via env vars) |

## Config shape

```yaml
pools:
  <name>:
    command: string           # required
    args: string[]
    keys: Record<string,string>[]  # at least 1; literal or ${VAR} values
    rateLimitPatterns: string[]  # required, at least 1, all valid regex
    cooldownSeconds?: number   # seconds a rate-limited key is skipped; defaults to 300
    cwd?: string
```

Config paths (first found wins): `--config <path>`, `./mcp-pool.yaml`, `./.mcp-pool.yaml`, `~/.config/mcp-pool/mcp-pool.yaml`.

## Flow

1. `loadConfig()` reads YAML, expands `${VAR}` env refs (missing variables are errors), then validates with Zod
2. For each pool, `Pool.start()` tries keys in order until one connects (retries across all keys); others spawned on-demand during failover
3. First upstream's tools are cached as the pool's tool set; subsequent spawns validate tool consistency
4. `Pool.routeCall()`: try current upstream → forward call → on rate-limit (error text matches `rateLimitPatterns`) → close current, advance to next key, spawn new upstream, retry
5. Transport errors (crash/broken pipe) → same as rate-limit: close, advance, spawn, retry
6. Non-rate-limit `isError` → return to client immediately, no retry
7. Route calls serialized via promise-chain mutex to prevent races on shared state

## Key behaviors

- **Lazy failover**: 1 process per pool at a time. On rate-limit, the current process is closed and a new one spawns with the next key. No warm standby processes.
- **`rateLimitPatterns` safety gate**: without explicit patterns, all `isError` results are terminal. Use `[".*"]` for blanket retry on read-only pools.
- **Per-key cooldown**: after a matching rate-limit error, that key is skipped for `cooldownSeconds` (300 seconds by default).
- **Tool set validation on each spawn**: when a new upstream spawns, its tools are compared against the cached set (by name→schema map, order-independent). Mismatch → error, logged before that upstream is used.
- **No persistent state**: everything resets on restart.
- **Stdio only**: HTTP upstreams would need transport field + factory.
- **Resource cleanup**: `spawnUpstream` cleans up client on connection/tool-list failure; tool mismatch also closes the client before throwing.

## Test structure

- `src/config.test.ts` — schema validation, YAML loading, and environment expansion
- `src/pool.integration.test.ts` — startup, failover, key exhaustion, tool mismatch, and log redaction
- `test/startup-cleanup.test.ts` — closes already-started pools when later startup fails
- `test/bin-smoke.ts` and `test/smoke-test.ts` — E2E stdio smoke coverage
- `test/helper-server.ts` — configurable via env: `TEST_CRASH_ON_START`, `TEST_RATE_LIMIT_EVERY_N`, `TEST_RATE_LIMIT_COUNT`, `TEST_CRASH_AFTER`, `TEST_TOOL_ERROR_TEXT`, `TEST_TOOLS_JSON`
