# Plan 008: Prebuilt per-platform binaries via optionalDependencies

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 3558e91..HEAD -- package.json bin/mcp-pool.js .github/workflows/check.yml .github/workflows/publish-ghp.yml .gitignore`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.
>
> **Background (read once)**: `/tmp/mcp-pool-cli-research/REPORT.md`
> findings section 4 + sources [1]–[8]. One-line summary: Bun does not run
> install lifecycle scripts of dependencies by default (default-secure,
> `trustedDependencies` allowlist [1][4]); `bunx` only runs them under
> `--trust` [2]; npm/npx runs them unconditionally [3]. So the plan-004
> `postinstall: bun build --compile` path is silently dead under `bunx` —
> mcp-pool's primary consumption route — and every consumer falls back to
> `node dist/index.js` without knowing it. The fix is the esbuild/biome
> pattern [5][6]: prebuilt per-platform binaries selected at install time
> by `optionalDependencies` + `os`/`cpu`/`libc` [7], built with
> `bun build --compile --target` [8], keeping `node dist/index.js` as the
> universal fallback.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (packaging + release flow; code change is a small shim)
- **Depends on**: plan 004 (postinstall shape exists), plan 002 (re-exec fix)
- **Category**: migration
- **Planned at**: commit `3558e91`, 2026-11-15

## Why this matters

`bunx mcp-pool` is the operator's consumption route. Under plan 004 the
tarball carries `src/` + `dist/` and a `postinstall` that compiles
`./mcp-pool-bin` on the consumer's machine. That compile never runs under
`bunx` (default-secure lifecycle policy), so bunx users silently get the
slow interpreted path and pay the 304-module transpile on every cold
start. Prebuilt platform packages fix all three problems at once: no
toolchain requirement on the consumer, no per-install compile seconds,
no silent fallback — the installer itself skips non-matching
`optionalDependencies` without aborting [7], and the shim execs the one
binary that matches.

## Current state

The facts the executor needs, inlined (verified at `3558e91`):

- `package.json`: `name: mcp-pool`, `version: 0.4.0`, `type: module`,
  `bin: { "mcp-pool": "./bin/mcp-pool.js" }`,
  `files: ["bin/", "dist/", "src/*.ts", "!src/*.test.ts", "README.md"]`.
  Scripts: `build: rm -rf dist && tsc`,
  `typecheck: tsc --project tsconfig.typecheck.json`,
  `prepare: [ -d dist ] || bun run build`,
  `postinstall: command -v bun >/dev/null 2>&1 || exit 0; [ -f src/index.ts ] || exit 0; bun build --compile src/index.ts --outfile ./mcp-pool-bin --minify || exit 0`,
  `start: node dist/index.js`, `test`, `smoke`, `check:package`
  (rejects `test.*` under `dist/` or `src/` in the tarball), `lint`,
  `format` (biome).
- `bin/mcp-pool.js` (20 lines): `#!/usr/bin/env node`; resolves
  `../mcp-pool-bin`; `accessSync(binary, X_OK)` → exec it with
  `spawnSync(target, args, { stdio: "inherit" })`, exit-code/signal
  passthrough; on miss falls back to
  `[process.execPath, ../dist/index.js, ...args]`. This file becomes the
  lookup-table shim (step 2) — keep the stdio/exit-code/signal behavior
  byte-identical.
- `.github/workflows/check.yml`: `verify` job (install → lint →
  typecheck → test → smoke → build → check:package on ubuntu-latest),
  `compile-smoke` job (builds `/tmp/mcp-pool-ci` with
  `bun build --compile src/index.ts --outfile ... --minify`, pipes the
  3-line initialize/initialized/tools-list handshake against
  `test/smoke.yaml` with `--local` and without, `grep -q smoke__`),
  `generate-project-page` job (regenerates `docs/index.html`, commits).
