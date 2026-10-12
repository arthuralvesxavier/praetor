/**
 * Memória de cálculo da provisão por competência (P1.10).
 *
 * Fonte: os itens GUARDADOS da competência (`portfolio_snapshot_items`). Uma
 * competência fechada nunca é recalculada (RN-10): valores, classificação,
 * percentual, garantias e provisão vêm do item. O parecer e o responsável vêm
 * da avaliação oficial que estava em vigor na data-base QUANDO a competência
 * foi calculada (`process_risk_assessments` é só de inserção; avaliações
 * registradas ou conferidas depois do cálculo são ignoradas), e só quando ela
 * confere com a classificação e o percentual guardados no item.
 *
 * Visibilidade (mesma política da página de provisão): linhas = processos que a
 * pessoa pode ver (regra atual do processo, sem a condição de exclusão lógica:
 * um processo excluído depois continua na competência, sinalizado); totais da
 * organização só para quem vê tudo ou fecha a competência (`snapshotScope`),
 * com a contagem dos sigilosos não listados; os demais perfis recebem totais dos
 * processos listados.
 *
 * Exportações (XLSX e PDF) saem do MESMO objeto e são auditadas
 * (`provision_memo.export`, sem conteúdo).
 */
import { and, asc, eq, inArray, lte, min } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import type { ClaimRiskLinkKind, DataOrigin, LossProbability } from "@/domain/enums";
import { riskAt, type PositionRisk } from "@/modules/contingency/position";
import { snapshotScope } from "@/modules/contingency/snapshot-service";
import { canViewScopedRecord, hasOrganizationWideScope, seesConfidential } from "@/server/auth/access";
import type { AuthContext } from "@/server/auth/context";
import { assertCan } from "@/server/auth/permissions";
import { getDb } from "@/server/db/client";
import {
  companies,
  legalProcesses,
  organizations,
  portfolioSnapshotItems,
  portfolioSnapshots,
  processClaimAssessments,
  processClaimRiskLinks,
  processRiskAssessments,
  snapshotCloseOverrides,
  units,
  users,
} from "@/server/db/schema";
import { NotFoundError, ValidationError } from "@/server/lib/errors";
import { recordAudit } from "@/server/services/audit";
import {
  buildTotals,
  memoBase,
  periodLabel,
  PROVISION_MEMO_PDF_ROW_LIMIT,
  provisionMemoFileName,
  splitProvision,
  type MemoClassificationSource,
  type ProvisionMemo,
  type ProvisionMemoRow,
} from "./memo";
import { renderProvisionMemoPdf } from "./pdf";
import { memoFormatSchema, memoPeriodSchema, type ProvisionMemoFormat } from "./schemas";
import { buildProvisionMemoXlsx } from "./xlsx";

export { PROVISION_MEMO_PDF_ROW_LIMIT };

function parse<S extends z.ZodType>(schema: S, value: unknown, field: string): z.output<S> {
  const r = schema.safeParse(value);
  if (!r.success) {
    const message = r.error.issues[0]?.message ?? "Verifique os campos informados.";
    throw new ValidationError(message, { [field]: [message] });
  }
  return r.data;
}

type RiskRow = PositionRisk & {
  id: string;
  processId: string;
  opinion: string;
  origin: DataOrigin;
  assessedById: string | null;
  reviewedById: string | null;
};

function classificationSource(
  item: { classification: LossProbability | null; percentageBp: number | null },
  winner: RiskRow | null,
  linkKind: ClaimRiskLinkKind | undefined,
  firstClaimAssessmentAt: Date | undefined,
): MemoClassificationSource {
  if (item.classification === null && item.percentageBp === null) return "unclassified";
  // Sem avaliação oficial em vigor no cálculo: o item usou a classificação do cadastro (fallback do cálculo).
  if (!winner) return "record";
  if (winner.classification !== item.classification || winner.percentageBp !== item.percentageBp) return "not_located";
  if (linkKind === "derived") return "claims_derived";
  if (linkKind === "override") return "claims_override";
  // Sem vínculo e registrada depois da primeira avaliação de pedido: o módulo de pedidos a mantém
  // como override "outside_panel" (`overrideOf` em claims/service), qualquer que seja a origem.
  const recordedAt = winner.reviewedAt ?? winner.createdAt;
  const afterClaims = firstClaimAssessmentAt !== undefined && firstClaimAssessmentAt.getTime() < recordedAt.getTime();
  if (winner.origin === "system") return afterClaims ? "rule_suggestion_outside_panel" : "rule_suggestion";
  if (winner.origin === "imported") return afterClaims ? "imported_outside_panel" : "imported";
  return afterClaims ? "outside_panel" : "manual";
}

