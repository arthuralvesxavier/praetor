/**
 * Acordos (proposta → negociação → firmado → homologado → cumprido |
 * descumprido | cancelado) and their installments. Settlement values are a
 * separate quantity (never added to the claim or liquidated values, RN-02).
 * A fulfilled settlement offers "Registrar quitação (RN-06)" in the UI, which
 * calls `registerExtinction` of the valuation service.
 * Requires `contingency:read` / `contingency:write`.
 */
import { and, asc, count, desc, eq, inArray, lte, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  SETTLEMENT_STATUS_LABELS,
  type InstallmentStatus,
  type ProcessStatus,
  type SettlementStatus,
} from "@/domain/enums";
import { normalizePage, type Page, type Paginated } from "@/domain/entities";
import { addDaysISO, formatMoneyCents, todayISO } from "@/lib/format";
import type { AuthContext } from "@/server/auth/context";
import { processWhere, settlementWhere } from "@/server/auth/access";
import { assertCan } from "@/server/auth/permissions";
import { getDb, type DbOrTx } from "@/server/db/client";
import { legalProcesses, settlementInstallments, settlements, users } from "@/server/db/schema";
import { diffChanges, recordAudit } from "@/server/services/audit";
import { ConflictError, NotFoundError, ValidationError } from "@/server/lib/errors";
import { assertUserInOrg, loadSettings, loadVisibleProcess, parseId, parseOrThrow } from "./internal";
import {
  BINDING_SETTLEMENT_STATUSES,
  canTransitionSettlement,
  splitInstallments,
  TERMS_EDITABLE_STATUSES,
} from "./rules";
import {
  installmentPaymentSchema,
  listSettlementsSchema,
  settlementCreateSchema,
  settlementNotesSchema,
  settlementStatusSchema,
  settlementTermsSchema,
  type InstallmentPaymentInput,
  type ListSettlementsFilters,
  type SettlementCreateInput,
  type SettlementStatusInput,
  type SettlementTermsInput,
} from "./schemas";

export type InstallmentItem = {
  id: string;
  number: number;
  dueDate: string;
  amountCents: number;
  status: InstallmentStatus;
  paidAt: string | null;
};

export type SettlementItem = {
  id: string;
  processId: string;
  processNumber: string;
  processTitle: string;
  processStatus: ProcessStatus;
  status: SettlementStatus;
  totalAmountCents: number | null;
  installmentsCount: number | null;
  proposedAt: string | null;
  signedAt: string | null;
  homologatedAt: string | null;
  notes: string | null;
  responsibleId: string | null;
  responsibleName: string | null;
  createdByName: string | null;
  createdAt: Date;
  updatedAt: Date;
  installments: InstallmentItem[];
  paidCents: number;
  pendingCents: number;
  /** Next pending installment (by due date), if any. */
  nextInstallment: InstallmentItem | null;
  overdueCount: number;
};

type SettlementRow = typeof settlements.$inferSelect;

async function loadSettlement(ctx: AuthContext, id: string, db: DbOrTx): Promise<SettlementRow & { processNumber: string }> {
  const [row] = await db
    .select({ s: settlements, processNumber: legalProcesses.number })
    .from(settlements)
    .innerJoin(legalProcesses, eq(legalProcesses.id, settlements.processId))
    .where(and(eq(settlements.id, parseId(id)), settlementWhere(ctx)));
  if (!row) throw new NotFoundError("Acordo não encontrado ou sem permissão de acesso.");
  return { ...row.s, processNumber: row.processNumber };
}

async function installmentsOf(organizationId: string, settlementIds: string[], db: DbOrTx) {
  if (settlementIds.length === 0) return new Map<string, InstallmentItem[]>();
  const rows = await db
    .select()
    .from(settlementInstallments)
    .where(and(eq(settlementInstallments.organizationId, organizationId), inArray(settlementInstallments.settlementId, settlementIds)))
    .orderBy(asc(settlementInstallments.number));
  const map = new Map<string, InstallmentItem[]>();
  for (const r of rows) {
    const list = map.get(r.settlementId) ?? [];
    list.push({ id: r.id, number: r.number, dueDate: r.dueDate, amountCents: r.amountCents, status: r.status, paidAt: r.paidAt });
    map.set(r.settlementId, list);
  }
  return map;
}

