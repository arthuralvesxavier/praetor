/** Client-safe presentation maps of the claims module. */
import type { ClaimRiskLinkKind, ClaimStatus, DataOrigin } from "@/domain/enums";
import { formatDateTime } from "@/lib/format";
import type { Tone } from "@/lib/tones";
import type { DerivedRateBasis } from "./derivation";

export const CLAIM_STATUS_TONES: Record<ClaimStatus, Tone> = {
  pending_confirmation: "warning",
  confirmed: "success",
  dismissed: "neutral",
};

/** Where the process classification in force came from, seen from the claims panel. */
export function inForceSourceLabel(link: ClaimRiskLinkKind | null, origin: DataOrigin): string {
  if (link === "derived") return "Derivada dos pedidos";
  if (link === "override") return "Definida manualmente (diferente da derivada)";
  if (origin === "system") return "Sugestão por regra aprovada";
  if (origin === "imported") return "Importada";
  return "Registrada na aba de valores e risco";
}

/** How the percentage of the derived classification was obtained (claims panel). */
export const DERIVED_RATE_BASIS_LABELS: Record<DerivedRateBasis, string> = {
  weighted: "percentual ponderado pelos pedidos quantificados",
  organization_no_base: "percentual da organização para a classificação (nenhum pedido avaliado com valor)",
  organization_unquantified: "percentual da organização para a classificação (há pedido avaliado sem valor)",
};

/**
 * Attribution line of a process risk assessment linked to the claims, for the
 * risk history of the "Valores e risco" tab (use it instead of the rule
 * suggestion text when `getClaimRiskLinkKinds` returns a kind for the row).
 * A derived row is a calculation from the claim assessments, never a rule
 * suggestion approved by someone.
 */
export function claimsRiskAttribution(
  kind: ClaimRiskLinkKind,
  r: { assessedByName: string | null; createdAt: Date | string },
): string {
  const when = formatDateTime(r.createdAt);
  if (kind === "derived") {
    return `Derivada dos pedidos (cálculo automático a partir das avaliações dos pedidos)${
      r.assessedByName ? `, registrada pela ação de ${r.assessedByName}` : ""
    } em ${when}`;
  }
  return `Definida manualmente${r.assessedByName ? ` por ${r.assessedByName}` : ""} em ${when}, diferente da derivada dos pedidos, com justificativa`;
}
