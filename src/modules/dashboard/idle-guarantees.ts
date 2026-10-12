/**
 * `/contingencias/garantias`: linked guarantees without movement for
 * `settings.contingency.idleGuaranteeDays` days or more (P0.1, list behind the
 * "Garantias sem movimentação" block of the dashboard).
 *
 * Same condition, scope and order as the dashboard block (`idleGuaranteesWhere`,
 * `IDLE_GUARANTEE_ORDER`), so the block's "Ver lista completa (N)" opens exactly N
 * rows. Requires `contingency:read`; row visibility through `guaranteeWhere` and,
 * for the process label, `processWhere`. Read-only.
 */
import { and, count, eq, sql } from "drizzle-orm";
import { normalizePage, type Page, type Paginated } from "@/domain/entities";
import type { GuaranteeKind, ProcessInstance } from "@/domain/enums";
import { todayISO, toISODate } from "@/lib/format";
import type { AuthContext } from "@/server/auth/context";
import { processWhere } from "@/server/auth/access";
import { assertCan } from "@/server/auth/permissions";
import { getDb } from "@/server/db/client";
import { legalProcesses, processGuarantees } from "@/server/db/schema";
import { loadOrganization } from "@/modules/analyses/org-settings";
import { IDLE_GUARANTEE_ORDER, idleGuaranteeDaysOf, idleGuaranteesWhere } from "./decision-service";

/** What dates the "parada desde" of a guarantee (same precedence as the routine). */
export type IdleSinceBasis = "status_change" | "deposit" | "registration";

export type IdleGuaranteeItem = {
  id: string;
  kind: GuaranteeKind;
  amountCents: number;
  description: string | null;
  /** "YYYY-MM-DD": last movement (status change, else deposit, else registration date). */
  idleSince: string;
  idleSinceBasis: IdleSinceBasis;
  processId: string;
  processNumber: string;
  processTitle: string;
  court: string;
  instance: ProcessInstance | null;
};

export type IdleGuaranteeList = Paginated<IdleGuaranteeItem> & {
  today: string;
  idleDays: number;
  /** Sum of every listed guarantee (all pages): same quantity, so it adds up. */
  totalCents: number;
};

export async function listIdleGuarantees(ctx: AuthContext, filters: Page = {}): Promise<IdleGuaranteeList> {
  assertCan(ctx, "contingency:read");
  const { page, pageSize, offset } = normalizePage(filters);
  const today = todayISO();
  const { settings } = await loadOrganization(ctx.organizationId);
  const idleDays = idleGuaranteeDaysOf(settings);
  const g = processGuarantees;
  const idle = idleGuaranteesWhere(ctx, today, idleDays);
  const db = getDb();

  const [[agg], rows] = await Promise.all([
    db
      .select({ total: count(), cents: sql<string>`coalesce(sum(${g.amountCents}), 0)::text` })
      .from(g)
      .where(idle),
    db
      .select({
        id: g.id,
        kind: g.kind,
        amountCents: g.amountCents,
        description: g.description,
        depositedAt: g.depositedAt,
        statusChangedAt: g.statusChangedAt,
        createdAt: g.createdAt,
        processId: legalProcesses.id,
        processNumber: legalProcesses.number,
        processTitle: legalProcesses.title,
        court: legalProcesses.court,
        instance: legalProcesses.instance,
      })
      .from(g)
      .innerJoin(legalProcesses, and(eq(legalProcesses.id, g.processId), processWhere(ctx)))
      .where(idle)
      .orderBy(...IDLE_GUARANTEE_ORDER())
      .limit(pageSize)
      .offset(offset),
  ]);

  return {
    today,
    idleDays,
    total: Number(agg?.total ?? 0),
    totalCents: Number(agg?.cents ?? 0),
    page,
    pageSize,
    items: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      amountCents: r.amountCents,
      description: r.description,
      idleSince: r.statusChangedAt ?? r.depositedAt ?? toISODate(r.createdAt),
      idleSinceBasis: r.statusChangedAt ? "status_change" : r.depositedAt ? "deposit" : "registration",
      processId: r.processId,
      processNumber: r.processNumber,
      processTitle: r.processTitle,
      court: r.court,
      instance: r.instance,
    })),
  };
}
