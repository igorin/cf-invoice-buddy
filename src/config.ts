import { z } from "zod";
import { PRICED_MODEL_IDS } from "./domain/models";

/**
 * Every variable and secret the Worker needs, parsed once per request path
 * that uses it. A missing or malformed value fails loudly and names the
 * variable, never its value (spec section 3).
 */
/** An optional variable. An empty value counts as not set. */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess(
    (value) => (value === "" ? undefined : value),
    schema.optional()
  );

const ConfigSchema = z.object({
  CF_ACCOUNT_ID: z.string().regex(/^[0-9a-f]{32}$/),
  CF_API_TOKEN: z.string().min(20),
  DAILY_NEURON_BUDGET: z.coerce.number().int().positive(),
  SMOKE_DAILY_NEURON_BUDGET: z.coerce.number().int().positive(),
  ENVIRONMENT: z.enum(["local", "staging", "production"]),
  ACCESS_TEAM_DOMAIN: z.string().regex(/^[a-z0-9-]+\.cloudflareaccess\.com$/),
  ACCESS_AUD: z.string().regex(/^[0-9a-f]{64}$/),
  AUTH_MODE: z.enum(["access", "dev"]).default("access"),
  // Cheaper testing (spec section 10). All three are off unless set, and
  // none of them changes an owner's conversation.
  /** The model the smoke-test instance uses. */
  SMOKE_MODEL_ID: optional(z.enum(PRICED_MODEL_IDS)),
  /** An AI Gateway whose cache serves the deployed smoke-test instance. */
  AI_GATEWAY_ID: optional(z.string().regex(/^[a-z0-9_-]{1,64}$/)),
  SMOKE_CACHE_TTL_SECONDS: optional(
    z.coerce.number().int().min(60).max(86_400)
  ),
  /** Local only: keep the model's raw streams for the recording script. */
  RECORD_MODEL_CALLS: optional(z.enum(["0", "1"])),
  /** Local only: answer from a fixed script, for the browser tests. */
  SCRIPTED_MODEL: optional(z.enum(["0", "1"]))
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
