# mcp-pool

MCP server that pools API keys across upstream MCP servers. List each upstream once with N keys; clients see one server and rate limits spread across the keys.

## How it works

Each pool keeps one upstream connection at a time. A rate-limited or crashed key is closed and replaced with the next key on demand. Tools, prompts, resources, and completions pass through with a `{pool}__` prefix. Resource URIs stay verbatim. `logging/setLevel` applies to every connected upstream.

The first agent connection starts a shared daemon that owns the upstreams, so N agents cost 1 upstream per pool instead of N. The last agent out stops the daemon after a grace period. Pass `--local` for a standalone server. Runtime state lives in `~/.mcp-pool/`.

## Config

```yaml
pools:
  # Spawns a local subprocess per pool (stdio is the default transport).
  brave-search:
    command: bunx
    args: ["-y", "brave-search-mcp-server@1.0.0"]
    keys:
      - {BRAVE_API_KEY: "sk-first"}
      - {BRAVE_API_KEY: "sk-second"}
    rateLimitPatterns:
      - "rate_limit_exceeded"
      - "too many requests"
  # Connects to a remote server instead of spawning (no subprocess).
  firecrawl-cloud:
    transport: http
    url: "https://api.firecrawl.dev/mcp"
    headers: {Authorization: "Bearer ${FIRECRAWL_API_KEY}"}
    keys:
      - {Authorization: "Bearer sk-first"}
      - {Authorization: "Bearer sk-second"}
    rateLimitPatterns:
      - "429"
```

Pin upstream versions (`pkg@x.y.z`). An unpinned `bunx -y <pkg>` refloats on every fresh cache.

| Field | Meaning |
|---|---|
| `command`, `args`, `cwd`, `env` | What to spawn (stdio only) |
| `transport` | `stdio`, `http`, or `sse` |
| `url`, `headers` | Where to connect (http/sse only); per-key entries merge over `headers` |
| `keys` | One env/header object per key, at least 1; values may be `${VAR}` |
| `rateLimitPatterns` | Required regex list matched against tool error text; no match means no retry, use `[".*"]` for blanket retry on read-only pools |
| `cooldownSeconds` | Skip a rate-limited key this long; default 300 |
| `transientRetry` | Opt-in same-key retries for listed tools (delays in ms, up to 5) |

Config file lookup: `--config <path>`, `./mcp-pool.yaml`, `./mcp-pool.yml`, `./.mcp-pool.yaml`, `./.mcp-pool.yml`, then the global config dir. `${VAR}` expands from the environment; an undefined variable is an error.

## Usage

```json
{
  "mcpServers": {
    "mcp-pool": {
      "command": "bunx",
      "args": ["mcp-pool@latest", "--config", "/path/to/mcp-pool.yaml"]
    }
  }
}
```

Tool names arrive prefixed (`brave-search__brave_web_search`); the client calls the prefixed name and mcp-pool routes it.

`bunx mcp-pool` installs a prebuilt platform binary. Without a matching binary it runs `node dist/index.js` instead (same flags, slower start). `mcp-pool --rebuild` compiles the binary in place (needs `bun`). `MCP_POOL_BINARY` overrides the lookup.

`--help` and `--version` exit before any config load. Usage errors print `mcp-pool: error: <msg>` to stderr and exit 2. Without `--verbose`, only `warn` and `error` logs print.

## HTTP mode

```bash
mcp-pool --http --port 3000
```

Serves the pools over Streamable HTTP at `/mcp` (`GET /health` reports pool count). Default bind is local only; `--host 0.0.0.0` opens it up.

## Logging

JSON lines on stderr:

```json
{"ts":"...","level":"warn","pool":"brave-search","event":"rate_limited","upstream":0}
```

## Development

```bash
scripts/gate.sh            # lint, typecheck, test, smoke, build, package check
scripts/release.sh <v>     # bump, rebuild binaries, gate, commit, tag, push
scripts/publish-all.sh     # publish all 8 packages (needs human npm OTP)
scripts/verify-release.sh <v>
```

## Releases

Each release publishes 8 packages in lockstep: 7 `@yuzu-octopus/mcp-pool-<platform>` binaries, then main (its `optionalDependencies` pins versions that must already exist). `scripts/bump-versions.sh` moves versions and pins together; `scripts/check-versions.sh` gates every publish on that. CI builds the binaries; publishing stays local.
