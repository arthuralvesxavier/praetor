/**
 * "Exige decisão agora" — the first band of the executive panel (P0.1).
 *
 * Five blocks, each one a count, the top items and a link to the place where
 * the user acts:
 *
 * - hearings     scheduled hearings from the start of today until the end of the 7th day,
 *                today's hearings still waiting for their result included (process:read).
 *                Same window and status as `/audiencias?periodo=7d&status=scheduled`;
 * - deadlines    "prazos fatais": open procedural/regulatory deadlines that count as real
 *                deadlines (validation_status in ('not_required', 'validated')), overdue or
 *                due within 7 days. AI/brief suggestions awaiting validation never count;
 *                they are reported apart (`pendingValidation`) (deadline:read);
 * - installments pending installments of binding settlements due within
 *                `settings.alerts.installmentDueDays` (overdue included) (contingency:read);
 * - guarantees   linked guarantees without movement for `settings.contingency.idleGuaranteeDays`
 *                days or more — same rule as the `portfolio_alerts` routine (contingency:read);
 * - valuations   proposed valuations waiting for human review (contingency:read).
 *
 * Every block carries `list`: the page that lists the block's items. `list.count` is the
 * exact number of rows that page shows (null when no list reproduces the block's filter,
 * so the UI shows no count). Items linked to a record the user cannot see are flagged
 * `restricted` (never their title).
 *
 * Every query applies the row-visibility scope of `@/server/auth/access`; parent
 * records joined for labels (process number, contract/occurrence title) are joined
 * through their own scope. A block whose permission the user lacks is `forbidden`
 * (the UI does not render it); a failing block is `error` and never breaks the page.
 * Not affected by the panel filters. Read-only: nothing here writes.
 */
import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, or, sql, type SQL } from "drizzle-orm";
import {
  DEADLINE_KIND_LABELS,
  GUARANTEE_KIND_LABELS,
  HEARING_KIND_LABELS,
  HEARING_MODE_LABELS,
  SETTLEMENT_STATUS_LABELS,
  VALUATION_KIND_LABELS,
  VALUATION_SOURCE_LABELS,
  type DeadlineKind,
} from "@/domain/enums";
import { addDaysISO, todayISO, toISODate, truncate } from "@/lib/format";
import type { AuthContext } from "@/server/auth/context";
import {
  contractWhere,
  deadlineWhere,
  guaranteeWhere,
  hearingWhere,
  occurrenceWhere,
  processWhere,
  settlementWhere,
} from "@/server/auth/access";
import { assertCan, can, type Permission } from "@/server/auth/permissions";
import { getDb } from "@/server/db/client";
import {
  contracts,
  deadlines,
  hearings,
  legalProcesses,
  occurrences,
  processGuarantees,
  settlementInstallments,
  settlements,
  users,
} from "@/server/db/schema";
import { logger } from "@/server/lib/logger";
import { loadOrganization } from "@/modules/analyses/org-settings";
import { BINDING_SETTLEMENT_STATUSES } from "@/modules/contingency/rules";
import { listReviewQueue } from "@/modules/contingency/service";
import { listUpcomingInstallments } from "@/modules/contingency/settlement-service";
import { endOfZonedDayExclusive, startOfZonedDay } from "@/modules/hearings/time";
import { PROCESS_SECTION_IDS, processTabUrl } from "@/modules/processes/tabs";
import type { Section } from "./portfolio-service";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const DECISION_BLOCKS = ["hearings", "deadlines", "installments", "guarantees", "valuations"] as const;
export type DecisionBlockKey = (typeof DECISION_BLOCKS)[number];

/** Window (days from today) of the hearings and fatal-deadline blocks. */
export const DECISION_WINDOW_DAYS = 7;
/** Items listed per block (the count covers every item). */
export const DECISION_ITEMS_LIMIT = 5;
/** Deadline kinds that are "prazos fatais" (procedural and regulatory). */
export const FATAL_DEADLINE_KINDS = ["procedural", "regulatory"] as const satisfies readonly DeadlineKind[];
/** Deadlines that count as real deadlines (AI suggestions only after human validation). */
const COUNTED_VALIDATION = ["not_required", "validated"] as const;