- `.github/workflows/publish-ghp.yml`: on `v*` tags (+ manual dispatch),
  ubuntu-latest, `setup-node` with `registry-url: https://npm.pkg.github.com`
  + `scope: @yuzu-octopus`, `bun install`, `bun run build`,
  `npm pkg set name=@yuzu-octopus/mcp-pool`, `npm publish` with
  `NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}`. npmjs canonical name
  stays unscoped `mcp-pool` (manual local `npm publish`; tokens stay off
  GitHub per operator decision).
- `.gitignore`: `node_modules/`, `dist/`, `/mcp-pool-bin`, `*.log`,
  `.env*`, `!.env.example`, `.venv/`, `.DS_Store`. Built binaries stay
  untracked; platform tarballs under `/tmp` only.
- Repo conventions: gate order lint → typecheck → test → smoke → build →
  `check:package`; never `npm`/`npx` (use `bun`/`bunx`); never hand-edit
  `docs/index.html`; never write outside the repo except `/tmp`.

## Commands you will need

| Purpose  | Command                         | Expected on success              |
|----------|---------------------------------|----------------------------------|
| Install  | `bun install --frozen-lockfile` | exit 0                           |
| Lint     | `bun run lint`                  | exit 0                           |
| Typecheck| `bun run typecheck`             | exit 0, no errors                |
| Tests    | `bun run test`                  | all pass                         |
| Smoke    | `bun run smoke`                 | `smoke: PASSED`                  |
| Build    | `bun run build`                 | exit 0                           |
| Publish  | `bun run check:package`         | exit 0                           |
| Pack view| `bun pm pack --dry-run`         | lists files (never `npm pack`)   |

## Scope

**In scope** (the only files you may modify):

- `package.json` (remove `postinstall` compile; add `optionalDependencies`
  family; keep `bin` → `./bin/mcp-pool.js`; keep `dist/` in `files` as
  fallback; see step 1)
- `bin/mcp-pool.js` (lookup-table shim + `MCP_POOL_BINARY` override +
  fallback; see step 2)
- `platform/` (or per-package dirs — N minimal `package.json` files for the
  platform packages; generated or hand-written, but committed; see step 1)
