# mcp-pool agent guide

## What

MCP proxy that pools multiple API keys for rate-limited upstream MCP servers. Spawns N upstream subprocesses (one per key), exposes their tools with `{poolName}__` prefix, routes `tools/call` across available upstreams.

## Key files

| File | Purpose |
|---|---|
| `src/index.ts` | MCP server entry — parses `--config`/`--verbose`, prefixes tools on `list`, strips prefix on `call`, starts all pools |
| `src/pool.ts` | Pool class — `start()` spawns upstreams (tolerant: failed spawns = dead), `routeCall()` selects and retries across available upstreams, cooldown timer re-activates rate-limited ones |
| `src/config.ts` | YAML loading, Zod validation with regex check on `rateLimitPatterns`, `${VAR}` expansion |
| `src/strategies.ts` | `RoundRobinStrategy` (cursor advances on success/rate_limited, unchanged on error) and `DepleteFirstStrategy` (always picks first available) |
| `src/types.ts` | `PoolConfig`, `UpstreamState`, `RoutingStrategy`, `LogEvent` |
| `src/logger.ts` | Structured JSON logging to stderr |
| `test/helper-server.ts` | Configurable test MCP server (crash/rate-limit/echo via env vars) |

## Config shape

```yaml
pools:
  <name>:
    command: string           # required
    args: string[]
    keys: Record<string,string>[]  # at least 1
    strategy: "round-robin" | "deplete-first"
    cooldownSeconds: 300      # default
    rateLimitPatterns: string[]  # required, at least 1, all valid regex
    maxConsecutiveErrors: 3    # default
    cwd?: string
```

Config paths (first found wins): `--config <path>`, `./mcp-pool.yaml`, `./.mcp-pool.yaml`, `~/.config/mcp-pool/mcp-pool.yaml`.
## Flow

1. `loadConfig()` reads YAML, validates with Zod, expands `${VAR}` env refs
2. For each pool, `Pool.start()` spawns all upstreams in parallel via `Promise.allSettled` — tolerant: dead spawns = `dead`, pool continues if at least one connects
3. Connected upstreams' tool sets compared by name→schema map (order-independent). Mismatch → pool fails, connected clients closed first
4. `Pool.routeCall()` retry loop: filter available → strategy selects → forward → on rate-limit (error text matches `rateLimitPatterns`) → mark rate_limited, cooldown timer, retry next upstream
5. Transport errors (crash/broken pipe) → mark dead after N consecutive, retry next
6. Non-rate-limit `isError` → return to client immediately, advance cursor, no retry
7. Every `cooldownIntervalMs` (default 30s, injectable for tests), check expired cooldowns → re-activate upstreams

## Routing strategy state machine

- **RoundRobin**: `select` = cursor % available.length. `record("success")` → cursor++. `record("rate_limited")` → cursor++. `record("error")` → cursor unchanged (retry same position next time unless dead).
- **DepleteFirst**: `select` = available[0]. Records are no-ops (status changes handled by Pool).

## Key behaviors

- **Tolerant startup**: failed upstreams = dead, pool starts if ≥1 connects. All fail → throw.
- **`rateLimitPatterns` safety gate**: without explicit patterns, all `isError` results are terminal. Use `[".*"]` for blanket retry on read-only pools.
- **success recorded on terminal tool errors**: non-rate-limit `isError` still advances cursor (counts as a successful dispatch).
- **Cooldown via `setInterval`**: poll-based, not per-upstream timer. OK for most cases; low-latency re-activation needs smaller interval.
- **No persistent state**: everything resets on restart.
- **Stdio only**: HTTP upstreams would need transport field + factory.
- **Process cleanup**: on startup failure (tool mismatch), already-connected upstreams are closed before rethrowing.

## Test structure

- `src/config.test.ts` — schema validation, YAML loading, env expansion (19 tests)
- `src/strategies.test.ts` — RoundRobin cycles/skip/error, DepleteFirst always-first (unit)
- `src/pool.integration.test.ts` — startup tolerance, tool mismatch, failover, cooldown (10 tests, spawns real subprocesses)
- `test/bin-smoke.ts` — E2E via linked `mcp-pool` bin
- `test/helper-server.ts` — configurable via env: `TEST_CRASH_ON_START`, `TEST_RATE_LIMIT_EVERY_N`, `TEST_RATE_LIMIT_COUNT`, `TEST_CRASH_AFTER`, `TEST_TOOL_ERROR_TEXT`, `TEST_TOOLS_JSON`
