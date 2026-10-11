import type { AiUsage } from "./provider";

/** USD per million tokens (input / output). Update when provider pricing changes. */
export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-fable-5-1": { input: 10, output: 50 },
};

const DEFAULT_PRICING = MODEL_PRICING["claude-opus-5-5"];

export function modelPricing(model: string): { input: number; output: number } {
  return MODEL_PRICING[model] ?? DEFAULT_PRICING;
}

/**
 * Estimated cost in millionths of USD. USD per MTok equals micro-USD per
 * token, so cost = tokens * pricePerMTok.
 */
export function costMicroUsd(model: string, usage: AiUsage): number {
  const p = modelPricing(model);
  return Math.round(Math.max(0, usage.inputTokens) * p.input + Math.max(0, usage.outputTokens) * p.output);
}
