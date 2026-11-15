import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	connectOnce,
	connectOrSpawn,
	daemonSpawnArgs,
	ensureRuntimeDir,
	writeStatus,
	type RuntimePaths,
} from "./ipc.js";

const CFG = "/tmp/mcp-pool-test.yaml";
const SOCK = "/tmp/mcp-pool-test.sock";

describe("daemonSpawnArgs", () => {
	test("node style keeps the script entry", () => {
		expect(
			daemonSpawnArgs("/usr/bin/node", "/app/dist/index.js", CFG, SOCK, false),
		).toEqual([
			"/usr/bin/node",
			"/app/dist/index.js",
			"--daemon",
			"--config",
			CFG,
			"--socket",
			SOCK,
		]);
	});

	test("bun dev style keeps the script entry and appends verbose", () => {
		expect(
			daemonSpawnArgs("/usr/bin/bun", "src/index.ts", CFG, SOCK, true),
		).toEqual([
			"/usr/bin/bun",
			"src/index.ts",
			"--daemon",
			"--config",
			CFG,
			"--socket",
			SOCK,
			"--verbose",
		]);
	});

	test("compiled binary with flag first drops argv[1]", () => {
		expect(
			daemonSpawnArgs("/tmp/mcp-pool", "--config", CFG, SOCK, false),
		).toEqual(["/tmp/mcp-pool", "--daemon", "--config", CFG, "--socket", SOCK]);
	});

	test("compiled binary with $bunfs entry re-execs directly", () => {
		expect(
			daemonSpawnArgs(
				"/tmp/mcp-pool",
				"/$bunfs/root/mcp-pool-reexec-check",
				CFG,
				SOCK,
				false,
			),
		).toEqual(["/tmp/mcp-pool", "--daemon", "--config", CFG, "--socket", SOCK]);
	});

	test("compiled binary with no argv1 re-execs directly", () => {
		expect(
			daemonSpawnArgs("/tmp/mcp-pool", undefined, CFG, SOCK, false),
		).toEqual(["/tmp/mcp-pool", "--daemon", "--config", CFG, "--socket", SOCK]);
	});

	test("empty execPath passes through verbatim (guard lives in spawnDaemon)", () => {
		expect(daemonSpawnArgs("", "/app/dist/index.js", CFG, SOCK, false)).toEqual(
			["", "/app/dist/index.js", "--daemon", "--config", CFG, "--socket", SOCK],
		);
	});
});

describe("connectOrSpawn single-spawn (CORRECT-07)", () => {
	test("spawns at most once while the daemon starts slowly", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mcp-pool-ipc-once-"));
		const socket = join(dir, "d.sock");
		const paths: RuntimePaths = { dir, socket, status: `${socket}.status` };
		let spawns = 0;
		let server: Server | undefined;
		try {
			const slowSpawn = () => {
				spawns++;
				// Slow daemon: the socket appears well after the first retry,
				// which previously read as ECONNREFUSED and triggered a
				// second spawn. Genuine delay: the retry loop waits on real
				// socket I/O, so fake timers cannot drive it.
				setTimeout(() => {
					server = createServer((s) => {
						s.on("error", () => {});
						s.end();
					});
					server.listen(socket);
				}, 300);
			};
			const sock = await connectOrSpawn(paths, join(dir, "nope.yaml"), false, slowSpawn);
			sock.destroy();
			expect(spawns).toBe(1);
		} finally {
			if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("runtime permissions (SEC-01)", () => {
	test("ensureRuntimeDir creates the dir owner-only", () => {
		const base = mkdtempSync(join(tmpdir(), "mcp-pool-ipc-dir-"));
		try {
			const dir = join(base, "nested", "rt");
			ensureRuntimeDir({
				dir,
				socket: join(dir, "d.sock"),
				status: join(dir, "d.sock.status"),
			});
			expect(statSync(dir).mode & 0o777).toBe(0o700);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	test("ensureRuntimeDir tightens a leftover loose dir", () => {
		const dir = mkdtempSync(join(tmpdir(), "mcp-pool-ipc-loose-"));
		try {
			chmodSync(dir, 0o755);
			ensureRuntimeDir({
				dir,
				socket: join(dir, "d.sock"),
				status: join(dir, "d.sock.status"),
			});
			expect(statSync(dir).mode & 0o777).toBe(0o700);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("writeStatus leaves an owner-only status file", () => {
		const dir = mkdtempSync(join(tmpdir(), "mcp-pool-ipc-status-"));
		try {
			const paths: RuntimePaths = {
				dir,
				socket: join(dir, "d.sock"),
				status: join(dir, "d.sock.status"),
			};
			writeStatus(paths, "ready");
			expect(statSync(paths.status).mode & 0o777).toBe(0o600);
			// Files left by older runs get tightened too.
			chmodSync(paths.status, 0o644);
			writeStatus(paths, "ready");
			expect(statSync(paths.status).mode & 0o777).toBe(0o600);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("connectOnce tightens a loose socket to owner-only", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mcp-pool-ipc-sock-"));
		const socket = join(dir, "d.sock");
		const server = createServer((s) => {
			s.on("error", () => {});
			s.end();
		});
		try {
			await new Promise<void>((resolve) => server.listen(socket, resolve));
			// Simulate a socket born under a default umask.
			chmodSync(socket, 0o755);
			const sock = await connectOnce(socket);
			sock.destroy();
			expect(statSync(socket).mode & 0o777).toBe(0o600);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
