# Plan 005: Serve `--http` on `Bun.serve` instead of `node:http`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 04bd6ba..HEAD -- src/index.ts test/ package.json`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW ( behind a runtime check; node path stays default)
- **Depends on**: plans/001-stateless-http-concurrency.md (build on the
  per-request transport shape, not the shared instance)
- **Category**: perf
- **Planned at**: commit `04bd6ba`, 2026-11-15

## Why this matters

After plan 001, `--http` constructs a `Server` + transport per POST and
routes over shared pools — correct, but still served by `node:http`'s
`createHttpServer`, and the SDK's `StreamableHTTPServerTransport.
handleRequest(req, res)` then converts Node objects to Web Standard
Request/Response and back (`streamableHttp.js:120-143`). That conversion
per request is pure overhead: the transport's real implementation already
speaks Web Standard (`_webStandardTransport.handleRequest`, same file).
`Bun.serve` speaks fetch-native Request/Response directly, so the Node
shim layer disappears. Bun docs (verified in recon): `Bun.serve({ fetch,
port, hostname, idleTimeout })`, per-request `server.timeout(req, seconds)`
(`0` disables — the right call for long SSE/tool-call streams), max
`idleTimeout` 255s. Quantified win is modest on localhost (the conversion
is microseconds against ~200ms upstream calls) — the real value is
removing the Node HTTP stack from the Bun-native path so the `--http`
surface and the compiled binary (plan 004) share one runtime story. Kept
P3 because it is strictly optional polish: node:http works, and this must
not destabilize it.

## Current state

The facts the executor needs, inlined:

- `runHttp` (`src/index.ts:205-245`) after plan 001: `createHttpServer`
  with three routes (`POST /mcp` → per-request transport `handleRequest`,
  `GET /health` → JSON, else 404), `listen(port, host)`, SIGTERM/SIGINT
  shutdown closing pools. `DEFAULT_PORT = 3000`, `DEFAULT_HOST =
  "127.0.0.1"` (`src/index.ts:33-34`).
- Runtime reality: the repo ALWAYS runs under Bun in practice (`bunx
  mcp-pool`, `bun run src/index.ts`, `dev: bun --watch src/index.ts`);
  `start: node dist/index.js` exists but the operator's path is Bun. So a
  `typeof Bun !== "undefined"` branch covers every real invocation, and the
  node path stays as the fallback for anyone running `node dist/`.
- Bun docs verified in recon: `Bun.serve({ fetch(req, server) {},
  port, hostname, idleTimeout })`; `server.timeout(req, 0)` disables the
  idle timeout for streaming responses (default idle close is 10s — a
  long `tools/call` over SSE would otherwise risk a connection reset mid-
  stream; `node:http` has no such default, so this is a behavior gap the
  Bun branch must close explicitly).
- No `--http` test existed before plan 001; plan 001 adds
  `test/http-concurrency.test.ts` against `POST /mcp` + `GET /health` —
  that file is this plan's regression net (it must pass unchanged against
  the Bun branch).

Repo conventions that apply here:

- `log({ level, event, pool, ... })` shapes in `src/types.ts:14-57`.
- Feature branches + conventional-commit messages (`git log --oneline -3`).
- `parseArgs` in `src/index.ts:36-62` throws on unknown args; any new flag
  must be registered there or it fatals.

## Commands you will need

| Purpose   | Command                       | Expected on success              |
|-----------|-------------------------------|----------------------------------|
| Typecheck | `bun run typecheck`           | exit 0, no errors                |
| Tests     | `bun run test`                | all pass (incl. plan-001 tests)  |
| Http test | `bun test test/http-concurrency.test.ts` | pass 5× consecutively |
| Smoke     | `bun run smoke`               | `smoke: PASSED`                  |
| Lint      | `bun run lint`                | exit 0                           |
| Build     | `bun run build`               | exit 0                           |
| Publish   | `bun run check:package`       | exit 0                           |

## Scope

**In scope** (the only files you should modify):

- `src/index.ts` (`runHttp` only, plus one `--http-*` flag registration in
  `parseArgs` if step 1 needs it — see below)
- `test/http-concurrency.test.ts` (plan 001's file — parameterized over
  both servers, no new test file)

**Out of scope** (do NOT touch, even though they look related):

- `src/server.ts`, `src/pool.ts`, `src/ipc.ts`, `src/socket-transport.ts`.
- No new routes, no auth, no GET `/mcp`, no session store (same boundary
  as plan 001).
- No change to the default serve path: node:http stays unless the operator
  opts in (step 1 picks the opt-in shape; default-off is mandatory).
- `package.json` scripts, CI, docs — a P3 does not get a docs campaign; one
  README line only if a new flag is added.

## Git workflow

- Branch: `advisor/005-bun-serve-http`
- Commit per step; message style: conventional commits (`git log
  --oneline -3`).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Confirm plan 001 merged, pick the opt-in shape

`rg -n "new StreamableHTTPServerTransport" src/index.ts` must show the
construction INSIDE the POST handler (plan 001's shape). If it still shows
one shared construction at `runHttp` top level: STOP (dependency unmet).

Then implement the branch as opt-in, default-off. Two shapes — pick the
first that fits without new parsing complexity:

- **Preferred: no flag.** `if (typeof Bun !== "undefined" && Bun.serve)
  { ...Bun.serve path... } else { ...existing node:http path... }`. Zero
  CLI surface, Bun users (everyone real) get it automatically, `node
  dist/` keeps working. `typeof Bun` guard is required because `tsc`
  (`moduleResolution: bundler`, `rootDir: src`) typechecks for node too —
  declare with `declare const Bun: any` in a 3-line local `src/bun-
  serve.ts` shim OR inline `globalThis as any`; do NOT add `@types/bun`
  usage beyond what exists (`@types/bun: latest` is already a devDep, so
  `Bun.serve` types may already resolve — check first; if they do, no
  `any` needed).
- **Fallback: `--http-server bun|node` flag.** Only if the no-flag branch
  proves untestable (e.g. typecheck can't see `Bun.serve` without real
  types). Register in `parseArgs`, default `"node"`.

Record the chosen shape in the commit body (one line + why).

**Verify**: `bun run typecheck` → exit 0 with the branch present.

### Step 2: Implement the `Bun.serve` branch (fetch-native, same three routes)

Mirror the node routes exactly:

```ts
Bun.serve({
	port, hostname: host, idleTimeout: 30,
	async fetch(req) {
		const url = new URL(req.url);
		if (req.method === "POST" && url.pathname === "/mcp") {
			const server = buildServer(pools, verbose);
			const transport = new StreamableHTTPServerTransport({
				sessionIdGenerator: undefined,
			});
			await server.connect(transport);
			// Convert the Web Standard req/res directly: no node shim.
			// transport.handleRequest has a (req, res, parsedBody) node form;
			// for a fetch-native req, call the underlying web-standard
			// transport instead — see streamableHttp.js:128-143 for how the
			// wrapper delegates, and replicate WITHOUT the node conversion.
			...
			return webResponse;
		}
		if (req.method === "GET" && url.pathname === "/health")
			return Response.json({ status: "ok", tools: pools.length });
		return Response.json({ error: `no route ...` }, { status: 404 });
	},
});
```

Two load-bearing details (both from recon — do not skip):

1. **No node conversion**: the wrapper `transport.handleRequest(req, res)`
   takes `IncomingMessage`/`ServerResponse`. The fetch-native path must go
   to the underlying Web Standard transport (the thing at
   `transport._webStandardTransport` in `streamableHttp.js:52`,
   `.handleRequest(webRequest, { authInfo, parsedBody })` at `:136-139`).
   If the installed SDK (check `node_modules/@modelcontextprotocol/sdk/
   package.json` version — recon saw 1.29.0) exposes no public fetch-
   native entry, use the documented public surface only: construct the
   `NodeStreamableHTTPServerTransport` from `@modelcontextprotocol/sdk/
   server/node.js`... but that package path may not exist in 1.29.0.
   Resolve empirically: `ls node_modules/@modelcontextprotocol/sdk/dist/
   esm/server/` and pick the documented export; NEVER reach into
   `_`-private fields from shipped code (`_webStandardTransport` is
   private — using it is a STOP, see below).
2. **`server.timeout(req, 0)`** on the POST route before awaiting the tool
   result (Bun closes idle connections after 10s by default; a slow
   upstream call would otherwise reset mid-stream — node:http has no such
   default, so parity demands the explicit disable).

Shutdown parity: `Bun.serve` returns a server with `.stop()` — wire
SIGTERM/SIGINT to `server.stop()` + the same `Promise.allSettled(pools...
close())` the node path uses.

**Verify**: `bun run typecheck` → exit 0; manual curl: `POST /mcp`
initialize + `tools/list` → same payloads as the node path (diff the two
bodies; they must be identical modulo ordering).

### Step 3: Parameterize plan-001's test over both servers

Extend `test/http-concurrency.test.ts` (do not create a second file): run
its existing 8-concurrent-POST assertion twice — once against the node
server, once against the Bun server (two ports, or an env var the test sets
before spawning: `MCP_POOL_HTTP_SERVER=bun|node` read by a 3-line branch
in `runHttp` — but step 1 preferred no-flag, so instead spawn with the flag
from the fallback shape, or spawn identically and assert which server
handled it via a distinct `Server` header... simplest: if no-flag won,
parameterize by spawning the same command twice on different ports and
asserting both pass — the no-flag branch means BOTH runs exercise Bun, and
node-parity is covered by... nothing. In that case add ONE env-gated
escape: `if (process.env.MCP_POOL_HTTP_NODE === "1")` use node path, test
sets it for the second run. Document the var in a comment, not in README.)

**Verify**: `bun test test/http-concurrency.test.ts` → pass 5×
consecutively (each run now covers both servers).

### Step 4: Full gate, one-line docs touch if flagged, commit

Full gate: lint → typecheck → test → smoke → build → check:package, all
exit 0. If step 1 added a CLI flag, add one line to `README.md` `--http`
section; otherwise no docs change.

Commit: `git add src/index.ts test/http-concurrency.test.ts` (+ README if
touched) → `git commit -m "feat: serve --http on Bun.serve with node:http
fallback" -m "<shape choice + curl parity note>"`.

