/**
 * Environment overrides for the seed. Imported right after `dotenv/config` and
 * before any application module, so `env()` (cached on first use) already sees
 * these values.
 *
 * - AI: the seed runs in demo mode (deterministic rules, no AI, no cost) unless
 *   SEED_USE_LIVE_AI=true is set explicitly.
 * - Logs: the services log one JSON line per job; the seed keeps only warnings
 *   unless SEED_LOG_LEVEL is set.
 */
if (process.env.SEED_USE_LIVE_AI !== "true") {
  process.env.AI_PROVIDER = "demo";
}
process.env.LOG_LEVEL = process.env.SEED_LOG_LEVEL ?? "warn";

export {};
