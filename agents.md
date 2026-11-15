# mcp-pool agent guide

## What

MCP proxy that pools multiple API keys for rate-limited upstream MCP servers. Spawns 1 upstream subprocess per pool (lazy failover: rotates to next key on rate-limit), exposes tools with `{poolName}__` prefix, routes `tools/call` across available upstreams.

## Key files

| File | Purpose |
|---|---|
| `src/index.ts` | MCP server entry — citty `defineCommand` parsing (`--config`/`--verbose`/`--version`, exit 2 on misuse), prefixes tools on `list`, strips prefix on `call`, starts all pools |
| `src/pool.ts` | Pool class — lazy failover: `start()` tries each key until one connects (retries across all keys), `routeCall()` retries across keys on rate-limit, `spawnUpstream()` spawns on-demand + validates tool set consistency |
| `src/config.ts` | YAML loading, Zod validation with regex check on `rateLimitPatterns`, `${VAR}` expansion |
| `src/types.ts` | `PoolConfig`, `LogEvent` |
| `src/logger.ts` | Structured JSON logging to stderr |
| `test/helper-server.ts` | Configurable test MCP server (crash/rate-limit/echo via env vars) |

## Config shape

```yaml
pools:
  <name>:
    command?: string         # required for stdio
    args?: string[]          # stdio only
    transport?: "stdio" | "http" | "sse"  # default "stdio"; http/sse use url + headers
    url?: string             # required for http/sse
    headers?: Record<string,string>  # merged under per-key entries for http/sse
    env?: Record<string,string>      # extra env for stdio upstreams
    keys: Record<string,string>[]  # at least 1; literal or ${VAR} values
    rateLimitPatterns: string[]  # required, at least 1, all valid regex
    cooldownSeconds?: number   # seconds a rate-limited key is skipped; defaults to 300
    cwd?: string               # stdio only
    transientRetry?: { tools: string[]; errorPatterns: string[]; delaysMs: number[] }  # opt-in same-key retries, up to 5 delays of 0-10000ms
```

Config paths (first found wins): `--config <path>`, `./mcp-pool.yaml`, `./.mcp-pool.yaml`, `~/.config/mcp-pool/mcp-pool.yaml`.

Upstream `args` should be pinned (`args: ["-y", "tavily-mcp@0.2.22"]`); unpinned `bunx -y <pkg>` refloats on every fresh cache. Verified 2026-11-15: `tavily-mcp@0.2.22`, `exa-mcp-server@3.4.3`, `firecrawl-mcp@3.40.0`, `@brave/brave-search-mcp-server@2.1.4` (brave needs an API key even to list tools).

## Flow

1. `loadConfig()` reads YAML, expands `${VAR}` env refs (missing variables are errors), then validates with Zod
2. For each pool, `Pool.start()` tries keys in order until one connects (retries across all keys); others spawned on-demand during failover
3. First upstream's tools are cached as the pool's tool set; subsequent spawns validate tool consistency
4. `Pool.routeCall()`: try current upstream → forward call → on rate-limit (error text matches `rateLimitPatterns`) → close current, advance to next key, spawn new upstream, retry
5. Transport errors (crash/broken pipe) → same as rate-limit: close, advance, spawn, retry
6. Non-rate-limit `isError` → return to client immediately, no retry
7. Only the swap window is serialized (mutex); the in-flight `callTool` runs outside it so concurrent callers proceed in parallel

## Serving modes

- **proxy (default)**: agent's stdio session. Connects to the shared daemon; spawns one if the socket is missing or stale. Pure byte pipe, no MCP logic.
- **`--daemon`**: detached process owning upstreams, one MCP `Server` per accepted connection. Exits when the last connection leaves, after `IDLE_GRACE_MS` (3s). `EADDRINUSE` means another daemon won the race — exits quietly.
- **`--local`**: standalone single-process server, no sharing.
- **`--http --port N [--host H]`**: per-request Server+transport over Streamable HTTP at `/mcp`, plus `GET /health`. Bun.serve when available, node:http fallback (`MCP_POOL_HTTP_NODE=1` forces node).
- **`--help` / `-h`, `--version`**: print usage / version and exit 0 before config load or daemon spawn. Usage errors exit 2 (`mcp-pool: error: …`, no stack trace).

Runtime sockets live in `~/.mcp-pool/<sha256(configPath)[:16]>.sock`. **Not** `os.tmpdir()`: the SDK's stdio transport filters `TMPDIR` out of the child environment, which would give the daemon a different directory than the agent that spawned it. A `.status` file carries `ready` or the daemon's startup error so proxies fail fast.

## Key behaviors

- **Lazy failover**: 1 process per pool at a time. On rate-limit, the current process is closed and a new one spawns with the next key. No warm standby processes.
- **`rateLimitPatterns` safety gate**: without explicit patterns, all `isError` results are terminal. Use `[".*"]` for blanket retry on read-only pools.
- **Per-key cooldown**: after a matching rate-limit error, that key is skipped for `cooldownSeconds` (300 seconds by default).
- **Tool set validation on each spawn**: when a new upstream spawns, its tools are compared against the cached set (by name→schema map, order-independent). Mismatch → error, logged before that upstream is used.
- **Parallel pool startup**: `Promise.allSettled` starts all pools at once; any failure closes the ones that started and rethrows. Removes the head-of-line stall of a slow upstream.
- **No persistent state**: everything resets on restart.
- **Stdio upstreams only**: HTTP upstreams would need transport field + factory.
- **Resource cleanup**: `spawnUpstream` cleans up client on connection/tool-list failure; tool mismatch also closes the client before throwing.

## Test structure

- `src/config.test.ts` — schema validation, YAML loading, and environment expansion
- `src/pool.integration.test.ts` — startup, failover, key exhaustion, tool mismatch, and log redaction
- `test/startup-cleanup.test.ts` — closes already-started pools when later startup fails (uses `--local`)
- `test/daemon-sharing.test.ts` — two agents over one daemon, teardown on last disconnect, recovery from a SIGKILLed daemon leaving a stale socket
- `test/bin-smoke.ts` and `test/smoke-test.ts` — E2E stdio smoke coverage
- `test/helper-server.ts` — configurable via env: `TEST_CRASH_ON_START`, `TEST_RATE_LIMIT_EVERY_N`, `TEST_RATE_LIMIT_COUNT`, `TEST_CRASH_AFTER`, `TEST_TOOL_ERROR_TEXT`, `TEST_TOOLS_JSON`
