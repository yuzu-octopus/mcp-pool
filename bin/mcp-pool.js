#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const binary = join(dir, "..", "mcp-pool-bin");
let target = binary;
let targetArgs = args;
try {
	accessSync(binary, constants.X_OK);
} catch {
	target = process.execPath;
	targetArgs = [join(dir, "..", "dist", "index.js"), ...args];
}
const result = spawnSync(target, targetArgs, { stdio: "inherit" });
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);
