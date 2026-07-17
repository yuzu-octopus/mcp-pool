# mcp-pool Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship mcp-pool 0.1.4 with an honest config contract, secret-safe logs, cleanup on partial startup failure, production-only build output, reproducible verification CI, and a pinned OMP launcher.

**Architecture:** Keep the existing `Pool` lazy-failover implementation and its one-active-client invariant. Narrow config validation to active runtime behaviors, make environment substitution fail closed, and put release correctness in the existing Bun/TypeScript build plus a separate CI verification job. No new dependencies or secret-loading layer are added.

**Tech Stack:** TypeScript, Bun, Zod, YAML, MCP SDK, GitHub Actions.

## Global Constraints

- Preserve inline key values and `${VAR}` key expansion; do not add dotenv loading.
- Never copy or commit local credential values. The user must rotate credentials already disclosed in conversation history.
- `cooldownSeconds` remains optional and defaults to exactly `300`.
- Reject `strategy` and `maxConsecutiveErrors` with migration-oriented validation errors.
- Do not add configurable routing strategies, retry-message templates, or upstream-version pins.
- Preserve one active upstream subprocess per pool and current rate-limit/transport-error failover behavior.
- Use Bun commands and preserve the committed `bun.lock` workflow.

---

## File structure

| File | Responsibility after this work |
|---|---|
| `src/config.ts` | Strict YAML configuration schema and fail-closed `${VAR}` expansion. |
| `src/config.test.ts` | Config compatibility, deprecation, and missing-environment regression tests. |
| `src/pool.ts` | Lazy routing with metadata-only logs. |
| `src/pool.integration.test.ts` | Pool-level failover and logging regression coverage. |
| `src/index.ts` | Server startup/cleanup and metadata version resolution. |
| `test/helper-server.ts` | Test upstream lifecycle observability needed for startup-cleanup regression coverage. |
| `test/smoke-test.ts` | Existing real stdio smoke test; remains the public-path check. |
| `tsconfig.json` | Production compile input; excludes test sources. |
| `tsconfig.typecheck.json` | No-emit typecheck input including production and test TypeScript. |
| `package.json` | 0.1.4 version, canonical scripts, package-file restrictions. |
| `.github/workflows/check.yml` | Separate verification and project-page-generation jobs. |
| `README.md`, `agents.md`, `project.toml` | Accurate public and maintenance documentation. |
| `~/.config/mcp-pool/mcp-pool.yaml` | Local supported config with no stale fields and rotated credentials supplied by the user. |
| `~/.omp/agent/mcp.json` | Deterministic `mcp-pool@0.1.4` launcher reference. |

---

### Task 1: Make the configuration contract fail closed

**Files:**
- Modify: `src/config.ts:5-25,48-61`
- Modify: `src/types.ts:1-10`
- Modify: `src/config.test.ts:11-162`

**Interfaces:**
- Produces `PoolConfigSchema` that accepts only `command`, `args`, `keys`, `rateLimitPatterns`, `cwd`, and `cooldownSeconds`.
- Produces `loadConfig(cliArg?: string): LoadedConfig` that throws `ConfigError` when an environment reference is unset.
- `Pool` continues to consume `PoolConfig` with `cooldownSeconds?: number`.

- [ ] **Step 1: Add failing config regression tests**

Add these tests to `src/config.test.ts`. Use the existing `tmpYaml()` helper and always clean its temporary YAML file.

```ts
test("rejects removed strategy field", () => {
  const result = PoolConfigSchema.safeParse({
    command: "echo",
    args: [],
    keys: [{ API_KEY: "value" }],
    strategy: "round-robin",
    rateLimitPatterns: ["rate_limit"],
  });
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.issues[0].message).toMatch(/strategy.*lazy failover/i);
  }
});

test("rejects removed maxConsecutiveErrors field", () => {
  const result = PoolConfigSchema.safeParse({
    command: "echo",
    args: [],
    keys: [{ API_KEY: "value" }],
    maxConsecutiveErrors: 3,
    rateLimitPatterns: ["rate_limit"],
  });
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.issues[0].message).toMatch(/maxConsecutiveErrors.*unsupported/i);
  }
});

test("defaults cooldownSeconds to 300", () => {
  const result = PoolConfigSchema.parse({
    command: "echo",
    args: [],
    keys: [{ API_KEY: "value" }],
    rateLimitPatterns: ["rate_limit"],
  });
  expect(result.cooldownSeconds).toBe(300);
});

test("throws when an environment reference is unset", () => {
  const path = tmpYaml(`
