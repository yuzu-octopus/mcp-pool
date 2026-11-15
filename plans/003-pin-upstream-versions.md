# Plan 003: Pin upstream MCP servers to exact versions

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 04bd6ba..HEAD -- README.md agents.md project.toml docs/superpowers/specs/2026-07-17-remediation-design.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: MED (behavior change risk is real; see step 2)
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `04bd6ba`, 2026-11-15

## Why this matters

Today every pool command is an unpinned `bunx -y <pkg>` (user config, e.g.
`bunx -y firecrawl-mcp`, `bunx -y tavily-mcp`, `bunx -y exa-mcp-server`).
Measured this session: first-ever spawn of an uncached package resolves +
downloads (~500ms in the warm-copy run, network-dependent on a true cold
start); cached-but-unpinned still pays version resolution + a fresh `bunx`
shim process (~200-240ms per upstream, and firecrawl keeps 9 cached
versions `3.24.0 → 3.29.1` — the directory listing shows unbounded drift).
The daemon pays this per pool on every cold start; with 3 pools that is
roughly a second of pure overhead before the first handshake. Pinning
`pkg@x.y.z` in the config's `args` freezes the resolution to one cache
entry, makes cold starts reproducible, and is a pure config change — zero
code. It also removes the failure mode where a fresh `bunx` pulls a broken
upstream release onto the user's machine with no action on their part.

## Current state

The facts the executor needs, inlined:

- The user's live config (NOT in this repo — `~/.config/mcp-pool/
  mcp-pool.yaml`, 3 pools, mode 600) uses `command: bunx` with unpinned
  `args: ["-y", "tavily-mcp"]` etc. You cannot edit it (outside the
  workspace, and the operator owns it — "config-side choices are none of
  ur business"). The plan therefore documents and exemplifies; the user
  applies it with one copy-paste per pool.
- The shipped example config in `project.toml:67-82` (regenerates
  `docs/index.html` via CI) uses `args: ["-y",
  "@brave/brave-search-mcp-server"]` — unpinned, and stale in a second way
  (see STOP conditions).
- The remediation design (`docs/superpowers/specs/2026-07-17-
  remediation-design.md:54`) explicitly records: "Pinning upstream MCP
  packages is out of scope until their compatible versions are separately
  confirmed." Step 2 below IS that compatibility confirmation, so this plan
  closes the loop on the design's own deferral.
- `bunx -y pkg@x.y.z` semantics (Bun docs, verified this session): with a
  version, bunx does not use the local package; it installs into the global
  shared cache (`~/.bun/install/cache/`) for future use. The user's cache
  already holds `tavily-mcp@0.2.22`, `exa-mcp-server@3.4.3`,
  `firecrawl-mcp@3.39.0/3.40.0`.

Repo conventions that apply here:

- Docs that ship to users: `README.md` (hand-written), `project.toml`
  (generates `docs/index.html` via CI — never hand-edit `docs/index.html`).
- `agents.md` is the operator's own working guide for this repo.

## Commands you will need

| Purpose   | Command                       | Expected on success              |
|-----------|-------------------------------|----------------------------------|
| Smoke     | `bun run smoke`               | `smoke: PASSED`                  |
| Lint      | `bun run lint`                | exit 0, no fixes applied         |
| Docs gen  | CI regenerates `docs/`       | do not hand-edit `docs/index.html` |

No typecheck/tests/build impact — this plan touches docs and examples only,
plus read-only probes of the user's cache. (If you touch `project.toml`,
the CI page job regenerates `docs/index.html` on push; do not commit a
hand-built `docs/`.)

## Scope

**In scope** (the only files you should modify):

- `README.md` (one short subsection under Config: pin example + why)
- `project.toml` (pin the quickstart example args; keep everything else identical)
- `agents.md` (one line in Config shape or Flow noting pinned args are recommended)

**Out of scope** (do NOT touch, even though they look related):

- `src/**`, `test/**` — zero code changes in this plan.
- The user's live `~/.config/mcp-pool/mcp-pool.yaml` — outside the
  workspace AND operator-owned. Provide the exact replacement lines, do not
  apply them.
- `docs/index.html` — CI regenerates it from `project.toml`. Never hand-edit.
- Adding a `bunx --offline` / `--prefer-offline` recommendation: bunx has no
  such flags (verified: `bunx --help` shows no offline/prefer/install
  controls). Do not document flags that do not exist.
- Locking bunx itself to a version in user docs: out of scope; the operator
  manages their own bun.

## Git workflow

- Branch: `advisor/003-pin-upstream-versions`
- Commit per logical unit; message style: conventional commits with a short
  summary first line — e.g. `fix: restore biome-mangled generated docs and
  pin version 0.2.0` (`git log --oneline -3`).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Confirm the newest working version of each upstream (read-only)

For each of the three packages the operator uses
(`tavily-mcp`, `exa-mcp-server`, `firecrawl-mcp`), determine the exact
version to recommend. Method, cheapest first:

1. List what is already cached: `ls ~/.bun/install/cache/ | grep -iE
   "tavily|exa-mcp|firecrawl"` — a cached version the operator already ran
   is the lowest-risk recommendation.
2. Check the registry for the current latest WITHOUT installing:
   `bunx npm@latest view <pkg> version` is banned (no npm/npx rule) — use
   `bun pm view <pkg> version` if it works read-only, else record the
   cached versions only and mark "latest" as unverified.

Known-good versions observed in the operator's cache this session (verify
they still exist before recommending): `tavily-mcp@0.2.22`,
`exa-mcp-server@3.4.3`, `firecrawl-mcp@3.40.0` (newest cached; `3.39.0`
also present). If the cache now shows a newer firecrawl (e.g. `3.41+`),
prefer the newest cached — but see step 2.

**Verify**: you have one exact `x.y.z` per package, each present in the
cache listing output you paste into the commit message body.

### Step 2: Compatibility check per pinned version (the design's deferred gate)

For each pinned candidate, run the handshake probe WITHOUT touching the
operator's config — spawn `bunx -y <pkg>@<x.y.z>` with a throwaway MCP
client (`initialize` → `tools/list` → close, keyless mode; all three start
keyless). Do NOT point `node` at the cached `build/index.js`/`dist/*.js`
directly: bare node cannot resolve bunx-hoisted dependencies and fails with
`ERR_MODULE_NOT_FOUND` even for good versions (verified 2026-11-15:
direct-node probe failed all three, pinned-bunx probe passed all three:
tavily-mcp@0.2.22 → 5 tools, firecrawl-mcp@3.40.0 → 28 tools,
exa-mcp-server@3.4.3 → 2 tools).

**Verify**: for each of the 3 packages, `tools/list` returns ≥1 tool and
the process exits 0. Any package whose pinned version fails the handshake
is dropped back to its previously-working cached version (record which in
the commit body), or STOP if none works (see STOP conditions).

### Step 3: Document the pin (docs-only change)

- `README.md`, under `## Config`: add a short subsection (~6 lines)
  showing `args: ["-y", "firecrawl-mcp@3.40.0"]` (use the verified versions
  from step 1) and one sentence on why: reproducible cold starts, one cache
  entry instead of drift, no surprise upstream upgrades. Mention the cache
  path (`~/.bun/install/cache/`) so the operator can see what is pinned.
- `project.toml` quickstart (`:67-82`): pin the example args the same way.
  Keep the brave-search example package (do not swap packages — see STOP).
- `agents.md` Config shape: append one line to the `args` row or Flow
  section noting pinned `pkg@x.y.z` args are recommended. One line only.

Also give the operator the exact copy-paste block for their own config
(three pools, `command: bunx` unchanged, only the `args` lines gain
`@x.y.z`). Put it in the commit message body AND in your final report —
never write it to their config file.

**Verify**: `bun run lint` → exit 0 (docs-only, but the repo lints md
codefences? No — biome covers `**` minus dist/docs; README fences are
safe. Still run it); `rg -n "bunx" README.md project.toml agents.md` shows
every example args line carrying an `@x.y.z`.

### Step 4: Commit

Commit: `git add README.md project.toml agents.md && git commit -m "docs:
recommend pinned upstream versions in bunx args" -m "<verified x.y.z per
package + cache evidence + copy-paste block for operator config>"`.

**Verify**: `git status` shows only the three in-scope files; `git diff
--stat` matches.

## Test plan

- No new tests (docs-only plan; code untouched).
- Regression guard: `bun run smoke` → `smoke: PASSED` (proves nothing in
  the example-config path broke tooling expectations).
- Compatibility evidence lives in step 2's probe outputs, recorded in the
  commit body.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `README.md`, `project.toml`, `agents.md` each contain a pinned
  `pkg@x.y.z` example; `rg "bunx.*-y.*@\d" README.md project.toml agents.md`
  returns ≥3 matches
- [ ] No `src/` or `test/` file modified (`git status`)
- [ ] `bun run lint` exits 0
- [ ] `bun run smoke` prints `smoke: PASSED`
- [ ] `docs/index.html` NOT hand-modified (`git status` clean for `docs/`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The `project.toml` quickstart example no longer uses
  `@brave/brave-search-mcp-server` / the excerpts drifted (codebase moved;
  reassess which example package is canonical before pinning a version to it).
- Step 2 fails for ALL cached versions of any package (no known-good pin
  exists — report the handshake errors verbatim; do not recommend an
  untested `@latest`).
- `bun pm view` (or any registry probe) attempts a write/install — abort
  that probe; cached versions are sufficient evidence.
- You are tempted to edit `~/.config/mcp-pool/mcp-pool.yaml` — that file is
  operator-owned and outside the workspace. Provide the block, do not apply it.

## Maintenance notes

For the human/agent who owns this code after the change lands:

- Pins rot: when an upstream ships a fix the operator wants, the pin must be
  bumped manually in their config. Consider a quarterly `ls
  ~/.bun/install/cache/` + handshake re-check; that is operator routine,
  not repo automation.
- If mcp-pool ever gains a config-level `version` field for upstreams, this
  advice moves into schema validation — until then, docs are the mechanism.
- Reviewer: check the three `@x.y.z` values against the step-2 evidence in
  the commit body; a pin without handshake proof is a guess.