/**
 * Memória de cálculo de uma competência para a pessoa (contingency:read).
 * NotFoundError quando a competência nunca foi calculada.
 */
export async function getProvisionMemo(ctx: AuthContext, period: string, opts: { now?: Date } = {}): Promise<ProvisionMemo> {
  assertCan(ctx, "contingency:read");
  const p = parse(memoPeriodSchema, period, "period");
  const db = getDb();
  const generator = alias(users, "memo_generator");
  const closer = alias(users, "memo_closer");
  const overrideCloser = alias(users, "memo_override_closer");
  const [row] = await db
    .select({ s: portfolioSnapshots, generatedByName: generator.name, closedByName: closer.name })
    .from(portfolioSnapshots)
    .leftJoin(generator, and(eq(generator.id, portfolioSnapshots.generatedById), eq(generator.organizationId, ctx.organizationId)))
    .leftJoin(closer, and(eq(closer.id, portfolioSnapshots.closedById), eq(closer.organizationId, ctx.organizationId)))
    .where(and(eq(portfolioSnapshots.organizationId, ctx.organizationId), eq(portfolioSnapshots.period, p)));
  if (!row) throw new NotFoundError(`A competência ${periodLabel(p)} ainda não foi calculada.`);
  const s = row.s;
  const scope = snapshotScope(ctx);

  const stored = await db
    .select({
      i: portfolioSnapshotItems,
      companyName: companies.name,
      unitName: units.name,
      pOrganizationId: legalProcesses.organizationId,
      pUnitId: legalProcesses.unitId,
      pResponsibleId: legalProcesses.responsibleId,
      pCreatedById: legalProcesses.createdById,
      pIsConfidential: legalProcesses.isConfidential,
      pLawFirmId: legalProcesses.lawFirmId,
      pDeletedAt: legalProcesses.deletedAt,
    })
    .from(portfolioSnapshotItems)
    .leftJoin(companies, and(eq(companies.id, portfolioSnapshotItems.companyId), eq(companies.organizationId, ctx.organizationId)))
    .leftJoin(units, and(eq(units.id, portfolioSnapshotItems.unitId), eq(units.organizationId, ctx.organizationId)))
    .leftJoin(
      legalProcesses,
      and(eq(legalProcesses.id, portfolioSnapshotItems.processId), eq(legalProcesses.organizationId, ctx.organizationId)),
    )
    .where(and(eq(portfolioSnapshotItems.snapshotId, s.id), eq(portfolioSnapshotItems.organizationId, ctx.organizationId)))
    .orderBy(asc(portfolioSnapshotItems.number), asc(portfolioSnapshotItems.id));

  const seesAll = seesConfidential(ctx);
  const listed = stored.filter(
    (r) =>
      seesAll ||
      (r.pOrganizationId !== null &&
        canViewScopedRecord(ctx, {
          organizationId: r.pOrganizationId,
          unitId: r.pUnitId,
          responsibleId: r.pResponsibleId,
          createdById: r.pCreatedById,
          isConfidential: r.pIsConfidential ?? true,
          lawFirmId: r.pLawFirmId,
          deletedAt: null,
        })),
  );
  const listedIds = new Set(listed.map((r) => r.i.processId));

  // Detalhes da classificação: só processos desta competência; linhas filtradas pelos listados abaixo.
  const inSnapshot = db
    .select({ id: portfolioSnapshotItems.processId })
    .from(portfolioSnapshotItems)
    .where(eq(portfolioSnapshotItems.snapshotId, s.id));
  const [riskRows, linkRows, claimStarts, overrideRows, [org]] = await Promise.all([
    db
      .select({
        id: processRiskAssessments.id,
        processId: processRiskAssessments.processId,
        classification: processRiskAssessments.classification,
        percentageBp: processRiskAssessments.percentageBp,
        effectiveFrom: processRiskAssessments.effectiveFrom,
        status: processRiskAssessments.status,
        createdAt: processRiskAssessments.createdAt,
        reviewedAt: processRiskAssessments.reviewedAt,
        opinion: processRiskAssessments.opinion,
        origin: processRiskAssessments.origin,
        assessedById: processRiskAssessments.assessedById,
        reviewedById: processRiskAssessments.reviewedById,
      })
      .from(processRiskAssessments)
      .where(
        and(
          eq(processRiskAssessments.organizationId, ctx.organizationId),
          eq(processRiskAssessments.status, "official"),
          lte(processRiskAssessments.effectiveFrom, s.referenceDate),
          inArray(processRiskAssessments.processId, inSnapshot),
        ),
      ),
    db
      .select({ riskAssessmentId: processClaimRiskLinks.riskAssessmentId, kind: processClaimRiskLinks.kind })
      .from(processClaimRiskLinks)
      .where(and(eq(processClaimRiskLinks.organizationId, ctx.organizationId), inArray(processClaimRiskLinks.processId, inSnapshot))),
    db
      .select({ processId: processClaimAssessments.processId, first: min(processClaimAssessments.createdAt) })
      .from(processClaimAssessments)
      .where(and(eq(processClaimAssessments.organizationId, ctx.organizationId), inArray(processClaimAssessments.processId, inSnapshot)))
      .groupBy(processClaimAssessments.processId),
    s.status === "closed"
      ? db
          .select({
            ids: snapshotCloseOverrides.unclassifiedProcessIds,
            unclassifiedCount: snapshotCloseOverrides.unclassifiedCount,
            reason: snapshotCloseOverrides.reason,
            createdAt: snapshotCloseOverrides.createdAt,
            closedByName: overrideCloser.name,
          })
          .from(snapshotCloseOverrides)
          .leftJoin(
            overrideCloser,
            and(eq(overrideCloser.id, snapshotCloseOverrides.closedById), eq(overrideCloser.organizationId, ctx.organizationId)),
          )
          .where(and(eq(snapshotCloseOverrides.snapshotId, s.id), eq(snapshotCloseOverrides.organizationId, ctx.organizationId)))
      : Promise.resolve([]),
    db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, ctx.organizationId)),
  ]);

  // Avaliação em vigor na data-base no momento do cálculo: só linhas registradas/conferidas até o cálculo.
  const calculatedAt = s.generatedAt.getTime();
  const risksBy = new Map<string, RiskRow[]>();
  for (const r of riskRows as RiskRow[]) {
    if (!listedIds.has(r.processId)) continue;
    if ((r.reviewedAt ?? r.createdAt).getTime() > calculatedAt) continue;
    const list = risksBy.get(r.processId) ?? [];
    list.push(r);
    risksBy.set(r.processId, list);
  }
  const winners = new Map<string, RiskRow>();
  for (const [processId, rows] of risksBy) {
    const w = riskAt(rows, s.referenceDate) as RiskRow | null;
    if (w) winners.set(processId, w);
  }
  const linkKind = new Map(linkRows.map((l) => [l.riskAssessmentId, l.kind]));
  const firstClaimAt = new Map<string, Date>();
  for (const c of claimStarts) if (c.first) firstClaimAt.set(c.processId, c.first instanceof Date ? c.first : new Date(c.first));
  const overrideIds = new Set(overrideRows[0]?.ids ?? []);

  const personIds = new Set<string>();
  for (const w of winners.values()) {
    if (w.assessedById) personIds.add(w.assessedById);
    if (w.reviewedById) personIds.add(w.reviewedById);
  }
  const people = personIds.size
    ? await db
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(and(eq(users.organizationId, ctx.organizationId), inArray(users.id, [...personIds])))
    : [];
  const nameOf = new Map(people.map((u) => [u.id, u.name]));

  const rows: ProvisionMemoRow[] = listed.map(({ i, companyName, unitName, pDeletedAt }) => {
    const winner = winners.get(i.processId) ?? null;
    const source = classificationSource(i, winner, winner ? linkKind.get(winner.id) : undefined, firstClaimAt.get(i.processId));
    const located = source !== "record" && source !== "unclassified" && source !== "not_located" && winner !== null;
    const values = {
      claimAmountCents: i.claimAmountCents,
      liquidatedAmountCents: i.liquidatedAmountCents,
      guaranteesCents: i.guaranteesCents,
      percentageBp: i.percentageBp,
      provisionCents: i.provisionCents,
      provisionIsEstimate: i.provisionIsEstimate,
    };
    return {
      processId: i.processId,
      number: i.number,
      companyName,
      unitName,
      isConfidential: i.isConfidential,
      processDeleted: pDeletedAt !== null,
      claimAmountCents: i.claimAmountCents,
      liquidatedAmountCents: i.liquidatedAmountCents,
      guaranteesCents: i.guaranteesCents,
      ...memoBase(values),
      classification: i.classification,
      percentageBp: i.percentageBp,
      provisionCents: i.provisionCents,
      provisionIsEstimate: i.provisionIsEstimate,
      ...splitProvision(values),
      classificationSource: source,
      classificationEffectiveFrom: located ? winner.effectiveFrom : null,
      opinion: located ? winner.opinion : null,
      assessedByName: located && winner.assessedById ? (nameOf.get(winner.assessedById) ?? null) : null,
      reviewedByName: located && winner.reviewedById ? (nameOf.get(winner.reviewedById) ?? null) : null,
      classifiedAt: located ? (winner.reviewedAt ?? winner.createdAt) : null,
      inCloseOverride: overrideIds.has(i.processId),
    };
  });

  const companyNames = new Map<string, string>();
  for (const r of stored) if (r.i.companyId && r.companyName) companyNames.set(r.i.companyId, r.companyName);
  const population = scope === "visible" ? listed : stored;
  const totals = buildTotals(
    population.map((r) => ({
      provisionCents: r.i.provisionCents,
      provisionIsEstimate: r.i.provisionIsEstimate,
      classification: r.i.classification,
      companyId: r.i.companyId,
    })),
    companyNames,
  );
  const listedTotals = buildTotals(rows.map((r) => ({ ...r, companyId: null })), companyNames).overall;

  // Ressalva do fechamento: mesma política do `getCloseGate` (competência fechada) para justificativa,
  // contagem e sigilosos, mas com a lista COMPLETA dos processos listados (a tela limita a 500).
  let override: ProvisionMemo["override"] = null;
  const o = overrideRows[0];
  if (s.status === "closed" && o) {
    const items = rows
      .filter((r) => r.inCloseOverride)
      .map((r) => ({ processId: r.processId, number: r.number, processDeleted: r.processDeleted }));
    override = {
      reason: scope === "visible" && items.length === 0 ? null : o.reason,
      createdAt: o.createdAt,
      closedByName: o.closedByName,
      count: scope === "visible" ? items.length : o.unclassifiedCount,
      hiddenCount: scope === "org_wide" ? Math.max(0, o.unclassifiedCount - items.length) : 0,
      items,
    };
  }

  return {
    organizationName: org?.name ?? null,
    isDemoOrganization: ctx.isDemoOrganization,
    snapshotId: s.id,
    period: s.period,
    referenceDate: s.referenceDate,
    status: s.status,
    calculatedAt: s.generatedAt,
    calculatedByName: row.generatedByName,
    closedAt: s.closedAt,
    closedByName: row.closedByName,
    params: s.params,
    exportedAt: opts.now ?? new Date(),
    exportedByName: ctx.kind === "user" ? ctx.name : null,
    scope,
    scopeNote:
      scope === "visible"
        ? hasOrganizationWideScope(ctx)
          ? "Totais da organização, exceto processos sigilosos (não visíveis para o seu perfil)."
          : "Totais calculados somente sobre os processos que você pode ver."
        : null,
    rows,
    totals: {
      scope,
      organizationWide: scope !== "visible",
      hiddenCount: scope === "org_wide" ? Math.max(0, stored.length - listed.length) : 0,
      ...totals,
    },
    listedTotals,
    deletedCount: rows.filter((r) => r.processDeleted).length,
    override,
  };
}

