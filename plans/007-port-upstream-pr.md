# Plan 007: Port upstream PR #1 (failover ownership, transient retries, HTTP/SSE upstreams)

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If any STOP condition occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md` — unless a reviewer dispatched you and told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat 2754d43..HEAD -- src/pool.ts src/server.ts src/config.ts src/types.ts src/index.ts package.json`
> If any in-scope file changed since this plan was written, compare the "Current state" excerpts against the live code before proceeding; on a STOP condition, treat it as a STOP.

## Status

- **Priority**: P1 (slice A) / P2 (slices B, C)
- **Effort**: M (3 independently committable slices: S + M + M)
- **Risk**: MED (touches the failover core; each slice gated by its own tests)
- **Depends on**: main at 2754d43+ (all of 001-006 merged)
- **Category**: correctness (A), feature (B, C)
- **Planned at**: commit `2754d43`, 2026-11-15

## Why this matters

External contributor PR #1 (`artempavlov`, open since 2026-10-18, head `main` of the fork as `pr-1-review` locally) fixes a REAL race our audit missed and adds two capabilities we lack. It cannot merge as-is (DIRTY, predates 001/002/004/005/006, carries fork metadata + an npm/Docker direction we rejected). The honest way to credit the contributor: port the accepted hunks onto current main as new commits with `Co-authored-by: Artem Pavlov <art.pavlov.2012@gmail.com>` and `Ported-from: #1`, then close #1 as superseded-with-credit.

## Current state

The relevant files and what the PR branch holds (inspect via `git show pr-1-review:<path>` — the branch is fetched locally as `pr-1-review`):

- Contributor commits: `295af04` (failover ownership), `16fa6ff` (transient retries), `ec30754` (HTTP/SSE upstream transport), `c1ca1b9` (Dockerfile webscraping pin — REJECT, see below)
- Our main already has: narrowed swap lock, per-request --http transports, compiled-binary re-exec, pinned docs, Bun.serve, full prompts/resources/completions/logging passthrough
- `src/pool.ts` on main has SEVEN unguarded failover sites (`rg -n "markRateLimited\(cooldownSec\)|markFailed\(err\)" src/pool.ts`): routeCall, routePrompt, routeRead, routeSubscribe, routeUnsubscribe, routeComplete, routeSetLevel
- SDK 1.29.0 ships `SSEClientTransport` (`sdk/client/sse.js`) and `StreamableHTTPClientTransport` (`sdk/client/streamableHttp.js`) — verified present in node_modules

## Scope

**In scope:**

- Slice A: failover ownership guard + unflagged-error prefixes + exhaustion text
- Slice B: opt-in transient retries (`transientRetry` config + logic + tests)
- Slice C: HTTP/SSE upstream transports (`transport`/`url`/`headers`/`env` config + `createTransport` factory + tests)
- `src/pool-passthrough.test.ts`, `src/pool.integration.test.ts`, `src/config.test.ts` (new/changed tests)

**Out of scope (REJECTED — do not port, with reasons recorded in plans/README.md):**

- Dockerfile + .dockerignore + webscraping-ai-mcp/brave pins: conflicts with the compiled-binary distribution story (plan 004, Shape A); operator direction is Bun-first, Docker is a separate proposal if ever wanted
- package-lock.json: Bun project uses bun.lock; never introduce an npm lockfile
- npm-ified scripts (`prepare` via npm, `tsc` via npx): our toolchain is Bun (`bun run`, `bun pm pack`)
- fork metadata (`artempavlov/mcp-pool` URLs, version `0.2.1-artem.1`): keep ours; credit travels via Co-authored-by trailers
- Context7/ScrapingAnt vendor-specific docs: keep the regex data, drop the vendor framing where it leaks into user docs
- GET/DELETE 405 + JSON-response mode for --http: our per-request SSE shape (001+005) is the settled design; do not relitigate it here

## Commands you will need

| Purpose   | Command                       | Expected on success              |
|-----------|-------------------------------|----------------------------------|
| Typecheck | `bun run typecheck`           | exit 0, no errors                |
| Tests     | `bun run test`                | all pass (grows per slice)       |
| Smoke     | `bun run smoke`               | `smoke: PASSED`                  |
| Lint      | `bun run lint`                | exit 0, no fixes applied         |
| Build     | `bun run build`               | exit 0                           |
| Publish   | `bun run check:package`       | exit 0                           |
| PR source | `git show pr-1-review:<path>` | read-only reference; never merge |

## Git workflow

- Branch: `advisor/007-port-upstream-pr`
- One commit per slice, each with `Co-authored-by: Artem Pavlov <art.pavlov.2012@gmail.com>` trailer AND `Ported-from: yuzu-octopus/mcp-pool#1` line in the body
- Do NOT push, open a PR, or comment on #1 — the reviewer/operator handles contributor communication

## Steps

### Slice A: failover ownership + unflagged errors + exhaustion text (do first)