export type DecisionItem = {
  id: string;
  processId: string | null;
  /** CNJ number; null when the item has no process or the process is not visible. */
  processNumber: string | null;
  /** Contract / occurrence title when the item is not linked to a visible process. */
  reference: string | null;
  /**
   * Linked to a process, contract or occurrence the user cannot see: the UI reads
   * "Registro sem acesso" (never "Sem processo vinculado", never the hidden title).
   */
  restricted: boolean;
  /** Short description (pt-BR). */
  description: string;
  /** Calendar date "YYYY-MM-DD": due date, base date of a value or "parada desde". */
  date: string | null;
  /** Timestamp (hearings). */
  at: Date | null;
  amountCents: number | null;
  /** Past its date: a deadline or installment overdue, or a hearing of today whose time passed without a recorded result. */
  overdue: boolean;
  /** Secondary labels (deadline kind, valuation source, hearing responsible…). */
  tags: string[];
  /** Simulated / demonstrative content: always labeled as such in the UI. */
  simulated: boolean;
  /** Estimated value (RN-07). */
  estimate: boolean;
  /** Where the user acts on this item. */
  href: string;
};

/**
 * The page that lists the block. `count` is the exact number of rows that page shows with
 * `href` (for installments: the settlements of `/acordos?vencendo=1`); null when no list
 * reproduces the block's filter (the UI then links without a count).
 */
export type DecisionList = { href: string; count: number | null };

export type DecisionBlock = {
  key: DecisionBlockKey;
  /** Every item of the block within the user's visibility (not only the listed ones). */
  total: number;
  /** Items whose date has passed (deadlines, installments); 0 for the other blocks. */
  overdue: number;
  /**
   * Sum of the block's amounts when they are the same quantity (installments to pay,
   * idle guarantees); null otherwise — proposed valuations of different kinds never add up (RN-02).
   */
  totalCents: number | null;
  items: DecisionItem[];
  /** Where the user acts on the whole block. */
  href: string;
  /** The complete list behind the block ("Ver lista completa"). */
  list: DecisionList;
};

export type DeadlineDecisionBlock = DecisionBlock & {
  /** Open AI / preliminary-analysis suggestions awaiting human validation (not counted in `total`). */
  pendingValidation: number;
  pendingValidationHref: string;
};

export type DecisionBand = {
  today: string;
  windows: { hearingDays: number; deadlineDays: number; installmentDueDays: number; idleGuaranteeDays: number };
  hearings: Section<DecisionBlock>;
  deadlines: Section<DeadlineDecisionBlock>;
  installments: Section<DecisionBlock>;
  guarantees: Section<DecisionBlock>;
  valuations: Section<DecisionBlock>;
};

/** Links of each block (params documented in docs/dev/MODULE_CONTRACTS.md). */
export const DECISION_HREFS = {
  hearings: "/audiencias?periodo=7d&status=scheduled",
  deadlines: "/prazos?aba=prazos&situacao=abertos",
  pendingValidation: "/prazos?aba=validacao",
  installments: "/acordos?vencendo=1",
  guarantees: "/contingencias/garantias",
  valuations: "/contingencias/revisao",
} as const;

/**
 * Where an item of the band is acted on, in the process page (P0.6 tabs): hearings in
 * "Prazos e audiências" (#audiencias), installments in "Valores e acordos" (#acordos),
 * guarantees in "Valores e acordos" (values and guarantees open the tab).
 */
const PROCESS_TARGETS = {
  hearings: { tab: "prazos-e-audiencias", section: PROCESS_SECTION_IDS.hearings },
  settlements: { tab: "valores-e-acordos", section: PROCESS_SECTION_IDS.settlements },
  values: { tab: "valores-e-acordos", section: null },
} as const;

