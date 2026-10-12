/**
 * Environment overrides for the seed. Imported right after `dotenv/config` and
 * before any application module, so `env()` (cached on first use) already sees
 * these values.
 *
 * - AI: the seed runs in demo mode (deterministic rules, no AI, no cost) unless
 *   SEED_USE_LIVE_AI=true is set explicitly.
 * - Logs: the services log one JSON line per job; the seed keeps only warnings
 *   unless SEED_LOG_LEVEL is set.
 * - Tribunals: the seed never queries the DataJud (CNJ). Without the key the
 *   court collection is inactive for this process only (the worker and the web
 *   app keep using DATAJUD_API_KEY from .env).
 * - Power BI: no refresh is requested while seeding (the BI routine of the
 *   worker does it later with the credentials from .env).
 * - Banco Central (SGS): the only external call the seed makes, once, through
 *   the index_series_refresh routine (public series; a network failure is
 *   recorded on the series and the seed continues).
 */
if (process.env.SEED_USE_LIVE_AI !== "true") {
  process.env.AI_PROVIDER = "demo";
}
process.env.LOG_LEVEL = process.env.SEED_LOG_LEVEL ?? "warn";
process.env.DATAJUD_API_KEY = "";
process.env.POWERBI_CLIENT_SECRET = "";

export {};