export type ProvisionMemoFile = {
  fileName: string;
  contentType: string;
  bytes: Uint8Array;
  rows: number;
};

const CONTENT_TYPES: Record<ProvisionMemoFormat, string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
};

/** Gera o arquivo (XLSX ou PDF) da memória e audita o download (sem conteúdo). */
export async function exportProvisionMemo(
  ctx: AuthContext,
  period: string,
  format: string | null | undefined,
  opts: { now?: Date } = {},
): Promise<ProvisionMemoFile> {
  assertCan(ctx, "contingency:read");
  const f = parse(memoFormatSchema, format, "format");
  const memo = await getProvisionMemo(ctx, period, opts);
  if (f === "pdf" && memo.rows.length > PROVISION_MEMO_PDF_ROW_LIMIT) {
    throw new ValidationError(
      `A memória desta competência tem ${memo.rows.length} processos; o PDF é limitado a ${PROVISION_MEMO_PDF_ROW_LIMIT}. Baixe o XLSX.`,
      { format: ["Use o XLSX para esta competência."] },
    );
  }
  const bytes = f === "xlsx" ? new Uint8Array(await buildProvisionMemoXlsx(memo)) : (await renderProvisionMemoPdf(memo)).bytes;
  await recordAudit(ctx, {
    action: "provision_memo.export",
    entityType: "snapshot",
    entityId: memo.snapshotId,
    summary:
      `Memória de cálculo da provisão da competência ${periodLabel(memo.period)} exportada em ${f.toUpperCase()} ` +
      `(${memo.rows.length} processo(s) listado(s)${memo.status === "preview" ? ", prévia" : ""}).`,
    metadata: {
      period: memo.period,
      status: memo.status,
      format: f,
      rows: memo.rows.length,
      scope: memo.scope,
      hiddenCount: memo.totals.hiddenCount,
    },
  });
  return { fileName: provisionMemoFileName(memo, f), contentType: CONTENT_TYPES[f], bytes, rows: memo.rows.length };
}
