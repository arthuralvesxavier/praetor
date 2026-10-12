/**
 * Server-only helpers shared by the contingency services (not a cross-module
 * API). Services never import `next/*`.
 */
import { and, desc, eq, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { provisionFor } from "@/domain/contingency";
import { todayISO } from "@/lib/format";
import { markAnalysesStaleForEntity } from "@/modules/analyses/service";
import { loadOrganization } from "@/modules/analyses/org-settings";
import type { AuthContext } from "@/server/auth/context";
import { documentWhere, processWhere } from "@/server/auth/access";
import { getDb, type DbOrTx } from "@/server/db/client";
import {
  documentVersions,
  documents,
  legalProcesses,
  processGuarantees,
  processRiskAssessments,
  processValuations,
  users,
  type OrganizationSettings,
} from "@/server/db/schema";
import { NotFoundError, ValidationError } from "@/server/lib/errors";
import { recordRiskBp } from "./position";

export function parseOrThrow<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const r = schema.safeParse(input);
  if (!r.success) {
    const flat = z.flattenError(r.error) as { formErrors: string[]; fieldErrors: Record<string, string[] | undefined> };
    const fieldErrors: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(flat.fieldErrors)) if (v && v.length) fieldErrors[k] = v;
    throw new ValidationError(flat.formErrors[0] ?? "Verifique os campos informados.", fieldErrors);
  }
  return r.data;
}

const uuidSchema = z.guid();

/** An invalid id can never match a record: same answer as "not found / not visible". */
export function parseId(id: string): string {
  const r = uuidSchema.safeParse(id);
  if (!r.success) throw new NotFoundError();
  return r.data;
}

export async function loadSettings(organizationId: string, db: DbOrTx = getDb()): Promise<OrganizationSettings> {
  return (await loadOrganization(organizationId, db)).settings;
}

export type ProcessRow = typeof legalProcesses.$inferSelect;

/** Loads a process visible to ctx (row visibility applied) or throws NotFoundError. */
export async function loadVisibleProcess(ctx: AuthContext, processId: string, db: DbOrTx = getDb()): Promise<ProcessRow> {
  const [row] = await db
    .select()
    .from(legalProcesses)
    .where(and(eq(legalProcesses.id, parseId(processId)), processWhere(ctx)));
  if (!row) throw new NotFoundError("Processo não encontrado ou sem permissão de acesso.");
  return row;
}

/** A human must be identified to make anything official (RN-11). */
export function requireHuman(ctx: AuthContext): string {
  if (!ctx.userId) throw new ValidationError("Somente uma pessoa identificada pode oficializar valores e classificações.");
  return ctx.userId;
}

/**
 * Validates a document reference of a valuation/guarantee: the document must
 * be visible to ctx, belong to the organization and be linked to the process.
 * Returns the version to reference (given version or the current one).
 */
export async function assertProcessDocument(
  ctx: AuthContext,
  processId: string,
  input: { documentId: string; documentVersionId?: string | null; page?: number | null },
  db: DbOrTx,
): Promise<{ documentId: string; versionId: string | null }> {
  const [doc] = await db
    .select({ id: documents.id, processId: documents.processId, currentVersionId: documents.currentVersionId })
    .from(documents)
    .where(and(eq(documents.id, input.documentId), documentWhere(ctx)));
  if (!doc) throw new ValidationError("Verifique os campos informados.", { documentId: ["Documento não encontrado ou sem acesso."] });
  if (doc.processId !== processId) {
    throw new ValidationError("Verifique os campos informados.", { documentId: ["Selecione um documento deste processo."] });
  }
  const versionId = input.documentVersionId ?? doc.currentVersionId ?? null;
  if (versionId) {
    const [version] = await db
      .select({ id: documentVersions.id, pageCount: documentVersions.pageCount })
      .from(documentVersions)
      .where(
        and(
          eq(documentVersions.id, versionId),
          eq(documentVersions.documentId, doc.id),
          eq(documentVersions.organizationId, ctx.organizationId),
        ),
      );
    if (!version) {
      throw new ValidationError("Verifique os campos informados.", { documentId: ["Versão do documento não encontrada."] });
    }
    if (input.page && version.pageCount && input.page > version.pageCount) {
      throw new ValidationError("Verifique os campos informados.", {
        page: [`O documento tem ${version.pageCount} página(s).`],
      });
    }
  }
  return { documentId: doc.id, versionId };
}

/** Active user of the organization (responsible selects). */
export async function assertUserInOrg(ctx: AuthContext, userId: string, field: string, db: DbOrTx): Promise<void> {
  const [u] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.organizationId, ctx.organizationId), eq(users.isActive, true)));
  if (!u) throw new ValidationError("Verifique os campos informados.", { [field]: ["Selecione um usuário ativo da organização."] });
}

const MIRROR_FIELDS = [
  "claimAmountCents",
  "liquidatedAmountCents",
  "riskPercentageBp",
  "lossProbability",
  "provisionAmountCents",
] as const;

export type MirrorChanges = Record<string, { from: unknown; to: unknown }> | null;