export const processTabHref = (processId: string, target: keyof typeof PROCESS_TARGETS) =>
  processTabUrl(processId, PROCESS_TARGETS[target].tab, PROCESS_TARGETS[target].section);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const toNum = (v: string | number | null | undefined) => (v == null ? 0 : Number(v));

function blankItem(id: string, href: string): DecisionItem {
  return {
    id,
    processId: null,
    processNumber: null,
    reference: null,
    restricted: false,
    description: "",
    date: null,
    at: null,
    amountCents: null,
    overdue: false,
    tags: [],
    simulated: false,
    estimate: false,
    href,
  };
}

/** Runs a block when the user has its permission; failures become `error` (logged without query text). */
async function section<T>(ctx: AuthContext, permission: Permission, name: string, run: () => Promise<T>): Promise<Section<T>> {
  if (!can(ctx, permission)) return { status: "forbidden" };
  try {
    return { status: "ok", data: await run() };
  } catch (error) {
    logger.error("dashboard_section_failed", { section: `decision_${name}`, error });
    return { status: "error" };
  }
}

/** Idle threshold in days from the organization settings (same clamping as the `portfolio_alerts` routine). */
export function idleGuaranteeDaysOf(settings: { contingency: { idleGuaranteeDays: number } }): number {
  return Math.max(1, Math.floor(settings.contingency.idleGuaranteeDays));
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

async function hearingsBlock(ctx: AuthContext): Promise<DecisionBlock> {
  const now = new Date();
  const today = todayISO(now);
  // Same window and status as `/audiencias?periodo=7d&status=scheduled` (listHearings): from the start of
  // today to the end of the 7th day, so the list opened by "Ver lista completa" has exactly `total` rows.
  const window = and(
    hearingWhere(ctx),
    eq(hearings.status, "scheduled"),
    gte(hearings.scheduledAt, startOfZonedDay(today)),
    lt(hearings.scheduledAt, endOfZonedDayExclusive(addDaysISO(today, DECISION_WINDOW_DAYS))),
  );
  const db = getDb();
  const [[row], rows] = await Promise.all([
    db.select({ n: count() }).from(hearings).where(window),
    db
      .select({
        id: hearings.id,
        kind: hearings.kind,
        mode: hearings.mode,
        scheduledAt: hearings.scheduledAt,
        processId: legalProcesses.id,
        processNumber: legalProcesses.number,
        responsibleName: users.name,
      })
      .from(hearings)
      .innerJoin(legalProcesses, and(eq(legalProcesses.id, hearings.processId), processWhere(ctx)))
      .leftJoin(users, and(eq(users.id, hearings.responsibleId), eq(users.organizationId, ctx.organizationId)))
      .where(window)
      .orderBy(asc(hearings.scheduledAt), asc(hearings.id))
      .limit(DECISION_ITEMS_LIMIT),
  ]);
  const total = toNum(row?.n);
  const items = rows.map((h) => ({
    ...blankItem(h.id, processTabHref(h.processId, "hearings")),
    processId: h.processId,
    processNumber: h.processNumber,
    description: `${HEARING_KIND_LABELS[h.kind]} · ${HEARING_MODE_LABELS[h.mode]}`,
    at: h.scheduledAt,
    // Today's hearing whose time has passed and is still `scheduled`: the result must be recorded.
    overdue: h.scheduledAt.getTime() < now.getTime(),
    tags: [h.responsibleName ?? "Sem responsável"],
  }));
  return {
    key: "hearings",
    total,
    overdue: 0,
    totalCents: null,
    href: DECISION_HREFS.hearings,
    list: { href: DECISION_HREFS.hearings, count: total },
    items,
  };
}

async function deadlinesBlock(ctx: AuthContext, today: string): Promise<DeadlineDecisionBlock> {
  const db = getDb();
  const fatal = and(
    deadlineWhere(ctx),
    eq(deadlines.status, "open"),
    inArray(deadlines.validationStatus, [...COUNTED_VALIDATION]),
    inArray(deadlines.kind, [...FATAL_DEADLINE_KINDS]),
    lte(deadlines.dueDate, addDaysISO(today, DECISION_WINDOW_DAYS)),
  );
  const [[counts], [pending], rows] = await Promise.all([
    db
      .select({
        total: sql<number>`count(*)::int`,
        overdue: sql<number>`(count(*) filter (where ${deadlines.dueDate} < ${today}))::int`,
      })
      .from(deadlines)
      .where(fatal),
    db
      .select({ n: count() })
      .from(deadlines)
      .where(and(deadlineWhere(ctx), eq(deadlines.status, "open"), eq(deadlines.validationStatus, "pending_validation"))),
    db
      .select({
        id: deadlines.id,
        title: deadlines.title,
        kind: deadlines.kind,
        dueDate: deadlines.dueDate,
        linkedProcessId: deadlines.processId,
        linkedContractId: deadlines.contractId,
        linkedOccurrenceId: deadlines.occurrenceId,
        processId: legalProcesses.id,
        processNumber: legalProcesses.number,
        contractTitle: contracts.title,
        occurrenceTitle: occurrences.title,
      })
      .from(deadlines)
      // Parent labels only through the parent's own scope (never leak an invisible title).
      .leftJoin(legalProcesses, and(eq(legalProcesses.id, deadlines.processId), processWhere(ctx)))
      .leftJoin(contracts, and(eq(contracts.id, deadlines.contractId), contractWhere(ctx)))
      .leftJoin(occurrences, and(eq(occurrences.id, deadlines.occurrenceId), occurrenceWhere(ctx)))
      .where(fatal)
      .orderBy(asc(deadlines.dueDate), asc(deadlines.createdAt), asc(deadlines.id))
      .limit(DECISION_ITEMS_LIMIT),
  ]);
  return {
    key: "deadlines",
    total: toNum(counts?.total),
    overdue: toNum(counts?.overdue),
    totalCents: null,
    href: DECISION_HREFS.deadlines,
    // `/prazos` filters neither by kind nor by a 7-day window: the link opens every open deadline, without a count.
    list: { href: DECISION_HREFS.deadlines, count: null },
    pendingValidation: toNum(pending?.n),
    pendingValidationHref: DECISION_HREFS.pendingValidation,
    items: rows.map((r) => {
      const reference = r.processNumber ? null : (r.contractTitle ?? r.occurrenceTitle ?? null);
      const linked = r.linkedProcessId !== null || r.linkedContractId !== null || r.linkedOccurrenceId !== null;
      return {
        ...blankItem(r.id, `/prazos?aba=prazos&prazo=${r.id}`),
        processId: r.processId,
        processNumber: r.processNumber,
        reference,
        restricted: !r.processNumber && !reference && linked,
        description: truncate(r.title, 90),
        date: r.dueDate,
        overdue: r.dueDate < today,
        tags: [DEADLINE_KIND_LABELS[r.kind]],
      };
    }),
  };
}

async function installmentsBlock(
  ctx: AuthContext,
  today: string,
  days: number,
  /** Window of `/acordos?vencendo=1` (listSettlements: `max(0, installmentDueDays)`). */
  listDays: number,
): Promise<DecisionBlock> {
  const db = getDb();
  const [[agg], [listed], upcoming] = await Promise.all([
    db
      .select({
        total: sql<number>`count(*)::int`,
        overdue: sql<number>`(count(*) filter (where ${settlementInstallments.dueDate} < ${today}))::int`,
        cents: sql<string>`coalesce(sum(${settlementInstallments.amountCents}), 0)::text`,
      })
      .from(settlementInstallments)
      .innerJoin(settlements, eq(settlements.id, settlementInstallments.settlementId))
      .where(
        and(
          settlementWhere(ctx),
          eq(settlementInstallments.organizationId, ctx.organizationId),
          eq(settlementInstallments.status, "pending"),
          inArray(settlements.status, [...BINDING_SETTLEMENT_STATUSES]),
          lte(settlementInstallments.dueDate, addDaysISO(today, days)),
        ),
      ),
    // The settlements `/acordos?vencendo=1` lists (same conditions as listSettlements' dueSoon filter).
    db
      .select({ n: count() })
      .from(settlements)
      .where(
        and(
          settlementWhere(ctx),
          inArray(settlements.status, [...BINDING_SETTLEMENT_STATUSES]),
          inArray(
            settlements.id,
            db
              .select({ id: settlementInstallments.settlementId })
              .from(settlementInstallments)
              .where(
                and(
                  eq(settlementInstallments.organizationId, ctx.organizationId),
                  eq(settlementInstallments.status, "pending"),
                  lte(settlementInstallments.dueDate, addDaysISO(today, listDays)),
                ),
              ),
          ),
        ),
      ),
    listUpcomingInstallments(ctx, { days, limit: DECISION_ITEMS_LIMIT }),
  ]);
  return {
    key: "installments",
    total: toNum(agg?.total),
    overdue: toNum(agg?.overdue),
    totalCents: toNum(agg?.cents),
    href: DECISION_HREFS.installments,
    list: { href: DECISION_HREFS.installments, count: toNum(listed?.n) },
    items: upcoming.items.map((i) => ({
      ...blankItem(i.id, processTabHref(i.processId, "settlements")),
      processId: i.processId,
      processNumber: i.processNumber,
      description: `Parcela ${i.number}${i.installmentsCount ? ` de ${i.installmentsCount}` : ""}`,
      date: i.dueDate,
      amountCents: i.amountCents,
      overdue: i.dueDate < today,
      tags: [SETTLEMENT_STATUS_LABELS[i.settlementStatus]],
    })),
  };
}

/**
 * Idle guarantee (same rule as the `portfolio_alerts` routine): status `linked` and the
 * last movement — status change, else deposit date, else registration date — is on or
 * before `today − idleDays`.
 */
export function idleGuaranteeCondition(today: string, idleDays: number): SQL {
  const g = processGuarantees;
  const cutoff = addDaysISO(today, -Math.max(1, idleDays));
  // Registration date in America/Sao_Paulo <= cutoff  ⇔  created_at < start of the day after the cutoff.
  const registeredBy = startOfZonedDay(addDaysISO(cutoff, 1));
  return and(
    eq(g.status, "linked"),
    or(
      and(isNotNull(g.statusChangedAt), lte(g.statusChangedAt, cutoff)),
      and(isNull(g.statusChangedAt), isNotNull(g.depositedAt), lte(g.depositedAt, cutoff)),
      and(isNull(g.statusChangedAt), isNull(g.depositedAt), lt(g.createdAt, registeredBy)),
    ),
  )!;
}

/** Visible idle guarantees: the condition shared by the band and `/contingencias/garantias` (same count). */
export function idleGuaranteesWhere(ctx: AuthContext, today: string, idleDays: number): SQL {
  return and(guaranteeWhere(ctx), idleGuaranteeCondition(today, idleDays))!;
}

/** Oldest movement first, then the largest amount (band and list use the same order). */
export const IDLE_GUARANTEE_ORDER = () => {
  const g = processGuarantees;
  return [asc(sql`coalesce(${g.statusChangedAt}, ${g.depositedAt}, ${g.createdAt}::date)`), desc(g.amountCents), asc(g.id)];
};

async function guaranteesBlock(ctx: AuthContext, today: string, idleDays: number): Promise<DecisionBlock> {
  const g = processGuarantees;
  const db = getDb();
  const idle = idleGuaranteesWhere(ctx, today, idleDays);
  const [[agg], rows] = await Promise.all([
    db
      .select({
        total: sql<number>`count(*)::int`,
        cents: sql<string>`coalesce(sum(${g.amountCents}), 0)::text`,
      })
      .from(g)
      .where(idle),
    db
      .select({
        id: g.id,
        kind: g.kind,
        amountCents: g.amountCents,
        depositedAt: g.depositedAt,
        statusChangedAt: g.statusChangedAt,
        createdAt: g.createdAt,
        processId: legalProcesses.id,
        processNumber: legalProcesses.number,
      })
      .from(g)
      .innerJoin(legalProcesses, and(eq(legalProcesses.id, g.processId), processWhere(ctx)))
      .where(idle)
      .orderBy(...IDLE_GUARANTEE_ORDER())
      .limit(DECISION_ITEMS_LIMIT),
  ]);
  const total = toNum(agg?.total);
  return {
    key: "guarantees",
    total,
    overdue: 0,
    totalCents: toNum(agg?.cents),
    href: DECISION_HREFS.guarantees,
    list: { href: DECISION_HREFS.guarantees, count: total },
    items: rows.map((r) => ({
      ...blankItem(r.id, processTabHref(r.processId, "values")),
      processId: r.processId,
      processNumber: r.processNumber,
      description: GUARANTEE_KIND_LABELS[r.kind],
      date: r.statusChangedAt ?? r.depositedAt ?? toISODate(r.createdAt),
      amountCents: r.amountCents,
    })),
  };
}

async function valuationsBlock(ctx: AuthContext): Promise<DecisionBlock> {
  const queue = await listReviewQueue(ctx, { pageSize: DECISION_ITEMS_LIMIT });
  return {
    key: "valuations",
    total: queue.total,
    overdue: 0,
    totalCents: null,
    href: DECISION_HREFS.valuations,
    // `/contingencias/revisao` without filters is the same listReviewQueue.
    list: { href: DECISION_HREFS.valuations, count: queue.total },
    items: queue.items.map((v) => ({
      ...blankItem(v.id, `/contingencias/revisao?item=${v.id}`),
      processId: v.processId,
      processNumber: v.processNumber,
      description: VALUATION_KIND_LABELS[v.kind],
      date: v.baseDate,
      amountCents: v.amountCents,
      tags: [VALUATION_SOURCE_LABELS[v.source]],
      simulated: v.source === "simulation",
      estimate: v.isEstimate,
    })),
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/** "Exige decisão agora" band of `/dashboard`. Requires `dashboard:read`; each block checks its own permission. */
export async function getDecisionBand(ctx: AuthContext): Promise<DecisionBand> {
  assertCan(ctx, "dashboard:read");
  const today = todayISO();
  const { settings } = await loadOrganization(ctx.organizationId);
  // Same clamping as listUpcomingInstallments and the portfolio_alerts routine.
  const installmentDueDays = Math.max(0, Math.min(365, Math.floor(settings.alerts.installmentDueDays)));
  const idleGuaranteeDays = idleGuaranteeDaysOf(settings);

  const [hearingsS, deadlinesS, installmentsS, guaranteesS, valuationsS] = await Promise.all([
    section(ctx, "process:read", "hearings", () => hearingsBlock(ctx)),
    section(ctx, "deadline:read", "deadlines", () => deadlinesBlock(ctx, today)),
    section(ctx, "contingency:read", "installments", () =>
      installmentsBlock(ctx, today, installmentDueDays, Math.max(0, settings.alerts.installmentDueDays)),
    ),
    section(ctx, "contingency:read", "guarantees", () => guaranteesBlock(ctx, today, idleGuaranteeDays)),
    section(ctx, "contingency:read", "valuations", () => valuationsBlock(ctx)),
  ]);

  return {
    today,
    windows: {
      hearingDays: DECISION_WINDOW_DAYS,
      deadlineDays: DECISION_WINDOW_DAYS,
      installmentDueDays,
      idleGuaranteeDays,
    },
    hearings: hearingsS,
    deadlines: deadlinesS,
    installments: installmentsS,
    guarantees: guaranteesS,
    valuations: valuationsS,
  };
}
