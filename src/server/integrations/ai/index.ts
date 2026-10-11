import type { AiMode } from "@/domain/enums";
import { env } from "@/server/env";
import { AnthropicProvider } from "./anthropic";
import { DemoProvider } from "./demo";
import type { AiProvider } from "./provider";

export { AiProviderError } from "./provider";
export type { AiAnalysisRequest, AiProvider, AiSource, AiUsage } from "./provider";
export { PROMPT_VERSION, buildSystemPrompt, buildUserContent } from "./prompt";
export { costMicroUsd } from "./pricing";
export { DemoProvider } from "./demo";

let override: AiProvider | null = null;
let cached: { key: string; provider: AiProvider } | null = null;

/**
 * Selects the provider from `AI_PROVIDER`:
 * - `demo`      -> DemoProvider (deterministic rules, no AI)
 * - `anthropic` -> AnthropicProvider (requires ANTHROPIC_API_KEY)
 * - `auto`      -> Anthropic when ANTHROPIC_API_KEY is set, otherwise demo
 */
export function getAiProvider(): AiProvider {
  if (override) return override;
  const e = env();
  const useLive = e.AI_PROVIDER === "anthropic" || (e.AI_PROVIDER === "auto" && !!e.ANTHROPIC_API_KEY);
  const key = useLive ? `anthropic:${e.AI_MODEL}:${e.AI_EFFORT}:${e.AI_MAX_OUTPUT_TOKENS}` : "demo";
  if (cached?.key === key) return cached.provider;
  const provider: AiProvider = useLive ? new AnthropicProvider() : new DemoProvider();
  cached = { key, provider };
  return provider;
}

/** What the UI shows about the AI configuration (never secrets). */
export function getAiRuntimeInfo(): { mode: AiMode; provider: string; model: string } {
  try {
    const p = getAiProvider();
    return { mode: p.mode, provider: p.name, model: p.model };
  } catch {
    // Misconfigured live provider (e.g. AI_PROVIDER=anthropic without key): report as live/unavailable.
    return { mode: "live", provider: "anthropic", model: env().AI_MODEL };
  }
}

/** Tests only: replace the provider (pass null to restore env-based selection). */
export function setAiProviderForTesting(provider: AiProvider | null): void {
  override = provider;
  cached = null;
}