pools:
  test:
    command: echo
    args: []
    keys: [{API_KEY: "\\${MCP_POOL_MISSING_TEST_KEY}"}]
    rateLimitPatterns: ["rate_limit"]
`);
  expect(() => loadConfig(path)).toThrow(/MCP_POOL_MISSING_TEST_KEY/);
  unlinkSync(path);
});
```

- [ ] **Step 2: Run the config test file and confirm the new tests fail**

Run:

```bash
bun test src/config.test.ts
```

Expected: the removed-field tests and missing-variable test fail because the current schema accepts the fields and substitutes an empty string.

- [ ] **Step 3: Narrow the Zod schema and make `${VAR}` expansion strict**

In `src/config.ts`:

1. Replace the `PoolConfigSchema` declaration with this strict schema. The two deprecated keys are deliberately included only so they can produce clear migration errors; `transform` removes them from the validated output type.

```ts
const PoolConfigSchema = z
  .object({
    command: z.string().min(1, "command is required"),
    args: z.array(z.string()),
    keys: z.array(z.record(z.string())).min(1, "keys must have at least one entry"),
    cooldownSeconds: z.coerce.number().int().positive().default(300),
    rateLimitPatterns: z
      .array(z.string().min(1))
      .min(1, "rateLimitPatterns is required")
      .refine(
        (patterns) =>
          patterns.every((pattern) => {
            try {
              new RegExp(pattern);
              return true;
            } catch {
              return false;
            }
          }),
        { message: "all rateLimitPatterns entries must be valid regular expressions" },
      ),
    cwd: z.string().optional(),
    strategy: z.unknown().optional(),
    maxConsecutiveErrors: z.unknown().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.strategy !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["strategy"],
        message: "strategy is unsupported: mcp-pool always uses lazy failover; remove this field",
      });
    }
    if (value.maxConsecutiveErrors !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["maxConsecutiveErrors"],
        message: "maxConsecutiveErrors is unsupported; remove this field",
      });
    }
  })
  .transform(({ strategy: _strategy, maxConsecutiveErrors: _maxConsecutiveErrors, ...config }) => config);
```

2. Replace `expandEnvVars()` with this recursive function. It keeps the existing `ConfigError` class and fails before Zod validation when a reference is missing:

```ts
function expandEnvVars(obj: unknown, configPath: string): unknown {
  if (typeof obj === "string") {
    return obj.replace(/\$\{(\w+)\}/g, (_, name: string) => {
      const value = process.env[name];
      if (value === undefined) {
        throw new ConfigError(`missing environment variable ${name} referenced by ${configPath}`);
      }
      return value;
    });
  }
  if (Array.isArray(obj)) return obj.map((item) => expandEnvVars(item, configPath));
  if (obj && typeof obj === "object") {
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>).map(([key, value]) => [
        key,
        expandEnvVars(value, configPath),
      ]),
    );
  }
  return obj;
}
```

3. Change the caller to `parsed = expandEnvVars(parsed, path);`.

4. Remove `strategy` and `maxConsecutiveErrors` from `src/types.ts`.

- [ ] **Step 4: Run config tests and typecheck**

Run:

```bash
bun test src/config.test.ts && bunx tsc --noEmit
```

Expected: all config tests pass and TypeScript reports no errors.

- [ ] **Step 5: Commit the config-contract change**

```bash
git add src/config.ts src/config.test.ts src/types.ts
git commit -m "fix: reject stale pool config fields"
```

---

### Task 2: Remove raw argument logging and guarantee partial-start cleanup

**Files:**
- Modify: `src/pool.ts:103-151`
- Modify: `src/pool.integration.test.ts:34-170`
- Modify: `src/index.ts:26-51,128-136`
- Modify: `test/helper-server.ts:1-86`
- Create: `test/startup-cleanup.test.ts`

**Interfaces:**
- `Pool.routeCall()` retains the existing return type and lazy failover behavior.
- `log()` retains the existing `LogEvent` union; no event may include raw tool arguments.
- `main()` must close every `Pool` accumulated in `pools` if a later `pool.start()` rejects.

- [ ] **Step 1: Add a logging regression test**

