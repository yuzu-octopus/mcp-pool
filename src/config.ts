import { z } from "zod";
import { parse as parseYaml } from "yaml";
import { readFileSync, existsSync } from "node:fs";

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

  parsed = expandEnvVars(parsed, path);

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
