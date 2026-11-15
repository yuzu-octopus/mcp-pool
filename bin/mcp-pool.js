#!/usr/bin/env node
import { spawnSync } from "node:child_process";
// bin/mcp-pool.js — prebuilt-binary lookup shim (esbuild/biome pattern).
// Resolution order:
//   1. $MCP_POOL_BINARY override (escape hatch for debugging / CI pinning)
//   2. prebuilt platform package from optionalDependencies (lookup table)
//   3. `node dist/index.js` universal fallback (never hard-errors: installs
//      with --omit=optional, unknown platforms, and GHP-only installs keep
//      working, slower cold start)
import {
	accessSync,
	chmodSync,
	constants,
	mkdirSync,
	realpathSync,
	renameSync,
	rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// npm os/cpu tokens, NOT bun --target tokens. Key is
// `${process.platform}-${process.arch}-${libc}` where libc is "musl" only
// on musl linux, else "glibc". linux-arm64-musl is intentionally absent
// (bun documents bun-linux-arm64 only) and falls through to dist/.
// Value is [optionalDependency package, binary file in its bin/].
export const TABLE = {
	"darwin-arm64-glibc": [
		"@yuzu-octopus/mcp-pool-darwin-arm64",
		"mcp-pool-darwin-arm64",
	],
	"darwin-x64-glibc": [
		"@yuzu-octopus/mcp-pool-darwin-x64",
		"mcp-pool-darwin-x64",
	],
	"linux-x64-glibc": ["@yuzu-octopus/mcp-pool-linux-x64", "mcp-pool-linux-x64"],
	"linux-x64-musl": [
		"@yuzu-octopus/mcp-pool-linux-x64-musl",
		"mcp-pool-linux-x64-musl",
	],
	"linux-arm64-glibc": [
		"@yuzu-octopus/mcp-pool-linux-arm64",
		"mcp-pool-linux-arm64",
	],
	"win32-x64-glibc": [
		"@yuzu-octopus/mcp-pool-win32-x64",
		"mcp-pool-win32-x64.exe",
	],
	"win32-arm64-glibc": [
		"@yuzu-octopus/mcp-pool-win32-arm64",
		"mcp-pool-win32-arm64.exe",
	],
};
// Platform key -> `bun build --compile --target` token. Same matrix as
// scripts/build-binaries.sh; linux-arm64-musl is absent (bun ships no such
// target) and --rebuild there errors with the manual recipe.
const BUN_TARGETS = {
	"darwin-arm64-glibc": "bun-darwin-arm64",
	"darwin-x64-glibc": "bun-darwin-x64",
	"linux-x64-glibc": "bun-linux-x64",
	"linux-x64-musl": "bun-linux-x64-musl",
	"linux-arm64-glibc": "bun-linux-arm64",
	"win32-x64-glibc": "bun-windows-x64",
	"win32-arm64-glibc": "bun-windows-arm64",
};

// --rebuild: compile the binary for THIS platform in place and exit.
// Early exit like --help: no config load, no daemon. Prints the output
// path on success so the next invocation picks it up via the table above.
function rebuild(rootDir) {
	const key = platformKey();
	const target = BUN_TARGETS[key];
	if (!target) {
		console.error(
			`mcp-pool --rebuild: unsupported platform ${key} (no bun --target). ` +
				`Build manually and export MCP_POOL_BINARY=<path>.`,
		);
		process.exit(1);
	}
	const src = join(rootDir, "src", "index.ts");
	try {
		accessSync(src, constants.R_OK);
	} catch {
		console.error(
			`mcp-pool --rebuild: no source at ${src} (this install ships no src/). ` +
				`Reinstall with source, or point MCP_POOL_BINARY at a prebuilt binary.`,
		);
		process.exit(1);
	}
	const entry = TABLE[key];
	let outDir;
	if (entry) {
		try {
			const pkgJson = createRequire(import.meta.url).resolve(
				`${entry[0]}/package.json`,
			);
			outDir = join(dirname(pkgJson), "bin");
		} catch {
			// no platform package installed: reported below
		}
	}
	if (!outDir) {
		console.error(
			`mcp-pool --rebuild: no platform package installed for ${key}. ` +
				`Reinstall (optionalDependencies), or build manually ` +
				`(bun build --compile --minify --target ${target} src/index.ts ` +
				`--outfile <path>) and export MCP_POOL_BINARY=<path>.`,
		);
		process.exit(1);
	}
	try {
		mkdirSync(outDir, { recursive: true });
		accessSync(outDir, constants.W_OK);
	} catch {
		console.error(
			`mcp-pool --rebuild: cannot write to ${outDir} (permission denied). ` +
				`Retry with sudo, reinstall into a user-writable prefix ` +
				`(npm --prefix ~/.local), or build elsewhere and export MCP_POOL_BINARY=<path>.`,
		);
		process.exit(1);
	}
	const out = join(outDir, entry[1]);
	const tmp = join(outDir, `.${entry[1]}.rebuild-${process.pid}`);
	const build = spawnSync(
		"bun",
		[
			"build",
			"--compile",
			"--minify",
			"--target",
			target,
			src,
			"--outfile",
			tmp,
		],
		{ encoding: "utf8" },
	);
	if (build.error?.code === "ENOENT") {
		console.error(
			`mcp-pool --rebuild: 'bun' not found on PATH. Install bun (https://bun.sh) and retry.`,
		);
		process.exit(1);
	}
	if (build.status !== 0) {
		console.error(`mcp-pool --rebuild: build failed:\n${build.stderr ?? ""}`);
		try {
			rmSync(tmp, { force: true });
		} catch {
			// best effort cleanup
		}
		process.exit(1);
	}
	try {
		chmodSync(tmp, 0o755);
		renameSync(tmp, out);
	} catch {
		try {
			rmSync(out, { force: true });
			renameSync(tmp, out);
		} catch {
			console.error(
				`mcp-pool --rebuild: cannot replace ${out} (permission denied).`,
			);
			process.exit(1);
		}
	}
	console.log(out);
	process.exit(0);
}

// One synchronous musl probe at startup (biome pattern): glibc runtimes
// report glibcVersionRuntime; musl runtimes omit it. ldd confirms.
// Exported for the CI musl assertion (check.yml) and local docker probes.
export function isMusl() {
	if (process.platform !== "linux") return false;
	try {
		const v = process.report?.getReport?.()?.header?.glibcVersionRuntime;
		if (typeof v === "string" && v.length > 0) return false;
	} catch {
		// fall through to the ldd probe
	}
	try {
		const probe = spawnSync("ldd", ["--version"], { encoding: "utf8" });
		const out = `${probe.stdout ?? ""}${probe.stderr ?? ""}`;
		if (/musl/i.test(out)) return true;
	} catch {
		// no ldd (e.g. macOS dev machines): default glibc
	}
	return false;
}

export function platformKey() {
	// Test-only hook (underscore-prefixed, never user config): lets CI
	// assert table resolution without extra runners. See release-binaries.yml.
	if (process.env._MCP_POOL_TEST_PLATFORM) {
		return process.env._MCP_POOL_TEST_PLATFORM;
	}
	return `${process.platform}-${process.arch}-${isMusl() ? "musl" : "glibc"}`;
}

function isExecutable(path) {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function run(target, targetArgs) {
	const result = spawnSync(target, targetArgs, { stdio: "inherit" });
	if (result.signal) process.kill(process.pid, result.signal);
	process.exit(result.status ?? 1);
}

function main() {
	const dir = dirname(fileURLToPath(import.meta.url));
	const args = process.argv.slice(2);
	// --rebuild first: early exit like --help, before override/table/dist.
	if (args.includes("--rebuild")) {
		rebuild(join(dir, ".."));
		return;
	}

	// 1. Explicit override wins. Env-only, must already be executable —
	// never a bare name resolved via PATH.
	const override = process.env.MCP_POOL_BINARY;
	if (override && isExecutable(override)) {
		run(override, args);
		return;
	}

	// 2. Platform package installed alongside us (optionalDependencies).
	// package.json always resolves; the extensionless binary beside it
	// cannot be require.resolve()d, so join it manually (esbuild pattern).
	const entry = TABLE[platformKey()];
	if (entry) {
		try {
			const pkgJson = createRequire(import.meta.url).resolve(
				`${entry[0]}/package.json`,
			);
			const resolved = join(dirname(pkgJson), "bin", entry[1]);
			if (isExecutable(resolved)) {
				run(resolved, args);
				return;
			}
		} catch {
			// uninstalled / skipped optional: fall through to dist/
		}
	}

	// 3. Universal fallback: same flags, slower cold start.
	run(process.execPath, [join(dir, "..", "dist", "index.js"), ...args]);
}

// realpathSync: install roots are often symlinked (bunx links, pnpm store
// links, /tmp on macOS) while the module URL is already resolved. Compare
// resolved paths so the guard cannot fail silent (exit 0, no-op).
let invokedAsBin = false;
try {
	invokedAsBin =
		typeof process.argv[1] === "string" &&
		import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
} catch {
	invokedAsBin = false;
}
if (invokedAsBin) {
	main();
}