In `src/pool.integration.test.ts`, temporarily spy on `console.error`, route one call containing a sentinel input value, and verify the emitted lines do not contain it. Restore the spy in `finally`.

```ts
test("never logs raw tool arguments", async () => {
  const pool = new Pool("test", poolConfig());
  const original = console.error;
  const lines: string[] = [];
  console.error = (...values: unknown[]) => lines.push(values.join(" "));

  try {
    await pool.start();
    await pool.routeCall("echo", { credential: "sensitive-test-value" }, true);
    expect(lines.join("\n")).not.toContain("sensitive-test-value");
  } finally {
    await pool.close();
    console.error = original;
  }
});
```

- [ ] **Step 2: Run that test and confirm it fails**

Run:

```bash
bun test src/pool.integration.test.ts --test-name-pattern "never logs raw tool arguments"
```

Expected: FAIL because `call_tool` currently includes `args`.

- [ ] **Step 3: Make tracing metadata-only**

In `src/pool.ts`, remove the `args` property from both `call_tool` log invocations. Delete the duplicate post-success trace event entirely; the pre-call metadata event is sufficient.

```ts
log({
  level: "trace",
  event: "call_tool",
  pool: this.name,
  tool: toolName,
  upstream: this.cursor,
});
```

Then change `LogEvent` in `src/types.ts` so `call_tool` has no `args` member:

```ts
| { level: "trace"; event: "call_tool"; pool: string; tool: string; upstream: number };
```

- [ ] **Step 4: Add partial-start cleanup coverage**

Create `test/startup-cleanup.test.ts`. It must spawn the real `src/index.ts` through `StdioClientTransport` using a temporary config with two pools: the first starts `test/helper-server.ts`; the second sets `TEST_CRASH_ON_START: "1"`. Capture the first helper process’s exit through a small test-only lifecycle marker added to `test/helper-server.ts`:

```ts
const lifecycleFile = process.env.TEST_LIFECYCLE_FILE;
if (lifecycleFile) {
  writeFileSync(lifecycleFile, "started");
  process.on("exit", () => writeFileSync(lifecycleFile, "closed"));
}
```

Import `writeFileSync` from `node:fs` in `test/helper-server.ts`. The test must:

1. Create unique temp config and lifecycle paths.
2. Start `bun run src/index.ts --config <temp-config>` through `StdioClientTransport`.
3. Assert `client.connect()` rejects because pool two fails startup.
4. Wait briefly with an event-based file poll (maximum 2 seconds) until the lifecycle file reads `closed`.
5. Assert `closed`, remove temp files, and close the transport/client if created.

- [ ] **Step 5: Add startup cleanup to the entrypoint**

Change the startup section in `src/index.ts` so pools accumulated before failure close before the error propagates:

```ts
const pools: Pool[] = [];
try {
  for (const name of poolNames) {
    const pool = new Pool(name, loaded.config.pools[name]);
    await pool.start();
    pools.push(pool);
  }
} catch (err) {
  await Promise.allSettled(pools.map((pool) => pool.close()));
  throw err;
}
```

Keep the existing top-level fatal handler unchanged so it reports the failure and exits nonzero.

- [ ] **Step 6: Run focused runtime tests**

Run:

```bash
bun test src/pool.integration.test.ts test/startup-cleanup.test.ts
```

Expected: all tests pass; the logging test confirms no raw arguments reach stderr and the cleanup test sees `closed`.

- [ ] **Step 7: Commit runtime correctness changes**

```bash
git add src/pool.ts src/types.ts src/pool.integration.test.ts src/index.ts test/helper-server.ts test/startup-cleanup.test.ts
git commit -m "fix: clean up failed startup and redact tool arguments"
```

---

### Task 3: Separate production build output from typechecking

**Files:**
- Modify: `tsconfig.json:1-20`
- Create: `tsconfig.typecheck.json`
- Modify: `package.json:1-28`

**Interfaces:**
- `bun run build` produces `dist/` from runtime source only.
- `bun run typecheck` validates production and test TypeScript without emitting files.
- `npm pack --dry-run` must not list `dist/*.test.js`, `dist/*.test.d.ts`, or their maps.

- [ ] **Step 1: Add a package-output check script that initially fails**

Add this package script:

```json
"check:package": "npm pack --dry-run | grep -E 'dist/.*\\.test\\.(js|d\\.ts|js\\.map|d\\.ts\\.map)' && exit 1 || exit 0"
```

