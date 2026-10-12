import type { AiMode } from "@/domain/enums";
import type { CaseBriefProvider } from "./provider";
import { SimulatedCaseBriefProvider } from "./simulated";

export { pageForOffset } from "./provider";
export type {
  CaseBriefDocumentSource,
  CaseBriefProvider,
  CaseBriefRecord,
  CaseBriefRequest,
  CaseBriefResponse,
} from "./provider";
export { CASE_BRIEF_SIMULATION_VERSION, SimulatedCaseBriefProvider, buildSimulatedCaseBrief } from "./simulated";

let override: CaseBriefProvider | null = null;
let simulated: SimulatedCaseBriefProvider | null = null;

/**
 * Provider of the preliminary case analysis. In this version it is ALWAYS the
 * simulated provider (deterministic rules, no AI). The live adapter in
 * ./live.ts exists for a future version and is intentionally not selectable:
 * enabling it requires an explicit configuration flag (not present yet) and a
 * review of costs, data protection and the labeling rules.
 */
export function getCaseBriefProvider(): CaseBriefProvider {
  if (override) return override;
  simulated ??= new SimulatedCaseBriefProvider();
  return simulated;
}

/** What the UI shows about the case-brief provider (never secrets). */
export function getCaseBriefRuntimeInfo(): { mode: AiMode; provider: string; model: string } {
  const p = getCaseBriefProvider();
  return { mode: p.mode, provider: p.name, model: p.model };
}

/** Tests only: replace the provider (pass null to restore the simulated provider). */
export function setCaseBriefProviderForTesting(provider: CaseBriefProvider | null): void {
  override = provider;
}
