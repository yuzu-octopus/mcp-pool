import { z } from "zod";
import { parse as parseYaml } from "yaml";
import { readFileSync, existsSync } from "node:fs";

const PoolConfigSchema = z.object({
  command: z.string().min(1, "command is required"),
  args: z.array(z.string()),
  keys: z
    .array(z.record(z.string()))
    .min(1, "keys must have at least one entry"),
  strategy: z.enum(["round-robin", "deplete-first"]).optional(),
  cooldownSeconds: z.coerce.number().int().positive().optional(),
  maxConsecutiveErrors: z.coerce.number().int().positive().optional(),
  rateLimitPatterns: z
    .array(z.string().min(1))
    .min(1, "rateLimitPatterns is required")
    .refine(
      (pats) => pats.every((p) => { try { new RegExp(p); return true } catch { return false } }),
      { message: "all rateLimitPatterns entries must be valid regular expressions" },
    ),
  cwd: z.string().optional(),
});
const ConfigFileSchema = z.object({
  pools: z.record(PoolConfigSchema),
});

export { PoolConfigSchema, ConfigFileSchema };

export type ValidatedPoolConfig = z.infer<typeof PoolConfigSchema>;
export type ValidatedConfigFile = z.infer<typeof ConfigFileSchema>;

function resolveConfigPath(cliArg?: string): string {
  if (cliArg) return cliArg;
  const candidates = [
    "./mcp-pool.yaml",
    "./mcp-pool.yml",
    "./.mcp-pool.yaml",
    "./.mcp-pool.yml",
    process.env.HOME + "/.config/mcp-pool/mcp-pool.yaml",
    process.env.HOME + "/.config/mcp-pool/mcp-pool.yml",
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return "./mcp-pool.yaml";
}

function expandEnvVars(obj: unknown): unknown {
  if (typeof obj === "string") {
    return obj.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? "");
  }
  if (Array.isArray(obj)) return obj.map(expandEnvVars);
  if (obj && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      result[k] = expandEnvVars(v);
    }
    return result;
  }
  return obj;
}

export interface LoadedConfig {
  path: string;
  config: ValidatedConfigFile;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function loadConfig(cliArg?: string): LoadedConfig {
  const path = resolveConfigPath(cliArg);

  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    throw new ConfigError(`cannot read config file: ${path}`);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConfigError(`invalid YAML in ${path}: ${msg}`);
  }

  parsed = expandEnvVars(parsed);

  const result = ConfigFileSchema.safeParse(parsed);
  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) => `  ${issue.path.join(".")}: ${issue.message}`,
    );
    throw new ConfigError(`config errors in ${path}:\n${lines.join("\n")}`);
  }

  return { path, config: result.data };
}

export { resolveConfigPath };
