# mcp-pool

**MCP Key Pool Proxy** — pool multiple API keys across upstream MCP servers to distribute rate limits.

## Problem

Rate-limited third-party MCP servers (Brave Search, Exa, SerpAPI, etc.) cap requests per API key. If you have multiple accounts, you need to pool keys and auto-route requests so no single key exhausts prematurely.

## How it works

mcp-pool is itself an MCP server. You configure one or more "pools" — each pool represents one upstream MCP server type (e.g. Brave Search) with N API keys. For each key, mcp-pool spawns an upstream MCP subprocess, connects via stdio, and exposes that pool's tools prefixed with `{poolName}__`.

When a client calls a tool, mcp-pool:
1. Strips the pool prefix to identify the target pool and real tool name
2. Selects an available upstream using the configured strategy (round-robin or deplete-first)
3. Forwards the call
4. On rate-limit errors (matched against configurable patterns), marks that upstream as rate-limited and retries the next one
5. On transport errors (process crash), marks the upstream dead after N consecutive failures
6. Periodically checks cooldown timers to re-activate rate-limited upstreams

## Config

```yaml
pools:
  brave-search:
    command: npx
    args: ["-y", "@anthropic/mcp-server-brave-search"]
    keys:
      - {BRAVE_API_KEY: "sk-first-key"}
      - {BRAVE_API_KEY: "sk-second-key"}
    strategy: round-robin           # or "deplete-first"
    cooldownSeconds: 300
    rateLimitPatterns:
      - "rate_limit_exceeded"
      - "too many requests"
    maxConsecutiveErrors: 3
```

| Field | Default | Description |
|---|---|---|
| `command` | — | Executable to spawn (required) |
| `args` | `[]` | CLI arguments |
| `keys` | — | Array of env-var objects, one per upstream (at least 1) |
| `strategy` | — | `"round-robin"` or `"deplete-first"` |
| `cooldownSeconds` | `300` | How long a rate-limited key sits out before re-entering rotation |
| `rateLimitPatterns` | — | Regex patterns matched against tool error text (required, at least 1 — safety gate) |
| `maxConsecutiveErrors` | `3` | Consecutive transport failures before marking upstream dead |
| `cwd` | — | Working directory for the upstream process |

Config paths (first found wins): `--config <path>`, `./mcp-pool.yaml`, `./.mcp-pool.yaml`, `~/.config/mcp-pool/mcp-pool.yaml`.

Values support `${VAR}` expansion from environment variables.

## Usage

```json
{
  "mcpServers": {
    "mcp-pool": {
      "command": "mcp-pool",
      "args": ["--config", "/path/to/mcp-pool.yaml"]
    }
  }
}
```

Tool names are prefixed: `brave-search__brave_web_search`. The client calls the prefixed name; mcp-pool strips the prefix and routes to the correct upstream.

Pass `--verbose` for per-request trace logs.

## Strategies

- **round-robin**: cycles through available upstreams. Cursor advances on success and rate-limit, stays unchanged on transport error.
- **deplete-first**: always picks the first available upstream in config order. Consumes keys sequentially — useful when you want to burn through a free tier before touching a paid key.

## Logging

All logs are JSON lines on stderr (stdout is reserved for MCP protocol):

```json
{"ts":"...","level":"info","pool":"brave-search","event":"upstream_start","keyIndex":0}
{"ts":"...","level":"warn","pool":"brave-search","event":"rate_limited","upstream":0,"cooldownUntil":"..."}
{"ts":"...","level":"error","pool":"brave-search","event":"upstream_dead","upstream":2,"consecutiveErrors":3}
```

## Design constraints

- **Stdio upstreams only**: upstream MCP servers are spawned as subprocesses.
- **Single-threaded**: Bun's event loop serializes requests — no locks needed on strategy state.
- **No persistent state**: cooldown timers and error counts reset on restart.
- **`rateLimitPatterns` is required**: without explicit patterns, all `isError` results are terminal — no retries. Use `[".*"]` for blanket retry on read-only pools.

## Development

```bash
bun install
bun test          # 29 tests (unit + integration + E2E)
bun run test/smoke-test.ts   # E2E with test helper server
bun run src/index.ts --config test/smoke.yaml  # run proxy
```
