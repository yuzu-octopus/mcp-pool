# Plan 001: Fix `--http` for concurrent requests

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 04bd6ba..HEAD -- src/index.ts src/server.ts test/ package.json .github/workflows/check.yml`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `04bd6ba`, 2026-11-15

## Why this matters

`mcp-pool --http` creates exactly one `StreamableHTTPServerTransport` (with
`sessionIdGenerator: undefined`) and reuses it for every POST to `/mcp`
(`src/index.ts:212-214`, route at `:219-222`). The SDK's server transport
(`node_modules/@modelcontextprotocol/sdk/dist/esm/server/
webStandardStreamableHttp.js`) routes responses through two instance-level
maps, `_streamMapping` and `_requestToStreamMapping` (`:57-58`), keyed by a
per-request `streamId` (`crypto.randomUUID()`, `:466`) and per-message
`message.id` (`:477-485`, `:531`). Most MCP servers build one transport per
session (`buildServer().connect(transport)` per `initialize`, then
`handleRequest` routes by `Mcp-Session-Id`) because a shared instance was
designed for one connection at a time. One shared instance serving many
unrelated clients at once is the SDK's stateless-Javascript-responses and
stateless-SSE examples' shape — but with a shared underlying
`WebStandardStreamableHTTPServerTransport` the risk is response cross-talk
between concurrent POSTs. The safe fix that stays inside the same SDK is:
create one `Server` + `StreamableHTTPServerTransport` per POST, route over
the shared pools, and rely on the existing session header if a client passes
one back (the SDK validates `Mcp-Session-Id` when present, `:441-449`).
This keeps the stateless profile (no `GET` stream, no `DELETE`, no session
store) while removing the shared-maps hazard. The SDK's own stateless
Express example does exactly this (one server + one transport per POST).

## Current state

The relevant files, each with one line on its role:

- `src/index.ts` — entry; `runHttp` (`:205-245`) owns the `--http` wiring
- `src/server.ts` — `buildServer(pools, verbose)` (`:39-119`); pure function
  of the shared pools, already safe to call per request
- `test/` — no `--http` coverage at all (`grep runHttp|StreamableHTTP|/mcp
  src test` matches only `src/index.ts` and a comment)

The code as it exists today:

```ts
// src/index.ts:205-222
async function runHttp(
	loaded: LoadedConfig,
	verbose: boolean,
	port: number,
	host: string,
): Promise<void> {
	const pools = await startPools(loaded.config.pools);
	const transport = new StreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
	});
	await buildServer(pools, verbose).connect(transport);
	...
		if (req.method === "POST" && url.pathname === "/mcp") {
			void transport.handleRequest(req, res);
			return;
		}