function toItem(
  r: {
    s: SettlementRow;
    processNumber: string;
    processTitle: string;
    processStatus: ProcessStatus;
    responsibleName: string | null;
    createdByName: string | null;
  },
  installments: InstallmentItem[],
  today: string,
): SettlementItem {
  const pending = installments.filter((i) => i.status === "pending");
  return {
    id: r.s.id,
    processId: r.s.processId,
    processNumber: r.processNumber,
    processTitle: r.processTitle,
    processStatus: r.processStatus,
    status: r.s.status,
    totalAmountCents: r.s.totalAmountCents,
    installmentsCount: r.s.installmentsCount,
    proposedAt: r.s.proposedAt,
    signedAt: r.s.signedAt,
    homologatedAt: r.s.homologatedAt,
    notes: r.s.notes,
    responsibleId: r.s.responsibleId,
    responsibleName: r.responsibleName,
    createdByName: r.createdByName,
    createdAt: r.s.createdAt,
    updatedAt: r.s.updatedAt,
    installments,
    paidCents: installments.filter((i) => i.status === "paid").reduce((s, i) => s + i.amountCents, 0),
    pendingCents: pending.reduce((s, i) => s + i.amountCents, 0),
    nextInstallment: pending.slice().sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0] ?? null,
    overdueCount: pending.filter((i) => i.dueDate < today).length,
  };
}

function baseSelect(db: DbOrTx) {
  const responsible = alias(users, "settlement_responsible");
  const creator = alias(users, "settlement_creator");
  return db
    .select({
      s: settlements,
      processNumber: legalProcesses.number,
      processTitle: legalProcesses.title,
      processStatus: legalProcesses.status,
      responsibleName: responsible.name,
      createdByName: creator.name,
    })
    .from(settlements)
    .innerJoin(legalProcesses, eq(legalProcesses.id, settlements.processId))
    .leftJoin(responsible, eq(responsible.id, settlements.responsibleId))
    .leftJoin(creator, eq(creator.id, settlements.createdById));
}

/** Settlements of a visible process, newest first. */
export async function listProcessSettlements(ctx: AuthContext, processId: string): Promise<SettlementItem[]> {
  assertCan(ctx, "contingency:read");
  const db = getDb();
  const p = await loadVisibleProcess(ctx, processId, db);
  const rows = await baseSelect(db)
    .where(and(settlementWhere(ctx), eq(settlements.processId, p.id)))
    .orderBy(desc(settlements.createdAt));
  const inst = await installmentsOf(ctx.organizationId, rows.map((r) => r.s.id), db);
  const today = todayISO();
  return rows.map((r) => toItem(r, inst.get(r.s.id) ?? [], today));
}

export type SettlementListFilters = Omit<ListSettlementsFilters, "page" | "pageSize"> & Page;