- `scripts/build-binaries.sh` (new; matrix `bun build --compile --target`
  loop used by CI and the operator's local publish; see step 3)
- `.github/workflows/check.yml` (extend `compile-smoke` or add
  `binary-matrix` job; see step 4)
- `.github/workflows/release-binaries.yml` (new; tag-triggered matrix build
  + artifact upload + provenance/attestation; see step 4)
- `.github/workflows/publish-ghp.yml` (mirror the platform family or
  document why not; see step 5)
- `README.md` + `project.toml` (install section: what `bunx mcp-pool` now
  fetches; invocation text unchanged; see step 6)
- `.gitignore` (keep `/mcp-pool-bin`; add per-platform output dir if the
  build script uses one, e.g. `/dist-bin/`)

**Out of scope** (do NOT touch, even though they look related):

- No CLI framework changes: keep the hand-rolled `node:util.parseArgs`
  parser; do not adopt commander/citty/oclif/yargs/clipanion/stricli.
- No flag changes: no new/renamed/removed flags, no exit-code changes, no
  help-text rewording beyond what the binary path already prints.
- `src/*.ts` (no runtime changes; the binary compiles `src/index.ts` as-is).
- `src/*.test.ts`, `test/**` — no unit-test changes; proof is consumer
  simulation + CI, not the suite.
- npm-publish automation / tokens on GitHub beyond what step 5 specifies —
  operator decision (manual local publish) stands unless step 5 records an
  explicit operator override for the platform family.
- `docs/index.html` — CI regenerates.
- curl|sh installer, Homebrew formula, Docker image — rejected channels
  (lockfile pinning / audit / airgap reasons); do not add one here.

## Git workflow

- Branch: `advisor/008-prebuilt-binaries`
- Commit per step or per logical unit; conventional commits, short first
  line (`git log --oneline -3` for style).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Define the target matrix and the platform package family

Decide the matrix first — everything else keys off it. Required matrix
(Bun compiler `--target` values [8]; 6 entries):

| `bun --target`        | Platform package                 | `os`    | `cpu`  | `libc`  |
|-----------------------|----------------------------------|---------|--------|---------|
| `bun-linux-x64`       | `@yuzu-octopus/mcp-pool-linux-x64` | `linux` | `x64`  | `glibc` |
| `bun-linux-x64-musl`  | `@yuzu-octopus/mcp-pool-linux-x64-musl` | `linux` | `x64` | `musl` |
| `bun-linux-arm64`     | `@yuzu-octopus/mcp-pool-linux-arm64` | `linux` | `arm64` | — |
| `bun-darwin-x64`      | `@yuzu-octopus/mcp-pool-darwin-x64` | `darwin` | `x64` | — |
| `bun-darwin-arm64`    | `@yuzu-octopus/mcp-pool-darwin-arm64` | `darwin` | `arm64` | — |
| `bun-windows-x64`     | `@yuzu-octopus/mcp-pool-win32-x64` | `win32` | `x64` | — |

Notes:

- Name the Windows package `...-win32-x64` (npm `os` value is `win32`,
  not `windows`) — esbuild/biome both use the npm `os` token in the
  package name, not the Bun target token.
- `linux-arm64` musl variant: Bun documents `bun-linux-arm64` only; do
  NOT invent `bun-linux-arm64-musl` — if the musl build is needed on
  arm64 later, add it then. Record the decision in the commit body.
- `windows-arm64`: Bun documents `bun-windows-x64`; if
  `bun-windows-arm64` exists in the installed Bun's
  `bun build --help`, add a 7th row
  (`@yuzu-octopus/mcp-pool-win32-arm64`); otherwise record "evaluated,
  absent in Bun x.y.z" and ship 6.
- `--trim` (size shed, blocks `eval`/`node:vm`/`bun:ffi`/dynamic import
  [8]): measure plain vs `--trim` binary size during step 3 and record;
  default to plain `--minify` (same flags as today's postinstall) unless
  `--trim` saves >20% with a green gate.

Each platform package is a minimal published package, lockstep version
with the main package (publish all 7 on every release — version skew
across the family is the #1 failure mode). Exact shape
(`platform/linux-x64/package.json` example; repeat per row):

```json
{
  "name": "@yuzu-octopus/mcp-pool-linux-x64",
  "version": "0.4.0",
  "os": ["linux"],
  "cpu": ["x64"],
  "libc": ["glibc"],
  "files": ["bin/"],
  "license": "MIT"
}
```

(`darwin`/`win32`/non-glibc rows omit `libc` or set per the table.)
Each package ships exactly one file: `bin/mcp-pool-<suffix>` (the
compiled binary, executable bit set; `.exe` suffix on win32). Nothing
else — no JS, no README, no deps.

Main `package.json` changes:

1. DELETE the `postinstall` script (it is dead under `bunx`; keeping it
   wastes consumer compile seconds on the one path where it does run and
   risks overwriting the prebuilt binary — see STOP conditions).
2. ADD `optionalDependencies` pinning the family at the exact version
   (no `^` — skew protection):
   ```json
   "optionalDependencies": {
     "@yuzu-octopus/mcp-pool-linux-x64": "0.4.0",
     "@yuzu-octopus/mcp-pool-linux-x64-musl": "0.4.0",
     "@yuzu-octopus/mcp-pool-linux-arm64": "0.4.0",
     "@yuzu-octopus/mcp-pool-darwin-x64": "0.4.0",
     "@yuzu-octopus/mcp-pool-darwin-arm64": "0.4.0",
     "@yuzu-octopus/mcp-pool-win32-x64": "0.4.0"
   }
   ```
3. KEEP `bin: { "mcp-pool": "./bin/mcp-pool.js" }`, KEEP `dist/` in
   `files` (universal fallback), KEEP `src/*.ts` entries (or drop `src/`
   from `files` once nothing compiles from source at install — decide in
   the commit; smaller tarball wins if no script needs `src/`).
4. `files` must NOT include any `*-bin` binary (binaries arrive via the
   platform packages, never the main tarball).

**Verify**: `bun run typecheck` → exit 0; `bun pm pack --dry-run` shows
the shim + `dist/` and NO binary; each `platform/*/package.json` parses
(`bun -e 'for (const f of Bun.Glob...)'` or a 3-line `bunx jsonlint`
equivalent — simplest: `for f in platform/*/package.json; do bun -e
"JSON.parse(await Bun.file('$f').text())" || exit 1; done` — adapt to a
plain node/bun one-liner that exits nonzero on bad JSON).

### Step 2: Rewrite `bin/mcp-pool.js` as a lookup-table shim

Replace the body with the esbuild `node-platform.ts` / biome-wrapper
pattern [5][6]: detect, resolve, exec, fall back. Requirements:

1. **Override first**: if `process.env.MCP_POOL_BINARY` is set and
   executable, exec it (parity with `ESBUILD_BINARY_PATH` [5] /
   `BIOME_BINARY` [6]; the single escape hatch for debugging and for CI
   pinning a locally built binary).
2. **Lookup table** (npm `os`/`cpu` tokens, not Bun target tokens):
   ```js
   const TABLE = {
     "darwin-arm64-glibc": "@yuzu-octopus/mcp-pool-darwin-arm64",
     "darwin-x64-glibc": "@yuzu-octopus/mcp-pool-darwin-x64",
     "linux-x64-glibc": "@yuzu-octopus/mcp-pool-linux-x64",
     "linux-x64-musl": "@yuzu-octopus/mcp-pool-linux-x64-musl",
     "linux-arm64-glibc": "@yuzu-octopus/mcp-pool-linux-arm64",
     "win32-x64-glibc": "@yuzu-octopus/mcp-pool-win32-x64",
   };
   ```
   Key = `${process.platform}-${process.arch}-${libc}` where `libc` is
   `"musl"` only on linux when musl is detected, else `"glibc"`.
   musl detection (biome pattern [6]): try `process.report?.getReport()`
   `header.glibcVersionRuntime` absent → musl, OR shell out once to
   `ldd --version` (musl string match), wrapped in try/catch defaulting
   to glibc. One synchronous probe at startup; no async, no network.
3. **Resolution**: `require.resolve(
   `${pkg}/bin/mcp-pool-${suffix}`)` from the main package root (or
   `import.meta.resolve` equivalent under ESM — the current file is ESM;
   keep ESM, do not convert to CJS). Binary filename per package:
   `mcp-pool-linux-x64`, `...-musl`, ..., `mcp-pool-win32-x64.exe`.
4. **Exec with passthrough** (keep today's semantics exactly):
   `spawnSync(target, args, { stdio: "inherit" })`, signal re-raise
   (`if (result.signal) process.kill(process.pid, result.signal)`),
   `process.exit(result.status ?? 1)`.
5. **Fallback last**: if override unset/unexecutable AND lookup misses or
   the resolved binary is absent/unexecutable (e.g. install with
   `--omit=optional` or `--ignore-scripts`, unknown platform, corrupted
   cache), fall back to `[process.execPath, ../dist/index.js, ...args]`
   — the current fallback path, unchanged. Never throw a "platform not
   supported" hard error when `dist/` can serve (esbuild hard-errors only
   when scripts are also ignored [5]; we always have `dist/`, so we
   always have a fallback — document this as an intentional deviation).
6. No new runtime dependencies. Node builtins only (`node:child_process`,
   `node:fs`, `node:path`, `node:url`, `node:os` for `arch()` if wanted).

**Verify**: `bun run lint` + `bun run typecheck` → exit 0 (shim is plain
JS; biome still lints `bin/`). Functional checks live in step 3.

### Step 3: Build script + local end-to-end proof (the whole point)

Write `scripts/build-binaries.sh` (POSIX sh, no bashisms; single source
of truth for CI and the operator's local publish):

```sh
#!/bin/sh
# Usage: scripts/build-binaries.sh <version> <outdir>
# Builds one bun --compile binary per matrix row for the CURRENT lockstep
# version. Cross-compile is bun-native (--target); no per-OS runners needed
# for the build itself (runners still verify in step 4).
set -eu
VERSION="$1"; OUT="$2"; mkdir -p "$OUT"
for t in linux-x64 linux-x64-musl linux-arm64 darwin-x64 darwin-arm64 win32-x64; do
  case "$t" in
    linux-x64)      TARGET=bun-linux-x64 ;;
    linux-x64-musl) TARGET=bun-linux-x64-musl ;;
    linux-arm64)    TARGET=bun-linux-arm64 ;;
    darwin-x64)     TARGET=bun-darwin-x64 ;;
    darwin-arm64)   TARGET=bun-darwin-arm64 ;;
    win32-x64)      TARGET=bun-windows-x64 ;;
  esac
  EXE="$OUT/mcp-pool-$t"; [ "$t" = "win32-x64" ] && EXE="$EXE.exe"
  bun build --compile --minify --target "$TARGET" src/index.ts --outfile "$EXE"
done
```

Then prove it WITHOUT publishing (consumer simulation, per platform or
mocked):

1. Build all 6 for real: `scripts/build-binaries.sh 0.4.0 /tmp/mcp-pool-bins`
   — record sizes (plain vs `--trim` if measured) in the commit body.
   (Answers REPORT open question 1 with real numbers for this codebase.)
2. Native-path simulation (the platform you are on — CIUbuntu or dev Mac):
   ```sh
   rm -rf /tmp/mcp-pool-consumer && mkdir -p /tmp/mcp-pool-consumer/pkg
   cd /tmp/mcp-pool-consumer && bun pm pack <repo>  # main tarball
   tar xzf mcp-pool-*.tgz -C pkg --strip-components=1
   mkdir -p pkg/node_modules/@yuzu-octopus/mcp-pool-<your-suffix>/bin
   cp /tmp/mcp-pool-bins/mcp-pool-<your-suffix> pkg/node_modules/@yuzu-octopus/mcp-pool-<your-suffix>/bin/
   chmod +x pkg/node_modules/@yuzu-octopus/mcp-pool-<your-suffix>/bin/*
   printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"ci","version":"0.0.0"}}}' '{"jsonrpc":"2.0","method":"notifications/initialized"}' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | pkg/bin/mcp-pool.js --local --config <repo>/test/smoke.yaml | grep -q smoke__
   ```
   **Verify**: `grep -q smoke__` passes; wall time recorded vs the
   `node dist/index.js` fallback path.
3. Fallback simulation: `rm -rf pkg/node_modules/@yuzu-octopus` then the
   same handshake — must still pass via `dist/` (proves
   `--omit=optional` / `--ignore-scripts` installs are not bricked).
4. Override simulation: `MCP_POOL_BINARY=/tmp/mcp-pool-bins/mcp-pool-<suffix> pkg/bin/mcp-pool.js --local ...` — must pass (proves the escape hatch).
5. Mocked-platform simulation (no extra runners needed): stub
   `process.platform`/`process.arch` via a 5-line ESM loader or env-forced
   test hook in the shim (e.g. `_MCP_POOL_TEST_PLATFORM=linux-x64-musl`)
   and assert the table resolves to the musl package name; assert an
   unknown platform (`sunos-sparc`) resolves to the `dist/` fallback, not
   a throw. Keep the hook underscore-prefixed, documented "test only",
   and covered by the step-4 CI assertion — or do it with a pure unit
   import of the table function if you factor one out. Either way: no new
   test files under `test/` unless a 10-line table test is cheaper than
   the hook (executor's choice; record it).
6. musl probe check: on a glibc machine assert probe → glibc; on alpine
   (CI or `docker run --rm alpine ldd --version` if docker exists, else
   CI-only) assert → musl. If docker is unavailable locally, defer the
   musl-live check to the step-4 CI job and record that.

**Verify**: all five simulations recorded with pass/fail + timings in the
commit body; native binary handshake OK; fallback OK; override OK.

### Step 4: CI — matrix verify + tag-triggered binary release with provenance

1. `check.yml`: extend `compile-smoke` (or add a `binary-matrix` job if
   the diff is cleaner) to: run `scripts/build-binaries.sh <dev-version>
   /tmp/mcp-pool-bins`, assert all 6 outputs exist and are non-empty,
   run the native-suffix handshake from step 3 (same `printf ... | grep
   -q smoke__` lines, both `--local` and daemon modes), run the fallback
   handshake with the platform dir removed, and run the mocked-platform
   table assertion. Runners: at minimum ubuntu-latest (covers
   linux-x64 + musl probe) — add macos-latest only if minutes allow;
   cross-compiled darwin/win32 binaries are build-verified (existence +
   `file(1)` magic) on ubuntu, handshake-verified on their native
   runners when present. Keep the existing `verify` job untouched.
2. New `.github/workflows/release-binaries.yml`, triggered on `v*` tags
   (same trigger as `publish-ghp.yml`) + `workflow_dispatch`:
   - `strategy.matrix` over the 6 targets with per-OS runners
     (`linux/*` on ubuntu-latest, `darwin/*` on macos-14/15,
     `win32/*` on windows-latest) OR single-ubuntu cross-compile if you
     prove in step 3 that cross-compiled darwin/win32 binaries handshake
     on native hardware — default to per-OS runners (reproducibility over
     minutes).
   - Steps per matrix leg: checkout, setup-bun, `bun install
     --frozen-lockfile`, build the ONE leg binary, upload as
     `actions/upload-artifact` named `mcp-pool-<suffix>`.
   - Publish job (`needs: build`, `permissions: contents: write,
     id-token: write`): download all artifacts, `npm publish` each
     `platform/<dir>` with `--provenance` (Sigstore via OIDC — the
     esbuild/biome-grade supply-chain claim), then publish the main
     package. Attach the 6 binaries as the GitHub Release assets too.
   - Provenance note: `npm --provenance` requires the publish step to run
     in CI with `id-token: write` — this is the ONE place this plan
     touches the "no tokens on GitHub" operator decision. If the operator
     refuses CI publish rights, the fallback is: CI uploads artifacts +
     attestation digests (`actions/attest-build-provenance`), the operator
     downloads them locally and runs a `scripts/publish-all.sh` (you must
     write it: loop `npm publish` over `platform/*` then the root, in that
     order, same version assertion `npm pkg get version` equality gate).
     Record which shape the operator chose in the commit body — do not
     silently pick.

**Verify**: `check.yml` contains the extended job referencing
`scripts/build-binaries.sh` + `test/smoke.yaml`; `release-binaries.yml`
is YAML-valid (`bun -e` parse or `python -c 'import yaml'`
equivalently — simplest: `bunx --bun prettier --check` is banned;
use `node -e "require('yaml').parse(...)"` via the repo's own `yaml`
dep or `python3 -c 'import yaml,sys'`); no secrets referenced beyond
`GITHUB_TOKEN`/OIDC.

### Step 5: Release flow + GHP mirror

1. Release flow change (record in README + commit body): today the
   operator runs `npm publish` locally once. After this plan every
   release publishes SEVEN packages in lockstep (main + 6 platform, 7th
   if win-arm64 lands): `platform/*` first, main last (main's
   `optionalDependencies` pin exact versions that must already exist).
   Who publishes: default = CI (`release-binaries.yml` publish job with
   trusted publishing / OIDC, `--provenance`); opt-out = operator-local
   via `scripts/publish-all.sh` (step 4 fallback) downloading CI-built
   artifacts — never rebuild per-platform binaries by hand on one laptop
   (a Mac cannot reproducibly build the linux-musl leg outside
   `bun --target`, and hand-built skew is undetectable until install).
   Either way: single version bump commit updates root + all
   `platform/*/package.json` versions together (provide
   `scripts/bump-versions.sh <v>` or a 3-line `bunx json` loop — keep it
   to one command).
2. GHP mirror implications: `publish-ghp.yml` currently rewrites the main
   name to `@yuzu-octopus/mcp-pool` for the GitHub registry (npmjs
   canonical stays unscoped). Platform packages are ALREADY scoped
   (`@yuzu-octopus/...`), so no rename is needed — but they must ALSO be
   mirrored, or GHP consumers get the fallback-only install (all
   optionals 404 → `dist/` path, silently slow, same trap as postinstall
   but quieter). Two consistent options: (a) mirror all 7 to GHP on every
   `v*` tag (recommended — extend `publish-ghp.yml` with a matrix over
   `platform/*` + the renamed main, same `NODE_AUTH_TOKEN` flow); (b)
   document "GHP carries the main package only; binary installs come from
   npmjs" in README + `publish-ghp.yml` comments. Default to (a); (b)
   needs an explicit operator sign-off recorded in the commit.
3. npmjs canonical stays the binary-capable install (`mcp-pool` +
   `@yuzu-octopus/mcp-pool-*` optionals, all on registry.npmjs.org).
   No registry config change for consumers.

**Verify**: `publish-ghp.yml` diff implements (a) or documents (b) with
operator sign-off; version-bump story is one command; publish order
(platforms → main) is written in README, not tribal knowledge.

### Step 6: Docs, full gate, commit

1. `README.md` install section + `project.toml` quickstart: replace the
   postinstall-compile note (plan 004) with: "`bunx mcp-pool` installs a
   prebuilt platform binary via `optionalDependencies` (version-pinned
   `@yuzu-octopus/mcp-pool-<platform>`); override with `MCP_POOL_BINARY`;
   without a matching binary it runs `node dist/index.js` (same flags,
   slower cold start)." Invocation text (`bunx mcp-pool ...`) unchanged.
   Do not touch `docs/index.html`.
2. Full gate, in order: `bun run lint` → `typecheck` → `test` → `smoke` →
   `build` → `check:package`, ALL exit 0. Note: if step 1 dropped `src/`
   from `files`, `check:package`'s grep still covers `dist/`; if `src/`
   stays, the existing `src/*.test.ts` rejection must still hold —
   either way `bun pm pack --dry-run` must list the shim + `dist/` (+
   `src/` iff kept) and NO `*.test.*` and NO binary.
3. Commit (two commits: packaging+shim, then CI+docs):
   `git add package.json platform/ bin/mcp-pool.js scripts/build-binaries.sh [scripts/publish-all.sh] .gitignore` →
   `git commit -m "feat: prebuilt per-platform binaries via optionalDependencies, lookup shim with dist fallback"`;
   `git add .github/workflows/check.yml .github/workflows/release-binaries.yml [.github/workflows/publish-ghp.yml] README.md project.toml` →
   `git commit -m "ci+docs: binary matrix verify, tag release with provenance, install notes"`.
   Bodies record: matrix decision (6 vs 7), plain vs `--trim` sizes,
   step-3 simulation timings, CI-vs-local publish decision + GHP (a)/(b).

## Test plan

- No unit-test changes (suite must stay green: `bun run test` → all pass;
  a ≤10-line lookup-table test is allowed iff cheaper than the
  `_MCP_POOL_TEST_PLATFORM` hook — executor's choice, recorded).
- Proof is the step-3 consumer simulation, all five legs: native binary
  handshake (`grep -q smoke__`, `--local` + daemon modes), fallback with
  optionals removed, `MCP_POOL_BINARY` override, mocked-platform table
  resolution incl. unknown-platform fallback, musl probe (live or
  CI-deferred with reason).
- CI shape mirrors the existing `compile-smoke` job's
  `oven-sh/setup-bun@v2` + `bun install --frozen-lockfile` preamble and
  the same 3-line handshake.
- Install-matrix coverage without N laptops: `bun pm pack` the main
  tarball + each `platform/<dir>` (`bun pm pack --dry-run` per dir),
  `npm install --dry-run`-style manifest check of `os`/`cpu`/`libc`
  fields (parse + assert against the step-1 table), and per-platform
  `npm install` simulation via `--omit=optional` (fallback leg) vs full
  (native leg). pnpm/yarn `os`/`cpu`/`libc` parity is a REPORT open
  question — if those installers matter to the operator, verify one of
  each here and record; otherwise record "npm/bun only".

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `postinstall` compile script is gone from `package.json`
  (`rg -n postinstall package.json` matches nothing)
- [ ] 6 (or 7, with win-arm64 evaluation recorded) platform dirs exist,
  each with `name`/`version`/`os`/`cpu` (+`libc` where tabled),
  versions equal to root (`for f in platform/*/package.json; do ... done`
  equality gate passes)
- [ ] `optionalDependencies` pins the exact family version (no `^`)
- [ ] `bin/mcp-pool.js` implements override → table → `dist/` fallback
  with today's stdio/exit-code/signal passthrough (no new deps)
- [ ] `scripts/build-binaries.sh` exists, is executable, builds all legs
- [ ] Step-3 simulations recorded: native OK + timings, fallback OK,
  override OK, mocked-table OK (incl. unknown → fallback), musl probe OK
  or CI-deferred with reason
- [ ] `check.yml` references `scripts/build-binaries.sh` + `test/smoke.yaml`
- [ ] `release-binaries.yml` exists, tag-triggered, matrix + artifacts +
  provenance-or-attestation story matching the recorded CI-vs-local decision
- [ ] GHP story resolved: (a) mirrors all 7 or (b) documents npmjs-only
  binaries with operator sign-off
- [ ] `bun run lint`, `typecheck`, `test`, `smoke`, `build`,
  `check:package` all exit 0
- [ ] `bun pm pack --dry-run` lists shim + `dist/` (+ `src/` iff kept),
  NO `*.test.*`, NO binary; per-platform packs list exactly one binary
- [ ] No binary committed (`git status --porcelain | xargs ls -la` shows
  no >1MB file; `/mcp-pool-bin` still gitignored)
- [ ] `bunx mcp-pool` invocation text in README unchanged apart from the
  mechanism note
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `bun build --compile --target <row>` fails for any tabled target on
  the installed Bun (toolchain changed) — report `bun --version` +
  verbatim error; do not shrink the matrix silently.
- A cross-compiled binary for a non-native leg fails `file(1)`/handshake
  where step 3 requires it — report which leg, which runner, verbatim log.
- `require.resolve` (or `import.meta.resolve`) cannot locate an installed
  optional dep from `bin/mcp-pool.js` under bunx's layout — report the
  resolution error + `bunx --verbose` (or equivalent) tree; do not
  restructure `files`/layout to work around it without asking.
- The operator rejects CI publish rights AND the local
  `scripts/publish-all.sh` path (e.g. refuses 7-package releases) — the
  release flow is undecided; report and ask.
- pnpm/yarn must be first-class and either ignores `libc` or resolves the
  wrong leg — report versions + behavior; do not add installer-specific
  shims here.
- A step's verification fails twice after a reasonable fix attempt.
- The fix appears to require touching an out-of-scope file (especially
  `src/*` runtime code or CLI flags).

## Maintenance notes

For the human/agent who owns this code after the change lands:

- Every release is now 7 publishes in lockstep. The version-bump command
  (step 5) must update root + all `platform/*/package.json` together; CI
  should assert version equality so skew fails fast instead of shipping a
  main that pins optionals that do not exist yet.
- If CI's matrix passes but a user's install falls back to `dist/`,
  suspect in order: `--omit=optional`/`--ignore-scripts` installer flags,
  unknown platform (shim table miss — add a row), musl misdetect (ldd
  probe — check `MCP_POOL_BINARY` as the instant workaround), GHP-only
  install under option (b).
- Bumping the SDK or adding a `node:*` import: re-run
  `scripts/build-binaries.sh` + the step-3 native handshake — compiled
  binaries resolve imports at build time, so a new import that works under
  `bun run` can break under `--compile` (or vice versa). Same warning as
  plan 004, now × 6 targets.
- Reviewer: scrutinize the shim's exit-code/signal passthrough (a shim
  that swallows the daemon's exit code breaks reload semantics), the musl
  probe's sync cost on every startup (must stay ~1ms, one `ldd` spawn
  max), that no binary is in `files`, and that `MCP_POOL_BINARY` cannot
  be confused with user config (env-only, absolute-path-or-executable
  check, never a bare name resolved via `PATH`).
- Deferred (again, separate): curl|sh installer, Homebrew, Docker,
  delicious `bunx --offline` flags that do not exist — do not add them here.
