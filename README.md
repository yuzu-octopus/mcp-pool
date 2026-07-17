# mcp-pool

**MCP Key Pool Proxy** — pool multiple API keys across upstream MCP servers to distribute rate limits.

## How it works

mcp-pool is itself an MCP server. You configure one or more "pools" — each pool represents one upstream MCP server type (e.g. Brave Search) with N API keys.

- **1 subprocess per pool at a time**, not per key. No warm standby processes.
- On rate-limit or transport error, the current upstream is closed and a new one spawns with the next key (~1-2s failover).
- Tools are exposed with `{poolName}__` prefix to avoid name collisions.
- Route calls are serialized via a promise-chain mutex to prevent state races.

## Config

```yaml
pools:
  brave-search:
    command: bunx
    args: ["-y", "@brave/brave-search-mcp-server"]
    keys:
      - {BRAVE_API_KEY: "sk-first"}
      - {BRAVE_API_KEY: "sk-second"}
    rateLimitPatterns:
      - "rate_limit_exceeded"
      - "too many requests"
```

| Field | Description |
|---|---|
| `command` | Executable to spawn (required) |
| `args` | CLI arguments |
| `keys` | Array of environment-variable objects, one per key (at least 1); values may be literal strings or `${NAME}` references |
| `rateLimitPatterns` | Regex patterns matched against tool error text (required, at least 1 — safety gate) |
| `cooldownSeconds` | Seconds a rate-limited key is skipped; defaults to 300 |
| `cwd` | Working directory for the upstream process |

Config paths (first found wins): `--config <path>`, `./mcp-pool.yaml`, `./.mcp-pool.yaml`, `~/.config/mcp-pool/mcp-pool.yaml`.

Values support `${VAR}` expansion from environment variables. An undefined reference is a configuration error.

## Usage

```json
{
  "mcpServers": {
    "mcp-pool": {
      "command": "bunx",
      "args": ["mcp-pool@0.1.4", "--config", "/path/to/mcp-pool.yaml"]
    }
  }
}
```

Tool names are prefixed: `brave-search__brave_web_search`. The client calls the prefixed name; mcp-pool strips the prefix and routes to the correct upstream.

Pass `--verbose` for per-request trace logs.

## Logging

All logs are JSON lines on stderr (stdout is reserved for MCP protocol):

```json
{"ts":"...","level":"info","pool":"brave-search","event":"upstream_start","keyIndex":0}
{"ts":"...","level":"warn","pool":"brave-search","event":"rate_limited","upstream":0}
{"ts":"...","level":"error","pool":"brave-search","event":"upstream_error","upstream":0,"error":"..."}
```

## Design

- **Lazy failover**: 1 process per pool. Rate-limited/crashed keys are closed and replaced with the next key on demand; rate-limited keys are skipped for `cooldownSeconds` (300 seconds by default).
- **Serialized calls**: promise-chain mutex prevents races on shared state across `await` points.
- **Tool validation**: each spawned upstream's tools are validated against the cached set (by name→schema map, order-independent).
- **`rateLimitPatterns` is required**: without explicit patterns, all `isError` results are terminal — no retries. Use `[".*"]` for blanket retry on read-only pools.
- **Stdio upstreams only**: upstream MCP servers are spawned as subprocesses.

## Development

```bash
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run smoke
bun run build
bun run check:package
```