```

```ts
// src/server.ts:39-43
export function buildServer(pools: Pool[], verbose: boolean): Server {
	const server = new Server(
		{ name: "mcp-pool", version: packageJson.version },
		{ capabilities: { tools: {} } },
	);
```

Repo conventions that apply here (see `src/pool.ts:305-310` for the
`log({ level, event, pool, ... })` shape, and `test/daemon-sharing.test.ts`
for per-test scratch configs built with `writeFileSync` + `mkdtemp` +
`rmSync(..., { recursive: true, force: true })` in a `finally` block):

- Tests live in `test/` for E2E (spawn the real entry with a helper-server
  config) and `src/*.integration.test.ts` for pool-level behavior.
- Errors that the user must act on are thrown with a plain message; see
  `Error("mcp-pool daemon failed to start: ${status}")` in `src/ipc.ts:132`.

## Commands you will need

| Purpose   | Command                       | Expected on success              |
|-----------|-------------------------------|----------------------------------|
| Typecheck | `bun run typecheck`           | exit 0, no errors                |
| Tests     | `bun run test`                | 30 pass, 0 fail (before) → more  |
| Smoke     | `bun run smoke`               | `smoke: PASSED`                  |
| Lint      | `bun run lint`                | exit 0, no fixes applied         |
| Build     | `bun run build`               | exit 0, `dist/` regenerated      |
| Publish   | `bun run check:package`       | exit 0, no test files in tarball |

## Scope

**In scope** (the only files you should modify):

- `src/index.ts` (the `runHttp` function only)
- `test/http-concurrency.test.ts` (create)

**Out of scope** (do NOT touch, even though they look related):

- `src/server.ts` — `buildServer` is already a pure function of shared pools;
  no change needed there.
- `src/pool.ts`, `src/ipc.ts`, `src/socket-transport.ts` — untouched.
- No GET `/mcp` stream support, no DELETE, no session store, no auth.
  Those are a different feature (real session management), not this fix.
- Do not add `express` or any web framework: the repo has zero web
  dependencies (`package.json` deps: `@modelcontextprotocol/sdk`, `yaml`,
  `zod`). Keep it stdlib `node:http`.

## Git workflow

- Branch: `advisor/001-stateless-http-concurrency`
- Commit per step or per logical unit; message style: conventional commits
  with a short summary first line — e.g. `fix: restore biome-mangled
  generated docs and pin version 0.2.0` (`git log --oneline -3`).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Write a failing concurrency test

Create `test/http-concurrency.test.ts`. Model the structure on
`test/daemon-sharing.test.ts`:

- Build a scratch config with `writeFileSync` + two pools pointing at
  `test/helper-server.ts` (env var documented in `agents.md`: configure
  via `TEST_TOOLS_JSON` to give the two pools distinct tool names so a
  crossed response is detectable by name).
- Spawn `bun run src/index.ts --http --port <free-port> --config <cfg>`
  as a child process, wait for `GET /health` to return 200.
- Fire N=8 concurrent POSTs to `/mcp` (4 `tools/list`, 4 `tools/call`
  against a pool-specific tool), each with `Accept:
  application/json, text/event-stream` and `Content-Type: application/json`.
- Assert every response carries the tool set / result of the pool it
  addressed — no response contains the other pool's tool names.

To find a free port without adding a dependency, bind `port: 0` behavior
manually: pick `port = 18000 + (process.pid % 1000)` and retry once on
`EADDRINUSE` (read the port from the child's stderr log line you add in
step 2: log `mcp-pool http listening on ${host}:${port}` via `log()`).

Expected before the fix: at least under repeated runs, responses mismatch
their requesting pool (or the run hangs past the 30s test timeout). The
test may pass once by luck — run it 3 times (`bun test
test/http-concurrency.test.ts` × 3). **Verify**: `bun test
test/http-concurrency.test.ts` → FAIL (crossed responses) at least once
in 3 runs, or consistently slow/hanging. Record which.

### Step 2: Scope one transport per POST in `runHttp`

In `src/index.ts`, change `runHttp` so the shared state is only the pools:

```ts
const pools = await startPools(loaded.config.pools);
// NO shared transport, NO shared server here.
const http = createHttpServer((req, res) => {
	const url = new URL(req.url ?? "/", "http://127.0.0.1");
	if (req.method === "POST" && url.pathname === "/mcp") {
		const server = buildServer(pools, verbose);
		const transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: undefined,
		});
		void server.connect(transport).then(() => transport.handleRequest(req, res));
		return;
	}
	...
});
```

Keep everything else in `runHttp` byte-identical: the `/health` route, the
404 route, `listen`, and the SIGTERM/SIGINT shutdown that closes pools.

Note: `server.connect(transport)` returns a promise (`src/server.ts:118`
returns `Server`; connect it before handling). If `connect` rejects, reply
500 JSON `{ jsonrpc: "2.0", error: { code: -32000, message: String(err) },
id: null }` so the HTTP client never hangs. Add the `http listening on`
info log line described in step 1.

**Verify**: `bun run typecheck` → exit 0.

### Step 3: Run the concurrency test until green

**Verify**: `bun test test/http-concurrency.test.ts` → pass, 5 consecutive
runs (`for i in 1 2 3 4 5; do bun test test/http-concurrency.test.ts; done`
→ all exit 0). Flaky-once is still failing — 5 clean runs is the bar.

### Step 4: Run the full gate, lint-fix, commit

Run, in order: `bun run lint` (fix with `bunx @biomejs/biome check --write`
only files you touched if it reports fixable issues, then re-run),
`bun run typecheck`, `bun run test`, `bun run smoke`, `bun run build`,
`bun run check:package`.

**Verify**: every command exits 0; `bun run test` shows the previous 30
tests plus your new file's tests, 0 fail.

Commit: `git add src/index.ts test/http-concurrency.test.ts && git commit -m
"fix: scope --http transport per request so concurrent clients cannot share
response state"`.

## Test plan

- New: `test/http-concurrency.test.ts` — 8 concurrent POSTs across 2 pools;
  asserts response↔request pool identity; the regression test for this plan.
- Existing pattern: `test/daemon-sharing.test.ts` (scratch config files,
  child-process spawn, `finally` cleanup with `rmSync recursive`).
- Full suite must stay green: `bun run test` → all pass, including N new tests.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run typecheck` exits 0
- [ ] `bun run test` exits 0; `test/http-concurrency.test.ts` exists and passes 5× consecutively
- [ ] `bun run lint` exits 0 with no fixes applied on a second run
- [ ] `bun run smoke` prints `smoke: PASSED`
- [ ] `bun run build` + `bun run check:package` exit 0
- [ ] `rg -n "const transport = new StreamableHTTPServerTransport" src/index.ts` shows the
  construction inside the request handler, not at `runHttp` top level
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at `src/index.ts:205-222` doesn't match the "Current state"
  excerpt (the codebase has drifted since this plan was written).
- The SDK version in `package.json` is no longer `^1.6.0` / installed
  `1.29.0` — the transport internals this plan relies on may have changed.
- The concurrency test passes 10× in a row *before* the fix (then the
  shared transport is safe for this SDK version; report that instead).
- A step's verification fails twice after a reasonable fix attempt.
- The fix appears to require touching an out-of-scope file.

## Maintenance notes

For the human/agent who owns this code after the change lands:

- Per-request `Server` + transport construction is cheap (measured: the SDK
  objects are in-memory only; the expensive part — upstream spawn +
  handshake, ~200ms — still happens once at daemon/pool startup, not per
  request).
- If sessionful behavior is ever added (GET stream, resumability), this
  per-request shape must be replaced by a session map keyed on
  `Mcp-Session-Id` — see the SDK's `serving/sessions-state-scaling.md`
  pattern. Do not bolt a `Map` onto the per-request shape; rewrite the
  route.
- Reviewer: scrutinize that the 404 and `/health` paths are untouched, and
  that no `Map` or module-level mutable state was introduced.
- Deferred: GET/DELETE on `/mcp`, authentication, rate-limiting the HTTP
  surface itself — all separate features, all out of scope here.
