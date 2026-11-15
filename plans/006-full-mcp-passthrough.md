# Plan 006: Pass through prompts, resources, completions, logging

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 04bd6ba..HEAD -- src/pool.ts src/server.ts src/types.ts test/ package.json`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition. NOTE: plans 001/002/004/005 touch
> src/index.ts, src/ipc.ts, test/http-concurrency.test.ts — this plan does
> NOT touch those files. If any merged branch has since modified
> src/pool.ts, src/server.ts, or src/types.ts, STOP (underlying shape changed).

## Status

- **Priority**: P1 (operator request: "mcp pool is supposed to fully support
  all mcp things")
- **Effort**: M
- **Risk**: MED (new handlers on the shared path; routing mistakes cross pools)
- **Depends on**: none for code (touches pool.ts/server.ts/types.ts only);
  merge AFTER 001–005 (independent files, but rebase onto merged main first)
- **Category**: direction (completeness — the proxy drops real upstream
  capabilities today)
- **Planned at**: commit `04bd6ba`, 2026-11-15

## Why this matters

mcp-pool advertises `capabilities: { tools: {} }` only
(`src/server.ts:42`) and handles only `tools/list` + `tools/call`. Measured
2026-11-15 against the operator's real upstreams: exa advertises
`prompts + resources`, firecrawl advertises `logging + completions` — all
four are silently dropped. No error, just absent. The operator's goal: every
capability a configured server exposes is reachable through the pool, with
the same `pool__` prefix discernment tools already use.

## Current state

The relevant files, each with one line on its role:

- `src/server.ts` — `buildServer(pools, verbose)` (`:39-119`); pure function
  of shared pools; owns the two tool handlers + prefix routing
- `src/pool.ts` — `Pool` class; `cachedTools` + `findToolMismatch`
  validation on every spawn (`:290-300`); `routeCall` for tools (`:58-118`)
- `src/types.ts` — `LogEvent` union (`:14-57`); every log line is typed here

The code as it exists today (tools pattern to mirror):

```ts
// src/server.ts:39-43, 45-70, 72-116 (abridged)
export function buildServer(pools: Pool[], verbose: boolean): Server {
	const server = new Server(
		{ name: "mcp-pool", version: packageJson.version },
		{ capabilities: { tools: {} } },
	);
	server.setRequestHandler(ListToolsRequestSchema, async () => {
		// for each pool: tools.push({ name: prefix + tool.name, ... })
	});
	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		// split poolName__toolName, pools.find, pool.routeCall(...)
	});
```

SDK surface verified in recon (installed 1.29.0):

- Schemas: `ListPromptsRequestSchema`, `GetPromptRequestSchema`,
  `ListResourcesRequestSchema`, `ListResourceTemplatesRequestSchema`,
  `ReadResourceRequestSchema` (all in `types.js`, `ZodObject`s).
- Client methods: `listPrompts`, `getPrompt`, `listResources`,
  `listResourceTemplates`, `readResource`, `complete`, `setLoggingLevel`,
  `subscribeResource`, `getServerCapabilities` (all in `client/index.d.ts`).
- Server notifications: `sendResourceListChanged`,
  `sendToolListChanged`, `sendPromptListChanged` (`server/index.js:428+`).
- `WebStandardStreamableHTTPServerTransport` is a public export
  (plan 005 uses it) — no new transport work needed.

## Design decisions (locked — do not relitigate)

1. **Prompts = tools shape exactly.** Flat names → `pool__name` prefix on
   `prompts/list`; `prompts/get` splits prefix, routes to
   `pool.routePrompt(name, args)` (new `Pool` method mirroring `routeCall`
   WITHOUT rate-limit retry — prompts are not rate-limited reads; on
   transport error, fail over once like `markFailed`, then return error).
   No new config: prompts ride the existing pool keys.
2. **Resources = URI→pool map, not URI rewriting.** `resources/list` returns
   upstream `{uri, name}` entries with the `name` prefixed
   (`pool__name`) but the `uri` VERBATIM (rewriting breaks opaque
   `exa://`/`file://` schemes). `buildServer` keeps a per-build
   `Map<uri, pool>` from the last list; `resources/read` and
   `resources/subscribe` look the URI up in the map and route to that pool's
   `routeRead(uri)` / `routeSubscribe(uri)`. Unknown URI → `isError`
   "Unknown resource". Map staleness on key rotation: acceptable (same
   tolerance as cached tools; mismatch validation keeps the set stable).
   Same for `resourceTemplates` (prefix `name`, verbatim `uriTemplate`).
3. **Capabilities advertised = union of what pools offer.** `buildServer`
   declares `prompts: {}` / `resources: {}` caps ONLY when ≥1 pool's
   `getServerCapabilities()` includes them (read at `startPools` time via
   the pool Client after handshake; cache on the Pool as
   `upstreamCapabilities`). Never advertise a category no pool has (else
   agents see empty lists). `listChanged: true` on all advertised
   categories.
