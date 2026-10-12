/**
 * Decision band of the process detail (P0.4): the compact strip shown before the
 * tabs of `/processos/[id]`. Pure and client-safe: the loader
 * (`./decision-band-service`) reads the records with the user's row scope and this
 * module turns them into the model the UI renders.
 *
 * Blocks:
 * - pendências   open alerts of the process and of its hearings, settlements and
 *                guarantees; suggested deadlines awaiting human validation; the
 *                "pendente de conferência" flag (needsVerification); scheduled hearings
 *                of a past day without a recorded outcome (registration gaps are listed
 *                once, by the cover of the "Resumo" tab: `./cover`);
 * - próximo ato  the nearest of: open deadline that counts as a real deadline
 *                (validation_status in ('not_required', 'validated')) — overdue first —
 *                and scheduled hearing from today on;
 * - valores      proposed valuations awaiting human review (count and amounts, never
 *                summed: kinds differ, RN-02), each linked to `/contingencias/revisao?item=`;
 * - risco        official classification in force today (+ %), else the classification
 *                kept on the record (flagged), else "sem classificação";
 * - responsável  name and law firm; without one, a link to the distribution when allowed.
 *
 * Permissions are decided by the loader (`BandAccess`) and enforced again here: without
 * `contingency` no amount, percentage or classification reaches the model, whatever the
 * input carries.
 */
import type {
  AlertSeverity,
  AlertType,
  DeadlineKind,
  HearingKind,
  HearingMode,
  LossProbability,
  ValidationStatus,
  ValuationKind,
  ValuationSource,
  ValuationStatus,
} from "@/domain/enums";
import { toISODate } from "@/lib/format";
import { PROCESS_SECTION_IDS, processTabUrl } from "./tabs";

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** What the viewer may see or do (computed from the permissions by the loader). */
export type BandAccess = {
  /** dashboard:read — open alerts (each one still follows `visibleAlertsWhere`). */
  alerts: boolean;
  /** deadline:read — deadlines in "próximo ato" and suggestions awaiting validation. */
  deadlines: boolean;
  /** contingency:read — "valor aguardando conferência", "risco" and value alerts. */
  contingency: boolean;
  /** contingency:write — "Classificar" link. */
  classify: boolean;
  /** distribution:manage — link to `/distribuicao` for the process. */
  distribute: boolean;
};

export type BandProcessFacts = {
  id: string;
  needsVerification: boolean;
  verificationNote: string | null;
  responsibleId: string | null;
  responsibleName: string | null;
  lawFirmName: string | null;
  /** Classification kept on the record (mirror); read only with `contingency`. */
  lossProbability: LossProbability | null;
  /** Percentage of the record (mirror, else organization % of the classification); only with `contingency`. */
  recordRiskBp: number | null;
};

export type BandAlert = {
  id: string;
  type: AlertType;
  severity: AlertSeverity;
  title: string;
  /** Link resolved by the alerts module (process tab), or null. */
  href: string | null;
  createdAt: Date;
};

/** Open deadline of the process. */
export type BandDeadline = {
  id: string;
  title: string;
  kind: DeadlineKind;
  dueDate: string;
  validationStatus: ValidationStatus;
};

/** Scheduled hearing of the process. */
export type BandHearing = {
  id: string;
  kind: HearingKind;
  mode: HearingMode;
  scheduledAt: Date;
};

/** Proposed valuation of the process. */
export type BandValuation = {
  id: string;
  kind: ValuationKind;
  amountCents: number;
  baseDate: string;
  source: ValuationSource;
  isEstimate: boolean;
  createdAt: Date;
};

export type BandRiskAssessment = {
  id: string;
  classification: LossProbability;
  percentageBp: number;
  effectiveFrom: string;
  status: ValuationStatus;
  createdAt: Date;
};

export type ProcessBandInput = {
  /** Today in America/Sao_Paulo ("YYYY-MM-DD"). */
  today: string;
  access: BandAccess;
  process: BandProcessFacts;
  alerts: readonly BandAlert[];
  deadlines: readonly BandDeadline[];
  hearings: readonly BandHearing[];
  valuations: readonly BandValuation[];
  risks: readonly BandRiskAssessment[];
};

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export type PendencyTone = "danger" | "warning" | "info";
export type PendencyKind = "verification" | "alert" | "deadline_validation" | "hearing_outcome";

