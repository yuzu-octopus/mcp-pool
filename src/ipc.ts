import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { connect, type Socket } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { UPSTREAM_CONNECT_TIMEOUT_MS } from "./pool.js";

/** Window a daemon with no agents waits before it shuts itself down. */
export const IDLE_GRACE_MS = 3_000;
/**
 * How long a freshly spawned proxy waits for the daemon's socket to appear.
 * Outlasts one upstream connect (a cold `bunx -y` install can take a while);
 * a daemon that fails reports it through the status file well before this.
 */
const DAEMON_START_TIMEOUT_MS = UPSTREAM_CONNECT_TIMEOUT_MS + 5_000;
const RETRY_BACKOFF_MS = 25;

export interface RuntimePaths {
	dir: string;
	socket: string;
	status: string;
}

/**
 * Runtime paths are keyed by the resolved config path, so two different configs
 * get two different daemons instead of fighting over one socket. The directory
 * is under $HOME, not os.tmpdir(): the SDK's stdio transport filters TMPDIR out
 * of the child environment, which would otherwise give the daemon a different
 * directory than the agent process that spawned it.
 */
export function runtimePaths(configPath: string): RuntimePaths {
	const key = createHash("sha256")
		.update(resolve(configPath))
		.digest("hex")
		.slice(0, 16);
	const socket = join(homedir(), ".mcp-pool", `${key}.sock`);
	return { dir: dirname(socket), socket, status: `${socket}.status` };
}

/**
 * Best-effort chmod, applied only to paths owned by this user. Never touches
 * a foreign path: an explicit socket location may live in a shared directory
 * whose permissions must keep their existing shape.
 */
function chmodIfOurs(path: string, mode: number): void {
	try {
		if (
			typeof process.getuid === "function" &&
			statSync(path).uid !== process.getuid()
		)
			return;
		chmodSync(path, mode);
	} catch {
		// Raced away or not ours — the caller still works, perms stay as-is.
	}
}

/**
 * Creates the runtime dir owner-only (0700) and tightens leftovers from
 * older runs. The socket and status file live here, so group/other must not
 * be able to list or traverse it — otherwise any local user could talk to
 * the daemon and ride the victim's keys. Runs proxy-side before spawning,
 * so the daemon inherits the tight dir even though its own mkdir leaves an
 * existing dir's permissions untouched.
 */
export function ensureRuntimeDir(paths: RuntimePaths): void {
	mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
	// mkdir's mode only applies to freshly created dirs; tighten the rest.
	chmodIfOurs(paths.dir, 0o700);
}

/** Writes "ready" or the daemon's startup error so proxies fail fast. */
export function writeStatus(paths: RuntimePaths, message: string): void {
	try {
		writeFileSync(paths.status, message, { mode: 0o600 });
		// mode only applies on creation; tighten files left by older runs.
		chmodIfOurs(paths.status, 0o600);
	} catch {
		// A missing status file only costs the proxy an extra retry.
	}
}

export function clearStatus(paths: RuntimePaths): void {
	rmSync(paths.status, { force: true });
}

/** Returns "ready" once the daemon is listening, or the error it died with. */
export function readStatus(paths: RuntimePaths): string | null {
	try {
		return readFileSync(paths.status, "utf8");
	} catch {
		return null;
	}
}

/**
 * Runtime paths for a socket that an explicit path already names. Keeps the
 * daemon on the exact socket the proxy chose, instead of re-deriving one.
 */
export function runtimePathsForSocket(socket: string): RuntimePaths {
	return { dir: dirname(socket), socket, status: `${socket}.status` };
}

/** True when the socket file is absent or has no live listener behind it. */
export function isStaleSocket(err: unknown): boolean {
	const code = (err as NodeJS.ErrnoException | null)?.code;
	return code === "ENOENT" || code === "ECONNREFUSED";
}

function socketAlive(socketPath: string): boolean {
	try {
		statSync(socketPath);
		return true;
	} catch {
		return false;
	}
}

