import { expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	watch,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { runtimePaths } from "../src/ipc.js";

async function waitForClosed(lifecycleFile: string): Promise<void> {
	if (
		existsSync(lifecycleFile) &&
		readFileSync(lifecycleFile, "utf8") === "closed"
	)
		return;

	const directory = dirname(lifecycleFile);
	const closed = Promise.withResolvers<void>();
	const watcher = watch(directory, () => {
		if (
			existsSync(lifecycleFile) &&
			readFileSync(lifecycleFile, "utf8") === "closed"
		) {
			closed.resolve();
		}
	});

	try {
		// This cross-process integration test needs a bounded real-time wait for fs events.
		await Promise.race([
			closed.promise,
			new Promise<void>((resolve) =>
				AbortSignal.timeout(2_000).addEventListener("abort", () => resolve(), {
					once: true,
				}),
			),
		]);
	} finally {
		watcher.close();
	}
}

test("closes started pools when a later pool fails startup", async () => {
	const directory = mkdtempSync(join(tmpdir(), "mcp-pool-startup-cleanup-"));
	const configFile = join(directory, "config.yaml");
	const lifecycleFile = join(directory, "lifecycle");
	let client: Client | undefined;
	let transport: StdioClientTransport | undefined;

	writeFileSync(
		configFile,
		`pools:
  first:
    command: bun
    args: ["run", "test/helper-server.ts"]
    keys:
      - { TEST_LIFECYCLE_FILE: "${lifecycleFile}" }
    rateLimitPatterns: ["rate_limit_exceeded"]
  second:
    command: bun
    args: ["run", "test/helper-server.ts"]
    keys:
      - { TEST_CRASH_ON_START: "1" }
    rateLimitPatterns: ["rate_limit_exceeded"]
`,
	);

	try {
		transport = new StdioClientTransport({
			command: "bun",
			args: ["run", "src/index.ts", "--local", "--config", configFile],
		});
		client = new Client(
			{ name: "startup-cleanup-test", version: "0.1.0" },
			{ capabilities: {} },
		);

		await expect(client.connect(transport)).rejects.toThrow();
		await waitForClosed(lifecycleFile);
		expect(readFileSync(lifecycleFile, "utf8")).toBe("closed");
	} finally {
		await client?.close().catch(() => {});
		await transport?.close().catch(() => {});
		rmSync(directory, { recursive: true, force: true });
	}
});

test("--version prints package version to stdout and exits 0", () => {
	const proc = Bun.spawnSync({
		cmd: ["bun", "run", "src/index.ts", "--version"],
		stdout: "pipe",
		stderr: "pipe",
		cwd: join(import.meta.dir, ".."),
	});
	const out = proc.stdout.toString().trim();
	const pkg = JSON.parse(
		readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"),
	) as { version: string };
	expect(proc.exitCode).toBe(0);
	expect(out).toContain(pkg.version);
});

test("unknown flag exits 2 with error + usage and no stack trace", () => {
	const proc = Bun.spawnSync({
		cmd: ["bun", "run", "src/index.ts", "--nope"],
		stdout: "pipe",
		stderr: "pipe",
		cwd: join(import.meta.dir, ".."),
	});
	const err = proc.stderr.toString();
	expect(proc.exitCode).toBe(2);
	expect(err).toMatch(/mcp-pool: error:/);
	expect(err).toMatch(/Usage: mcp-pool/);
	expect(err).not.toMatch(/\n\s+at\s/);
});

test("bad --port exits 2 with error and no stack trace", () => {
	const proc = Bun.spawnSync({
		cmd: ["bun", "run", "src/index.ts", "--port", "abc"],
		stdout: "pipe",
		stderr: "pipe",
		cwd: join(import.meta.dir, ".."),
	});
	const err = proc.stderr.toString();
	expect(proc.exitCode).toBe(2);
	expect(err).toMatch(/mcp-pool: error:/);
	expect(err).not.toMatch(/\n\s+at\s/);
});

test.each(["--help", "-h"])("%s exits 0 without spawning a daemon", (flag) => {
	const directory = mkdtempSync(join(tmpdir(), "mcp-pool-help-"));
	const configFile = join(directory, "config.yaml");
	writeFileSync(
		configFile,
		`pools:\n  main:\n    command: bun\n    args: ["run", "test/helper-server.ts"]\n    keys:\n      - {}\n`,
	);
	try {
		const paths = runtimePaths(configFile);
		const proc = Bun.spawnSync({
			cmd: ["bun", "run", "src/index.ts", flag, "--config", configFile],
			stdout: "pipe",
			stderr: "pipe",
			cwd: join(import.meta.dir, ".."),
		});
		expect(proc.exitCode).toBe(0);
		expect(proc.stdout.toString()).toContain("Usage: mcp-pool");
		expect(existsSync(paths.socket)).toBe(false);
		expect(existsSync(paths.status)).toBe(false);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
