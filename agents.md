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
    transientRetry?:          # opt in only for replay-safe tools
      tools: string[]         # exact upstream tool names
      errorPatterns: string[] # valid regexes matching flagged tool errors
      delaysMs: number[]      # 1–5 additional attempts, each delay 0–10000 ms
```

Config paths (first found wins): `--config <path>`, `./mcp-pool.yaml`, `./.mcp-pool.yaml`, `~/.config/mcp-pool/mcp-pool.yaml`.

## Flow

1. `loadConfig()` reads YAML, expands `${VAR}` env refs (missing variables are errors), then validates with Zod
2. For each pool, `Pool.start()` tries keys in order until one connects (retries across all keys); others spawned on-demand during failover
3. First upstream's tools are cached as the pool's tool set; subsequent spawns validate tool consistency
4. `Pool.routeCall()`: capture client and key index → forward call → on matching error cool down the captured key; close/advance only if that client is still current, then retry
5. Transport errors (crash/broken pipe) → close/advance only if the captured client is still current. Late errors cannot close its replacement.
6. Non-rate-limit `isError` → optional `transientRetry` on the same client/key for listed tools and matching errors; otherwise return immediately. Quota patterns take precedence. Bounded backoff runs outside the mutex; a replaced client is never retried.
7. Only the swap window is serialized (mutex); the in-flight `callTool` runs outside it so concurrent callers proceed in parallel

## Serving modes

- **proxy (default)**: agent's stdio session. Connects to the shared daemon; spawns one if the socket is missing or stale. Pure byte pipe, no MCP logic.
- **`--daemon`**: detached process owning upstreams, one MCP `Server` per accepted connection. Exits when the last connection leaves, after `IDLE_GRACE_MS` (3s). `EADDRINUSE` means another daemon won the race — exits quietly.
- **`--local`**: standalone single-process server, no sharing.
- **`--http --port N [--host H]`**: stateless Streamable HTTP endpoint at `/mcp`, plus `GET /health`.

Runtime sockets live in `~/.mcp-pool/<sha256(configPath)[:16]>.sock`. **Not** `os.tmpdir()`: the SDK's stdio transport filters `TMPDIR` out of the child environment, which would give the daemon a different directory than the agent that spawned it. A `.status` file carries `ready` or the daemon's startup error so proxies fail fast.

## Key behaviors

- **Lazy failover**: 1 process per pool at a time. On rate-limit, the current process is closed and a new one spawns with the next key. No warm standby processes.
- **`rateLimitPatterns` safety gate**: without explicit patterns, all `isError` results are terminal. Use `[".*"]` for blanket retry on read-only pools.
- **Per-key cooldown**: after a matching rate-limit error, that key is skipped for `cooldownSeconds` (300 seconds by default).
- **Unflagged error compatibility**: known Context7 auth/quota prefixes are treated as error candidates, still gated by configured `rateLimitPatterns`. Ordinary documentation mentioning errors is returned unchanged.
- **Stateless HTTP ownership**: one MCP session/transport per POST; pools are shared. Response close releases the session; GET/DELETE `/mcp` return 405.
- **Tool set validation on each spawn**: when a new upstream spawns, its tools are compared against the cached set (by name→schema map, order-independent). Mismatch → error, logged before that upstream is used.
- **Parallel pool startup**: `Promise.allSettled` starts all pools at once; any failure closes the ones that started and rethrows. Removes the head-of-line stall of a slow upstream.
- **No persistent state**: everything resets on restart.
- **Stdio upstreams only**: HTTP upstreams would need transport field + factory.
- **Resource cleanup**: `spawnUpstream` cleans up client on connection/tool-list failure; tool mismatch also closes the client before throwing.

## Test structure

- `src/config.test.ts` — schema validation, YAML loading, and environment expansion
- `src/pool.integration.test.ts` — startup, failover, key exhaustion, tool mismatch, and log redaction
- `src/pool.failover.test.ts` — concurrent budget errors, stale transport failures, Context7 error prefixes, and exhaustion diagnostics
- `src/pool.transient.test.ts` — opt-in bounded same-key retries, argument preservation, quota priority, concurrent replacement and real stdio recovery
- `test/http-stateless.test.ts` — real repeated/concurrent MCP HTTP clients
- `test/startup-cleanup.test.ts` — closes already-started pools when later startup fails (uses `--local`)
- `test/daemon-sharing.test.ts` — two agents over one daemon, teardown on last disconnect, recovery from a SIGKILLed daemon leaving a stale socket
- `test/bin-smoke.ts` and `test/smoke-test.ts` — E2E stdio smoke coverage
- `test/helper-server.ts` — configurable via env: `TEST_CRASH_ON_START`, `TEST_RATE_LIMIT_EVERY_N`, `TEST_RATE_LIMIT_COUNT`, `TEST_CRASH_AFTER`, `TEST_TOOL_ERROR_TEXT`, `TEST_TOOLS_JSON`

Native install/build uses npm and `package-lock.json`; Bun runs tests and the existing Bun workflows. The fork Dockerfile builds locked source and installs pinned Exa/Context7 upstreams without embedding runtime keys.
