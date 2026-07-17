# mcp-pool remediation design

**Status:** approved design; pending implementation-plan review

## Goal

Ship a clean `0.1.4` release that preserves lazy failover while making configuration honest, preventing routine argument leakage, tightening startup cleanup, and making CI validate the distributable package.

## Scope

### Configuration

The supported pool fields are:

- `command` (required)
- `args` (required)
- `keys` (required)
- `rateLimitPatterns` (required)
- `cwd` (optional)
- `cooldownSeconds` (optional; defaults to 300 seconds)

A `keys` value may contain a literal credential or a `${NAME}` environment reference. Environment references remain supported, but an undefined variable must fail configuration loading with the variable name and config path; it must never become an empty string.

`strategy` and `maxConsecutiveErrors` are unsupported. The schema rejects either key with a migration-oriented error explaining that lazy failover is fixed behavior and retries are governed by `rateLimitPatterns` and `cooldownSeconds`.

Inline credentials remain supported by user choice. Documentation must recommend environment-variable expansion for credentials that should not be stored in the YAML file. The current locally configured credentials must be rotated because they were exposed in conversation history; the implementation must not reproduce them.

### Runtime

The proxy retains one active upstream subprocess per pool. It advances to the next key only after a rate-limit response or transport failure, honoring the per-key cooldown timer.

Structured logs may record pool name, tool name, and upstream index. They must not include raw tool arguments under any log level.

If startup succeeds for one or more pools but a later pool cannot start, the entrypoint closes every already-started pool before exiting with the existing fatal error.

The MCP server metadata version must come from the package version rather than remain a hard-coded stale value.

### Build, tests, and release

Production TypeScript output must exclude source test files. The package artifact therefore contains only runtime modules, declarations, maps, package metadata, and README.

The canonical verification sequence is:

```bash
bun install --frozen-lockfile
bunx tsc --noEmit
bun test src/
bun run test/smoke-test.ts
npm pack --dry-run
```

GitHub Actions must run that sequence in a Bun job. The existing project-page generation job remains separate and may still commit only generated `docs/` changes.

The release is `0.1.4`. After build and verification, publish the package and pin the OMP local MCP launcher to `mcp-pool@0.1.4`. Pinning upstream MCP packages is out of scope until their compatible versions are separately confirmed.

## Tests

Add or update tests for:

- Missing environment references yielding `ConfigError` with the variable identifier.
- Rejection of `strategy` and `maxConsecutiveErrors`.
- `cooldownSeconds` defaulting to 300.
- Partial startup cleanup: pool one is closed if pool two startup fails.
- Logs omitting tool arguments.
- Compiled output/package inspection excluding `*.test.js` and `*.test.d.ts`.

## Non-goals

- Supporting configurable routing strategies.
- Configurable response-message templates.
- Automatic dotenv loading.
- Changing key-rotation policy beyond existing rate-limit and transport-failure behavior.
- Pinning third-party upstream MCP package versions.

## Acceptance criteria

1. A config using only supported fields loads and maintains lazy failover.
2. A config with an unset `${VAR}` fails before any upstream spawn.
3. A config with `strategy` or `maxConsecutiveErrors` fails with migration guidance.
4. No structured log includes raw tool-call arguments.
5. Partial startup leaks no connected upstreams.
6. CI validates source, smoke behavior, and published-file shape.
7. `npm pack --dry-run` does not list compiled test files.
8. OMP launches exactly `mcp-pool@0.1.4`.
