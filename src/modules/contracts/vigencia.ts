/**
 * Pure vigency helpers for contracts (client-safe, no server imports).
 *
 * Everything here is simple calendar arithmetic over the dates informed in the
 * contract record. It is NOT a legal interpretation of the contract: the UI
 * labels these values as "calculada a partir das datas informadas".
 */
import type { ContractStatus } from "@/domain/enums";
import { addDaysISO, daysUntil } from "@/lib/format";
import type { Tone } from "@/lib/tones";

export const VIGENCY_STATES = ["sem_vigencia", "vigente", "vencendo", "vencido", "encerrado"] as const;
export type VigencyState = (typeof VIGENCY_STATES)[number];

export const VIGENCY_STATE_LABELS: Record<VigencyState, string> = {
  sem_vigencia: "Sem vigência em curso",
  vigente: "Em vigência",
  vencendo: "Próximo do vencimento",
  vencido: "Vigência encerrada (vencido)",
  encerrado: "Encerrado",
};

export const VIGENCY_STATE_TONES: Record<VigencyState, Tone> = {
  sem_vigencia: "neutral",
  vigente: "success",
  vencendo: "warning",
  vencido: "danger",
  encerrado: "neutral",
};

/** Default "expiring" window when the organization setting is not available (mirrors DEFAULT_ORGANIZATION_SETTINGS). */
export const DEFAULT_CONTRACT_EXPIRATION_DAYS = 60;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isIsoDate(value: string | null | undefined): value is string {
  return typeof value === "string" && ISO_DATE_RE.test(value);
}

export type VigencyInput = {
  status: ContractStatus;
  startDate: string | null;
  endDate: string | null;
};

/**
 * Vigency state of a contract on `today` ("YYYY-MM-DD"):
 *
 * - `encerrado`: status "terminated" (rescindido).
 * - `vencido`: status "expired", or an active contract whose end date is before today.
 * - `sem_vigencia`: draft / under review, or active but the start date is still in the future.
 * - `vencendo`: active and the end date is within `expiringWithinDays` days (today included).
 * - `vigente`: active, already started, and ends later (or has no end date — prazo indeterminado).
 */
export function contractVigencyState(
  contract: VigencyInput,
  today: string,
  expiringWithinDays: number = DEFAULT_CONTRACT_EXPIRATION_DAYS,
): VigencyState {
  if (contract.status === "terminated") return "encerrado";
  if (contract.status === "expired") return "vencido";
  if (contract.status !== "active") return "sem_vigencia";

  if (isIsoDate(contract.startDate) && daysUntil(contract.startDate, today) > 0) return "sem_vigencia";
  if (!isIsoDate(contract.endDate)) return "vigente";

  const remaining = daysUntil(contract.endDate, today);
  if (remaining < 0) return "vencido";
  if (remaining <= Math.max(0, expiringWithinDays)) return "vencendo";
  return "vigente";
}

/** Calendar days from `today` until the end date (negative when past, 0 = ends today); null without end date. */
export function daysToEnd(endDate: string | null | undefined, today: string): number | null {
  if (!isIsoDate(endDate)) return null;
  return daysUntil(endDate, today);
}

/**
 * Last day to give renewal/termination notice: `endDate - renewalNoticeDays`.
 * Returns null when either value is missing or invalid.
 */
export function noticeDeadline(endDate: string | null | undefined, renewalNoticeDays: number | null | undefined): string | null {
  if (!isIsoDate(endDate)) return null;
  if (renewalNoticeDays === null || renewalNoticeDays === undefined) return null;
  if (!Number.isFinite(renewalNoticeDays) || renewalNoticeDays < 0) return null;
  return addDaysISO(endDate, -Math.trunc(renewalNoticeDays));
}

/** How the notice date is labeled everywhere (contractual term arithmetic, not a legal opinion). */
export const NOTICE_DATE_LABEL = "Data-limite para aviso";
export const NOTICE_DATE_HINT = "data-limite para aviso conforme cláusula informada (término − antecedência de aviso)";

export type NoticeState = "none" | "later" | "soon" | "passed";
export type NoticeInfo = { date: string | null; days: number | null; state: NoticeState };

/**
 * Renewal/termination notice of a contract on `today`:
 * - `date` = end date − notice days, when the notice days are informed (> 0);
 * - `state` only applies to ACTIVE contracts still in force (end date today or later):
 *   `soon` when the notice date is within `windowDays` (today included), `passed`
 *   when it is already behind (the contract keeps running), `later` otherwise;
 *   every other case is `none`.
 */
export function contractNoticeInfo(
  contract: VigencyInput & { renewalNoticeDays: number | null },
  today: string,
  windowDays: number = DEFAULT_CONTRACT_EXPIRATION_DAYS,
): NoticeInfo {
  const days = contract.renewalNoticeDays;
  const date = days !== null && days > 0 ? noticeDeadline(contract.endDate, days) : null;
  if (!date || contract.status !== "active" || !isIsoDate(contract.endDate) || contract.endDate < today) {
    return { date, days: date ? daysUntil(date, today) : null, state: "none" };
  }
  const remaining = daysUntil(date, today);
  const state: NoticeState = remaining < 0 ? "passed" : remaining <= Math.max(0, windowDays) ? "soon" : "later";
  return { date, days: remaining, state };
}

/** "aviso hoje", "aviso em 12 dias", "prazo de aviso encerrado há 3 dias". */
export function noticeRelativeText(days: number | null): string | null {
  if (days === null) return null;
  if (days === 0) return "aviso hoje";
  if (days === 1) return "aviso amanhã";
  if (days > 1) return `aviso em ${days} dias`;
  return days === -1 ? "prazo de aviso encerrado há 1 dia" : `prazo de aviso encerrado há ${-days} dias`;
}

/** Short relative text for a vigency badge: "vence hoje", "vence em 12 dias", "venceu há 3 dias". */
export function vigencyRelativeText(days: number | null): string | null {
  if (days === null) return null;
  if (days === 0) return "vence hoje";
  if (days === 1) return "vence amanhã";
  if (days > 1) return `vence em ${days} dias`;
  return days === -1 ? "venceu há 1 dia" : `venceu há ${-days} dias`;
}
