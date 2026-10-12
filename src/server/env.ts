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
  /**
   * DataJud (CNJ) public API key. It is a PUBLIC key published by the CNJ at
   * https://datajud-wiki.cnj.jus.br/api-publica/acesso and may be rotated by
   * the CNJ at any time. Without it the court data collection stays inactive.
   */
  DATAJUD_API_KEY: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() !== "" ? v.trim() : undefined)),
  DATAJUD_BASE_URL: z.string().url().default("https://api-publica.datajud.cnj.jus.br"),
  /** Per-request timeout (DataJud queries commonly take 7 to 25 s). */
  DATAJUD_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
  /**
   * Power BI (docs/POWER_BI.md): app registration (service principal) in
   * Microsoft Entra ID. Without the three ids/secret the BI panels stay in the
   * setup state and no refresh is requested. Never stored in the database.
   */
  POWERBI_TENANT_ID: z.string().optional(),
  POWERBI_CLIENT_ID: z.string().optional(),
  POWERBI_CLIENT_SECRET: z.string().optional(),
  POWERBI_API_URL: z.string().url().default("https://api.powerbi.com"),
  POWERBI_AUTHORITY_URL: z.string().url().default("https://login.microsoftonline.com"),
  /** Password of the read-only database role (`praetor_bi`, or the one given with --role) used only by scripts/bi-setup.ts. */
  BI_DB_PASSWORD: z.string().optional(),
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