export type BandPendency = {
  key: string;
  kind: PendencyKind;
  tone: PendencyTone;
  label: string;
  detail: string | null;
  /** Calendar date shown with the item (due date, hearing day), when any. */
  date: string | null;
  /** Where the user acts; null when the action lives on this page (e.g. the header buttons). */
  href: string | null;
  actionLabel: string | null;
};

export type NextAct =
  | {
      kind: "deadline";
      id: string;
      title: string;
      deadlineKind: DeadlineKind;
      date: string;
      overdue: boolean;
      /** AI or preliminary-analysis suggestion validated by a person. */
      validated: boolean;
      href: string;
    }
  | {
      kind: "hearing";
      id: string;
      hearingKind: HearingKind;
      mode: HearingMode;
      date: string;
      at: Date;
      href: string;
    };

export type BandNextAct = {
  act: NextAct | null;
  /** Other acts after the next one (same rules). */
  more: number;
  /** False when the viewer has no deadline:read (only hearings were considered). */
  deadlinesConsidered: boolean;
  /** Where the remaining acts are listed. */
  moreHref: string;
};

export type BandValuationItem = {
  id: string;
  kind: ValuationKind;
  amountCents: number;
  baseDate: string;
  source: ValuationSource;
  /** `source = simulation`: labeled "Extração simulada (demonstração)". */
  simulated: boolean;
  estimate: boolean;
  href: string;
};

export type BandValuations = {
  total: number;
  /** Oldest first (review-queue order). Amounts are never summed (RN-02). */
  items: BandValuationItem[];
  /** Review of the oldest pending value, or the whole queue when none. */
  href: string;
};

export type BandRisk = {
  classification: LossProbability | null;
  percentageBp: number | null;
  /** official = assessment in force today; record = only the classification kept on the record; none. */
  basis: "official" | "record" | "none";
  effectiveFrom: string | null;
  /** Rule suggestions (RF-12) awaiting approval. */
  pendingProposals: number;
  href: string;
  canClassify: boolean;
};

export type BandResponsible = {
  assigned: boolean;
  name: string | null;
  lawFirmName: string | null;
  /** `/distribuicao?aba=regras&processo=<id>` for `distribution:manage`, else null. */
  distributeHref: string | null;
};

export type ProcessDecisionBand = {
  processId: string;
  today: string;
  /** Sorted: danger, warning, info; then by kind. Every item (the UI collapses the tail). */
  pendencies: BandPendency[];
  nextAct: BandNextAct;
  /** null = hidden (no contingency:read). */
  valuations: BandValuations | null;
  /** null = hidden (no contingency:read). */
  risk: BandRisk | null;
  responsible: BandResponsible;
};

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/** Deadlines that count as real deadlines (AI suggestions only after human validation). */
export const COUNTED_DEADLINE_VALIDATION: readonly ValidationStatus[] = ["not_required", "validated"];

/** Alert types about money (valores, garantias, acordos, risco): shown only with contingency:read. */
export const CONTINGENCY_ALERT_TYPES: readonly AlertType[] = [
  "valuation_pending_review",
  "enforcement_without_value",
  "guarantee_idle",
  "settlement_installment_due",
  "claims_risk_review",
  "snapshot_close_blocked",
];

/**
 * Alert types never listed as pendências because a dedicated block already shows them:
 * the verification flag (`needsVerification`) and the "valor aguardando conferência" block.
 */
export const BAND_REDUNDANT_ALERT_TYPES: readonly AlertType[] = ["process_needs_verification", "valuation_pending_review"];

const TONE_RANK: Record<PendencyTone, number> = { danger: 0, warning: 1, info: 2 };
const KIND_RANK: Record<PendencyKind, number> = {
  verification: 0,
  alert: 1,
  deadline_validation: 2,
  hearing_outcome: 3,
};
const SEVERITY_TONE: Record<AlertSeverity, PendencyTone> = { critical: "danger", warning: "warning", info: "info" };

/**
 * Where the band sends the user inside the process page (P0.6 tabs, `./tabs`):
 * values → "Valores e acordos"; deadlines → "Prazos e audiências"; hearings → the
 * hearings section of that tab.
 */
