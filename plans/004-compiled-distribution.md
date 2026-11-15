# Plan 004: Ship a compiled `mcp-pool` binary via bunx

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 04bd6ba..HEAD -- package.json src/ipc.ts src/index.ts .github/workflows/check.yml .github/workflows/publish-ghp.yml README.md project.toml`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (packaging + CI matrix; the code change is small)
- **Depends on**: plans/002-compiled-daemon-reexec.md
- **Category**: migration
- **Planned at**: commit `04bd6ba`, 2026-11-15

## Why this matters

Today `bunx mcp-pool` downloads the npm tarball (compiled `dist/*.js` +
SDK + yaml + zod, ~110MB `node_modules` at install time), then every agent
session pays: bunx resolution (~200ms warm, ~500ms+ cold) + `bun run`-style
startup that transpiles 304 modules on the fly. A `bun build --compile`
binary is one ~85MB file, starts with no transpile step, no dependency
install, no 304-module graph — the daemon, the proxy, and every upstream
`bunx` shim stay as they are, but mcp-pool's own startup collapses to exec
+ listen. Measured this session: compile takes ~130ms; the binary runs and
serves a daemon correctly (socket + `ready` + upstream spawn verified), but
the default proxy mode is broken until plan 002 lands (re-exec bug). This
plan makes the binary the thing bunx installs, keeping `bunx mcp-pool`
invocation byte-identical for the operator (`~/.omp/agent/mcp.json` uses
`mcp-pool@latest` — no config change).

## Current state

The facts the executor needs, inlined:

- `package.json`: `bin: { "mcp-pool": "dist/index.js" }`, `files:
  ["dist/", "README.md"]`, scripts `build: rm -rf dist && tsc`, `start:
  node dist/index.js`, `prepare: bun run build`. Deps:
  `@modelcontextprotocol/sdk ^1.6.0` (installed 1.29.0), `yaml ^2.7.1`,
  `zod ^3.24.4`. DevDeps: `@biomejs/biome ^2`, `@types/bun latest`,
  `typescript ^5.7.0`.
- `dist/index.js:1` is `#!/usr/bin/env node` + 225 lines of compiled JS
  with `.d.ts`/`.map` siblings — the npm tarball ships all of it
  (`bun pm pack --dry-run` verified this session: 1.30KB package.json +
  dist set + README).
- `src/index.ts:1` is `#!/usr/bin/env node`; `spawnDaemon`
  (`src/ipc.ts:173`) uses `spawn(process.execPath, ...)` — under a
  compiled binary `process.execPath` IS the binary, which is exactly what
  plan 002's fix relies on. Type-only imports (`import type ...`) compile
  away; the only runtime Node imports are `node:fs/os/path/crypto/net/
  http/child_process` — all available in the compiled runtime.
- CI: `check.yml` runs install→lint→typecheck→test→smoke→build→
  check:package on ubuntu-latest via `oven-sh/setup-bun@v2`. `publish-
  ghp.yml` mirrors to GitHub Packages on `v*` tags. npm publish is manual
  (operator runs `npm publish` locally; tokens stay off GitHub).
- Bun docs (verified this session): `bun build --compile` supports
  `--target bun-darwin-arm64 bun-darwin-x64 bun-linux-x64(-musl)
  bun-linux-arm64 bun-windows-x64`; without `--target` it compiles for the
  current platform. `postinstall`/`prepare` scripts that run at install
  time CAN build per-platform, but `bunx` runs the package binary from the
  cache — a single tarball cannot carry per-platform binaries selected at
  install time without `optionalDependencies` per platform.

Repo conventions that apply here:

- Verification gate order: lint → typecheck → test → smoke → build →
  check:package (see `check.yml:18-24`).
- Never hand-edit `docs/index.html` (CI regenerates from `project.toml`).
- Commit style: conventional commits, short first line (`git log
  --oneline -3`).

## Commands you will need

| Purpose   | Command                       | Expected on success              |
|-----------|-------------------------------|----------------------------------|
| Install   | `bun install --frozen-lockfile` | exit 0                         |
| Lint      | `bun run lint`                | exit 0                           |
| Typecheck | `bun run typecheck`           | exit 0, no errors                |
| Tests     | `bun run test`                | all pass                         |
| Smoke     | `bun run smoke`               | `smoke: PASSED`                  |
| Build     | `bun run build`               | exit 0                           |
| Publish   | `bun run check:package`       | exit 0                           |
| Pack view | `bun pm pack --dry-run`       | lists files (replaces banned `npm pack`) |

## Scope

**In scope** (the only files you should modify):

- `package.json` (bin map + files + compile scripts; see step 2 for the
  exact shape decision)
- `src/index.ts` (shebang line only, if the chosen shape needs it)
- `.github/workflows/check.yml` (add a compile-smoke job or step)
- `README.md` + `project.toml` (install section: what `bunx mcp-pool`
  now fetches; keep `bunx mcp-pool` invocation text unchanged)

**Out of scope** (do NOT touch, even though they look related):

- `src/pool.ts`, `src/server.ts`, `src/ipc.ts` (plan 002 owns the re-exec
  fix), `src/socket-transport.ts`, `src/config.ts`, `src/types.ts`,
  `src/logger.ts`.
- `src/*.test.ts`, `test/**` — no test changes; compile is verified by the
  CI step, not the unit suite.
- `publish-ghp.yml` flow itself (tag → mirror) — unchanged; only the
  tarball *contents* change.
- npm publish automation / tokens on GitHub — operator decision stands
  (manual local `npm publish`).
- `docs/index.html` — CI regenerates.

## Git workflow

- Branch: `advisor/004-compiled-distribution`
- Commit per step or per logical unit; message style: conventional commits
  (`git log --oneline -3`).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Confirm plan 002 is merged, then choose the packaging shape

Do not start this plan unless `daemonSpawnArgs` (or its merged equivalent)
exists in `src/ipc.ts` — `rg -n "daemonSpawnArgs|startsWith" src/ipc.ts`
must match. If absent: STOP (see STOP conditions).

Then decide ONE shape and record it in the commit body. The two viable
shapes (Bun docs + npm constraints, verified in recon):

- **Shape A — `postinstall` compile (recommended).** Tarball keeps a tiny
  launcher + `src/` (or prebuilt `dist/`); `postinstall: bun build
  --compile src/index.ts --outfile ./mcp-pool-bin` produces the binary at
  install time on the user's machine; `bin` points at a 3-line JS shim that
  execs `./mcp-pool-bin`. Pros: one tarball, always the right platform, no
  matrix. Cons: install requires bun (true already — the operator runs
  bunx), install is slower once (~seconds), `postinstall` must be silent
  and idempotent.
- **Shape B — `optionalDependencies` per platform.** Prebuild N binaries in
  CI (`--target` × darwin-arm64/darwin-x64/linux-x64-musl/...), publish as
  `mcp-pool-darwin-arm64` etc., main package selects via
  `optionalDependencies` + `bin` shim. Pros: instant install. Cons: N
  packages to publish by hand (operator publishes locally!), CI matrix,
  version skew risk across the family.

Recommend Shape A unless the operator already said otherwise — the manual-
publish constraint makes Shape B's N-package release a recurring tax.

**Verify**: decision recorded; `rg -n "daemonSpawnArgs" src/ipc.ts` matches
(plan 002 present).

### Step 2: Implement Shape A

Concrete edits:

1. `package.json`:
   - `bin`: keep `"mcp-pool": "dist/index.js"` ONLY if dist remains the
     fallback; otherwise `"mcp-pool": "./bin/mcp-pool.js"` (new 3-line shim
     — create `bin/mcp-pool.js`: `#!/usr/bin/env node` +
     `spawnSync(join(__dirname, "mcp-pool-bin"), process.argv.slice(2),
     { stdio: "inherit" })` — stdio inherit, exit code passthrough).
     Prefer the shim + binary as primary, keep `dist/` in `files` as the
     fallback the shim uses when the binary is absent (e.g. `postinstall`
     skipped with `--ignore-scripts`): shim logic = if `mcp-pool-bin`
     exists and is executable, exec it; else `node dist/index.js`.
   - `scripts`: add `"postinstall": "bun build --compile src/index.ts
     --outfile ./mcp-pool-bin --minify"` — must tolerate missing `src/`
     (guard: `[ -f src/index.ts ] || exit 0` so consumers of a
     src-less tarball don't fail; but DO ship `src/` in `files` then).
   - `files`: add `"bin/"`, `"mcp-pool-bin"` is GENERATED at install (never
     committed, never packed — add to `.gitignore` too), keep `"dist/"`,
     add `"src/"` if postinstall compiles from source.
2. `.gitignore`: add `mcp-pool-bin` (generated artifact).
3. `src/index.ts:1`: shebang stays `#!/usr/bin/env node` (harmless under
   compile; Bun ignores it). No change needed unless the shim approach
   requires it — default to no change.

**Verify**: `bun run typecheck` → exit 0; `bun run lint` → exit 0.

### Step 3: Local end-to-end proof (the whole point)

Simulate a consumer install WITHOUT publishing:

```bash
rm -rf /tmp/mcp-pool-consumer && mkdir -p /tmp/mcp-pool-consumer
cd /tmp/mcp-pool-consumer && bun pm pack /Users/yuzu/Documents/Projects/mcp-pool
tar xzf mcp-pool-*.tgz && cd package && bun install --ignore-scripts
# now run postinstall manually, as install would:
bun build --compile src/index.ts --outfile ./mcp-pool-bin --minify
./bin/mcp-pool.js --config <repo>/test/smoke.yaml \
  <<< '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

**Verify**: stdout contains `"serverInfo":{"name":"mcp-pool"` and a
`smoke__` tool result; wall time is visibly faster than the equivalent
`bun run src/index.ts` invocation (record both timings in the commit
body). Also verify the fallback: `rm ./mcp-pool-bin` then the same command
still works via `dist/` (proves `--ignore-scripts` installs aren't bricked).

### Step 4: CI compile-smoke + docs, full gate, commit

1. `check.yml`: add a `compile-smoke` job (after `verify`, ubuntu-latest):
   checkout, setup-bun, `bun install --frozen-lockfile`, `bun build
   --compile src/index.ts --outfile /tmp/mcp-pool-ci --minify`,
   `printf ... | /tmp/mcp-pool-ci --config test/smoke.yaml | grep -q
   smoke__`. Keep it to ~6 lines; no matrix (Shape A compiles on the
   runner's own platform — that IS the test).
2. `README.md` install section + `project.toml` quickstart: one line each
   noting `bunx mcp-pool` now installs a platform-optimized binary built at
   install time (invocation unchanged). Do not touch `docs/index.html`.
3. Full gate: lint → typecheck → test → smoke → build → check:package,
   all exit 0. Note: `check:package` greps `dist/*.test.*` — if you added
   `src/` to `files`, extend the `check:package` script's grep to also
   reject `src/*.test.ts` from the tarball (`bun pm pack --dry-run | grep
   -E 'src/.*\.test\.ts'` must be empty), and record that in the commit.

Commit (two commits: code+packaging, then CI+docs):
`git add package.json bin/ .gitignore src/index.ts` →
`git commit -m "feat: ship compiled binary via postinstall, shim bin with dist fallback"`;
`git add .github/workflows/check.yml README.md project.toml` →
`git commit -m "ci+docs: compile-smoke job and binary install notes"`.

## Test plan

- No unit-test changes (suite must stay green: `bun run test` → all pass).
- Proof is the step-3 consumer simulation (binary path + dist fallback
  path) and the new CI job — both recorded with timings in the commit body.
- Existing pattern for CI shape: mirror the `verify` job's
  `oven-sh/setup-bun@v2` + `bun install --frozen-lockfile` preamble.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] Plan 002's fix present (`rg daemonSpawnArgs src/ipc.ts` matches)
- [ ] `bun run typecheck`, `lint`, `test`, `smoke`, `build`,
  `check:package` all exit 0
- [ ] Step-3 simulation output recorded: binary handshake OK with timings,
  fallback handshake OK
- [ ] `check.yml` contains a `compile-smoke` job referencing
  `test/smoke.yaml`
- [ ] `bun pm pack --dry-run` lists the shim + dist (+ src if Shape A
  compiles from source) and NO `*.test.*` under either `dist/` or `src/`
- [ ] `mcp-pool-bin` in `.gitignore`; no binary committed (`git status`
  clean of any >1MB file: `git status --porcelain | xargs ls -la`)
- [ ] `bunx mcp-pool` invocation text in README unchanged apart from the
  added note line
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Plan 002 is not merged (the re-exec fix is absent) — this plan's binary
  is broken without it; do not work around it here.
- `bun build --compile` output does NOT reproduce the recon result
  (~85MB, runs, serves daemon directly) — toolchain changed; report the new
  output verbatim.
- Shape A `postinstall` fails under `bun install` in the step-3 simulation
  (e.g. bun forbids network/build at install) — fall back to reporting
  Shape B as the recommendation with a fresh cost estimate, do not silently
  ship a broken postinstall.
- The operator says npm tarball size is a constraint (binary + dist + src
  roughly doubles it) — that kills Shape A; report and ask.
- A step's verification fails twice after a reasonable fix attempt.
- The fix appears to require touching an out-of-scope file.

## Maintenance notes

For the human/agent who owns this code after the change lands:

- Every release now has two artifacts to sanity-check: the tarball
  contents (`bun pm pack --dry-run`) and the CI compile-smoke. If CI's
  compile passes but a user's install fails, first suspect `postinstall`
  being skipped (`--ignore-scripts` → dist fallback covers this by design).
- Bumping the SDK or adding a Node built-in import: re-run the step-3
  simulation — compiled binaries resolve imports at build time, so a new
  `node:*` import that works under `bun run` can break under `--compile`
  (or vice versa).
- Reviewer: scrutinize the shim's stdio/exit-code passthrough (a shim that
  swallows the daemon's exit code breaks `/mcp reload` semantics) and that
  `mcp-pool-bin` is gitignored AND unpacked (never in `files`).
- Deferred: Shape B (prebuilt per-platform packages), npm-publish
  automation, daemon `.sock` cleanup of pre-002 binaries — all separate.
