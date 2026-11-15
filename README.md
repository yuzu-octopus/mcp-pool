# mcp-pool

**MCP Key Pool Proxy** — pool multiple API keys across upstream MCP servers to distribute rate limits.

## How it works

mcp-pool is itself an MCP server. You configure one or more "pools" — each pool represents one upstream MCP server type (e.g. Brave Search) with N API keys.

- **1 subprocess per pool at a time**, not per key. No warm standby processes.
- On rate-limit or transport error, the current upstream is closed and a new one spawns with the next key (~1-2s failover).
- Tools, prompts, resources, and completions are exposed with `{poolName}__` prefix to avoid name collisions (resource URIs stay verbatim; `logging/setLevel` applies to every connected upstream).
- `mcp-pool --help` prints modes and options (`--help-detailed` prints the setup guide: config examples, modes, logs). See [Sharing](#sharing) for how several agents share one set of upstreams.

## Sharing

The first agent connection starts a **daemon**, a detached local process that owns the upstreams. Every later agent connects to that same daemon instead of spawning its own copies, so N agents cost **1 upstream per pool** rather than N. When the last agent disconnects, the daemon exits after a grace period.

- Pools are keyed by config file, so different configs get different daemons.
- A hard-killed daemon leaves a stale socket; the next agent detects it, removes it, and starts a fresh daemon.
- Pass `--local` to opt out and run a standalone single-process server.

Runtime state lives in `~/.mcp-pool/`, not `/tmp`, so the path is stable regardless of the child environment.

## Config

```yaml
pools:
  brave-search:
    command: bunx
    args: ["-y", "@brave/brave-search-mcp-server@2.1.4"]
    keys:
      - {BRAVE_API_KEY: "sk-first"}
      - {BRAVE_API_KEY: "sk-second"}
    rateLimitPatterns:
      - "rate_limit_exceeded"
      - "too many requests"
```

Pin upstream versions for reproducible cold starts: `args: ["-y", "firecrawl-mcp@3.40.0"]`. An unpinned `bunx -y <pkg>` refloats on every fresh cache, while a `pkg@x.y.z` pin freezes resolution to one cache entry. Verified 2026-11-15 against the local bun cache: `tavily-mcp@0.2.22` (5 tools), `exa-mcp-server@3.4.3` (2 tools), `firecrawl-mcp@3.40.0` (28 tools), `@brave/brave-search-mcp-server@2.1.4` (8 tools; requires an API key even to list tools).

| Field | Description |
|---|---|
| `command` | Executable to spawn (required for stdio) |
| `args` | CLI arguments (stdio only) |
| `keys` | Array of environment-variable objects, one per key (at least 1); values may be literal strings or `${NAME}` references |
| `rateLimitPatterns` | Regex patterns matched against tool error text (required, at least 1 — safety gate) |
| `cooldownSeconds` | Seconds a rate-limited key is skipped; defaults to 300 |
| `cwd` | Working directory for the upstream process (stdio only) |
| `transport` | `stdio` (default), `http`, or `sse` for remote upstreams |
| `url` | Upstream URL (required for http/sse) |
| `headers` | Extra HTTP headers merged under each per-key entry (http/sse only) |
| `env` | Extra environment variables for the upstream process (stdio only) |
| `transientRetry` | Opt-in same-key retries for listed tools whose error text matches (delays in ms, up to 5 attempts) |

Config paths (first found wins): `--config <path>`, `./mcp-pool.yaml`, `./.mcp-pool.yaml`, `~/.config/mcp-pool/mcp-pool.yaml`.

Values support `${VAR}` expansion from environment variables. An undefined reference is a configuration error.

## Web server mode

```bash
mcp-pool --http --port 3000
```

Serves the pooled tools over MCP Streamable HTTP at `http://host:port/mcp`, so remote clients and non-stdio hosts can use the same pools. `GET /health` returns pool count. Bind to `0.0.0.0` (`--host 0.0.0.0`) to accept remote connections; the default `127.0.0.1` is local only.

## Usage

```json
{
  "mcpServers": {
    "mcp-pool": {
      "command": "bunx",
      "args": ["mcp-pool@0.4.0", "--config", "/path/to/mcp-pool.yaml"]
    }
  }
}
```

Tool names are prefixed: `brave-search__brave_web_search`. The client calls the prefixed name; mcp-pool strips the prefix and routes to the correct upstream. Prompts, resources, and completions pass through the same way (resource URIs stay verbatim; the pool is resolved from the prefixed name). `logging/setLevel` applies to every connected upstream — logging level is shared, not per-session.

`bunx mcp-pool` installs a prebuilt platform binary via `optionalDependencies` (version-pinned `@yuzu-octopus/mcp-pool-<platform>`); override with `MCP_POOL_BINARY`. Rebuild it in place with `mcp-pool --rebuild` (needs `bun` + a writable install). Without a matching binary it runs `node dist/index.js` (same flags, slower cold start). Invocation is unchanged.

`--version` prints the version and exits 0. Usage errors (unknown flag, bad `--port`) print `mcp-pool: error: <msg>` to stderr and exit 2 — never a stack trace. `--help`/`-h`, `--help-detailed`, and `--version` exit before any config load or daemon spawn, and processes run as `mcp-pool` (visible in btop/htop).

Without `--verbose`, only `warn`/`error` logs print; pass `--verbose` for per-request trace logs.

## Logging

All logs are JSON lines on stderr (stdout is reserved for MCP protocol):

```json
{"ts":"...","level":"info","pool":"brave-search","event":"upstream_start","keyIndex":0}
{"ts":"...","level":"warn","pool":"brave-search","event":"rate_limited","upstream":0}
{"ts":"...","level":"error","pool":"brave-search","event":"upstream_error","upstream":0,"error":"..."}
```

## Design

- **Lazy failover**: 1 process per pool. Rate-limited/crashed keys are closed and replaced with the next key on demand; rate-limited keys are skipped for `cooldownSeconds` (300 seconds by default).
- **Serialized swaps**: the promise-chain mutex covers only the state swap (spawn, close, cursor move), not the in-flight call, so concurrent callers still reach the upstream in parallel.
- **Shared daemon**: one daemon per config serves every agent, so upstreams are not duplicated per agent. See [Sharing](#sharing).
- **Tool validation**: each spawned upstream's tools are validated against the cached set (by name→schema map, order-independent).
- **`rateLimitPatterns` is required**: without explicit patterns, all `isError` results are terminal — no retries. Use `[".*"]` for blanket retry on read-only pools.
- **Remote upstreams**: `http`/`sse` pools connect over Streamable HTTP/SSE instead of spawning a subprocess, with per-key header objects merged over the static `headers`.

## Development

```bash
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run test
bun run smoke
bun run build
bun run check:package
```

## Releases

Every release publishes 8 packages in lockstep: the 7 `@yuzu-octopus/mcp-pool-<platform>` binaries first, then main (its `optionalDependencies` pins versions that must already exist). Bump all versions together with `scripts/bump-versions.sh <v>`. Primary path is operator-local: CI builds the binaries (`release-binaries.yml`), the operator downloads the artifacts and runs `scripts/publish-all.sh`. The GHP mirror carries the same 8 packages.
