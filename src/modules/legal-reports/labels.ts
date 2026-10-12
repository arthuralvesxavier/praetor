import type { LegalReportStatus, ReportItemOrigin } from "@/domain/enums";
import type { Tone } from "@/lib/tones";

/** Tons de interface (client-safe). Violeta fica reservado para conteúdo de IA. */
export const LEGAL_REPORT_STATUS_TONES: Record<LegalReportStatus, Tone> = {
  draft: "neutral",
  pending_review: "warning",
  approved: "success",
  superseded: "neutral",
};

export const REPORT_ITEM_ORIGIN_TONES: Record<ReportItemOrigin, Tone> = {
  documented: "success",
  record: "info",
  inference: "warning",
  analysis: "primary",
  gap: "danger",
};

/** Parâmetro `situacao` da lista (pt-BR na URL). */
export const STATUS_PARAMS: Record<string, LegalReportStatus> = {
  pendentes: "pending_review",
  aprovados: "approved",
  substituidos: "superseded",
};
