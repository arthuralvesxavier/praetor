/** Client-safe tones and texts of the court-sync screens. */
import type { CourtSyncRunStatus, CourtSyncStatus } from "@/domain/enums";
import type { Tone } from "@/lib/tones";

export const COURT_SYNC_STATUS_TONES: Record<CourtSyncStatus, Tone> = {
  pending: "neutral",
  found: "success",
  not_found: "warning",
  error: "danger",
  unsupported: "neutral",
};

export const COURT_SYNC_RUN_STATUS_TONES: Record<CourtSyncRunStatus, Tone> = {
  running: "info",
  succeeded: "success",
  partial: "warning",
  failed: "danger",
};

/** What the DataJud public API does NOT provide (shown next to every view of its data). */
export const DATAJUD_LIMITS_NOTICE =
  "Fonte oficial: API pública do DataJud (CNJ), somente leitura. O DataJud não informa partes, valores, documentos nem a data das audiências.";

export const GRAU_LABELS: Record<string, string> = {
  G1: "1º grau",
  G2: "2º grau",
  SUP: "Tribunal superior",
  JE: "Juizado especial",
  TR: "Turma recursal",
};

export function grauText(grau: string): string {
  return GRAU_LABELS[grau.toUpperCase()] ?? grau;
}