export function connectOnce(socketPath: string): Promise<Socket> {
	return new Promise((resolvePromise, reject) => {
		const socket = connect(socketPath);
		const onError = (err: Error) => {
			socket.destroy();
			reject(err);
		};
		socket.once("error", onError);
		socket.once("connect", () => {
			socket.off("error", onError);
			// Errors after the handshake are reported to the caller by 'close'.
			socket.on("error", () => {});
			// The daemon creates the socket under a default umask; tighten it
			// now that it exists. The owner-only runtime dir already keeps
			// other users out; this is defense in depth for socket locations
			// whose parent dir is shared.
			chmodIfOurs(socketPath, 0o600);
			resolvePromise(socket);
		});
	});
}

/** Connects, spawning the daemon when the socket is missing or stale. */
export async function connectOrSpawn(
	paths: RuntimePaths,
	configPath: string,
	verbose: boolean,
	spawnFn: typeof spawnDaemon = spawnDaemon,
): Promise<Socket> {
	// Two agents can race to spawn; the loser's daemon hits EADDRINUSE and
	// exits, so the loser only has to retry connecting.
	try {
		return await connectOnce(paths.socket);
	} catch (err) {
		if (!isStaleSocket(err)) throw err;
		// ENOENT: no daemon yet. ECONNREFUSED: socket left over from a crashed
		// daemon. Either way the file cannot be trusted.
		if (socketAlive(paths.socket)) {
			rmSync(paths.socket, { force: true });
		}
		// A status left by an earlier daemon that failed to start would
		// otherwise fail this attempt before the new daemon can report.
		clearStatus(paths);
		// Spawn at most once per call: a slow daemon still starting reads as
		// ECONNREFUSED, which must not trigger a second spawn. After spawning,
		// go straight to the retry loop and wait for the socket to appear.
		spawnFn(paths, configPath, verbose);
	}

	return await connectWithRetry(paths);
}

async function connectWithRetry(paths: RuntimePaths): Promise<Socket> {
	const deadline = Date.now() + DAEMON_START_TIMEOUT_MS;
	let lastError: unknown;

	while (Date.now() < deadline) {
		// A daemon that failed to start reports why, instead of leaving the proxy
		// to spin for the whole timeout.
		const status = readStatus(paths);
		if (status !== null && status !== "ready") {
			throw new Error(`mcp-pool daemon failed to start: ${status}`);
		}

		try {
			return await connectOnce(paths.socket);
		} catch (err) {
			lastError = err;
			await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
		}
	}

	throw new Error(`daemon did not start within ${DAEMON_START_TIMEOUT_MS}ms`, {
		cause: lastError,
	});
}

/**
 * Computes the argv for re-execing the daemon. Three runtimes:
 * - `bun run src/index.ts`: argv[1] is the script path, keep it.
 * - `node dist/index.js`: argv[1] is the script path, keep it.
 * - compiled binary (`bun build --compile`): argv[1] is Bun's virtual-FS
 *   path (`/$bunfs/...`), not a real script, so re-exec the binary directly.
 *   (A leading-dash argv[1] means the same thing: no script entry.)
 */
export function daemonSpawnArgs(
	execPath: string,
	argv1: string | undefined,
	configPath: string,
	socketPath: string,
	verbose: boolean,
): string[] {
	const rest = ["--daemon", "--config", configPath, "--socket", socketPath];
	if (verbose) rest.push("--verbose");
	// Under bun/node with a script entry, argv[1] is that script and must be
	// kept. In a compiled binary argv[1] is the virtual-FS path of the entry
	// (or, on some builds, the first user flag) — neither is re-execable.
	if (
		argv1 !== undefined &&
		!argv1.startsWith("-") &&
		!argv1.startsWith("/$bunfs/")
	)
		return [execPath, argv1, ...rest];
	return [execPath, ...rest];
}

/**
 * Spawns a detached daemon so it outlives the agent that started it. That is
 * what lets a second agent reuse it instead of forking its own copies.
 */
export function spawnDaemon(
	paths: RuntimePaths,
	configPath: string,
	verbose: boolean,
): void {
	if (!process.execPath) throw new Error("cannot determine daemon executable");
	// Owner-only dir before the daemon listens, so the socket and status
	// file are born unreachable by other local users.
	ensureRuntimeDir(paths);

	const args = daemonSpawnArgs(
		process.execPath,
		process.argv[1],
		configPath,
		paths.socket,
		verbose,
	);

	const child = spawn(args[0], args.slice(1), {
		detached: true,
		stdio: "ignore",
	});
	child.unref();
}