1. RED: add a test that reproduces the stale-handle race — two concurrent callers on one client where the loser’s `markFailed` must NOT close the winner’s replacement client or advance the cursor twice. Model on their `pool.failover.test.ts` (`git show pr-1-review:src/pool.failover.test.ts`) but write it against OUR narrowed-lock shape; watch it fail (cursor advances twice / replacement closed).
2. GREEN: port `PreparedCall { client, keyIndex }` + the `if (this.client === prepared.client)` guard into OUR `markRateLimited`/`markFailed`, and thread `prepared` through ALL SEVEN current call sites (routeCall, routePrompt, routeRead, routeSubscribe, routeUnsubscribe, routeComplete, routeSetLevel). Port `UNFLAGGED_ERROR_PREFIX` as a module-level const with the Context7 AND ScrapingAnt alternations (`SCRAPING FAILED`), applied exactly where theirs applies it (unflagged check feeds the same `matchesRateLimit` gate — keep our per-call `new RegExp` hoisting if 006 already did it; otherwise leave construction as-is).
3. Port the exhaustion-diagnostics text change (quota/auth-aware wording instead of pure frequency-limit language).
4. **Verify**: new test passes; full suite green; `bun run typecheck` clean.
5. Commit: `fix: guard failover against stale clients, classify unflagged upstream errors` + Co-authored-by + Ported-from trailers.

### Slice B: opt-in transient retries (independent of A)

1. RED: port their `pool.transient.test.ts` cases adapted to our config/test layout (config validation tests go in `src/config.test.ts` alongside existing schema tests): unknown-tool rejection, nonmatching-pattern passthrough, bounded retries with same args/client/key, quota-pattern priority over transient patterns, client-replacement-during-backoff resumes via failover.
2. GREEN: port `transientRetry` config schema (`tools[]`, `errorPatterns[]`, `delaysMs[]`, disabled-by-default, validation: 1-5 attempts, 0-10000ms delays) and the retry loop exactly as specified: requires listed tool AND matching pattern, same args/client/key, waits OUTSIDE the swap mutex, abandons the captured client if replaced mid-backoff, returns final result unchanged.
3. **Verify**: ported tests pass; full suite green.
4. Commit: `feat: opt-in transient retries without rotating healthy keys` + trailers.

### Step C: HTTP/SSE upstream transports (independent of A/B)

1. RED: port their `pool.http.test.ts` cases (config validation: url required for http/sse, command forbidden; handshake against a local HTTP MCP server fixture — check how their test fixtures it; reuse the pattern).
2. GREEN: port config schema additions (`transport` enum default `stdio`; `url`, `headers`, `env` optional; conditional validation per transport in `superRefine`), `createTransport` factory (stdio/http/sse, keys as headers for remote), and transport-exception rate-limit matching (`matchesRateLimit` on caught error text → `markRateLimited` instead of `markFailed`).
3. **Verify**: ported tests pass; full suite green; `bun run check:package` clean (no new deps — SDK already provides all three transports).
4. Commit: `feat: http/sse upstream transports with per-key headers` + trailers.

### Final pass

Run the FULL gate (lint → typecheck → test → smoke → build → check:package), all exit 0. Update `agents.md` Config shape (add `transport`/`url`/`headers`/`env` rows, one line each; mark `transientRetry` as opt-in) and `README.md` Config table likewise — docs ONLY for fields actually shipped.

**Verify**: full gate green; `git status` shows only in-scope files.

## Test plan

- Ported-and-adapted: failover ownership test, unflagged-error classification tests, transient retry suite, HTTP/SSE transport suite, config validation tests
- New: URI-map collision is unaffected (no shared code); passthrough suite must stay green unchanged
- Regression net: full `bun run test` after every slice commit

## Done criteria

- [ ] Slices A, B, C each committed separately with Co-authored-by + Ported-from trailers
- [ ] `bun run typecheck`, `lint`, `test`, `smoke`, `build`, `check:package` all exit 0
- [ ] No files outside the in-scope list (`git status`)
- [ ] No npm/Docker/lockfile/fork-metadata artifacts introduced (`rg -l "package-lock|Dockerfile|artempavlov" --glob '!plans/**'` empty)
- [ ] `plans/README.md` status row updated

## STOP conditions

- The `pr-1-review` branch is gone or its SHAs differ from recon (`295af04`, `16fa6ff`, `ec30754`, `c1ca1b9`) — re-fetch `origin pull/1/head` and reassess.
- SDK no longer exports one of the three client transports — report, do not polyfill.
- Any slice's ported tests fail against current main for architectural reasons (not mere drift) — report the mismatch instead of redesigning the slice.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- The `client === prepared.client` guard and 006's teardown `close()` interact: a replaced client that is ALSO closed by teardown is fine (close is idempotent via closeCurrent's `if (this.client)` — verify this invariant holds in review).
- Transient-retry delays run outside the swap mutex by design; a retry storm across many concurrent callers is bounded by `delaysMs` length, not by concurrency — acceptable per the plan's opt-in framing, flag in review if abused.
- HTTP/SSE upstreams put API keys in headers per key-entry — never log headers; the existing no-raw-args rule covers tool args, extend the same care to header values in any new log line.
