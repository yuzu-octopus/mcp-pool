# mcp-pool

**MCP Key Pool Proxy** — pool multiple API keys across upstream MCP servers to distribute rate limits.

## Maintained fork

This fork of [yuzu-octopus/mcp-pool](https://github.com/yuzu-octopus/mcp-pool)
includes these fixes:

- Concurrent failures retain the originating client and key index. Late errors
  cannot cool down an unused healthy key or close its replacement client.
- Known unflagged Context7 auth/quota error prefixes can trigger the configured
  failover patterns; arbitrary documentation text does not trigger a retry.
- HTTP mode creates a stateless MCP session per request, with shared pools.
  Repeated and concurrent remote requests no longer reuse an invalid transport.
- Exhaustion diagnostics include quota/auth failures, rather than describing
  every upstream error as a request-frequency limit.
- Opt-in transient retries recover read-only tool calls on the same key,
  without replacing the upstream executable or cooling down healthy keys.

Native installation needs Node.js 22 or newer and npm; Docker is optional:

```sh
git clone https://github.com/artempavlov/mcp-pool.git
cd mcp-pool
npm ci
npm run build
node dist/index.js --local --config /absolute/path/to/mcp-pool.yaml
```

Upstream executables must be installed separately and available through `PATH`
or configured with absolute paths. Keep actual API keys in private runtime
configuration, outside this repository. Tests run with Bun; the CLI runs on Node.

`src/pool.failover.test.ts` covers concurrent/stale failures and Context7 error
classification. `test/http-stateless.test.ts` exercises two real MCP HTTP clients
with repeated requests. No paid service or real API key is needed by these tests.

The optional `Dockerfile` builds this fork with `npm ci` and includes pinned Exa
and Context7 executables. Mount a private YAML config at `/app/mcp-pool.yaml`;
override the command with `--http --host 0.0.0.0 --port PORT --config
/app/mcp-pool.yaml` for HTTP mode. `SOURCE_REVISION` labels the built revision.

## How it works

mcp-pool is itself an MCP server. You configure one or more "pools" — each pool represents one upstream MCP server type (e.g. Brave Search) with N API keys.

- **1 subprocess per pool at a time**, not per key. No warm standby processes.
- On rate-limit or transport error, the current upstream is closed and a new one spawns with the next key (~1-2s failover).
- Tools are exposed with `{poolName}__` prefix to avoid name collisions.
- See [Sharing](#sharing) for how several agents share one set of upstreams.

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
| `transientRetry` | Optional bounded retries for explicitly listed replay-safe tools; see below |

Config paths (first found wins): `--config <path>`, `./mcp-pool.yaml`, `./.mcp-pool.yaml`, `~/.config/mcp-pool/mcp-pool.yaml`.

Values support `${VAR}` expansion from environment variables. An undefined reference is a configuration error.

### Transient network failures

Exa MCP 3.4.2 returns `web_search_exa error: fetch failed` for intermittent
connection failures. Its internal retries cover certain HTTP errors but not
these network failures. Configure retries in the pool while launching Exa directly:

```yaml
pools:
  exa:
    command: exa-mcp-server
    args: []
    keys:
      - {EXA_API_KEY: "${EXA_KEY_1}"}
      - {EXA_API_KEY: "${EXA_KEY_2}"}
    rateLimitPatterns: ['\b(401|402|403|429)\b', '[Bb]udget|[Qq]uota']
    transientRetry:
      tools: [web_search_exa, web_fetch_exa]
      errorPatterns: ['^web_(search|fetch)_exa error: fetch failed$']
      delaysMs: [250, 750, 1500]
```

Retries are disabled by default. All three fields are required when enabled:
nonempty tool names, valid error regexes, and one to five integer delays between
0 and 10000 ms. Each delay permits one additional attempt per key. Only flagged
MCP tool errors matching both the tool allowlist and an error pattern are retried.
List only tools whose calls can be safely replayed. Use narrow error patterns;
successful text and nonmatching failures pass through unchanged.

Calls retry with the same arguments and key. Quota/auth patterns take precedence
and retain normal key failover, even when transient patterns overlap. Backoff
does not hold the swap mutex. If a concurrent caller replaces the client, the
waiting call resumes through normal failover rather than reusing the old client.
After the configured retries, the final upstream result is returned unchanged.
Logs record `transient_retry`, tool, key index, attempt and delay, without
arguments, credentials or raw error text. MCP transport exceptions retain the
existing failover behavior.

This handles the error exposed by Exa at the MCP boundary; it cannot recover
nested network codes that Exa omits, or fix the underlying network connection.
`src/pool.transient.test.ts` covers bounded retries, direct stdio recovery,
quota priority, exclusions and concurrent replacement.

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
      "args": ["mcp-pool@0.2.0", "--config", "/path/to/mcp-pool.yaml"]
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
- **Serialized swaps**: the promise-chain mutex covers only the state swap (spawn, close, cursor move), not the in-flight call, so concurrent callers still reach the upstream in parallel.
- **Shared daemon**: one daemon per config serves every agent, so upstreams are not duplicated per agent. See [Sharing](#sharing).
- **Tool validation**: each spawned upstream's tools are validated against the cached set (by name→schema map, order-independent).
- **`rateLimitPatterns` is required**: without explicit patterns, all `isError` results are terminal — no retries. Use `[".*"]` for blanket retry on read-only pools.
- **Stdio upstreams only**: upstream MCP servers are spawned as subprocesses.

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