## Test plan

- Reuse: `test/http-concurrency.test.ts` (plan 001's 8-POST cross-talk
  test), now run against both servers — the regression net for this plan.
- New: none (no new behavior, only a second serving runtime for identical
  behavior).
- Manual: curl parity check in step 2 (bodies identical across servers).
- Full suite green: `bun run test` → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] Plan 001 merged (per-request transport in POST handler)
- [ ] `bun run typecheck`, `lint`, `test`, `smoke`, `build`,
  `check:package` all exit 0
- [ ] `test/http-concurrency.test.ts` passes 5× consecutively, covering
  both servers
- [ ] Manual curl parity recorded in commit body (identical bodies)
- [ ] node:http path still present and reachable (env-gated or default);
  `rg -n "createHttpServer" src/index.ts` still matches
- [ ] No `_`-private SDK field accessed from `src/` (`rg -n
  "_webStandardTransport|_streamMapping|_requestToStreamMapping" src/`
  returns no matches)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Plan 001 is not merged (dependency unmet).
- The installed SDK exposes no public fetch-native server entry (no
  `server/node.js`-style export, no documented web-standard `handleRequest`
  on the public transport) — reaching into `_webStandardTransport` from
  shipped code is forbidden; report the `ls` of the SDK `server/` dir and
  stop. The node:http path is fine as the permanent answer.
- `Bun.serve` streaming responses cannot be held open for slow tool calls
  even with `server.timeout(req, 0)` (measure: a 15s-delayed helper-server
  tool over Bun vs node — if Bun resets and node doesn't, stop and report).
- A step's verification fails twice after a reasonable fix attempt.
- The change requires touching an out-of-scope file.

## Maintenance notes

For the human/agent who owns this code after the change lands:

- Two serving runtimes = two places a route change must land. Any future
  route edit (auth, new endpoint) must be made in BOTH branches — the
  parameterized test only covers existing routes. Consider deleting the
  node branch once the operator is Bun-only for a full release cycle; that
  deletion is its own one-line plan.
- SDK upgrades: re-check the public fetch-native surface; the SDK team is
  actively reshaping these transports (1.29.0 already wraps web-standard
  inside node).
- Reviewer: verify `server.timeout(req, 0)` is on the POST path (missing
  it reintroduces 10s resets), and that shutdown closes pools on both
  branches.
- Deferred: HTTP keep-alive tuning, request logging, TLS termination —
  all separate, all out of scope.
