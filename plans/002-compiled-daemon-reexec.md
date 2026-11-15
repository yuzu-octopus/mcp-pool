# Plan 002: Re-exec the daemon correctly from a compiled binary

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 04bd6ba..HEAD -- src/ipc.ts src/index.ts test/ package.json`
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

`spawnDaemon` re-execs the daemon as `[process.execPath, process.argv[1],
"--daemon", ...]` (`src/ipc.ts:163-171`). That assumes `argv[1]` is a script
path (true for `bun run src/index.ts` and `node dist/index.js`). In a Bun
compiled binary (`bun build --compile`), `argv[1]` is the first *user flag*,
so the proxy spawns `<binary> --config --daemon --config <path> ...`,
`parseArgs` eats `--daemon` as the config path, the child exits silently
(stdio is `"ignore"`), no status is ever written, and the proxy spins the
full 10s `DAEMON_START_TIMEOUT_MS` before failing. Verified this session:
compiled daemon invoked directly works (socket + `ready` appear, upstream
spawns); compiled proxy → spawned daemon fails with `daemon did not start
within 10000ms`. This bug blocks any compiled-binary distribution (plan
004): the default proxy mode would be broken in the shipped artifact while
every dev-mode test stays green.

## Current state

The relevant files, each with one line on its role:

- `src/ipc.ts` — socket paths, `spawnDaemon` (`:152-178`), `connectOrSpawn`
- `src/index.ts` — `main()` (`:247-273`): `--daemon` requires `--socket`,
  everything else loads config then dispatches

The code as it exists today:

```ts
// src/ipc.ts:152-178
export function spawnDaemon(
	paths: RuntimePaths,
	configPath: string,
	verbose: boolean,
): void {
	// Re-exec the entry that is already running: dev mode is src/index.ts,
	// installed mode is dist/index.js. argv[1] is correct for both.
	const entry = process.argv[1];
	if (!entry)
		throw new Error("cannot determine daemon entry from process.argv[1]");

	const argv = [
		entry,
		"--daemon",
		"--config",
		configPath,
		"--socket",
		paths.socket,
	];
	if (verbose) argv.push("--verbose");

	const child = spawn(process.execPath, argv, {
		detached: true,
		stdio: "ignore",
	});
	child.unref();
}
```

Repo conventions that apply here (see `test/daemon-sharing.test.ts` for
scratch-config + child-process patterns, `src/config.test.ts` for unit-test
shape with `bun:test`):

- Unit tests live in `src/*.test.ts` and run under `bun run test`
  (`package.json:29`: `bun test src/ test/startup-cleanup.test.ts
  test/daemon-sharing.test.ts`).
- Thrown errors for operator action use plain messages; see
  `src/ipc.ts:160-161`.

## Commands you will need

| Purpose   | Command                 | Expected on success               |
|-----------|-------------------------|-----------------------------------|
| Typecheck | `bun run typecheck`     | exit 0, no errors                 |
| Tests     | `bun run test`          | all pass (30 + new)               |
| Lint      | `bun run lint`          | exit 0, no fixes applied         |
| Smoke     | `bun run smoke`         | `smoke: PASSED`                   |
| Build     | `bun run build`         | exit 0, `dist/` regenerated      |
| Publish   | `bun run check:package` | exit 0, no test files in tarball |

## Scope

**In scope** (the only files you should modify):

- `src/ipc.ts` (extract argv computation, use it in `spawnDaemon`)
- `src/ipc.test.ts` (create — unit tests for the argv computation)

**Out of scope** (do NOT touch, even though they look related):

- `src/index.ts`, `src/pool.ts`, `src/server.ts`, `src/socket-transport.ts`
- `package.json` bin/build scripts, CI workflows — distribution is plan 004.
- Do not change the daemon protocol, socket paths, or status file format.

## Git workflow

- Branch: `advisor/002-compiled-daemon-reexec`
- Commit per step or per logical unit; message style: conventional commits
  with a short summary first line — e.g. `fix: restore biome-mangled
  generated docs and pin version 0.2.0` (`git log --oneline -3`).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Extract a pure `daemonSpawnArgs` function with unit tests

In `src/ipc.ts`, extract the argv computation out of `spawnDaemon` so it is
testable without spawning anything:

```ts
export function daemonSpawnArgs(
	execPath: string,
	argv1: string | undefined,
	configPath: string,
	socketPath: string,
	verbose: boolean,
): string[] {
	const rest = ["--daemon", "--config", configPath, "--socket", socketPath];
	if (verbose) rest.push("--verbose");
	// Compiled binary (bun build --compile): argv[1] is the first user flag,
	// not a script path, so re-exec the binary directly. Under bun/node with
	// a script entry, argv[1] is that script and must be kept.
	if (argv1 !== undefined && !argv1.startsWith("-")) return [execPath, argv1, ...rest];
	return [execPath, ...rest];
}
```

`spawnDaemon` becomes: compute `entry`-less args via `daemonSpawnArgs(
process.execPath, process.argv[1], configPath, paths.socket, verbose)` and
`spawn(args[0], args.slice(1), { detached: true, stdio: "ignore" })`. Keep
the `"cannot determine daemon entry"` throw only for the case where BOTH
`process.execPath` is empty and `argv1` is undefined — in practice execPath
is always set; if it is somehow empty, throw
`new Error("cannot determine daemon executable")`. Update the stale comment
("argv[1] is correct for both") to describe the three runtimes: `bun run
src/index.ts`, `node dist/index.js`, compiled binary.

Create `src/ipc.test.ts` (`bun:test`, model on `src/config.test.ts`) with
these cases:

1. node style: `("​/usr/bin/node", "/app/dist/index.js", cfg, sock, false)` →
   `["/usr/bin/node", "/app/dist/index.js", "--daemon", "--config", cfg,
   "--socket", sock]`
2. bun dev style: `("<bun>", "src/index.ts", cfg, sock, true)` → same shape
   plus trailing `"--verbose"`
3. compiled, flag first: `("/tmp/mcp-pool", "--config", cfg, sock, false)` →
   `["/tmp/mcp-pool", "--daemon", "--config", cfg, "--socket", sock]` (no
   entry element)
4. compiled, no argv1: `("/tmp/mcp-pool", undefined, cfg, sock, false)` →
   same as 3

**Verify**: `bun test src/ipc.test.ts` → 4 pass; `bun run typecheck` → exit 0.

### Step 2: Prove the real compiled binary heals (manual, cheap)

Build once (this is a ~100ms compile, ~85MB output — acceptable locally,
and `/tmp` keeps it out of the repo):

```bash
bun build --compile src/index.ts --outfile /tmp/mcp-pool-reexec-check
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n' | timeout 30 /tmp/mcp-pool-reexec-check --config test/smoke.yaml
```

**Verify**: stdout contains `"serverInfo":{"name":"mcp-pool"` and a
`tools/list` result with the `smoke__` tool (not `daemon did not start
within 10000ms`). This is the exact repro that failed before the fix.
Delete `/tmp/mcp-pool-reexec-check` afterwards. Do NOT commit the binary;
do NOT add compilation to any test or CI job (that is plan 004).

### Step 3: Run the full gate, lint-fix, commit

Run, in order: `bun run lint` (fix only files you touched via
`bunx @biomejs/biome check --write <file>` if needed, then re-run),
`bun run typecheck`, `bun run test`, `bun run smoke`, `bun run build`,
`bun run check:package`.

**Verify**: every command exits 0; `bun run test` shows the previous 30
tests plus the 4 new ones, 0 fail.

Commit: `git add src/ipc.ts src/ipc.test.ts && git commit -m "fix:
re-exec daemon binary directly when argv[1] is a flag (compiled binary)"`.

## Test plan

- New: `src/ipc.test.ts` — 4 cases above; the regression test for this plan.
- Existing pattern: `src/config.test.ts` (`bun:test` unit style).
- Manual proof: compiled-binary proxy→daemon handshake (step 2) — the only
  test that exercises the real failure, kept manual so the suite never pays
  for an 85MB compile.
- Full suite must stay green: `bun run test` → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run typecheck` exits 0
- [ ] `bun run test` exits 0; `src/ipc.test.ts` exists with ≥4 tests, all pass
- [ ] `bun run lint` exits 0 with no fixes applied on a second run
- [ ] `bun run smoke` prints `smoke: PASSED`
- [ ] `bun run build` + `bun run check:package` exit 0
- [ ] `rg -n "process.argv\[1\]" src/ipc.ts` shows the access only inside
  `daemonSpawnArgs` / `spawnDaemon` call site (no other reader depends on it)
- [ ] Step-2 manual check output recorded in the commit message body or the
  plan's status row (one line: binary handshake OK, no 10s timeout)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at `src/ipc.ts:152-178` doesn't match the "Current state"
  excerpt (the codebase has drifted since this plan was written).
- Bun documents a first-class "am I compiled" API that contradicts the
  `startsWith("-")` heuristic (check `Bun.main` semantics first; if
  `Bun.main` reliably distinguishes script-path from binary-path, prefer it
  — but it must also work when executed under plain `node`, where `Bun`
  is undefined, so any `Bun.*` read needs a `typeof Bun !== "undefined"`
  guard).
- The step-2 manual check still times out after the fix (the failure has a
  second cause — capture `/tmp` stderr and report it verbatim).
- A step's verification fails twice after a reasonable fix attempt.
- The fix appears to require touching an out-of-scope file.

## Maintenance notes

For the human/agent who owns this code after the change lands:

- If a fourth runtime appears (deno? a bundled single-file JS?), add a case
  to `daemonSpawnArgs` + one unit test — the function exists so this
  decision stays in one place.
- Plan 004 (compiled distribution) depends on this fix; without it the
  shipped binary's default mode is broken.
- Reviewer: scrutinize that `spawn(args[0], args.slice(1), ...)` preserves
  `detached: true, stdio: "ignore"` + `unref()` exactly — losing `unref`
  pins the proxy open after the agent disconnects.