/** `/acordos`: visible settlements with filters (`status`, `vencendo=1` = pending installment within the alert window). */
export async function listSettlements(
  ctx: AuthContext,
  filters: SettlementListFilters = {},
): Promise<Paginated<SettlementItem> & { dueDays: number }> {
  assertCan(ctx, "contingency:read");
  const f = parseOrThrow(listSettlementsSchema, filters);
  const { page, pageSize, offset } = normalizePage(f);
  const db = getDb();
  const settings = await loadSettings(ctx.organizationId, db);
  const dueDays = Math.max(0, settings.alerts.installmentDueDays);
  const today = todayISO();

  const conds: SQL[] = [settlementWhere(ctx)];
  if (f.status) conds.push(eq(settlements.status, f.status));
  if (f.processId) conds.push(eq(settlements.processId, f.processId));
  if (f.dueSoon) {
    conds.push(inArray(settlements.status, [...BINDING_SETTLEMENT_STATUSES]));
    conds.push(
      inArray(
        settlements.id,
        db
          .select({ id: settlementInstallments.settlementId })
          .from(settlementInstallments)
          .where(
            and(
              eq(settlementInstallments.organizationId, ctx.organizationId),
              eq(settlementInstallments.status, "pending"),
              lte(settlementInstallments.dueDate, addDaysISO(today, dueDays)),
            ),
          ),
      ),
    );
  }
  const where = and(...conds);
  const [rows, [{ total }]] = await Promise.all([
    baseSelect(db)
      .where(where)
      .orderBy(
        sql`case when ${settlements.status} in ('signed', 'homologated', 'breached') then 0 when ${settlements.status} in ('proposal', 'negotiating') then 1 else 2 end`,
        desc(settlements.updatedAt),
        asc(settlements.id),
      )
      .limit(pageSize)
      .offset(offset),
    db.select({ total: count() }).from(settlements).where(where),
  ]);
  const inst = await installmentsOf(ctx.organizationId, rows.map((r) => r.s.id), db);
  return {
    dueDays,
    total: Number(total),
    page,
    pageSize,
    items: rows.map((r) => toItem(r, inst.get(r.s.id) ?? [], today)),
  };
}

export type UpcomingInstallment = InstallmentItem & {
  settlementId: string;
  settlementStatus: SettlementStatus;
  installmentsCount: number | null;
  processId: string;
  processNumber: string;
  processTitle: string;
};

/** Pending installments of binding settlements due up to `today + days` (overdue included), soonest first. */
export async function listUpcomingInstallments(
  ctx: AuthContext,
  opts: { days?: number; limit?: number } = {},
): Promise<{ items: UpcomingInstallment[]; days: number }> {
  assertCan(ctx, "contingency:read");
  const db = getDb();
  const settings = await loadSettings(ctx.organizationId, db);
  const days = Math.max(0, Math.min(365, opts.days ?? settings.alerts.installmentDueDays));
  const rows = await db
    .select({
      i: settlementInstallments,
      settlementStatus: settlements.status,
      installmentsCount: settlements.installmentsCount,
      processId: legalProcesses.id,
      processNumber: legalProcesses.number,
      processTitle: legalProcesses.title,
    })
    .from(settlementInstallments)
    .innerJoin(settlements, eq(settlements.id, settlementInstallments.settlementId))
    .innerJoin(legalProcesses, eq(legalProcesses.id, settlements.processId))
    .where(
      and(
        settlementWhere(ctx),
        eq(settlementInstallments.organizationId, ctx.organizationId),
        eq(settlementInstallments.status, "pending"),
        inArray(settlements.status, [...BINDING_SETTLEMENT_STATUSES]),
        lte(settlementInstallments.dueDate, addDaysISO(todayISO(), days)),
      ),
    )
    .orderBy(asc(settlementInstallments.dueDate), asc(settlementInstallments.number))
    .limit(Math.max(1, Math.min(200, opts.limit ?? 20)));
  return {
    days,
    items: rows.map((r) => ({
      id: r.i.id,
      number: r.i.number,
      dueDate: r.i.dueDate,
      amountCents: r.i.amountCents,
      status: r.i.status,
      paidAt: r.i.paidAt,
      settlementId: r.i.settlementId,
      settlementStatus: r.settlementStatus,
      installmentsCount: r.installmentsCount,
      processId: r.processId,
      processNumber: r.processNumber,
      processTitle: r.processTitle,
    })),
  };
}