4. **`list_changed` forwarding (chatty-correct v1).** When any pool's Client
   receives `notifications/{tools,prompts,resources}/list_changed`, the pool
   records a dirty flag; every `buildServer` session polls the flag on each
   list request is WRONG (stale). Correct v1: each `Server` instance created
   by `buildServer` subscribes once (at build time) to a per-process
   emitter the pools share; on fire, it calls the matching
   `send*ListChanged()`. Pool→sessions fan-out lives in `server.ts` as a
   15-line `Map<poolName, Set<Server>>` registry with deregistration on
   session close (`transport.onclose`). No payload filtering in v1.
5. **`completion/complete` routed by ref.** `complete` params carry
   `{ref: {type: 'ref/prompt'|'ref/resource', name|uri}, ...}`. Prompt refs:
   split `pool__name` like tools. Resource refs: URI→pool map lookup.
   New `pool.routeComplete(params)` mirroring routeCall without retry.
6. **`logging/setLevel` applies to all connected upstreams.** No routable
   field exists; upstream is shared across sessions. `pool.routeSetLevel
   (level)` forwards to the current client (best-effort; no retry). Document
   as shared-state in README (one line).
7. **Server→client features untouched.** Sampling, elicitation, roots are
   negotiated between upstream and mcp-pool-as-client automatically by the
   SDK `Client`; mcp-pool-as-server negotiates separately with the agent.
   No code needed; assert nothing about them.
8. **Same validation for new caches.** `cachedPrompts`, `cachedResources`
   (+templates) validated with the existing `findToolMismatch` shape
   (rename to `findSchemaMismatch` or generalize — executor's call, keep the
   name→schema order-independent comparison). Mismatch → same close+throw.

## Commands you will need

| Purpose   | Command                       | Expected on success              |
|-----------|-------------------------------|----------------------------------|
| Typecheck | `bun run typecheck`           | exit 0, no errors                |
| Tests     | `bun run test`                | all pass (grows with new tests)  |
| Smoke     | `bun run smoke`               | `smoke: PASSED`                  |
| Lint      | `bun run lint`                | exit 0, no fixes applied         |
| Build     | `bun run build`               | exit 0, `dist/` regenerated      |
| Publish   | `bun run check:package`       | exit 0                           |

## Scope

**In scope** (the only files you should modify):

- `src/pool.ts` (new caches + routePrompt/routeRead/routeSubscribe/
  routeComplete/routeSetLevel + capability cache)
- `src/server.ts` (new handlers + union caps + URI map + list_changed fan-out)
- `src/types.ts` (new LogEvent variants for the new routes)
- `test/helper-server.ts` (extend: serve a prompt + resource + complete
  when env-configured, mirroring TEST_TOOLS_JSON pattern)
- `src/pool-passthrough.test.ts` (create) or extend
  `src/pool.integration.test.ts` — executor's call, one file

**Out of scope** (do NOT touch, even though they look related):

- `src/index.ts`, `src/ipc.ts`, `src/socket-transport.ts`, `src/config.ts`,
  `src/logger.ts` — no changes (capabilities flow through existing config).
- `test/http-concurrency.test.ts`, `src/ipc.test.ts` — other plans' files.
- Sampling/elicitation/roots handlers — nothing to do (decision 7).
- `package.json`, CI, docs — one README subsection at the end ONLY if all
  gates pass (describe new categories + logging-shared note); no
  `project.toml` change (no new user-facing config).

## Git workflow

- Branch: `advisor/006-full-mcp-passthrough`
- Worktree: create fresh from merged main (after 001–005 land), NOT from
  04bd6ba — the drift check covers pool/server/types which 001–005 do not
  touch, but rebase anyway so tests run against final code.
- Commit per slice (prompts → resources → completions/logging), message
  style: conventional commits (`git log --oneline -3`).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Prompts slice (same shape as tools)

1. `src/pool.ts`: add `cachedPrompts`, validate in `spawnUpstream` with the
   generalized mismatch fn; add `upstreamCapabilities` cache (set from
   `client.getServerCapabilities()` after handshake); add `routePrompt`
   (mirror routeCall minus rate-limit retry: try current → transport error
   → markFailed once → error result).
2. `src/server.ts`: advertise `prompts: { listChanged: true }` iff any pool
   has the cap; `prompts/list` prefixes names; `prompts/get` splits prefix
   → `pool.routePrompt`. Invalid name → same isError shape as tools.
3. `src/types.ts`: add prompt route log variant (mirror `route` event).
4. Extend `test/helper-server.ts`: `TEST_PROMPTS_JSON` env (mirror
   `TEST_TOOLS_JSON`); serve `prompts/list` + `prompts/get` echo.