/**
 * Order that picks THE official valuation in force among several (e.g. official
 * values of different instances sharing a base date after an import):
 * latest base date, then most recently reviewed (approval), then created, then id.
 * Deterministic; mirrored by `later()` in ./position.ts.
 */
export const OFFICIAL_VALUATION_ORDER = [
  desc(processValuations.baseDate),
  desc(sql`coalesce(${processValuations.reviewedAt}, ${processValuations.createdAt})`),
  desc(processValuations.createdAt),
  desc(processValuations.id),
] as const;

/** PostgreSQL unique violation (SQLSTATE 23505), possibly wrapped in `cause` (DrizzleQueryError). */
export function isUniqueViolation(err: unknown): boolean {
  let e: unknown = err;
  for (let i = 0; i < 5 && e && typeof e === "object"; i++) {
    if ((e as { code?: unknown }).code === "23505") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Recomputes the denormalized contingency fields of a process inside the
 * caller's transaction (MODULE_CONTRACTS "Denormalized mirrors"):
 *   liquidatedAmountCents = latest OFFICIAL liquidated valuation (OFFICIAL_VALUATION_ORDER)
 *   claimAmountCents      = latest OFFICIAL claim valuation (kept when there is none)
 *   riskPercentageBp / lossProbability = official assessment in force today (kept when there is none)
 *   provisionAmountCents  = provisionFor(...) with the linked guarantees (RN-04/RN-05)
 * Returns the field diff (null when nothing changed).
 */
export async function syncProcessMirrors(
  organizationId: string,
  processId: string,
  tx: DbOrTx,
  settings?: OrganizationSettings,
): Promise<MirrorChanges> {
  const s = settings ?? (await loadSettings(organizationId, tx));
  const [proc] = await tx
    .select()
    .from(legalProcesses)
    .where(and(eq(legalProcesses.id, processId), eq(legalProcesses.organizationId, organizationId)));
  if (!proc) throw new NotFoundError();

  const latestOfficial = (kind: "claim" | "liquidated") =>
    tx
      .select({ amountCents: processValuations.amountCents })
      .from(processValuations)
      .where(
        and(
          eq(processValuations.organizationId, organizationId),
          eq(processValuations.processId, processId),
          eq(processValuations.kind, kind),
          eq(processValuations.status, "official"),
        ),
      )
      .orderBy(...OFFICIAL_VALUATION_ORDER)
      .limit(1);

  const today = todayISO();
  const [[liq], [claim], [risk], [guarantees]] = await Promise.all([
    latestOfficial("liquidated"),
    latestOfficial("claim"),
    tx
      .select({ classification: processRiskAssessments.classification, percentageBp: processRiskAssessments.percentageBp })
      .from(processRiskAssessments)
      .where(
        and(
          eq(processRiskAssessments.organizationId, organizationId),
          eq(processRiskAssessments.processId, processId),
          eq(processRiskAssessments.status, "official"),
          lte(processRiskAssessments.effectiveFrom, today),
        ),
      )
      .orderBy(
        desc(processRiskAssessments.effectiveFrom),
        desc(sql`coalesce(${processRiskAssessments.reviewedAt}, ${processRiskAssessments.createdAt})`),
        desc(processRiskAssessments.createdAt),
        desc(processRiskAssessments.id),
      )
      .limit(1),
    tx
      .select({ total: sql<number>`coalesce(sum(${processGuarantees.amountCents}), 0)`.mapWith(Number) })
      .from(processGuarantees)
      .where(
        and(
          eq(processGuarantees.organizationId, organizationId),
          eq(processGuarantees.processId, processId),
          eq(processGuarantees.status, "linked"),
          isNull(processGuarantees.deletedAt),
        ),
      ),
  ]);

  const next = {
    claimAmountCents: claim ? claim.amountCents : proc.claimAmountCents,
    liquidatedAmountCents: liq ? liq.amountCents : proc.liquidatedAmountCents,
    riskPercentageBp: risk ? risk.percentageBp : proc.riskPercentageBp,
    lossProbability: risk ? risk.classification : proc.lossProbability,
    provisionAmountCents: null as number | null,
  };
  const bp = recordRiskBp(next, s.contingency.riskPercentages);
  next.provisionAmountCents = provisionFor({
    liquidatedCents: next.liquidatedAmountCents,
    linkedGuaranteesCents: guarantees?.total ?? 0,
    claimCents: next.claimAmountCents,
    riskPercentageBp: bp,
  }).provisionCents;

  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of MIRROR_FIELDS) {
    const from = proc[key] ?? null;
    const to = next[key] ?? null;
    if (from !== to) changes[key] = { from, to };
  }
  if (Object.keys(changes).length === 0) return null;

  await tx
    .update(legalProcesses)
    .set({ ...next, updatedAt: new Date() })
    .where(and(eq(legalProcesses.id, processId), eq(legalProcesses.organizationId, organizationId)));
  await markAnalysesStaleForEntity(
    { organizationId, entityId: processId, reason: "Valores, garantias ou risco do processo alterados." },
    tx,
  );
  return changes;
}