export const processTabHref = (processId: string, tab: "valores" | "audiencias" | "prazos") =>
  tab === "valores"
    ? processTabUrl(processId, "valores-e-acordos")
    : tab === "audiencias"
      ? processTabUrl(processId, "prazos-e-audiencias", PROCESS_SECTION_IDS.hearings)
      : processTabUrl(processId, "prazos-e-audiencias");
/** Anchor of the risk classification card in the values section ("Valores e acordos" tab). */
export const RISK_SECTION_ID = PROCESS_SECTION_IDS.risk;
export const distributionHref = (processId: string) => `/distribuicao?aba=regras&processo=${processId}`;
export const reviewItemHref = (valuationId: string) => `/contingencias/revisao?item=${valuationId}`;
export const REVIEW_QUEUE_HREF = "/contingencias/revisao";

type Candidate = { act: NextAct; sortKey: string };

/**
 * Sort key of an act: calendar day first (an overdue deadline is always first); on the
 * same day a hearing comes before a deadline (the hearing has a fixed time, the deadline
 * runs until the end of the day); then the time of the hearing and the id.
 */
function actKey(day: string, rank: 0 | 1, at: string, id: string): string {
  return `${day}|${rank}|${at}|${id}`;
}

function nextActs(input: ProcessBandInput): Candidate[] {
  const { process: p, today, access } = input;
  const out: Candidate[] = [];
  if (access.deadlines) {
    for (const d of input.deadlines) {
      if (!COUNTED_DEADLINE_VALIDATION.includes(d.validationStatus)) continue;
      out.push({
        sortKey: actKey(d.dueDate, 1, "", d.id),
        act: {
          kind: "deadline",
          id: d.id,
          title: d.title,
          deadlineKind: d.kind,
          date: d.dueDate,
          overdue: d.dueDate < today,
          validated: d.validationStatus === "validated",
          href: `/prazos?aba=prazos&prazo=${d.id}`,
        },
      });
    }
  }
  for (const h of input.hearings) {
    const day = toISODate(h.scheduledAt);
    // A hearing of a past day still "scheduled" is a pending outcome, not a next act.
    if (day < today) continue;
    out.push({
      sortKey: actKey(day, 0, h.scheduledAt.toISOString(), h.id),
      act: {
        kind: "hearing",
        id: h.id,
        hearingKind: h.kind,
        mode: h.mode,
        date: day,
        at: h.scheduledAt,
        href: processTabHref(p.id, "audiencias"),
      },
    });
  }
  return out.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
}

function pendencies(input: ProcessBandInput): BandPendency[] {
  const { process: p, access, today } = input;
  const items: { item: BandPendency; order: string }[] = [];
  const push = (item: BandPendency, order = "") => {
    items.push({ item, order });
  };

  if (p.needsVerification) {
    push({
      key: "verification",
      kind: "verification",
      tone: "warning",
      label: "Pendente de conferência",
      detail: p.verificationNote?.trim() || "Marcado para conferência, sem nota registrada.",
      date: null,
      href: null,
      actionLabel: null,
    });
  }

  if (access.alerts) {
    const processHref = `/processos/${p.id}`;
    for (const a of input.alerts) {
      if (BAND_REDUNDANT_ALERT_TYPES.includes(a.type)) continue;
      if (!access.contingency && CONTINGENCY_ALERT_TYPES.includes(a.type)) continue;
      // A link to this very page does not help: send the user to the alert in the alerts center.
      const href = !a.href || a.href === processHref ? `/alertas?tipo=${a.type}` : a.href;
      push(
        {
          key: `alert:${a.id}`,
          kind: "alert",
          tone: SEVERITY_TONE[a.severity],
          label: a.title,
          detail: null,
          date: null,
          href,
          actionLabel: null,
        },
        a.createdAt.toISOString(),
      );
    }
  }

  if (access.deadlines) {
    for (const d of input.deadlines) {
      if (d.validationStatus !== "pending_validation") continue;
      push(
        {
          key: `deadline:${d.id}`,
          kind: "deadline_validation",
          tone: "warning",
          label: "Prazo sugerido aguardando validação humana",
          detail: d.title,
          date: d.dueDate,
          href: `/prazos?aba=validacao&prazo=${d.id}`,
          actionLabel: "Validar",
        },
        d.dueDate,
      );
    }
  }

  for (const h of input.hearings) {
    const day = toISODate(h.scheduledAt);
    if (day >= today) continue;
    push(
      {
        key: `hearing:${h.id}`,
        kind: "hearing_outcome",
        tone: "warning",
        label: "Audiência sem desfecho registrado",
        detail: "Registre se foi realizada, redesignada ou cancelada.",
        date: day,
        href: processTabHref(p.id, "audiencias"),
        actionLabel: "Registrar desfecho",
      },
      h.scheduledAt.toISOString(),
    );
  }

  const byText = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  return items
    .sort(
      (a, b) =>
        TONE_RANK[a.item.tone] - TONE_RANK[b.item.tone] ||
        KIND_RANK[a.item.kind] - KIND_RANK[b.item.kind] ||
        byText(a.order, b.order) ||
        byText(a.item.key, b.item.key),
    )
    .map((x) => x.item);
}

