/**
 * Client-safe labels and tones of the Central de e-mails (simulated delivery).
 * Kept in the module because they are only used here; the canonical enum
 * labels stay in `@/domain/enums`.
 */
import type { EmailStatus } from "@/domain/enums";
import type { Tone } from "@/lib/tones";

/** Mandatory banner of every simulated e-mail screen (MODULE_CONTRACTS → Simulation labeling). */
export const SIMULATED_EMAIL_BANNER = "Envio simulado: nenhuma mensagem foi enviada";

/** Header callout of the Central de e-mails. */
export const EMAIL_CENTER_NOTICE =
  "Central de e-mails simulados: nenhuma mensagem é entregue; os envios ficam registrados aqui para demonstração";

/** Short status label for tables and badges (the long one is EMAIL_STATUS_LABELS). */
export const EMAIL_STATUS_SHORT_LABELS: Record<EmailStatus, string> = {
  simulated: "Simulado",
  failed: "Falha",
  cancelled: "Cancelado",
};

export const EMAIL_STATUS_TONES: Record<EmailStatus, Tone> = {
  simulated: "info",
  failed: "danger",
  cancelled: "neutral",
};

/** Event types stored in `email_events.type`. */
export const EMAIL_EVENT_TYPES = ["composed", "simulated_delivery", "viewed", "failed", "resent"] as const;
export type EmailEventType = (typeof EMAIL_EVENT_TYPES)[number];

export const EMAIL_EVENT_LABELS: Record<EmailEventType, string> = {
  composed: "Mensagem gerada",
  simulated_delivery: "Entrega simulada registrada (nada foi enviado)",
  viewed: "Aberta pelo destinatário na central",
  failed: "Falha ao gerar o envio",
  resent: "Reenviada (simulação)",
};

export const EMAIL_EVENT_TONES: Record<EmailEventType, Tone> = {
  composed: "neutral",
  simulated_delivery: "info",
  viewed: "success",
  failed: "danger",
  resent: "primary",
};

export function emailEventLabel(type: string): string {
  return (EMAIL_EVENT_LABELS as Record<string, string>)[type] ?? type;
}

export function emailEventTone(type: string): Tone {
  return (EMAIL_EVENT_TONES as Record<string, Tone>)[type] ?? "neutral";
}