Run:

```bash
bun run build && bun run check:package
```

Expected before excluding test sources: the command must fail because `dist/config.test.js` and `dist/pool.integration.test.js` are present.

- [ ] **Step 2: Split production compile and no-emit typecheck configs**

Modify `tsconfig.json` to exclude test sources:

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "src/**/*.test.ts"]
}
```

Create `tsconfig.typecheck.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

Update package scripts:

```json
"build": "rm -rf dist && tsc",
"typecheck": "tsc --project tsconfig.typecheck.json",
"test": "bun test src/",
"smoke": "bun run test/smoke-test.ts",
"check:package": "npm pack --dry-run | grep -E 'dist/.*\\.test\\.(js|d\\.ts|js\\.map|d\\.ts\\.map)' && exit 1 || exit 0"
```

- [ ] **Step 3: Verify artifact and full type coverage**

Run:

```bash
bun run build && bun run typecheck && bun test src/ && bun run smoke && bun run check:package
```

Expected: all commands pass. `npm pack --dry-run` lists runtime `dist/` files but no compiled test files.

- [ ] **Step 4: Commit build separation**

```bash
git add tsconfig.json tsconfig.typecheck.json package.json bun.lock
git commit -m "build: exclude tests from published output"
```

---

### Task 4: Make CI enforce the release contract

**Files:**
- Modify: `.github/workflows/check.yml:1-48`

**Interfaces:**
- Pushes to `main` run a Bun verification job and a separate docs-generation job.
- Only the docs job receives `contents: write`; verification requires only `contents: read`.

- [ ] **Step 1: Replace the single job with verification and docs jobs**

Use this workflow shape, retaining the existing generator URLs and commit logic:

```yaml
name: Check

on:
  push:
    branches: [main]
    paths-ignore:
      - "docs/**"
  workflow_dispatch:

jobs:
  verify:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bun run typecheck
      - run: bun test src/
      - run: bun run smoke
      - run: bun run build
      - run: bun run check:package

  generate-project-page:
    needs: verify
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.11"
      - name: Install system deps
        run: sudo apt-get update && sudo apt-get install -y libcairo2-dev fonts-jetbrains-mono
      - name: Install generator dependencies
        run: pip install uv && uv pip install --system jinja2 pillow cairosvg
      - name: Fetch generator
        run: |
          mkdir -p /tmp/projectsite
          curl --fail --location --silent --show-error https://raw.githubusercontent.com/yuzu-octopus/ProjectSite/main/genpage.py -o /tmp/projectsite/genpage.py
          curl --fail --location --silent --show-error https://raw.githubusercontent.com/yuzu-octopus/ProjectSite/main/template.html.j2 -o /tmp/projectsite/template.html.j2
      - name: Generate project page
        run: python /tmp/projectsite/genpage.py --input project.toml --output docs/index.html
      - name: Commit generated page
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add docs/
          if git diff --cached --quiet; then
            echo "No changes to commit"
          else
            git commit -m "ci: regenerate project page [skip ci]"
            git push
          fi
```

- [ ] **Step 2: Validate YAML and commands locally**

Run the exact verification commands locally:

```bash
bun install --frozen-lockfile && bun run typecheck && bun test src/ && bun run smoke && bun run build && bun run check:package
```

Expected: every command exits zero.

- [ ] **Step 3: Commit CI validation**

```bash
git add .github/workflows/check.yml
git commit -m "ci: verify build and package artifact"
```

---

### Task 5: Align documentation, local configuration, and release metadata

**Files:**
- Modify: `README.md:14-80`
- Modify: `agents.md:18-60`
- Modify: `project.toml:66-120`
- Modify: `src/index.ts:1-10,48-50`
- Modify: `package.json:1-28`
- Modify: `~/.config/mcp-pool/mcp-pool.yaml`
- Modify: `~/.omp/agent/mcp.json:30-33`

**Interfaces:**
- Runtime server reports package version 0.1.4 in MCP metadata.
- README, project page source, and agent guide all document active `cooldownSeconds` semantics and only supported fields.
- Local OMP launches `mcp-pool@0.1.4`.

- [ ] **Step 1: Add package-version access without adding a dependency**

In `src/index.ts`, import the package JSON using a relative import compatible with the compiled `dist/index.js` location:

```ts
import packageJson from "../package.json" with { type: "json" };
```

