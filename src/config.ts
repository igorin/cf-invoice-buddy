import { z } from "zod";

/**
 * Every variable and secret the Worker needs, parsed once per request path
 * that uses it. A missing or malformed value fails loudly and names the
 * variable, never its value (spec section 3).
 */
const ConfigSchema = z.object({
  CF_ACCOUNT_ID: z.string().regex(/^[0-9a-f]{32}$/),
  CF_API_TOKEN: z.string().min(20),
  DAILY_NEURON_BUDGET: z.coerce.number().int().positive(),
  SMOKE_DAILY_NEURON_BUDGET: z.coerce.number().int().positive(),
  ENVIRONMENT: z.enum(["local", "staging", "production"]),
  ACCESS_TEAM_DOMAIN: z.string().regex(/^[a-z0-9-]+\.cloudflareaccess\.com$/),
  ACCESS_AUD: z.string().regex(/^[0-9a-f]{64}$/),
  AUTH_MODE: z.enum(["access", "dev"]).default("access")
});

export type Config = z.infer<typeof ConfigSchema>;

export type ConfigResult =
  | { ok: true; config: Config }
  | { ok: false; invalid: ReadonlyArray<string> };

export function readConfig(env: unknown): ConfigResult {
  const parsed = ConfigSchema.safeParse(env);
  if (parsed.success) return { ok: true, config: parsed.data };
  const invalid = [
    ...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))
  ];
  return { ok: false, invalid };
}
