import type { PoolConfig } from "./types.js";

/**
 * Secrets are the configured credential values themselves (per-key entries
 * plus stdio env), matched verbatim — no patterns, so no false positives
 * and no misses on odd key shapes. Values under 4 chars are skipped to
 * avoid mangling prose. Longest first so nested values redact fully.
 */
export function collectSecrets(config: PoolConfig): string[] {
	const secrets = new Set<string>();
	for (const keyEntry of config.keys) {
		for (const value of Object.values(keyEntry)) secrets.add(value);
	}
	if (config.env) {
		for (const value of Object.values(config.env)) secrets.add(value);
	}
	return [...secrets]
		.filter((s) => s.length >= 4)
		.sort((a, b) => b.length - a.length);
}

export function redactSecrets(text: string, secrets: string[]): string {
	let out = text;
	for (const secret of secrets) {
		if (out.includes(secret)) out = out.split(secret).join("[redacted]");
	}
	return out;
}