function valuationsBlock(input: ProcessBandInput): BandValuations | null {
  if (!input.access.contingency) return null;
  const items = [...input.valuations]
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1))
    .map((v) => ({
      id: v.id,
      kind: v.kind,
      amountCents: v.amountCents,
      baseDate: v.baseDate,
      source: v.source,
      simulated: v.source === "simulation",
      estimate: v.isEstimate,
      href: reviewItemHref(v.id),
    }));
  return { total: items.length, items, href: items[0]?.href ?? REVIEW_QUEUE_HREF };
}

/** Official assessment in force on `today`: greatest effective date ≤ today, then the latest recorded. */
export function riskInForce(risks: readonly BandRiskAssessment[], today: string): BandRiskAssessment | null {
  let best: BandRiskAssessment | null = null;
  for (const r of risks) {
    if (r.status !== "official" || r.effectiveFrom > today) continue;
    if (
      !best ||
      r.effectiveFrom > best.effectiveFrom ||
      (r.effectiveFrom === best.effectiveFrom && r.createdAt.getTime() > best.createdAt.getTime())
    ) {
      best = r;
    }
  }
  return best;
}

function riskBlock(input: ProcessBandInput): BandRisk | null {
  const { access, process: p, today } = input;
  if (!access.contingency) return null;
  const inForce = riskInForce(input.risks, today);
  const pendingProposals = input.risks.filter((r) => r.status === "proposed").length;
  const href = `${processTabHref(p.id, "valores")}#${RISK_SECTION_ID}`;
  if (inForce) {
    return {
      classification: inForce.classification,
      percentageBp: inForce.percentageBp,
      basis: "official",
      effectiveFrom: inForce.effectiveFrom,
      pendingProposals,
      href,
      canClassify: access.classify,
    };
  }
  if (p.lossProbability !== null || p.recordRiskBp !== null) {
    return {
      classification: p.lossProbability,
      percentageBp: p.recordRiskBp,
      basis: "record",
      effectiveFrom: null,
      pendingProposals,
      href,
      canClassify: access.classify,
    };
  }
  return {
    classification: null,
    percentageBp: null,
    basis: "none",
    effectiveFrom: null,
    pendingProposals,
    href,
    canClassify: access.classify,
  };
}

/** Builds the decision band of a process from records already filtered by the viewer's scope. */
export function buildProcessDecisionBand(input: ProcessBandInput): ProcessDecisionBand {
  const { process: p, access } = input;
  const acts = nextActs(input);
  const assigned = p.responsibleId !== null;
  return {
    processId: p.id,
    today: input.today,
    pendencies: pendencies(input),
    nextAct: {
      act: acts[0]?.act ?? null,
      more: Math.max(0, acts.length - 1),
      deadlinesConsidered: access.deadlines,
      moreHref: processTabHref(p.id, access.deadlines ? "prazos" : "audiencias"),
    },
    valuations: valuationsBlock(input),
    risk: riskBlock(input),
    responsible: {
      assigned,
      name: assigned ? p.responsibleName : null,
      lawFirmName: p.lawFirmName,
      distributeHref: access.distribute ? distributionHref(p.id) : null,
    },
  };
}
