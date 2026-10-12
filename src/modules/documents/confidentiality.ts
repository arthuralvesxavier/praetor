import type { ConfidentialityLevel, DocumentCategory } from "@/domain/enums";

/**
 * Confidentiality rules shared by the service and the forms (client-safe).
 *
 * PD-04: documents of category `sensitive_health` (atestado, laudo, CAT) hold
 * sensitive personal data and are always stored as `restricted`, whatever
 * level was selected (row visibility additionally limits them, see rule 12 in
 * src/server/auth/access.ts).
 */
export function effectiveConfidentiality(category: DocumentCategory, requested: ConfidentialityLevel): ConfidentialityLevel {
  return category === "sensitive_health" ? "restricted" : requested;
}

export const SENSITIVE_HEALTH_HINT =
  "Atestados, laudos e CAT contêm dados sensíveis de saúde: o documento é salvo sempre como Restrito " +
  "(visível para gestores, quem enviou e o responsável pelo registro vinculado).";
