import { describe, expect, test } from "bun:test";
import { daemonSpawnArgs } from "./ipc.js";

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
		expect(daemonSpawnArgs("", "/app/dist/index.js", CFG, SOCK, false)).toEqual([
			"",
			"/app/dist/index.js",
			"--daemon",
			"--config",
			CFG,
			"--socket",
			SOCK,
		]);
	});
});