Then replace the hard-coded metadata:

```ts
const server = new Server(
  { name: "mcp-pool", version: packageJson.version },
  { capabilities: { tools: {} } },
);
```

If the existing TypeScript/Bun/Node combination does not support JSON import attributes in the emitted ESM, use `readFileSync(new URL("../package.json", import.meta.url), "utf8")` and `JSON.parse` instead. The final compiled `dist/index.js` must resolve the root package file after npm installation.

- [ ] **Step 2: Update human-facing config docs**

Apply these exact documentation changes:

1. In `README.md`, add `cooldownSeconds: 300` to the sample only if documenting a non-default is useful; otherwise omit it and state: “Defaults to 300 seconds.”
2. Add `cooldownSeconds` to the config table with: “Seconds a rate-limited key is skipped; defaults to 300.”
3. Add: “Key values may be literal strings or `${NAME}` environment references. An undefined reference is a configuration error.”
4. Remove all `strategy` and `maxConsecutiveErrors` mentions.
5. Change Development verification to:

```bash
bun install --frozen-lockfile
bun run typecheck
bun test src/
bun run smoke
bun run build
bun run check:package
```

6. In `agents.md`, remove `strategy` and `maxConsecutiveErrors` from the config shape; state that `cooldownSeconds` defaults to 300 seconds and that rate-limited keys are skipped until their cooldown ends.
7. In `project.toml`, add `cooldownSeconds` as an optional config-reference table row and ensure its prose says keys rotate after a rate limit and remain unavailable until the configured cooldown expires.

- [ ] **Step 3: Rotate and update the local config manually**

Do not write credential values into commands, commits, documentation, test fixtures, or the plan output. The user must rotate the three provider credential sets first.

After rotation, edit `~/.config/mcp-pool/mcp-pool.yaml` so it:

- Removes every `strategy: round-robin` line.
- Retains `command`, `args`, `keys`, and `rateLimitPatterns`.
- Optionally adds `cooldownSeconds` only when the default 300 seconds is unsuitable.
- Uses either newly rotated inline values or `${VAR}` references, as the user chooses.
- Remains mode `0600`.

Validate it without showing secrets:

```bash
chmod 600 ~/.config/mcp-pool/mcp-pool.yaml
bunx mcp-pool@0.1.4 --config ~/.config/mcp-pool/mcp-pool.yaml
```

Expected: stderr contains one `upstream_start` for each pool at `keyIndex: 0`, with no config error. Stop the foreground command after startup validation.

- [ ] **Step 4: Prepare the release**

Update `package.json` version to `0.1.4`, then run:

```bash
bun install --frozen-lockfile
bun run typecheck
bun test src/
bun run smoke
bun run build
bun run check:package
npm pack --dry-run
```

Expected: all checks pass and package inspection contains no compiled tests.

- [ ] **Step 5: Commit and publish**

Commit source, docs, and release metadata. Do not commit the user-local runtime config or OMP config.

```bash
git add README.md agents.md project.toml src/index.ts package.json bun.lock
git commit -m "release: prepare 0.1.4"
git push && git push --tags
npm publish
```

If the project uses `npm version patch` to create the version commit and tag instead, run it only after the verification commands above and before `git push`; do not run it after a manual version commit.

- [ ] **Step 6: Pin OMP and verify installed behavior**

After `npm view mcp-pool version` reports `0.1.4`, change the OMP MCP entry to:

```json
"mcp-pool": {
  "command": "bunx",
  "args": ["mcp-pool@0.1.4"]
}
```

Do not pre-pin an unpublished version: retain the current published pin until this step.

Then run `/mcp reload` in OMP. Confirm it exposes expected `tavily__*`, `exa__*`, and `firecrawl__*` tools and that startup logs show only `keyIndex: 0` for each pool.

---

## Final verification

- [ ] Run all repository checks:

```bash
bun install --frozen-lockfile && bun run typecheck && bun test src/ && bun run smoke && bun run build && bun run check:package && npm pack --dry-run
```

Expected: all commands exit zero; `npm pack --dry-run` has no compiled tests.

- [ ] Verify release state:

```bash
git status -sb
npm view mcp-pool version
```

Expected: clean working tree and `0.1.4`.

- [ ] Verify local config and OMP reload without printing credentials. Confirm the pool process starts a single upstream per configured pool and OMP lists prefixed tools.