/** Visible processes (active first) for the "Novo acordo" select of `/acordos`. */
export async function listSettlementProcessOptions(ctx: AuthContext): Promise<{ id: string; number: string; title: string }[]> {
  assertCan(ctx, "contingency:read");
  return getDb()
    .select({ id: legalProcesses.id, number: legalProcesses.number, title: legalProcesses.title })
    .from(legalProcesses)
    .where(and(processWhere(ctx), inArray(legalProcesses.status, ["active", "suspended"])))
    .orderBy(asc(legalProcesses.number))
    .limit(3000);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

async function insertInstallments(
  tx: DbOrTx,
  organizationId: string,
  settlementId: string,
  terms: { totalAmountCents: number | null; installmentsCount: number | null; firstDueDate: string | null },
): Promise<void> {
  if (terms.installmentsCount === null || terms.totalAmountCents === null || terms.firstDueDate === null) return;
  const plan = splitInstallments(terms.totalAmountCents, terms.installmentsCount, terms.firstDueDate);
  await tx.insert(settlementInstallments).values(
    plan.map((p) => ({ organizationId, settlementId, number: p.number, dueDate: p.dueDate, amountCents: p.amountCents })),
  );
}

export async function createSettlement(ctx: AuthContext, input: SettlementCreateInput): Promise<{ id: string; processId: string }> {
  assertCan(ctx, "contingency:write");
  const data = parseOrThrow(settlementCreateSchema, input);
  return getDb().transaction(async (tx) => {
    const p = await loadVisibleProcess(ctx, data.processId, tx);
    if (data.responsibleId) await assertUserInOrg(ctx, data.responsibleId, "responsibleId", tx);
    const today = todayISO();
    const [created] = await tx
      .insert(settlements)
      .values({
        organizationId: ctx.organizationId,
        processId: p.id,
        status: data.status,
        totalAmountCents: data.totalAmountCents,
        installmentsCount: data.installmentsCount,
        proposedAt: data.proposedAt ?? today,
        signedAt: data.status === "signed" ? today : null,
        notes: data.notes,
        responsibleId: data.responsibleId,
        createdById: ctx.userId,
      })
      .returning({ id: settlements.id });
    await insertInstallments(tx, ctx.organizationId, created.id, data);
    await recordAudit(
      ctx,
      {
        action: "settlement.create",
        entityType: "legal_process",
        entityId: p.id,
        summary:
          `Acordo (${SETTLEMENT_STATUS_LABELS[data.status].toLowerCase()}) registrado no processo ${p.number}` +
          (data.totalAmountCents !== null ? `, total de ${formatMoneyCents(data.totalAmountCents)}` : "") +
          (data.installmentsCount ? ` em ${data.installmentsCount} parcela(s).` : "."),
        metadata: { settlementId: created.id },
      },
      tx,
    );
    return { id: created.id, processId: p.id };
  });
}

/** Changes total / installments (regenerating them) while nothing was paid and the deal is open. */
export async function updateSettlementTerms(ctx: AuthContext, id: string, input: SettlementTermsInput): Promise<void> {
  assertCan(ctx, "contingency:write");
  const data = parseOrThrow(settlementTermsSchema, input);
  await getDb().transaction(async (tx) => {
    const s = await loadSettlement(ctx, id, tx);
    if (!TERMS_EDITABLE_STATUSES.includes(s.status)) {
      throw new ConflictError("Os termos só podem ser alterados em acordos em proposta, negociação ou firmados.");
    }
    const [paid] = await tx
      .select({ n: count() })
      .from(settlementInstallments)
      .where(and(eq(settlementInstallments.settlementId, s.id), eq(settlementInstallments.status, "paid")));
    if (Number(paid?.n ?? 0) > 0) throw new ConflictError("Há parcelas pagas: os termos do acordo não podem mais ser alterados.");
    await tx.delete(settlementInstallments).where(and(eq(settlementInstallments.settlementId, s.id), eq(settlementInstallments.organizationId, ctx.organizationId)));
    await tx
      .update(settlements)
      .set({ totalAmountCents: data.totalAmountCents, installmentsCount: data.installmentsCount, updatedAt: new Date() })
      .where(and(eq(settlements.id, s.id), eq(settlements.organizationId, ctx.organizationId)));
    await insertInstallments(tx, ctx.organizationId, s.id, data);
    await recordAudit(
      ctx,
      {
        action: "settlement.update_terms",
        entityType: "legal_process",
        entityId: s.processId,
        summary: `Termos do acordo do processo ${s.processNumber} alterados.`,
        changes: diffChanges(s, data, ["totalAmountCents", "installmentsCount"]),
        metadata: { settlementId: s.id, firstDueDate: data.firstDueDate },
      },
      tx,
    );
  });
}

export async function setSettlementStatus(ctx: AuthContext, id: string, input: SettlementStatusInput): Promise<{ processId: string }> {
  assertCan(ctx, "contingency:write");
  const data = parseOrThrow(settlementStatusSchema, input);
  return getDb().transaction(async (tx) => {
    const s = await loadSettlement(ctx, id, tx);
    if (!canTransitionSettlement(s.status, data.status)) {
      throw new ConflictError(
        `Não é possível passar de "${SETTLEMENT_STATUS_LABELS[s.status]}" para "${SETTLEMENT_STATUS_LABELS[data.status]}".`,
      );
    }
    const date = data.date ?? todayISO();
    if (date > todayISO()) throw new ValidationError("Verifique os campos informados.", { date: ["A data não pode ser futura."] });
    if (data.status === "fulfilled") {
      const [pending] = await tx
        .select({ n: count() })
        .from(settlementInstallments)
        .where(and(eq(settlementInstallments.settlementId, s.id), eq(settlementInstallments.status, "pending")));
      if (Number(pending?.n ?? 0) > 0) {
        throw new ConflictError("Há parcelas a pagar. Marque-as como pagas antes de registrar o cumprimento do acordo.");
      }
    }
    const patch: Partial<typeof settlements.$inferInsert> = { status: data.status, updatedAt: new Date() };
    if (data.status === "signed") patch.signedAt = date;
    if (data.status === "homologated") {
      patch.homologatedAt = date;
      if (!s.signedAt) patch.signedAt = date;
    }
    await tx.update(settlements).set(patch).where(and(eq(settlements.id, s.id), eq(settlements.organizationId, ctx.organizationId)));
    if (data.status === "cancelled") {
      await tx
        .update(settlementInstallments)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(and(eq(settlementInstallments.settlementId, s.id), eq(settlementInstallments.status, "pending")));
    }
    await recordAudit(
      ctx,
      {
        action: "settlement.status_change",
        entityType: "legal_process",
        entityId: s.processId,
        summary: `Acordo do processo ${s.processNumber}: ${SETTLEMENT_STATUS_LABELS[s.status]} para ${SETTLEMENT_STATUS_LABELS[data.status]}.`,
        changes: { settlementStatus: { from: s.status, to: data.status } },
        metadata: { settlementId: s.id, date },
      },
      tx,
    );
    return { processId: s.processId };
  });
}

export async function updateSettlementNotes(ctx: AuthContext, id: string, input: { notes?: string | null }): Promise<void> {
  assertCan(ctx, "contingency:write");
  const data = parseOrThrow(settlementNotesSchema, input);
  await getDb().transaction(async (tx) => {
    const s = await loadSettlement(ctx, id, tx);
    if ((s.notes ?? null) === data.notes) return;
    await tx
      .update(settlements)
      .set({ notes: data.notes, updatedAt: new Date() })
      .where(and(eq(settlements.id, s.id), eq(settlements.organizationId, ctx.organizationId)));
    await recordAudit(
      ctx,
      {
        action: "settlement.update_notes",
        entityType: "legal_process",
        entityId: s.processId,
        summary: `Observações do acordo do processo ${s.processNumber} alteradas.`,
        changes: diffChanges(s, data, ["notes"]),
        metadata: { settlementId: s.id },
      },
      tx,
    );
  });
}

/** Marks an installment as paid (with date) or back to pending. */
export async function setInstallmentPaid(
  ctx: AuthContext,
  installmentId: string,
  input: InstallmentPaymentInput,
): Promise<{ processId: string; settlementId: string }> {
  assertCan(ctx, "contingency:write");
  const data = parseOrThrow(installmentPaymentSchema, input);
  return getDb().transaction(async (tx) => {
    const [row] = await tx
      .select({ i: settlementInstallments, s: settlements, processNumber: legalProcesses.number })
      .from(settlementInstallments)
      .innerJoin(settlements, eq(settlements.id, settlementInstallments.settlementId))
      .innerJoin(legalProcesses, eq(legalProcesses.id, settlements.processId))
      .where(
        and(
          eq(settlementInstallments.id, parseId(installmentId)),
          eq(settlementInstallments.organizationId, ctx.organizationId),
          settlementWhere(ctx),
        ),
      );
    if (!row) throw new NotFoundError("Parcela não encontrada ou sem permissão de acesso.");
    if (row.s.status === "cancelled" || row.i.status === "cancelled") {
      throw new ConflictError("Parcelas de acordo cancelado não podem ser alteradas.");
    }
    if (row.s.status === "fulfilled" && !data.paid) {
      throw new ConflictError("O acordo já foi registrado como cumprido.");
    }
    if (data.paid && row.i.status === "paid") throw new ConflictError("A parcela já está paga.");
    if (!data.paid && row.i.status === "pending") throw new ConflictError("A parcela já está a pagar.");
    const paidAt = data.paid ? (data.paidAt ?? todayISO()) : null;
    if (paidAt && paidAt > todayISO()) {
      throw new ValidationError("Verifique os campos informados.", { paidAt: ["A data de pagamento não pode ser futura."] });
    }
    await tx
      .update(settlementInstallments)
      .set({ status: data.paid ? "paid" : "pending", paidAt, updatedAt: new Date() })
      .where(and(eq(settlementInstallments.id, row.i.id), eq(settlementInstallments.organizationId, ctx.organizationId)));
    await tx.update(settlements).set({ updatedAt: new Date() }).where(eq(settlements.id, row.s.id));
    await recordAudit(
      ctx,
      {
        action: data.paid ? "settlement.installment_paid" : "settlement.installment_unpaid",
        entityType: "legal_process",
        entityId: row.s.processId,
        summary: data.paid
          ? `Parcela ${row.i.number} (${formatMoneyCents(row.i.amountCents)}) do acordo do processo ${row.processNumber} marcada como paga.`
          : `Parcela ${row.i.number} do acordo do processo ${row.processNumber} voltou para "a pagar".`,
        changes: { installmentStatus: { from: row.i.status, to: data.paid ? "paid" : "pending" } },
        metadata: { settlementId: row.s.id, installmentId: row.i.id, paidAt },
      },
      tx,
    );
    return { processId: row.s.processId, settlementId: row.s.id };
  });
}

export async function getSettlementProcessId(ctx: AuthContext, id: string): Promise<string> {
  assertCan(ctx, "contingency:read");
  return (await loadSettlement(ctx, id, getDb())).processId;
}

/** Settlement counts for the `/acordos` header. */
export async function getSettlementKpis(ctx: AuthContext): Promise<{
  open: number;
  binding: number;
  breached: number;
  pendingCents: number;
  overdueInstallments: number;
}> {
  assertCan(ctx, "contingency:read");
  const db = getDb();
  const today = todayISO();
  const scope = settlementWhere(ctx);
  const [[counts], [money]] = await Promise.all([
    db
      .select({
        open: sql<number>`count(*) filter (where ${settlements.status} in ('proposal', 'negotiating'))`.mapWith(Number),
        binding: sql<number>`count(*) filter (where ${settlements.status} in ('signed', 'homologated'))`.mapWith(Number),
        breached: sql<number>`count(*) filter (where ${settlements.status} = 'breached')`.mapWith(Number),
      })
      .from(settlements)
      .where(scope),
    db
      .select({
        pendingCents: sql<number>`coalesce(sum(${settlementInstallments.amountCents}), 0)`.mapWith(Number),
        overdue: sql<number>`count(*) filter (where ${settlementInstallments.dueDate} < ${today})`.mapWith(Number),
      })
      .from(settlementInstallments)
      .innerJoin(settlements, eq(settlements.id, settlementInstallments.settlementId))
      .where(
        and(
          scope,
          eq(settlementInstallments.status, "pending"),
          inArray(settlements.status, [...BINDING_SETTLEMENT_STATUSES]),
        ),
      ),
  ]);
  return {
    open: counts?.open ?? 0,
    binding: counts?.binding ?? 0,
    breached: counts?.breached ?? 0,
    pendingCents: money?.pendingCents ?? 0,
    overdueInstallments: money?.overdue ?? 0,
  };
}