5. Tests: prompts list shows `pool__` names from two pools; get routes by
   prefix; unknown prompt → isError.

**Verify**: `bun run typecheck` → 0; new tests pass; full suite green.

### Step 2: Resources slice (URI map + subscribe)

1. `src/pool.ts`: `cachedResources` + `cachedTemplates` validated same way;
   `routeRead(uri)`, `routeSubscribe(uri)`/`routeUnsubscribe(uri)` (direct
   client passthrough, fail-over once on transport error like prompts).
2. `src/server.ts`: advertise `resources: {}` iff offered; `resources/list`
   + `resources/templates/list` prefix `name`, verbatim URI; per-build
   `Map<uri, pool>`; `resources/read`/`subscribe`/`unsubscribe` via map;
   unknown URI → isError "Unknown resource".
3. `src/types.ts`: resource route log variants.
4. Helper: `TEST_RESOURCES_JSON` (list of `{uri, name}`); serve list/read/
   subscribe echo.
5. Tests: list shows prefixed names + verbatim URIs; read routes via map;
   unknown URI → isError; subscribe round-trips.

**Verify**: typecheck 0; new tests pass; full suite green.

### Step 3: Completions + logging + list_changed fan-out

1. `src/pool.ts`: `routeComplete(params)` — prompt refs split prefix,
   resource refs map-lookup (needs the URI map: move it from per-build to
   per-POOL, updated on every list — refactor step-2 map into
   `pool.resolvePoolForUri(uri)`; server.ts calls it).
2. `src/server.ts`: `completion/complete` handler routing via (1);
   `logging/setLevel` → forward to every pool's current client
   (best-effort, `Promise.allSettled`); list_changed fan-out registry
   (`Map<poolName, Set<Server>>`, deregister on close) + subscribe at build
   time to pool emitter; call `send*ListChanged()` on fire.
3. `src/pool.ts`: pool Client `setNotificationHandler` for the three
   list_changed methods → fire the shared emitter.
4. Tests: complete routes prompt-ref by prefix; setLevel reaches upstream
   (helper records level); list_changed from upstream surfaces as pool
   notification (assert via test client notification handler).
5. README subsection (only now): new categories + logging-shared one-liner.

**Verify**: typecheck 0; new tests pass; FULL gate
(lint→typecheck→test→smoke→build→check:package) all 0.

Commit per slice; final commit message records upstream capability evidence
(exa prompts+resources, firecrawl logging+completions, measured 2026-11-15).

## Test plan

- Extend `test/helper-server.ts` with `TEST_PROMPTS_JSON` /
  `TEST_RESOURCES_JSON` (mirror `TEST_TOOLS_JSON` pattern documented in
  agents.md).
- New tests in `src/pool-passthrough.test.ts` (or extended integration
  file): per-slice list/get/read/subscribe/complete/setLevel +
  unknown-name/URI errors + mismatch validation for new caches.
- Regression: FULL suite must stay green throughout (each slice commits
  green independently).
- Manual: against real exa (`prompts/list` shows `exa__*`; firecrawl
  `logging/setLevel` accepted) — record outputs in final commit body.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run typecheck`, `lint`, `test`, `smoke`, `build`,
  `check:package` all exit 0
- [ ] `prompts/list`, `resources/list`, `completion/complete`,
  `logging/setLevel` all reachable through the pool against helper-server
- [ ] Real-upstream manual check recorded (exa prompts, firecrawl logging)
- [ ] No `_`-private SDK access from `src/` (same rg as plan 005)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `src/pool.ts` / `src/server.ts` / `src/types.ts` differ from the "Current
  state" excerpts (post-merge drift from 001–005 — rebase first, then
  reassess).
- The SDK Client lacks any method step 1–3 needs (listPrompts, readResource,
  complete, setLoggingLevel, setNotificationHandler) — version drift; report
  the installed version.
- URI→pool map proves unworkable (e.g. two pools serve the same URI and the
  map collides) — report the collision; do NOT invent URI rewriting without
  asking.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- The URI map is the load-bearing new state: on key rotation the map can
  point at a stale pool cursor — tolerated by design (same as cached tools),
  but if phantom-resource reports arrive, the map is the first suspect.
- list_changed fan-out is chatty by design (any upstream change notifies all
  sessions to re-list). If this ever causes storms, add per-category
  filtering — separate plan.
- Reviewer: cross-pool routing mistakes are the catastrophic failure (exa
  prompt served as firecrawl's). Scrutinize every split/lookup for the
  unknown-pool/unknown-URI error path.
- Deferred: sampling/elicitation/roots (no-op by design), per-category
  list_changed filtering, logging-level per-session isolation.
