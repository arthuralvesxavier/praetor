/**
 * Garantias e deduções (RF-10). Only `linked` guarantees reduce the exposure
 * and the provision base (RN-04); every change re-syncs the process mirrors.
 * Requires `contingency:read` / `contingency:write`.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { GUARANTEE_KIND_LABELS, GUARANTEE_STATUS_LABELS, type DataOrigin, type GuaranteeKind, type GuaranteeStatus } from "@/domain/enums";
import { formatMoneyCents, todayISO } from "@/lib/format";
import type { AuthContext } from "@/server/auth/context";
import { documentWhere, guaranteeWhere } from "@/server/auth/access";
import { assertCan } from "@/server/auth/permissions";
import { getDb, type DbOrTx } from "@/server/db/client";
import { documents, legalProcesses, processGuarantees, users } from "@/server/db/schema";
import { diffChanges, recordAudit } from "@/server/services/audit";
import { ConflictError, NotFoundError, ValidationError } from "@/server/lib/errors";
import { assertProcessDocument, loadVisibleProcess, parseId, parseOrThrow, syncProcessMirrors } from "./internal";
import { guaranteeInputSchema, guaranteeStatusSchema, type GuaranteeInput, type GuaranteeStatusInput } from "./schemas";

export type GuaranteeItem = {
  id: string;
  kind: GuaranteeKind;
  amountCents: number;
  status: GuaranteeStatus;
  depositedAt: string | null;
  statusChangedAt: string | null;
  description: string | null;
  documentId: string | null;
  /** Null when the user cannot see the document. */
  documentTitle: string | null;
  origin: DataOrigin;
  createdByName: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type GuaranteeRow = typeof processGuarantees.$inferSelect;

async function loadGuarantee(ctx: AuthContext, id: string, db: DbOrTx): Promise<GuaranteeRow & { processNumber: string }> {
  const [row] = await db
    .select({ g: processGuarantees, processNumber: legalProcesses.number })
    .from(processGuarantees)
    .innerJoin(legalProcesses, eq(legalProcesses.id, processGuarantees.processId))
    .where(and(eq(processGuarantees.id, parseId(id)), guaranteeWhere(ctx)));
  if (!row) throw new NotFoundError("Garantia não encontrada ou sem permissão de acesso.");
  return { ...row.g, processNumber: row.processNumber };
}

const AUDIT_FIELDS = ["kind", "amountCents", "depositedAt", "documentId", "description"] as const;

export async function listGuarantees(ctx: AuthContext, processId: string): Promise<GuaranteeItem[]> {
  assertCan(ctx, "contingency:read");
  const db = getDb();
  const p = await loadVisibleProcess(ctx, processId, db);
  const creator = alias(users, "guarantee_creator");
  const rows = await db
    .select({ g: processGuarantees, createdByName: creator.name })
    .from(processGuarantees)
    .leftJoin(creator, eq(creator.id, processGuarantees.createdById))
    .where(and(guaranteeWhere(ctx), eq(processGuarantees.processId, p.id)))
    .orderBy(desc(processGuarantees.createdAt));
  const docIds = [...new Set(rows.map((r) => r.g.documentId).filter((x): x is string => !!x))];
  const titles = new Map<string, string>();
  if (docIds.length) {
    const docs = await db
      .select({ id: documents.id, title: documents.title })
      .from(documents)
      .where(and(inArray(documents.id, docIds), documentWhere(ctx)));
    for (const d of docs) titles.set(d.id, d.title);
  }
  return rows.map(({ g, createdByName }) => ({
    id: g.id,
    kind: g.kind,
    amountCents: g.amountCents,
    status: g.status,
    depositedAt: g.depositedAt,
    statusChangedAt: g.statusChangedAt,
    description: g.description,
    documentId: g.documentId,
    documentTitle: g.documentId ? (titles.get(g.documentId) ?? null) : null,
    origin: g.origin,
    createdByName,
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
  }));
}

function assertNotFuture(date: string | null, field: string) {
  if (date && date > todayISO()) {
    throw new ValidationError("Verifique os campos informados.", { [field]: ["A data não pode ser futura."] });
  }
}

export async function createGuarantee(ctx: AuthContext, processId: string, input: GuaranteeInput): Promise<{ id: string }> {
  assertCan(ctx, "contingency:write");
  const data = parseOrThrow(guaranteeInputSchema, input);
  assertNotFuture(data.depositedAt, "depositedAt");
  return getDb().transaction(async (tx) => {
    const p = await loadVisibleProcess(ctx, processId, tx);
    if (data.documentId) await assertProcessDocument(ctx, p.id, { documentId: data.documentId }, tx);
    const [created] = await tx
      .insert(processGuarantees)
      .values({
        organizationId: ctx.organizationId,
        processId: p.id,
        kind: data.kind,
        amountCents: data.amountCents,
        status: "linked",
        depositedAt: data.depositedAt,
        description: data.description,
        documentId: data.documentId,
        origin: "manual",
        createdById: ctx.userId,
      })
      .returning({ id: processGuarantees.id });
    const mirrors = await syncProcessMirrors(ctx.organizationId, p.id, tx);
    await recordAudit(
      ctx,
      {
        action: "guarantee.create",
        entityType: "legal_process",
        entityId: p.id,
        summary: `${GUARANTEE_KIND_LABELS[data.kind]} de ${formatMoneyCents(data.amountCents)} vinculada ao processo ${p.number}.`,
        changes: { ...(diffChanges(null, data, AUDIT_FIELDS) ?? {}), ...(mirrors ?? {}) },
        metadata: { guaranteeId: created.id },
      },
      tx,
    );
    return { id: created.id };
  });
}

