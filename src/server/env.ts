import { z } from "zod";

/**
 * Server environment. Parsed lazily so that importing a module never crashes
 * the build; the first call to `env()` validates everything.
 * Secrets live only in environment variables — never in code or the database.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1).default("postgres://postgres:postgres@127.0.0.1:54329/praetor"),
  /** Public base URL, used for absolute links and cookie `secure` decisions. */
  APP_URL: z.string().url().default("http://localhost:3000"),
  /** Directory where uploaded files are stored by the local storage provider (outside /public). */
  STORAGE_DIR: z.string().default("./storage"),
  MAX_UPLOAD_MB: z.coerce.number().positive().max(100).default(20),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(12),
  /** `auto` = anthropic when ANTHROPIC_API_KEY is set, otherwise demo. */
  AI_PROVIDER: z.enum(["auto", "anthropic", "demo"]).default("auto"),
  ANTHROPIC_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default("claude-opus-5-5"),
  AI_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
  /** Hard cap of output tokens per analysis request. */
  AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(16000),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function env(): Env {
  if (!cached) cached = envSchema.parse(process.env);
  return cached;
}

/** For tests only. */
export function resetEnvCache() {
  cached = undefined;
}