export async function updateGuarantee(ctx: AuthContext, id: string, input: GuaranteeInput): Promise<void> {
  assertCan(ctx, "contingency:write");
  const data = parseOrThrow(guaranteeInputSchema, input);
  assertNotFuture(data.depositedAt, "depositedAt");
  await getDb().transaction(async (tx) => {
    const before = await loadGuarantee(ctx, id, tx);
    if (data.documentId && data.documentId !== before.documentId) {
      await assertProcessDocument(ctx, before.processId, { documentId: data.documentId }, tx);
    }
    if (before.statusChangedAt && data.depositedAt && data.depositedAt > before.statusChangedAt) {
      throw new ValidationError("Verifique os campos informados.", {
        depositedAt: ["A data do depósito não pode ser posterior à mudança de situação da garantia."],
      });
    }
    const changes = diffChanges(before, data, AUDIT_FIELDS);
    if (!changes) return;
    await tx
      .update(processGuarantees)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(processGuarantees.id, before.id), eq(processGuarantees.organizationId, ctx.organizationId)));
    const mirrors = await syncProcessMirrors(ctx.organizationId, before.processId, tx);
    await recordAudit(
      ctx,
      {
        action: "guarantee.update",
        entityType: "legal_process",
        entityId: before.processId,
        summary: `Garantia do processo ${before.processNumber} alterada.`,
        changes: { ...changes, ...(mirrors ?? {}) },
        metadata: { guaranteeId: before.id },
      },
      tx,
    );
  });
}

/** linked / released_to_plaintiff / returned_to_company, with the date of the change. */
export async function setGuaranteeStatus(ctx: AuthContext, id: string, input: GuaranteeStatusInput): Promise<void> {
  assertCan(ctx, "contingency:write");
  const data = parseOrThrow(guaranteeStatusSchema, input);
  await getDb().transaction(async (tx) => {
    const before = await loadGuarantee(ctx, id, tx);
    if (before.status === data.status) throw new ConflictError("A garantia já está nessa situação.");
    const changedAt = data.statusChangedAt ?? todayISO();
    assertNotFuture(changedAt, "statusChangedAt");
    if (before.depositedAt && changedAt < before.depositedAt) {
      throw new ValidationError("Verifique os campos informados.", {
        statusChangedAt: ["A data da mudança não pode ser anterior ao depósito."],
      });
    }
    await tx
      .update(processGuarantees)
      .set({ status: data.status, statusChangedAt: changedAt, updatedAt: new Date() })
      .where(and(eq(processGuarantees.id, before.id), eq(processGuarantees.organizationId, ctx.organizationId)));
    const mirrors = await syncProcessMirrors(ctx.organizationId, before.processId, tx);
    await recordAudit(
      ctx,
      {
        action: "guarantee.status_change",
        entityType: "legal_process",
        entityId: before.processId,
        summary: `Garantia de ${formatMoneyCents(before.amountCents)} do processo ${before.processNumber}: ${GUARANTEE_STATUS_LABELS[data.status].toLowerCase()}.`,
        changes: {
          guaranteeStatus: { from: before.status, to: data.status },
          statusChangedAt: { from: before.statusChangedAt, to: changedAt },
          ...(mirrors ?? {}),
        },
        metadata: { guaranteeId: before.id },
      },
      tx,
    );
  });
}

/** Soft delete (registration error). Use the status change for released/returned guarantees. */
export async function deleteGuarantee(ctx: AuthContext, id: string): Promise<{ processId: string }> {
  assertCan(ctx, "contingency:write");
  return getDb().transaction(async (tx) => {
    const before = await loadGuarantee(ctx, id, tx);
    await tx
      .update(processGuarantees)
      .set({ deletedAt: new Date() })
      .where(and(eq(processGuarantees.id, before.id), eq(processGuarantees.organizationId, ctx.organizationId)));
    const mirrors = await syncProcessMirrors(ctx.organizationId, before.processId, tx);
    await recordAudit(
      ctx,
      {
        action: "guarantee.delete",
        entityType: "legal_process",
        entityId: before.processId,
        summary: `Garantia de ${formatMoneyCents(before.amountCents)} excluída do processo ${before.processNumber}.`,
        changes: mirrors,
        metadata: { guaranteeId: before.id },
      },
      tx,
    );
    return { processId: before.processId };
  });
}

export async function getGuaranteeProcessId(ctx: AuthContext, id: string): Promise<string> {
  assertCan(ctx, "contingency:read");
  return (await loadGuarantee(ctx, id, getDb())).processId;
}
