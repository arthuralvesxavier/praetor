import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { CASE_BRIEF_DEMO_NOTICE, CASE_BRIEF_SECTIONS, type BriefCitation, type StoredCaseBrief } from "@/domain/case-brief";
import { isValidCnj, normalizeCnj } from "@/domain/cnj";
import { formatBp } from "@/domain/contingency";
import {
  ALERT_SEVERITY_LABELS,
  ALERT_TYPE_LABELS,
  CASE_BRIEF_STATUS_LABELS,
  CLAIM_CATEGORY_LABELS,
  CORRECTION_INDEX_LABELS,
  DEADLINE_KIND_LABELS,
  GUARANTEE_KIND_LABELS,
  GUARANTEE_STATUS_LABELS,
  HEARING_KIND_LABELS,
  HEARING_MODE_LABELS,
  LEGAL_AREA_LABELS,
  LOSS_PROBABILITY_LABELS,
  PARTY_ROLE_LABELS,
  PROBABILITY_BAND_LABELS,
  PROCESS_INSTANCE_LABELS,
  PROCESS_INSTANCE_RANK,
  VALUATION_KIND_LABELS,
  VALUATION_SOURCE_LABELS,
  processPhaseLabel,
  type CaseBriefStatus,
  type CorrectionIndex,
  type ProcessInstance,
} from "@/domain/enums";
import {
  containsPersonalId,
  GAP_MARKER,
  itemGapLabels,
  redactPersonalIds,
  type RecordSource,
  type ReportItemDraft,
  type ReportSectionSpec,
  type ReportTableColumn,
} from "@/domain/legal-reports";
import { daysUntil, formatDate, formatDateTime, formatMoneyCents, todayISO } from "@/lib/format";
import { visibleAlertsWhere } from "@/modules/alerts/service";
import { getProcessClaims, type ProcessClaimItem } from "@/modules/claims/service";
import { exposureBreakdown } from "@/modules/contingency/components/exposure-breakdown";
import { historyOf, positionAt, riskAt, valuationAt, type ProcessPosition } from "@/modules/contingency/position";
import { DATAJUD_SOURCE_LABEL } from "@/modules/court-sync/mapping";
import { formatMonth, unavailableMessage, updatedValue, type SeriesByIndex } from "@/modules/indices/math";
import { loadRatesFor } from "@/modules/indices/service";
import {
  caseBriefWhere,
  deadlineWhere,
  documentWhere,
  guaranteeWhere,
  hearingWhere,
  processWhere,
  riskAssessmentWhere,
  valuationWhere,
} from "@/server/auth/access";
import type { AuthContext } from "@/server/auth/context";
import { can, type Permission } from "@/server/auth/permissions";
import { getDb, type DbOrTx } from "@/server/db/client";
import {
  alerts,
  caseBriefRevisions,
  caseBriefSources,
  caseBriefs,
  companies,
  deadlines,
  documentVersions,
  documents,
  hearings,
  lawFirms,
  legalProcesses,
  processClaimAssessments,
  processClaims,
  processEvents,
  processGuarantees,
  processInstances,
  processParties,
  processRiskAssessments,
  processValuations,
  users,
  type OrganizationSettings,
} from "@/server/db/schema";
import { processScenarios } from "@/server/db/schema/legal-reports";
import { NotFoundError } from "@/server/lib/errors";
import { insertScenarioProposals, planScenarioProposals, type PlannedScenarioProposal, type ScenarioProposalSource } from "./scenarios";
import type { IssuableDraft } from "./service";

/**
 * Gerador do R1, "Relatório de Processo": monta, a partir dos dados REAIS de um
 * processo visível a quem gera (ou ao sistema), os itens das seções 1 e 3 a 8;
 * a nota metodológica (2) é gerada dos números lidos; a auditoria de fontes (9)
 * e as pendências (10) vêm do motor (conferência na emissão).
 *
 * Regras do produto aplicadas aqui:
 * - todo item tem origem; dado ausente vira lacuna (nunca zero, nunca presumido);
 * - valor da causa e valor apurado em itens e colunas separados, nunca somados;
 * - a análise preliminar (simulação nesta versão) entra pela proveniência de cada
 *   item: extraído vira Documentado (trecho conferido na página), cadastro vira
 *   Cadastro, lacuna vira Lacuna, ilustrativo vira Análise marcada como simulação
 *   (só nas seções 3 e 8), item do revisor vira Análise com autor e data;
 * - documento de saúde (atestado, laudo, CAT) é só referenciado: o texto do item
 *   não reproduz o conteúdo e o motor não grava o trecho;
 * - sem CPF/CNPJ (minimização): textos livres passam por `redactPersonalIds` e
 *   trecho de documento com CPF ou CNPJ não é citado;
 * - todo dado não localizado vira lacuna listada nas pendências: item de lacuna,
 *   célula vazia de coluna de lacuna, ou marcador no texto que repete uma lacuna
 *   (`gapRefs`); a nota metodológica conta pela mesma regra (`itemGapLabels`);
 * - nada é gravado durante a montagem: cenários propostos pelo sistema só são
 *   gravados na emissão (`onIssue`, mesma transação do relatório).
 */

export const PROCESS_REPORT_GENERATOR = "process_report";
export const PROCESS_REPORT_VERSION = 1;
export const PROCESS_REPORT_TITLE = "Relatório de Processo";
export const PROCESS_REPORT_PURPOSE = "Relatório interno de acompanhamento do processo";
export const SCENARIO_CAVEAT =
  "Os cenários são estimativas condicionais à data-base deste relatório e não constituem prognóstico de resultado.";

export const PROCESS_REPORT_SECTIONS: readonly ReportSectionSpec[] = [
  { key: "identification", title: "Capa de identificação" },
  { key: "synthesis", title: "Síntese executiva" },
  { key: "timeline", title: "Linha do tempo" },
  { key: "claims", title: "Quadro de pedidos e valores" },
  { key: "guarantees", title: "Garantias e exposição líquida" },
  { key: "scenarios", title: "Matriz de cenários", note: SCENARIO_CAVEAT },
  { key: "attention", title: "Pontos de atenção e próximos atos" },
];

/** Linhas da linha do tempo (as mais recentes, quando houver mais). */
export const TIMELINE_MAX_ROWS = 150;
const BRIEF_ATTENTION_MAX = 3;
const ATTENTION_TABLE_MAX = 30;
/** Análise preliminar usada: a última aprovada; sem ela, a última pronta (com conteúdo, não rejeitada). */
const READY_BRIEF_STATUSES: readonly CaseBriefStatus[] = ["ready_for_review", "in_review"];

const SENSITIVE_CATEGORY = "sensitive_health";
const SENSITIVE_TEXT = "documento de saúde (dado sensível): apenas referenciado, sem transcrição";

/** Texto do relatório: sem travessão nem meia-risca e sem CPF ou CNPJ (trechos literais NÃO passam por aqui). */
function clean(value: string): string {
  return redactPersonalIds(value)
    .replace(/[ \u00a0]+[\u2012-\u2015][ \u00a0]+/g, ", ")
    .replace(/[\u2012-\u2015]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/** Corta no limite de caracteres, de preferência entre palavras, com reticências. */
function clip(text: string, max: number): string {
  const t = clean(text);
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, "")}…`;
}

function money(cents: number): string {
  return formatMoneyCents(cents, "");
}

function day(iso: string | Date | null | undefined, fallback = GAP_MARKER): string {
  return iso ? formatDate(iso, fallback) : fallback;
}

function instanceLabel(value: ProcessInstance | null | undefined): string | null {
  return value ? PROCESS_INSTANCE_LABELS[value] : null;
}

function iso(d: Date): string {
  return d.toISOString();
}

function latestIso(dates: readonly Date[], fallback: string): string {
  return dates.length ? new Date(Math.max(...dates.map((d) => d.getTime()))).toISOString() : fallback;
}

/** Frase terminada em ponto (sem ponto duplicado quando o dado já termina em ponto, ex.: "Ltda."). */
function sentence(text: string): string {
  const t = text.trim();
  return /[.!?…]$/.test(t) ? t : `${t}.`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// ---------------------------------------------------------------------------
// Atualização de valores (calculada na leitura, nunca gravada)
// ---------------------------------------------------------------------------

/** Texto do valor atualizado de um valor com data-base e índice (P1.7). */
export function updatedValueText(
  amountCents: number | null,
  baseDate: string | null,
  index: CorrectionIndex | null,
  asOf: string,
  series: SeriesByIndex,
): string | null {
  if (amountCents === null) return null;
  if (!baseDate) return "Sem data-base: não atualizado";
  const r = updatedValue(amountCents, baseDate, index, asOf, series);
  switch (r.status) {
    case "no_index":
      return "Sem índice informado: não atualizado";
    case "not_corrected":
      return `${money(amountCents)} (sem atualização: índice nenhum)`;
    case "no_months":
      return `${money(amountCents)} (sem mês completo a aplicar)`;
    case "updated":
      return `${money(r.cents as number)} (até ${formatMonth(r.throughMonth)})`;
    case "unavailable":
      return unavailableMessage(r);
  }
}

// ---------------------------------------------------------------------------
// Impressão digital dos dados (rotina de atualização)
// ---------------------------------------------------------------------------

/** Análise preliminar usada pelo R1 (sem filtro de perfil): última aprovada, senão a última pronta. */
async function chooseBriefRow(
  db: DbOrTx,
  organizationId: string,
  processId: string,
  scope: ReturnType<typeof caseBriefWhere> | null,
): Promise<{ id: string; status: CaseBriefStatus; currentRevision: number } | null> {
  const base = and(
    eq(caseBriefs.organizationId, organizationId),
    eq(caseBriefs.processId, processId),
    isNotNull(caseBriefs.content),
    scope ?? undefined,
  );
  const [approved] = await db
    .select({ id: caseBriefs.id, status: caseBriefs.status, currentRevision: caseBriefs.currentRevision })
    .from(caseBriefs)
    .where(and(base, eq(caseBriefs.status, "approved")))
    .orderBy(desc(caseBriefs.version))
    .limit(1);
  if (approved) return approved;
  const [ready] = await db
    .select({ id: caseBriefs.id, status: caseBriefs.status, currentRevision: caseBriefs.currentRevision })
    .from(caseBriefs)
    .where(and(base, inArray(caseBriefs.status, [...READY_BRIEF_STATUSES])))
    .orderBy(desc(caseBriefs.version))
    .limit(1);
  return ready ?? null;
}

/**
 * Impressão digital (SHA-256) dos dados do processo que o R1 apresenta: fase e
 * instância, valores oficiais, classificações e avaliações dos pedidos,
 * garantias, cenários, movimentações e a análise preliminar usada. Lida sem
 * filtro de perfil (é do processo, não de quem olha): a rotina compara com a
 * gravada no R1 para decidir se há dado novo. `plannedScenarioIds`: cenários que
 * o R1 propõe e só grava na emissão (entram na impressão digital como já gravados).
 */
export async function processReportFingerprint(
  organizationId: string,
  processId: string,
  db: DbOrTx = getDb(),
  opts: { plannedScenarioIds?: readonly string[] } = {},
): Promise<string | null> {
  const [p] = await db
    .select({
      phase: legalProcesses.phase,
      instance: legalProcesses.instance,
      status: legalProcesses.status,
      claim: legalProcesses.claimAmountCents,
      liquidated: legalProcesses.liquidatedAmountCents,
      loss: legalProcesses.lossProbability,
      riskBp: legalProcesses.riskPercentageBp,
      verification: legalProcesses.needsVerification,
      responsibleId: legalProcesses.responsibleId,
    })
    .from(legalProcesses)
    .where(and(eq(legalProcesses.id, processId), eq(legalProcesses.organizationId, organizationId), isNull(legalProcesses.deletedAt)));
  if (!p) return null;
  const org = (t: { organizationId: AnyPgColumn }) => eq(t.organizationId, organizationId);
  const [instances, valuations, risks, claims, assessments, guarantees, scenarios, events, brief] = await Promise.all([
    db
      .select({ i: processInstances.instance, c: processInstances.isCurrent })
      .from(processInstances)
      .where(and(org(processInstances), eq(processInstances.processId, processId))),
    db
      .select({ id: processValuations.id, s: processValuations.status, x: processValuations.correctionIndex })
      .from(processValuations)
      .where(
        and(
          org(processValuations),
          eq(processValuations.processId, processId),
          inArray(processValuations.status, ["official", "superseded"]),
        ),
      ),
    db
      .select({ id: processRiskAssessments.id, s: processRiskAssessments.status })
      .from(processRiskAssessments)
      .where(and(org(processRiskAssessments), eq(processRiskAssessments.processId, processId), eq(processRiskAssessments.status, "official"))),
    db
      .select({
        id: processClaims.id,
        s: processClaims.status,
        a: processClaims.claimedAmountCents,
        d: processClaims.amountBaseDate,
        x: processClaims.correctionIndex,
        del: processClaims.deletedAt,
      })
      .from(processClaims)
      .where(and(org(processClaims), eq(processClaims.processId, processId))),
    db
      .select({ id: processClaimAssessments.id })
      .from(processClaimAssessments)
      .where(and(org(processClaimAssessments), eq(processClaimAssessments.processId, processId))),
    db
      .select({
        id: processGuarantees.id,
        s: processGuarantees.status,
        a: processGuarantees.amountCents,
        d: processGuarantees.depositedAt,
        del: processGuarantees.deletedAt,
      })
      .from(processGuarantees)
      .where(and(org(processGuarantees), eq(processGuarantees.processId, processId))),
    db
      .select({ id: processScenarios.id })
      .from(processScenarios)
      .where(and(eq(processScenarios.organizationId, organizationId), eq(processScenarios.processId, processId))),
    db
      .select({ id: processEvents.id })
      .from(processEvents)
      .where(and(org(processEvents), eq(processEvents.processId, processId))),
    chooseBriefRow(db, organizationId, processId, null),
  ]);
  const sorted = <T>(rows: T[], key: (r: T) => string) => [...rows].sort((a, b) => key(a).localeCompare(key(b)));
  const payload = {
    p,
    i: sorted(instances, (r) => r.i),
    v: sorted(valuations, (r) => r.id),
    r: sorted(risks, (r) => r.id),
    c: sorted(claims, (r) => r.id).map((c) => ({ ...c, del: c.del ? 1 : 0 })),
    a: sorted(assessments, (r) => r.id).map((r) => r.id),
    g: sorted(guarantees, (r) => r.id).map((g) => ({ ...g, del: g.del ? 1 : 0 })),
    s: [...scenarios.map((r) => r.id), ...(opts.plannedScenarioIds ?? [])].sort((a, b) => a.localeCompare(b)),
    e: sorted(events, (r) => r.id).map((r) => r.id),
    b: brief,
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

// ---------------------------------------------------------------------------
// Rascunho
// ---------------------------------------------------------------------------

type BriefDoc = { documentId: string; versionId: string; sha256: string; title: string; sensitive: boolean };

type BriefInfo = {
  id: string;
  version: number;
  status: CaseBriefStatus;
  demo: boolean;
  content: StoredCaseBrief;
  generatedAt: Date | null;
  createdAt: Date;
  approvedAt: Date | null;
  approvedByName: string | null;
  lastEditedAt: Date | null;
  lastEditedByName: string | null;
  docs: Map<string, BriefDoc>;
  /** Autor e data de um item do revisor, pela revisão que o incluiu (histórico de revisões). */
  reviewerAuthor: (section: string, item: BriefItemLike) => { name: string | null; at: Date } | null;
};

type BriefItemLike = {
  provenance?: string;
  text?: string;
  description?: string;
  label?: string;
  value?: string | null;
  date?: string | null;
};

/** Assinatura de um item da análise (seção + textos), para achar a revisão que o incluiu. */
function briefItemSignature(section: string, item: BriefItemLike): string {
  return `${section}|${JSON.stringify([item.text ?? item.description ?? item.label ?? "", item.date ?? null, item.value ?? null])}`;
}

/** Assinaturas dos itens do revisor de um conteúdo da análise. */
function reviewerSignatures(content: StoredCaseBrief): Set<string> {
  const out = new Set<string>();
  for (const [section, value] of Object.entries(content)) {
    if (!Array.isArray(value)) continue;
    for (const item of value as unknown[]) {
      if (item && typeof item === "object" && (item as BriefItemLike).provenance === "reviewer") {
        out.add(briefItemSignature(section, item as BriefItemLike));
      }
    }
  }
  return out;
}

async function loadBrief(ctx: AuthContext, processId: string): Promise<BriefInfo | null> {
  if (!can(ctx, "brief:read")) return null;
  const db = getDb();
  const chosen = await chooseBriefRow(db, ctx.organizationId, processId, caseBriefWhere(ctx));
  if (!chosen) return null;
  const [b] = await db
    .select({
      id: caseBriefs.id,
      version: caseBriefs.version,
      status: caseBriefs.status,
      mode: caseBriefs.mode,
      content: caseBriefs.content,
      generatedAt: caseBriefs.generatedAt,
      createdAt: caseBriefs.createdAt,
      approvedAt: caseBriefs.approvedAt,
      approvedById: caseBriefs.approvedById,
      lastEditedAt: caseBriefs.lastEditedAt,
      lastEditedById: caseBriefs.lastEditedById,
      currentRevision: caseBriefs.currentRevision,
    })
    .from(caseBriefs)
    .where(and(eq(caseBriefs.id, chosen.id), caseBriefWhere(ctx)))
    .limit(1);
  if (!b?.content) return null;
  // Histórico de revisões: cada item do revisor é creditado a quem o incluiu (na forma atual) e na data dessa revisão.
  const revisions = await db
    .select({
      revision: caseBriefRevisions.revision,
      content: caseBriefRevisions.content,
      editedById: caseBriefRevisions.editedById,
      createdAt: caseBriefRevisions.createdAt,
    })
    .from(caseBriefRevisions)
    .where(
      and(
        eq(caseBriefRevisions.briefId, b.id),
        eq(caseBriefRevisions.organizationId, ctx.organizationId),
        sql`${caseBriefRevisions.revision} <= ${b.currentRevision}`,
      ),
    )
    .orderBy(asc(caseBriefRevisions.revision));
  const introducedBy = new Map<string, { editedById: string | null; at: Date }>();
  let previous = new Set<string>();
  for (const r of revisions) {
    const current = reviewerSignatures(r.content);
    for (const sig of current) if (!previous.has(sig)) introducedBy.set(sig, { editedById: r.editedById, at: r.createdAt });
    previous = current;
  }
  const people = [b.approvedById, b.lastEditedById, ...[...introducedBy.values()].map((v) => v.editedById)].filter(
    (v): v is string => !!v,
  );
  const names = people.length
    ? new Map(
        (await db.select({ id: users.id, name: users.name }).from(users).where(and(inArray(users.id, people), eq(users.organizationId, ctx.organizationId)))).map(
          (u) => [u.id, u.name],
        ),
      )
    : new Map<string, string>();
  const docs = new Map<string, BriefDoc>();
  if (can(ctx, "document:read")) {
    const sources = await db
      .select({ ref: caseBriefSources.ref, documentId: caseBriefSources.entityId, versionId: caseBriefSources.versionId })
      .from(caseBriefSources)
      .where(
        and(
          eq(caseBriefSources.briefId, b.id),
          eq(caseBriefSources.organizationId, ctx.organizationId),
          eq(caseBriefSources.sourceType, "document_version"),
        ),
      );
    const versionIds = sources.map((s) => s.versionId).filter((v): v is string => !!v);
    const rows = versionIds.length
      ? await db
          .select({
            versionId: documentVersions.id,
            documentId: documentVersions.documentId,
            sha256: documentVersions.sha256,
            title: documents.title,
            category: documents.category,
          })
          .from(documentVersions)
          .innerJoin(documents, eq(documents.id, documentVersions.documentId))
          .where(and(inArray(documentVersions.id, versionIds), eq(documentVersions.organizationId, ctx.organizationId), documentWhere(ctx)))
      : [];
    const byVersion = new Map(rows.map((r) => [r.versionId, r]));
    for (const s of sources) {
      const v = s.versionId ? byVersion.get(s.versionId) : undefined;
      if (!v || v.documentId !== s.documentId) continue;
      docs.set(s.ref, {
        documentId: v.documentId,
        versionId: v.versionId,
        sha256: v.sha256,
        title: v.title,
        sensitive: v.category === SENSITIVE_CATEGORY,
      });
    }
  }
  return {
    id: b.id,
    version: b.version,
    status: b.status,
    demo: b.mode === "demo",
    content: b.content,
    generatedAt: b.generatedAt,
    createdAt: b.createdAt,
    approvedAt: b.approvedAt,
    approvedByName: b.approvedById ? (names.get(b.approvedById) ?? null) : null,
    lastEditedAt: b.lastEditedAt,
    lastEditedByName: b.lastEditedById ? (names.get(b.lastEditedById) ?? null) : null,
    docs,
    reviewerAuthor: (section, item) => {
      const found = introducedBy.get(briefItemSignature(section, item));
      if (!found || !found.editedById) return null;
      return { name: names.get(found.editedById) ?? null, at: found.at };
    },
  };
}

/** Quem incluiu um item do revisor (pela revisão) ou, sem registro no histórico, o aviso disso. */
function reviewerCredit(brief: BriefInfo, section: string, item: BriefItemLike): { who: string; at: Date; label: string } {
  const author = brief.reviewerAuthor(section, item);
  if (author) {
    const who = author.name ?? "pessoa identificada";
    return { who, at: author.at, label: `Análise preliminar versão ${brief.version}, item incluído ou editado na revisão por ${who}` };
  }
  return {
    who: "revisor não identificado no histórico de revisões",
    at: brief.lastEditedAt ?? brief.approvedAt ?? brief.createdAt,
    label: `Análise preliminar versão ${brief.version}, item incluído na revisão (autor não identificado no histórico de revisões; data da última edição)`,
  };
}

/** Citação utilizável de um item extraído: documento visível, página e trecho literal. */
function documentCitation(brief: BriefInfo, citations: readonly BriefCitation[]): { doc: BriefDoc; page: number; excerpt: string } | null {
  for (const c of citations) {
    const doc = brief.docs.get(c.ref);
    if (!doc || !c.page || c.page < 1 || !c.excerpt || c.excerpt.replace(/\s+/g, " ").trim().length < 12) continue;
    // Minimização: trecho literal com CPF ou CNPJ não é citado (um trecho literal não pode ser alterado).
    if (containsPersonalId(c.excerpt)) continue;
    return { doc, page: c.page, excerpt: c.excerpt };
  }
  return null;
}

export type ProcessReportCounts = {
  documents: number;
  documentsExamined: number;
  documentsWithoutText: number;
  documentsUnsupported: number;
  documentsSensitive: number;
  valuations: number;
  valuationsOfficial: number;
  valuationsProposed: number;
  valuationsSuperseded: number;
  valuationsRejected: number;
  claims: number;
  claimsAssessed: number;
  claimsPending: number;
  guarantees: number;
  movements: number;
  movementsDataJud: number;
  scenarios: number;
  scenariosProposed: number;
};

/**
 * Rascunho do R1 de um processo visível a `ctx`. Nada é gravado aqui: sem cenário
 * registrado, a matriz traz cenários propostos a partir das avaliações dos
 * pedidos (origem sistema, sujeitos a revisão), gravados só na emissão
 * (`onIssue`, na transação do relatório; se a emissão falhar, nada fica).
 */
export async function buildProcessReportDraft(
  ctx: AuthContext,
  input: { processId: string },
  settings: OrganizationSettings,
): Promise<IssuableDraft> {
  const db = getDb();
  const orgId = ctx.organizationId;
  const [p] = await db
    .select({
      id: legalProcesses.id,
      number: legalProcesses.number,
      title: legalProcesses.title,
      court: legalProcesses.court,
      courtDivision: legalProcesses.courtDivision,
      area: legalProcesses.area,
      processClass: legalProcesses.processClass,
      phase: legalProcesses.phase,
      phaseDetail: legalProcesses.phaseDetail,
      instance: legalProcesses.instance,
      city: legalProcesses.city,
      state: legalProcesses.state,
      filedAt: legalProcesses.filedAt,
      claimAmountCents: legalProcesses.claimAmountCents,
      liquidatedAmountCents: legalProcesses.liquidatedAmountCents,
      riskPercentageBp: legalProcesses.riskPercentageBp,
      lossProbability: legalProcesses.lossProbability,
      needsVerification: legalProcesses.needsVerification,
      verificationNote: legalProcesses.verificationNote,
      createdAt: legalProcesses.createdAt,
      updatedAt: legalProcesses.updatedAt,
      responsibleName: users.name,
      companyName: companies.name,
      lawFirmName: lawFirms.name,
    })
    .from(legalProcesses)
    .leftJoin(users, and(eq(users.id, legalProcesses.responsibleId), eq(users.organizationId, orgId)))
    .leftJoin(companies, and(eq(companies.id, legalProcesses.companyId), eq(companies.organizationId, orgId)))
    .leftJoin(lawFirms, and(eq(lawFirms.id, legalProcesses.lawFirmId), eq(lawFirms.organizationId, orgId)))
    .where(and(eq(legalProcesses.id, input.processId), processWhere(ctx)))
    .limit(1);
  if (!p) throw new NotFoundError("Processo não encontrado ou sem permissão de acesso.");

  const baseDate = todayISO();
  const queriedAt = new Date().toISOString();
  const recordedAt = iso(p.updatedAt ?? p.createdAt);
  const readValues = can(ctx, "contingency:read");
  const items: ReportItemDraft[] = [];
  let seq = 0;
  const push = (item: Omit<ReportItemDraft, "key">): string => {
    seq += 1;
    const key = `i${seq}`;
    items.push({ ...item, key, content: clean(item.content) });
    return key;
  };
  const processSource = (field: string, label: string): RecordSource => ({
    table: "legal_processes",
    field,
    recordId: p.id,
    label: `Cadastro do processo, campo ${label}`,
    recordedAt,
  });
  /** Fonte de uma consulta que NÃO encontrou registro (a data é a da consulta). Só para resultados vazios. */
  const emptyQuerySource = (table: string, field: string, label: string): RecordSource => ({
    table,
    field,
    recordId: null,
    label,
    recordedAt: queriedAt,
    dateBasis: "query",
  });
  /** Fonte de vários registros lidos (data do mais recente; com um só, a data dele). */
  const rowsSource = (table: string, field: string, label: string, rows: readonly { id: string; at: Date }[]): RecordSource => ({
    table,
    field,
    recordId: rows.length === 1 ? rows[0].id : null,
    label,
    recordedAt: latestIso(
      rows.map((r) => r.at),
      queriedAt,
    ),
    dateBasis: rows.length === 1 ? "record" : "latest",
  });
  /** Lacunas, por tipo (a síntese resume as principais). */
  type GapKind = "record" | "brief_doc" | "brief";
  const gapList: { key: string; label: string; kind: GapKind }[] = [];
  const gap = (section: string, label: string, kind: GapKind = "record"): string => {
    const key = push({ section, content: label, origin: "gap" });
    gapList.push({ key, label, kind });
    return key;
  };
  const requiredPermissions = new Set<Permission>(["process:read"]);
  const counts: ProcessReportCounts = {
    documents: 0,
    documentsExamined: 0,
    documentsWithoutText: 0,
    documentsUnsupported: 0,
    documentsSensitive: 0,
    valuations: 0,
    valuationsOfficial: 0,
    valuationsProposed: 0,
    valuationsSuperseded: 0,
    valuationsRejected: 0,
    claims: 0,
    claimsAssessed: 0,
    claimsPending: 0,
    guarantees: 0,
    movements: 0,
    movementsDataJud: 0,
    scenarios: 0,
    scenariosProposed: 0,
  };

  const [instances, parties, events, documentRows, brief] = await Promise.all([
    db
      .select({
        id: processInstances.id,
        instance: processInstances.instance,
        court: processInstances.court,
        courtDivision: processInstances.courtDivision,
        city: processInstances.city,
        state: processInstances.state,
        processClass: processInstances.processClass,
        isCurrent: processInstances.isCurrent,
        updatedAt: processInstances.updatedAt,
      })
      .from(processInstances)
      .where(and(eq(processInstances.organizationId, orgId), eq(processInstances.processId, p.id))),
    db
      .select({
        id: processParties.id,
        name: processParties.name,
        role: processParties.role,
        isClient: processParties.isClient,
        counselName: processParties.counselName,
        createdAt: processParties.createdAt,
      })
      .from(processParties)
      .where(and(eq(processParties.organizationId, orgId), eq(processParties.processId, p.id)))
      .orderBy(asc(processParties.createdAt)),
    db
      .select({
        id: processEvents.id,
        occurredAt: processEvents.occurredAt,
        type: processEvents.type,
        title: processEvents.title,
        origin: processEvents.origin,
        externalSource: processEvents.externalSource,
        instance: processEvents.instance,
        createdAt: processEvents.createdAt,
      })
      .from(processEvents)
      .where(and(eq(processEvents.organizationId, orgId), eq(processEvents.processId, p.id)))
      .orderBy(asc(processEvents.occurredAt), asc(processEvents.createdAt)),
    can(ctx, "document:read")
      ? db
          .select({
            id: documents.id,
            category: documents.category,
            extractionStatus: documentVersions.extractionStatus,
            hasText: sql<boolean>`(coalesce(length(${documentVersions.extractedText}), 0) > 0)`,
          })
          .from(documents)
          .innerJoin(documentVersions, eq(documentVersions.id, documents.currentVersionId))
          .where(and(eq(documents.processId, p.id), documentWhere(ctx)))
      : Promise.resolve([]),
    loadBrief(ctx, p.id),
  ]);

  counts.documents = documentRows.length;
  if (documentRows.length > 0) requiredPermissions.add("document:read");
  if (brief) requiredPermissions.add("brief:read");
  for (const d of documentRows) {
    if (d.category === SENSITIVE_CATEGORY) counts.documentsSensitive += 1;
    else if (d.extractionStatus === "unsupported") counts.documentsUnsupported += 1;
    else if (d.extractionStatus === "succeeded" && d.hasText) counts.documentsExamined += 1;
    else counts.documentsWithoutText += 1;
  }

  // ===== 1. Capa de identificação =========================================
  push({ section: "identification", content: `Número do processo (CNJ): ${p.number}.`, origin: "record", recordSource: processSource("number", "Número") });
  push({
    section: "identification",
    content: `Matéria: ${LEGAL_AREA_LABELS[p.area]}${p.processClass ? `, classe processual ${p.processClass}` : ""}.`,
    origin: "record",
    recordSource: processSource(p.processClass ? "area, process_class" : "area", p.processClass ? "Área e classe" : "Área"),
  });
  if (!p.processClass) gap("identification", "Classe processual");
  // Fase processual (repetida na síntese; sem fase, a síntese repete a lacuna deste item).
  const phaseLabel = processPhaseLabel(p.phase);
  let phaseGapKey: string | null = null;
  if (phaseLabel) {
    push({
      section: "identification",
      content: sentence(`Fase processual: ${phaseLabel}${p.phaseDetail ? ` (${clip(p.phaseDetail, 120)})` : ""}`),
      origin: "record",
      recordSource: processSource(p.phaseDetail ? "phase, phase_detail" : "phase", "Fase"),
    });
  } else {
    phaseGapKey = gap("identification", "Fase processual");
  }

  const sortedInstances = [...instances].sort((a, b) => PROCESS_INSTANCE_RANK[a.instance] - PROCESS_INSTANCE_RANK[b.instance]);
  // Instância atual: a linha marcada como atual; sem ela, a da instância do cadastro. O tribunal e o órgão
  // julgador da síntese vêm desta linha (os campos do cadastro do processo guardam os da origem).
  const currentInstance =
    sortedInstances.find((i) => i.isCurrent) ?? (p.instance ? sortedInstances.find((i) => i.instance === p.instance) : undefined) ?? null;
  let instanceGapKey: string | null = null;
  if (sortedInstances.length > 0) {
    push({
      section: "identification",
      content: `Autos de origem e recursais do número ${p.number} (um processo por número CNJ, com uma linha por instância)`,
      origin: "record",
      recordSource: {
        table: "process_instances",
        field: "instance, court, court_division, city, state, process_class, is_current",
        recordId: sortedInstances.length === 1 ? sortedInstances[0].id : null,
        label: "Instâncias do processo",
        recordedAt: latestIso(sortedInstances.map((i) => i.updatedAt), queriedAt),
        dateBasis: sortedInstances.length === 1 ? "record" : "latest",
      },
      data: {
        kind: "table",
        columns: [
          { header: "Instância", weight: 1.1 },
          { header: "Tribunal e órgão julgador", weight: 3 },
          { header: "Cidade/UF", weight: 1.4, nullLabel: GAP_MARKER },
          { header: "Classe", weight: 1, nullLabel: GAP_MARKER },
          { header: "Situação", weight: 1 },
        ],
        rows: sortedInstances.map((i) => [
          PROCESS_INSTANCE_LABELS[i.instance],
          clean([i.court, i.courtDivision].filter(Boolean).join(", ")),
          [i.city, i.state].filter(Boolean).join("/") || null,
          i.processClass,
          i.isCurrent || i.id === currentInstance?.id ? "Instância atual" : "Anterior",
        ]),
        totals: null,
        note: null,
      },
    });
    if (!currentInstance && !p.instance) instanceGapKey = gap("identification", "Instância atual do processo");
  } else {
    const where = clean([p.court, p.courtDivision].filter(Boolean).join(", "));
    const place = [p.city, p.state].filter(Boolean).join("/");
    push({
      section: "identification",
      content: `Autos: ${p.number}${where ? `, ${where}` : ""}${place ? `, ${place}` : ""}${instanceLabel(p.instance) ? `, instância atual ${instanceLabel(p.instance)}` : ""}.`,
      origin: "record",
      recordSource: processSource("court, court_division, city, state, instance", "Tribunal, órgão julgador, cidade e instância"),
    });
    if (!where) gap("identification", "Tribunal e órgão julgador");
    if (!place) gap("identification", "Cidade/UF do processo");
    if (!p.instance) instanceGapKey = gap("identification", "Instância atual do processo");
    gap("identification", "Vínculos de instância (autos de origem e recursais) registrados");
  }

  if (parties.length > 0) {
    push({
      section: "identification",
      content: "Partes do processo (nome e polo; sem CPF ou CNPJ, por minimização de dados)",
      origin: "record",
      recordSource: {
        table: "process_parties",
        field: "name, role, is_client, counsel_name",
        recordId: parties.length === 1 ? parties[0].id : null,
        label: "Partes do processo",
        recordedAt: latestIso(parties.map((r) => r.createdAt), queriedAt),
        dateBasis: parties.length === 1 ? "record" : "latest",
      },
      data: {
        kind: "table",
        columns: [
          { header: "Polo", weight: 1.3 },
          { header: "Nome", weight: 3.4 },
          { header: "Cliente", weight: 0.8 },
          { header: "Advogado(a) informado(a)", weight: 2.2, nullLabel: "Não informado" },
        ],
        rows: parties.map((r) => [PARTY_ROLE_LABELS[r.role], clean(r.name), r.isClient ? "Sim" : "Não", r.counselName ? clean(r.counselName) : null]),
        totals: null,
        note: null,
      },
    });
  } else {
    gap("identification", "Partes do processo");
  }
  if (p.companyName) {
    push({ section: "identification", content: sentence(`Empresa do grupo: ${p.companyName}`), origin: "record", recordSource: processSource("company_id", "Empresa") });
  } else {
    gap("identification", "Empresa do grupo");
  }
  if (p.responsibleName) {
    push({
      section: "identification",
      content: sentence(`Responsável: ${p.responsibleName}${p.lawFirmName ? `; escritório externo: ${p.lawFirmName}` : ""}`),
      origin: "record",
      recordSource: processSource(p.lawFirmName ? "responsible_id, law_firm_id" : "responsible_id", p.lawFirmName ? "Responsável e escritório" : "Responsável"),
    });
  } else {
    gap("identification", "Responsável pelo processo");
  }

  // ===== 4. Linha do tempo ===============================================
  /** `recordedAt`: data do registro lido (movimentação) ou da análise preliminar (itens dela). */
  type TimelineRow = { date: string | null; order: number; recordedAt: Date; item: Omit<ReportItemDraft, "key"> };
  const timeline: TimelineRow[] = [];
  const timelineColumns: ReportTableColumn[] = [
    { header: "Data", weight: 1.25 },
    { header: "Evento", weight: 3.4 },
    { header: "Instância", weight: 1, nullLabel: "Não informada" },
    { header: "Fonte", weight: 2.5 },
  ];
  const row = (cells: (string | null)[]) => ({ kind: "row" as const, group: "timeline", caption: "Eventos do processo, por data", columns: timelineColumns, cells });
  const hasFilingEvent = events.some((e) => e.type === "filing");
  if (p.filedAt && !hasFilingEvent) {
    timeline.push({
      date: p.filedAt,
      order: 0,
      recordedAt: p.updatedAt ?? p.createdAt,
      item: {
        section: "timeline",
        content: `${day(p.filedAt)}: ajuizamento, conforme o cadastro do processo.`,
        origin: "record",
        recordSource: processSource("filed_at", "Data de ajuizamento"),
        data: row([day(p.filedAt), "Ajuizamento", null, "Cadastro do processo"]),
      },
    });
  }
  counts.movements = events.length;
  for (const e of events) {
    const datajud = e.origin === "imported" && e.externalSource === DATAJUD_SOURCE_LABEL;
    if (datajud) counts.movementsDataJud += 1;
    const source = datajud
      ? `${DATAJUD_SOURCE_LABEL}, coletado em ${day(e.createdAt)}`
      : e.origin === "imported"
        ? `Cadastro (importação${e.externalSource ? `: ${clip(e.externalSource, 60)}` : ""})`
        : "Cadastro (lançamento manual)";
    timeline.push({
      date: e.occurredAt,
      order: 1,
      recordedAt: e.createdAt,
      item: {
        section: "timeline",
        content: `${day(e.occurredAt)}: ${clip(e.title, 200)} (${source}).`,
        origin: "record",
        recordSource: {
          table: "process_events",
          field: "occurred_at, title",
          recordId: null,
          label: "Movimentações do processo (cadastro, importação e DataJud)",
          recordedAt: iso(e.createdAt),
        },
        data: row([day(e.occurredAt), clip(e.title, 200), instanceLabel(e.instance), source]),
      },
    });
  }
  const briefLabel = brief ? `análise preliminar v${brief.version}${brief.demo ? ", simulação" : ""}` : "";
  /** Sufixo das lacunas apontadas pela análise preliminar. */
  const briefGapSuffix = brief ? ` (apontado pela ${briefLabel})` : "";
  let briefDocumented = 0;
  let briefSkipped = 0;
  const timelineGaps: string[] = [];
  if (brief) {
    const briefAt = brief.generatedAt ?? brief.createdAt;
    for (const t of brief.content.timeline) {
      // Sem data no documento: a célula Data fica vazia (lacuna listada nas pendências) e o texto repete o marcador.
      const when = t.date ? day(t.date) : GAP_MARKER;
      if (t.provenance === "extracted") {
        const c = documentCitation(brief, t.citations);
        if (!c) {
          briefSkipped += 1;
          continue;
        }
        briefDocumented += 1;
        const text = c.doc.sensitive ? `Evento citado em ${SENSITIVE_TEXT}` : clip(t.description, 200);
        const docLabel = c.doc.sensitive ? "Documento de saúde" : clip(c.doc.title, 70);
        timeline.push({
          date: t.date,
          order: 2,
          recordedAt: briefAt,
          item: {
            section: "timeline",
            content: `${when}: ${text} (${docLabel}, página ${c.page}; ${briefLabel}).`,
            origin: "documented",
            documentId: c.doc.documentId,
            documentVersionId: c.doc.versionId,
            documentSha256: c.doc.sha256,
            page: c.page,
            excerpt: c.excerpt,
            data: row([t.date ? day(t.date) : null, text, null, `${docLabel}, p. ${c.page} (${briefLabel})`]),
          },
        });
      } else if (t.provenance === "reviewer") {
        const credit = reviewerCredit(brief, "timeline", t);
        timeline.push({
          date: t.date,
          order: 3,
          recordedAt: credit.at,
          item: {
            section: "timeline",
            content: `${when}: ${clip(t.description, 200)} (incluído na revisão por ${credit.who}).`,
            origin: "analysis",
            recordSource: { table: "case_briefs", field: "timeline", recordId: brief.id, label: credit.label, recordedAt: iso(credit.at) },
            data: row([t.date ? day(t.date) : null, clip(t.description, 200), null, `Revisão de ${credit.who}, ${day(credit.at)}`]),
          },
        });
      } else if (t.provenance === "missing") {
        timelineGaps.push(`${clip(t.description, 160).replace(/[.;:,\s]+$/, "")}${briefGapSuffix}`);
      }
      // `record` repete o cadastro (já lido acima); `illustrative` nunca entra como fato na linha do tempo.
    }
  }
  timeline.sort((a, b) => (a.date ?? "9999-12-31").localeCompare(b.date ?? "9999-12-31") || a.order - b.order);
  const omitted = Math.max(0, timeline.length - TIMELINE_MAX_ROWS);
  if (timeline.length === 0) {
    gap("timeline", "Movimentações e eventos do processo");
  } else {
    if (omitted > 0) {
      const firstKept = timeline[omitted].date;
      const omittedRows = timeline.slice(0, omitted);
      push({
        section: "timeline",
        content: `${plural(omitted, "evento anterior", "eventos anteriores")}${firstKept ? ` a ${day(firstKept)}` : ""} não ${omitted === 1 ? "está listado" : "estão listados"} aqui (a linha do tempo completa está na ficha do processo).`,
        origin: "record",
        recordSource: {
          table: "process_events",
          field: "occurred_at (contagem dos eventos mais antigos)",
          recordId: null,
          label: "Linha do tempo do processo, eventos mais antigos não listados",
          recordedAt: latestIso(
            omittedRows.map((t) => t.recordedAt),
            queriedAt,
          ),
          dateBasis: omittedRows.length === 1 ? "record" : "latest",
        },
      });
    }
    for (const t of timeline.slice(omitted)) push(t.item);
  }
  // Ajuizamento: a data vem do cadastro; sem ela, lacuna.
  if (!p.filedAt && !hasFilingEvent) gap("timeline", "Data de ajuizamento");
  for (const label of timelineGaps) gap("timeline", label, "brief");

  // ===== 5. Quadro de pedidos e valores ===================================
  let claimItems: ProcessClaimItem[] = [];
  let claimsRisk: Awaited<ReturnType<typeof getProcessClaims>>["risk"] = null;
  try {
    const overview = await getProcessClaims(ctx, p.id);
    claimItems = overview.claims.filter((c) => c.status !== "dismissed");
    claimsRisk = overview.risk;
  } catch (err) {
    if (!(err instanceof NotFoundError)) throw err;
  }
  const confirmedClaims = claimItems.filter((c) => c.status === "confirmed");
  counts.claims = confirmedClaims.length;
  counts.claimsAssessed = confirmedClaims.filter((c) => c.assessment).length;
  counts.claimsPending = claimItems.filter((c) => c.status === "pending_confirmation").length;

  const claimRates = await loadRatesFor(
    confirmedClaims
      .filter((c) => c.claimedAmountCents !== null && c.amountBaseDate)
      .map((c) => ({ baseDate: c.amountBaseDate as string, correctionIndex: c.correctionIndex })),
    baseDate,
  );
  if (confirmedClaims.length > 0) {
    push({
      section: "claims",
      content: "Pedidos do processo (verbas pleiteadas confirmadas) com o risco avaliado por pedido",
      origin: "record",
      recordSource: {
        table: "process_claims",
        field: "description, claimed_amount_cents, amount_base_date, correction_index; avaliações vigentes",
        recordId: confirmedClaims.length === 1 ? confirmedClaims[0].id : null,
        label: "Pedidos do processo e avaliações de risco por pedido",
        recordedAt: latestIso(
          confirmedClaims.flatMap((c) => [c.confirmedAt ?? c.createdAt, ...(c.assessment ? [c.assessment.createdAt] : [])]),
          queriedAt,
        ),
        dateBasis: confirmedClaims.length === 1 && !confirmedClaims[0].assessment ? "record" : "latest",
      },
      data: {
        kind: "table",
        columns: [
          { header: "Verba", weight: 2.15 },
          { header: "Valor pleiteado (original)", weight: 1.3, align: "right", nullLabel: "Não quantificado" },
          { header: "Valor apurado", weight: 1, align: "right", nullLabel: "Não apurado" },
          { header: "Data-base", weight: 1.15, nullLabel: GAP_MARKER },
          { header: "Índice", weight: 0.95, nullLabel: "Sem índice" },
          { header: `Valor atualizado em ${day(baseDate)}`, weight: 1.55, align: "right", nullLabel: "Não quantificado" },
          { header: "Risco", weight: 0.95, nullLabel: readValues ? "Não avaliado" : "Sem acesso" },
          { header: "%", weight: 0.62, align: "right", nullLabel: readValues ? "Não avaliado" : "Sem acesso" },
        ],
        rows: confirmedClaims.map((c) => [
          `${clip(c.description, 140)}${c.category ? `\nCategoria: ${CLAIM_CATEGORY_LABELS[c.category]}` : ""}`,
          c.claimedAmountCents !== null ? money(c.claimedAmountCents) : null,
          // O módulo de pedidos não registra valor apurado por pedido: nunca é presumido.
          null,
          c.claimedAmountCents !== null ? (c.amountBaseDate ? day(c.amountBaseDate) : null) : "Não se aplica",
          c.claimedAmountCents === null ? "Não se aplica" : c.correctionIndex ? CORRECTION_INDEX_LABELS[c.correctionIndex] : null,
          updatedValueText(c.claimedAmountCents, c.amountBaseDate, c.correctionIndex, baseDate, claimRates),
          c.assessment ? LOSS_PROBABILITY_LABELS[c.assessment.classification] : null,
          c.assessment ? formatBp(c.assessment.percentageBp) : null,
        ]),
        totals: null,
        note:
          "Valor pleiteado de cada pedido, valor apurado e valor da causa são grandezas diferentes e não são somados entre si; o valor da causa e o valor apurado do processo estão nos itens abaixo, separados. O módulo de pedidos não registra valor apurado por pedido (coluna sempre \"Não apurado\"). O valor atualizado é calculado na geração pelo índice escolhido no pedido (séries do Banco Central) e nunca gravado; meses sem taxa tornam a atualização indisponível.",
      },
    });
  } else {
    gap("claims", "Quadro de pedidos do processo (nenhum pedido confirmado)");
  }
  if (counts.claimsPending > 0) {
    const pendingClaims = claimItems.filter((c) => c.status === "pending_confirmation");
    push({
      section: "claims",
      content: `${plural(counts.claimsPending, "pedido sugerido", "pedidos sugeridos")} pela análise preliminar ${counts.claimsPending === 1 ? "aguarda" : "aguardam"} confirmação de uma pessoa e não ${counts.claimsPending === 1 ? "entra" : "entram"} no quadro nem no risco até lá.`,
      origin: "record",
      recordSource: rowsSource(
        "process_claims",
        "status = pending_confirmation",
        "Pedidos sugeridos aguardando confirmação",
        pendingClaims.map((c) => ({ id: c.id, at: c.createdAt })),
      ),
    });
  }

  // Valores do processo (mesma posição da ficha e do fechamento: `positionAt`).
  let position: ProcessPosition | null = null;
  let claimKey: string | null = null;
  let liquidatedKey: string | null = null;
  let guaranteesKey: string | null = null;
  let riskKey: string | null = null;
  let exposureKey: string | null = null;
  let riskSummary: { content: string; origin: "analysis" | "record"; recordSource: RecordSource } | null = null;
  let valuesSummary: { content: string; recordSource: RecordSource; gapRefs: string[] } | null = null;
  /** Cenários propostos pelo sistema nesta geração (gravados só na emissão). */
  let plannedScenarios: PlannedScenarioProposal[] = [];
  let proposedValuations: {
    id: string;
    kind: keyof typeof VALUATION_KIND_LABELS;
    amountCents: number;
    baseDate: string;
    source: keyof typeof VALUATION_SOURCE_LABELS;
    isEstimate: boolean;
    documentId: string | null;
    documentVersionId: string | null;
    page: number | null;
    excerpt: string | null;
    confidence: number | null;
    createdAt: Date;
  }[] = [];

  if (readValues) {
    requiredPermissions.add("contingency:read");
    const [valuations, risks, guarantees] = await Promise.all([
      db
        .select({
          id: processValuations.id,
          kind: processValuations.kind,
          amountCents: processValuations.amountCents,
          baseDate: processValuations.baseDate,
          status: processValuations.status,
          source: processValuations.source,
          isEstimate: processValuations.isEstimate,
          correctionIndex: processValuations.correctionIndex,
          documentId: processValuations.documentId,
          documentVersionId: processValuations.documentVersionId,
          page: processValuations.page,
          excerpt: processValuations.excerpt,
          confidence: processValuations.confidence,
          reviewedAt: processValuations.reviewedAt,
          createdAt: processValuations.createdAt,
        })
        .from(processValuations)
        .where(and(eq(processValuations.processId, p.id), valuationWhere(ctx)))
        .orderBy(desc(processValuations.baseDate), desc(processValuations.createdAt)),
      db
        .select({
          id: processRiskAssessments.id,
          classification: processRiskAssessments.classification,
          percentageBp: processRiskAssessments.percentageBp,
          opinion: processRiskAssessments.opinion,
          effectiveFrom: processRiskAssessments.effectiveFrom,
          status: processRiskAssessments.status,
          reviewedAt: processRiskAssessments.reviewedAt,
          createdAt: processRiskAssessments.createdAt,
          assessedByName: users.name,
        })
        .from(processRiskAssessments)
        .leftJoin(users, and(eq(users.id, processRiskAssessments.assessedById), eq(users.organizationId, orgId)))
        .where(and(eq(processRiskAssessments.processId, p.id), riskAssessmentWhere(ctx))),
      db
        .select({
          id: processGuarantees.id,
          kind: processGuarantees.kind,
          amountCents: processGuarantees.amountCents,
          status: processGuarantees.status,
          depositedAt: processGuarantees.depositedAt,
          statusChangedAt: processGuarantees.statusChangedAt,
          createdAt: processGuarantees.createdAt,
          updatedAt: processGuarantees.updatedAt,
          deletedAt: processGuarantees.deletedAt,
        })
        .from(processGuarantees)
        .where(and(eq(processGuarantees.processId, p.id), guaranteeWhere(ctx)))
        .orderBy(asc(processGuarantees.depositedAt), asc(processGuarantees.createdAt)),
    ]);
    counts.valuations = valuations.length;
    counts.valuationsOfficial = valuations.filter((v) => v.status === "official").length;
    counts.valuationsProposed = valuations.filter((v) => v.status === "proposed").length;
    counts.valuationsSuperseded = valuations.filter((v) => v.status === "superseded").length;
    counts.valuationsRejected = valuations.filter((v) => v.status === "rejected").length;
    counts.guarantees = guarantees.length;
    proposedValuations = valuations.filter((v) => v.status === "proposed");

    const history = historyOf(valuations, risks);
    position = positionAt({
      date: baseDate,
      process: {
        claimAmountCents: p.claimAmountCents,
        liquidatedAmountCents: p.liquidatedAmountCents,
        riskPercentageBp: p.riskPercentageBp,
        lossProbability: p.lossProbability,
      },
      valuations,
      risks,
      guarantees,
      params: settings.contingency.riskPercentages,
      history,
    });
    const valueRates = await loadRatesFor(
      valuations.filter((v) => v.status === "official" || v.status === "superseded"),
      baseDate,
    );

    const valueItem = (kind: "claim" | "liquidated", label: string, cents: number | null, fromHistory: boolean, field: string): string => {
      if (cents === null) return gap("claims", label);
      if (!fromHistory) {
        return push({
          section: "claims",
          content: `${label}: ${money(cents)} (valor do cadastro do processo, sem histórico de valorações; data-base e índice de atualização não registrados, por isso não é atualizado).`,
          origin: "record",
          recordSource: processSource(field, label),
        });
      }
      const inForce = valuationAt(valuations, kind, baseDate);
      const v = valuations.find((r) => r.id === inForce?.id);
      if (!v) return gap("claims", label);
      const updated =
        v.correctionIndex === "none"
          ? "não se aplica (sem atualização: índice nenhum)"
          : (updatedValueText(v.amountCents, v.baseDate, v.correctionIndex, baseDate, valueRates) ?? "não calculado");
      const indexLabel = v.correctionIndex === "none" ? "nenhum" : v.correctionIndex ? CORRECTION_INDEX_LABELS[v.correctionIndex] : "não informado";
      return push({
        section: "claims",
        content: `${label}: ${money(v.amountCents)} (valor original, data-base ${day(v.baseDate)}; índice de atualização: ${indexLabel}). Valor atualizado em ${day(baseDate)}: ${updated}.`,
        origin: "record",
        recordSource: {
          table: "process_valuations",
          field: "amount_cents, base_date, correction_index",
          recordId: v.id,
          label: v.status === "official" ? `Valoração oficial do tipo ${VALUATION_KIND_LABELS[kind].toLocaleLowerCase("pt-BR")}` : `Valoração do tipo ${VALUATION_KIND_LABELS[kind].toLocaleLowerCase("pt-BR")} vigente na data-base`,
          recordedAt: iso(v.reviewedAt ?? v.createdAt),
        },
      });
    };
    claimKey = valueItem("claim", "Valor da causa", position.claimCents, history.claim, "claim_amount_cents");
    liquidatedKey = valueItem("liquidated", "Valor apurado vigente", position.liquidatedCents, history.liquidated, "liquidated_amount_cents");
    const officialDates = valuations.filter((v) => v.status === "official").map((v) => v.reviewedAt ?? v.createdAt);
    // A síntese repete o valor; sem ele, repete a lacuna do item da seção de valores (que consta das pendências).
    const isGapItem = (key: string | null) => !!key && items.find((i) => i.key === key)?.origin === "gap";
    const claimGap = isGapItem(claimKey);
    const liquidatedGap = isGapItem(liquidatedKey);
    valuesSummary = {
      content: `Valores vigentes: valor da causa ${!claimGap && position.claimCents !== null ? money(position.claimCents) : GAP_MARKER}; valor apurado ${!liquidatedGap && position.liquidatedCents !== null ? money(position.liquidatedCents) : GAP_MARKER}. São grandezas diferentes e não são somadas.`,
      gapRefs: [claimGap ? claimKey : null, liquidatedGap ? liquidatedKey : null].filter((k): k is string => !!k),
      recordSource:
        officialDates.length === 0
          ? processSource("claim_amount_cents, liquidated_amount_cents", "Valor da causa e valor apurado")
          : {
              table: "process_valuations",
              field: "amount_cents (valor da causa e valor apurado vigentes na data-base)",
              recordId: null,
              label: "Valores do processo vigentes na data-base",
              recordedAt: latestIso(officialDates, recordedAt),
              dateBasis: "latest",
            },
    };

    // Classificação de risco vigente (para a síntese): oficial com parecer, cadastro sem histórico, ou lacuna.
    const riskInForce = riskAt(risks, baseDate);
    const riskRow = risks.find((r) => r.id === riskInForce?.id);
    const derivedNote = claimsRisk?.inForce?.link === "derived" ? ", derivada dos pedidos" : claimsRisk?.inForce?.link === "override" ? ", definida manualmente (diferente da derivada dos pedidos)" : "";
    if (history.risk && riskRow) {
      riskSummary = {
        content: `Classificação de risco vigente: ${LOSS_PROBABILITY_LABELS[riskRow.classification]} (${formatBp(riskRow.percentageBp)})${derivedNote}, desde ${day(riskRow.effectiveFrom)}${riskRow.assessedByName ? `, registrada por ${riskRow.assessedByName}` : ""}. Parecer: ${clip(riskRow.opinion, 420)}`,
        origin: "analysis",
        recordSource: {
          table: "process_risk_assessments",
          field: "classification, percentage_bp, opinion",
          recordId: riskRow.id,
          label: `Classificação de risco oficial com parecer${riskRow.assessedByName ? ` de ${riskRow.assessedByName}` : ""}`,
          recordedAt: iso(riskRow.reviewedAt ?? riskRow.createdAt),
        },
      };
    } else if (!history.risk && position.classification !== null) {
      riskSummary = {
        content: `Classificação de risco: ${LOSS_PROBABILITY_LABELS[position.classification]}${position.percentageBp !== null ? ` (${formatBp(position.percentageBp)})` : ""}, conforme o cadastro do processo (sem classificação oficial no histórico).`,
        origin: "record",
        recordSource: processSource("loss_probability", "Classificação de risco"),
      };
    }

    // ===== 6. Garantias e exposição líquida ================================
    const active = guarantees.filter((g) => !g.deletedAt);
    if (active.length > 0) {
      guaranteesKey = push({
        section: "guarantees",
        content: "Garantias registradas (depósitos, penhoras, seguros e outras)",
        origin: "record",
        recordSource: {
          table: "process_guarantees",
          field: "kind, amount_cents, deposited_at, status",
          recordId: active.length === 1 ? active[0].id : null,
          label: "Garantias do processo",
          recordedAt: latestIso(active.map((g) => g.updatedAt), queriedAt),
          dateBasis: active.length === 1 ? "record" : "latest",
        },
        data: {
          kind: "table",
          columns: [
            { header: "Tipo", weight: 1.8 },
            { header: "Valor", weight: 1.3, align: "right" },
            { header: "Data", weight: 1, nullLabel: GAP_MARKER },
            { header: "Situação", weight: 1.9 },
            { header: "Abate a exposição", weight: 1.2 },
          ],
          rows: active.map((g) => [
            GUARANTEE_KIND_LABELS[g.kind],
            money(g.amountCents),
            g.depositedAt ? day(g.depositedAt) : null,
            `${GUARANTEE_STATUS_LABELS[g.status]}${g.status !== "linked" && g.statusChangedAt ? ` em ${day(g.statusChangedAt)}` : ""}`,
            g.status === "linked" ? "Sim" : "Não",
          ]),
          totals: null,
          note: "Só garantias vinculadas abatem a exposição; as levantadas ou devolvidas aparecem para histórico e não são abatidas.",
        },
      });
    } else {
      guaranteesKey = push({
        section: "guarantees",
        content: "Garantias vinculadas ao processo: nenhuma registrada.",
        origin: "record",
        recordSource: emptyQuerySource("process_guarantees", "amount_cents", "Garantias do processo"),
      });
    }
    const breakdown = exposureBreakdown(
      {
        liquidatedCents: position.liquidatedCents,
        liquidatedBaseDate: position.liquidatedBaseDate,
        linkedGuaranteesCents: position.linkedGuaranteesCents,
        claimCents: position.claimCents,
        percentageBp: position.percentageBp,
      },
      active.map((g) => ({ id: g.id, kind: g.kind, amountCents: g.amountCents, status: g.status, depositedAt: g.depositedAt })),
    );
    const deductions = breakdown.deductions.length
      ? ` Abatido: ${breakdown.deductions.map((d) => `${GUARANTEE_KIND_LABELS[d.kind]} ${money(d.amountCents)}${d.depositedAt ? ` (${day(d.depositedAt)})` : ""}`).join("; ")}.`
      : " Nenhuma garantia vinculada a abater.";
    if (riskSummary) {
      riskKey = push({ section: "guarantees", content: riskSummary.content, origin: riskSummary.origin, recordSource: riskSummary.recordSource });
    }
    if (breakdown.net) {
      exposureKey = push({
        section: "guarantees",
        content: `Exposição líquida: ${money(breakdown.net.exposureCents)} (valor apurado vigente ${money(breakdown.net.liquidatedCents)} menos garantias vinculadas ${money(breakdown.net.guaranteesCents)}, nunca negativa).${deductions}${breakdown.net.guaranteesExceedCents > 0 ? ` As garantias superam o valor apurado em ${money(breakdown.net.guaranteesExceedCents)}; a exposição fica em zero.` : ""}`,
        origin: "inference",
        derivedFrom: [liquidatedKey, guaranteesKey].filter((k): k is string => !!k),
      });
    } else {
      exposureKey = push({
        section: "guarantees",
        content: "Exposição líquida: não calculada, porque não há valor apurado vigente (a exposição nunca usa zero no lugar de um valor ausente).",
        origin: "inference",
        derivedFrom: [liquidatedKey, guaranteesKey].filter((k): k is string => !!k),
      });
      if (breakdown.estimate) {
        push({
          section: "guarantees",
          content: `Estimado (não é valor apurado): exposição estimada de ${money(breakdown.estimate.exposureCents)}, calculada como valor da causa ${money(breakdown.estimate.claimCents)} vezes ${formatBp(breakdown.estimate.percentageBp)} da classificação vigente (${money(breakdown.estimate.weightedCents)}), menos garantias vinculadas ${money(breakdown.estimate.guaranteesCents)}.`,
          origin: "inference",
          derivedFrom: [claimKey, riskKey, guaranteesKey].filter((k): k is string => !!k),
        });
      } else if (breakdown.estimateMissing) {
        const missing = [breakdown.estimateMissing.claim ? "valor da causa" : null, breakdown.estimateMissing.classification ? "classificação de risco" : null]
          .filter(Boolean)
          .join(" e ");
        push({
          section: "guarantees",
          content: `Exposição estimada: não calculada (falta ${missing}).`,
          origin: "inference",
          derivedFrom: [claimKey, guaranteesKey].filter((k): k is string => !!k),
        });
      }
    }
    if (!riskSummary) gap("guarantees", "Classificação de risco vigente");
  } else {
    gap("claims", "Valor da causa e valor apurado (perfil de quem gerou sem acesso a valores)");
    gap("guarantees", "Garantias e exposição líquida (perfil de quem gerou sem acesso a valores)");
  }

  // ===== 7. Matriz de cenários =============================================
  if (readValues) {
    const loadScenarios = () =>
      db
        .select({
          id: processScenarios.id,
          description: processScenarios.description,
          band: processScenarios.probabilityBand,
          min: processScenarios.percentMin,
          max: processScenarios.percentMax,
          comment: processScenarios.comment,
          origin: processScenarios.origin,
          createdAt: processScenarios.createdAt,
          authorName: users.name,
        })
        .from(processScenarios)
        .leftJoin(users, and(eq(users.id, processScenarios.authorId), eq(users.organizationId, orgId)))
        .where(and(eq(processScenarios.processId, p.id), eq(processScenarios.organizationId, orgId)))
        .orderBy(asc(processScenarios.createdAt), asc(processScenarios.id));
    let scenarios: Awaited<ReturnType<typeof loadScenarios>> = await loadScenarios();
    if (scenarios.length === 0) {
      const sources: ScenarioProposalSource[] = confirmedClaims
        .filter((c) => c.assessment)
        .map((c) => ({
          claimId: c.id,
          description: c.description,
          classification: c.assessment!.classification,
          percentageBp: c.assessment!.percentageBp,
          effectiveFrom: c.assessment!.effectiveFrom,
          assessedByName: c.assessment!.assessedByName,
        }));
      // Proposta do sistema: só planejada aqui; gravada na emissão (onIssue), na transação do relatório.
      plannedScenarios = planScenarioProposals(sources, settings.legalReports.bands);
      counts.scenariosProposed = plannedScenarios.length;
      scenarios = plannedScenarios.map((s) => ({
        id: s.id,
        description: s.description,
        band: s.probabilityBand,
        min: s.percentMin,
        max: s.percentMax,
        comment: s.comment,
        origin: "system" as const,
        createdAt: s.createdAt,
        authorName: null,
      }));
    }
    counts.scenarios = scenarios.length;
    if (scenarios.length > 0) {
      push({
        section: "scenarios",
        content: "Cenários registrados para o processo (registros datados, nunca sobrescritos)",
        origin: "analysis",
        recordSource: {
          table: "process_scenarios",
          field: "description, probability_band, percent_min, percent_max, comment, origin",
          recordId: scenarios.length === 1 ? scenarios[0].id : null,
          label: "Cenários do processo",
          recordedAt: latestIso(scenarios.map((s) => s.createdAt), queriedAt),
          dateBasis: scenarios.length === 1 ? "record" : "latest",
        },
        data: {
          kind: "table",
          columns: [
            { header: "Cenário", weight: 2.6 },
            { header: "Probabilidade", weight: 1.1 },
            { header: "Intervalo", weight: 0.95, align: "right" },
            { header: "Comentário", weight: 2.6, nullLabel: "Sem comentário" },
            { header: "Origem", weight: 1.7 },
          ],
          rows: scenarios.map((s) => [
            clip(s.description, 200),
            PROBABILITY_BAND_LABELS[s.band],
            `${s.min}% a ${s.max}%`,
            s.comment ? clip(s.comment, 260) : null,
            s.origin === "system"
              ? `Proposta do sistema, sujeita a revisão (${day(s.createdAt)})`
              : `Registrado por ${s.authorName ?? "pessoa identificada"} em ${day(s.createdAt)}`,
          ]),
          totals: null,
          note: `Faixas configuradas: ${(["very_high", "high", "moderate", "low", "very_low"] as const)
            .map((b) => `${PROBABILITY_BAND_LABELS[b]} ${settings.legalReports.bands[b].min}% a ${settings.legalReports.bands[b].max}%`)
            .join("; ")}. Propostas do sistema saem da avaliação de risco de cada pedido (percentual do pedido na faixa configurada) e valem só depois de revisadas por uma pessoa.`,
        },
      });
    } else {
      gap("scenarios", "Cenários do processo (nenhum cenário registrado e nenhum pedido avaliado para a proposta automática)");
    }
  } else {
    gap("scenarios", "Cenários do processo (perfil de quem gerou sem acesso a valores)");
  }

  // ===== 8. Pontos de atenção e próximos atos ============================
  const [openDeadlines, scheduledHearings, openAlerts] = await Promise.all([
    can(ctx, "deadline:read")
      ? db
          .select({
            id: deadlines.id,
            title: deadlines.title,
            kind: deadlines.kind,
            dueDate: deadlines.dueDate,
            validationStatus: deadlines.validationStatus,
            createdAt: deadlines.createdAt,
            updatedAt: deadlines.updatedAt,
          })
          .from(deadlines)
          .where(
            and(
              deadlineWhere(ctx),
              eq(deadlines.processId, p.id),
              eq(deadlines.status, "open"),
              // Prazos sugeridos aguardando validação e rejeitados não são prazos reais.
              inArray(deadlines.validationStatus, ["not_required", "validated"]),
            ),
          )
          .orderBy(asc(deadlines.dueDate), asc(deadlines.createdAt))
      : Promise.resolve(null),
    db
      .select({
        id: hearings.id,
        kind: hearings.kind,
        mode: hearings.mode,
        scheduledAt: hearings.scheduledAt,
        updatedAt: hearings.updatedAt,
      })
      .from(hearings)
      .where(and(hearingWhere(ctx), eq(hearings.processId, p.id), eq(hearings.status, "scheduled")))
      .orderBy(asc(hearings.scheduledAt)),
    db
      .select({ id: alerts.id, type: alerts.type, severity: alerts.severity, title: alerts.title, createdAt: alerts.createdAt })
      .from(alerts)
      .where(
        and(
          visibleAlertsWhere(ctx, ["legal_process"]),
          eq(alerts.entityType, "legal_process"),
          eq(alerts.entityId, p.id),
          isNull(alerts.resolvedAt),
        ),
      )
      .orderBy(desc(alerts.createdAt))
      .limit(ATTENTION_TABLE_MAX),
  ]);
  if (openDeadlines) requiredPermissions.add("deadline:read");
  const upcomingHearings = scheduledHearings.filter((h) => formatIsoDay(h.scheduledAt) >= baseDate);
  const hearingsWithoutOutcome = scheduledHearings.filter((h) => formatIsoDay(h.scheduledAt) < baseDate);

  // Próximo ato: prazo vencido primeiro; senão o mais próximo entre prazo e audiência.
  type NextAct = { content: string; source: RecordSource };
  let nextAct: NextAct | null = null;
  const firstDeadline = openDeadlines?.[0] ?? null;
  const firstHearing = upcomingHearings[0] ?? null;
  const deadlineAct = (d: NonNullable<typeof firstDeadline>): NextAct => {
    const days = daysUntil(d.dueDate, baseDate);
    const when = days < 0 ? `vencido há ${plural(-days, "dia", "dias")}` : days === 0 ? "vence hoje" : `em ${plural(days, "dia", "dias")}`;
    return {
      content: `Próximo ato: prazo "${clip(d.title, 120)}" (${DEADLINE_KIND_LABELS[d.kind].toLocaleLowerCase("pt-BR")}) em ${day(d.dueDate)}, ${when}.`,
      source: { table: "deadlines", field: "due_date, title", recordId: d.id, label: "Prazos do processo", recordedAt: iso(d.updatedAt ?? d.createdAt) },
    };
  };
  const hearingAct = (h: NonNullable<typeof firstHearing>): NextAct => ({
    content: `Próximo ato: ${HEARING_KIND_LABELS[h.kind].toLocaleLowerCase("pt-BR")} (${HEARING_MODE_LABELS[h.mode].toLocaleLowerCase("pt-BR")}) designada para ${formatDateTime(h.scheduledAt, GAP_MARKER)}.`,
    source: { table: "hearings", field: "scheduled_at, kind", recordId: h.id, label: "Audiência designada", recordedAt: iso(h.updatedAt) },
  });
  if (firstDeadline && (firstDeadline.dueDate < baseDate || !firstHearing || firstDeadline.dueDate < formatIsoDay(firstHearing.scheduledAt))) {
    nextAct = deadlineAct(firstDeadline);
  } else if (firstHearing) {
    nextAct = hearingAct(firstHearing);
  } else if (firstDeadline) {
    nextAct = deadlineAct(firstDeadline);
  }
  if (nextAct) push({ section: "attention", content: nextAct.content, origin: "record", recordSource: nextAct.source });
  else gap("attention", "Próximo ato processual registrado (prazo ou audiência)");

  if (openDeadlines) {
    if (openDeadlines.length > 0) {
      const shown = openDeadlines.slice(0, ATTENTION_TABLE_MAX);
      push({
        section: "attention",
        content: "Prazos em aberto (cadastrados ou validados; sugestões aguardando validação não contam)",
        origin: "record",
        recordSource: {
          table: "deadlines",
          field: "due_date, title, kind, validation_status",
          recordId: shown.length === 1 ? shown[0].id : null,
          label: "Prazos do processo",
          recordedAt: latestIso(shown.map((d) => d.updatedAt ?? d.createdAt), queriedAt),
          dateBasis: shown.length === 1 ? "record" : "latest",
        },
        data: {
          kind: "table",
          columns: [
            { header: "Vencimento", weight: 1 },
            { header: "Prazo", weight: 3.4 },
            { header: "Tipo", weight: 1.1 },
            { header: "Situação", weight: 1.4 },
          ],
          rows: shown.map((d) => {
            const days = daysUntil(d.dueDate, baseDate);
            return [
              day(d.dueDate),
              clip(d.title, 160),
              DEADLINE_KIND_LABELS[d.kind],
              days < 0 ? `Vencido há ${plural(-days, "dia", "dias")}` : days === 0 ? "Vence hoje" : `Em ${plural(days, "dia", "dias")}`,
            ];
          }),
          totals: null,
          note: openDeadlines.length > shown.length ? `Mostrando ${shown.length} de ${openDeadlines.length} prazos em aberto.` : null,
        },
      });
    } else {
      push({
        section: "attention",
        content: "Prazos em aberto: nenhum registrado (prazos cadastrados ou validados).",
        origin: "record",
        recordSource: emptyQuerySource("deadlines", "status = open", "Prazos do processo"),
      });
    }
  } else {
    gap("attention", "Prazos do processo (perfil de quem gerou sem acesso a prazos)");
  }

  if (upcomingHearings.length > 0) {
    push({
      section: "attention",
      content: "Audiências designadas",
      origin: "record",
      recordSource: {
        table: "hearings",
        field: "scheduled_at, kind, mode, status = scheduled",
        recordId: upcomingHearings.length === 1 ? upcomingHearings[0].id : null,
        label: "Audiências do processo",
        recordedAt: latestIso(upcomingHearings.map((h) => h.updatedAt), queriedAt),
        dateBasis: upcomingHearings.length === 1 ? "record" : "latest",
      },
      data: {
        kind: "table",
        columns: [
          { header: "Data e hora", weight: 1.5 },
          { header: "Audiência", weight: 2.4 },
          { header: "Modalidade", weight: 1.3 },
        ],
        rows: upcomingHearings.slice(0, ATTENTION_TABLE_MAX).map((h) => [formatDateTime(h.scheduledAt, GAP_MARKER), HEARING_KIND_LABELS[h.kind], HEARING_MODE_LABELS[h.mode]]),
        totals: null,
        note: null,
      },
    });
  } else {
    push({
      section: "attention",
      content: "Audiências designadas: nenhuma registrada.",
      origin: "record",
      recordSource: emptyQuerySource("hearings", "status = scheduled", "Audiências do processo"),
    });
  }

  // Valores aguardando conferência: com trecho de documento visível, o item é Documentado (e a confiança decide se é afirmado).
  if (hearingsWithoutOutcome.length > 0) {
    push({
      section: "attention",
      content: `${plural(hearingsWithoutOutcome.length, "audiência designada", "audiências designadas")} para data já passada sem desfecho registrado (a mais antiga em ${formatDateTime(hearingsWithoutOutcome[0].scheduledAt, GAP_MARKER)}).`,
      origin: "record",
      recordSource: {
        table: "hearings",
        field: "scheduled_at, status = scheduled",
        recordId: hearingsWithoutOutcome.length === 1 ? hearingsWithoutOutcome[0].id : null,
        label: "Audiências do processo sem desfecho registrado",
        recordedAt: latestIso(hearingsWithoutOutcome.map((h) => h.updatedAt), queriedAt),
        dateBasis: hearingsWithoutOutcome.length === 1 ? "record" : "latest",
      },
    });
  }

  if (readValues && proposedValuations.length > 0) {
    const docVersionIds = [
      ...new Set(
        proposedValuations
          .filter((v) => v.documentId && v.documentVersionId && v.page && v.excerpt && v.excerpt.trim().length >= 12)
          .map((v) => v.documentVersionId as string),
      ),
    ];
    const hashRows =
      docVersionIds.length && can(ctx, "document:read")
        ? await db
            .select({ id: documentVersions.id, sha256: documentVersions.sha256, category: documents.category })
            .from(documentVersions)
            .innerJoin(documents, eq(documents.id, documentVersions.documentId))
            .where(and(inArray(documentVersions.id, docVersionIds), documentWhere(ctx)))
        : [];
    const hashOf = new Map(hashRows.map((h) => [h.id, h]));
    const plain: typeof proposedValuations = [];
    for (const v of proposedValuations) {
      const h = v.documentVersionId ? hashOf.get(v.documentVersionId) : undefined;
      const label = `${VALUATION_KIND_LABELS[v.kind]} de ${money(v.amountCents)} (data-base ${day(v.baseDate)})`;
      // Trecho com CPF ou CNPJ não é citado (minimização): o valor entra na tabela, sem o trecho.
      if (h && v.documentId && v.page && v.excerpt && !containsPersonalId(v.excerpt)) {
        push({
          section: "attention",
          content: `Valor aguardando conferência humana: ${label}, lido em documento${v.source === "simulation" ? " pela extração simulada (demonstração)" : ""}${h.category === SENSITIVE_CATEGORY ? `; ${SENSITIVE_TEXT}` : ""}. Não é valor oficial até a conferência.`,
          origin: "documented",
          documentId: v.documentId,
          documentVersionId: v.documentVersionId,
          documentSha256: h.sha256,
          page: v.page,
          excerpt: v.excerpt,
          confidence: v.confidence,
        });
      } else {
        plain.push(v);
      }
    }
    if (plain.length > 0) {
      push({
        section: "attention",
        content: "Valores aguardando conferência humana (não são valores oficiais; cada valor aparece separado, nunca somado)",
        origin: "record",
        recordSource: {
          table: "process_valuations",
          field: "status = proposed",
          recordId: plain.length === 1 ? plain[0].id : null,
          label: "Valores propostos do processo",
          recordedAt: latestIso(plain.map((v) => v.createdAt), queriedAt),
          dateBasis: plain.length === 1 ? "record" : "latest",
        },
        data: {
          kind: "table",
          columns: [
            { header: "Tipo", weight: 1.8 },
            { header: "Valor", weight: 1.3, align: "right" },
            { header: "Data-base", weight: 1 },
            { header: "Origem do valor", weight: 2.2 },
          ],
          rows: plain.slice(0, ATTENTION_TABLE_MAX).map((v) => [
            `${VALUATION_KIND_LABELS[v.kind]}${v.isEstimate ? " (estimativa)" : ""}`,
            money(v.amountCents),
            day(v.baseDate),
            VALUATION_SOURCE_LABELS[v.source],
          ]),
          totals: null,
          note: null,
        },
      });
    }
  }
  if (p.needsVerification) {
    push({
      section: "attention",
      content: `Processo pendente de conferência${p.verificationNote ? `: ${clip(p.verificationNote, 300)}` : "."}`,
      origin: "record",
      recordSource: processSource("needs_verification, verification_note", "Pendente de conferência"),
    });
  }
  if (openAlerts.length > 0) {
    push({
      section: "attention",
      content: "Alertas abertos do processo",
      origin: "record",
      recordSource: {
        table: "alerts",
        field: "type, title, severity, resolved_at is null",
        recordId: openAlerts.length === 1 ? openAlerts[0].id : null,
        label: "Alertas do processo",
        recordedAt: latestIso(openAlerts.map((a) => a.createdAt), queriedAt),
        dateBasis: openAlerts.length === 1 ? "record" : "latest",
      },
      data: {
        kind: "table",
        columns: [
          { header: "Alerta", weight: 3.6 },
          { header: "Tipo", weight: 2.4 },
          { header: "Severidade", weight: 1 },
          { header: "Desde", weight: 1 },
        ],
        rows: openAlerts.map((a) => [clip(a.title, 160), ALERT_TYPE_LABELS[a.type], ALERT_SEVERITY_LABELS[a.severity], day(a.createdAt)]),
        totals: null,
        note: null,
      },
    });
  }

  // Número do processo: o dígito verificador (padrão CNJ) é conferido na geração, a partir do cadastro.
  if (normalizeCnj(p.number) && !isValidCnj(p.number)) {
    push({
      section: "attention",
      content: "O número do processo no cadastro não passa na validação do dígito verificador (padrão CNJ): conferir o número nos autos.",
      origin: "record",
      recordSource: processSource("number", "Número (dígito verificador conferido na geração)"),
    });
  }

  // Análise preliminar: urgências e possíveis prazos (extraídos), próximos passos ilustrativos (simulação) e lacunas.
  let briefGapCount = 0;
  let briefRecordGaps = 0;
  if (brief) {
    const briefItem = (
      section: "attention",
      text: string,
      source: BriefItemLike & { provenance: string; citations: readonly BriefCitation[] },
      prefix: string,
      sourceField: string,
    ): boolean => {
      const provenance = source.provenance;
      if (provenance === "extracted") {
        const c = documentCitation(brief, source.citations);
        if (!c) return false;
        const body = c.doc.sensitive ? `item citado em ${SENSITIVE_TEXT}` : clip(text, 400);
        push({
          section,
          content: `${prefix}: ${body} (${briefLabel}; trecho conferido no documento).`,
          origin: "documented",
          documentId: c.doc.documentId,
          documentVersionId: c.doc.versionId,
          documentSha256: c.doc.sha256,
          page: c.page,
          excerpt: c.excerpt,
        });
        briefDocumented += 1;
        return true;
      }
      if (provenance === "reviewer") {
        const credit = reviewerCredit(brief, sourceField, source);
        push({
          section,
          content: `${prefix}: ${clip(text, 400)} (incluído na revisão da análise preliminar por ${credit.who}).`,
          origin: "analysis",
          recordSource: { table: "case_briefs", field: sourceField, recordId: brief.id, label: credit.label, recordedAt: iso(credit.at) },
        });
        return true;
      }
      if (provenance === "record") {
        push({
          section,
          content: `${prefix}: ${clip(text, 400)} (dado do cadastro lido pela análise preliminar).`,
          origin: "record",
          recordSource: {
            table: "case_briefs",
            field: sourceField,
            recordId: brief.id,
            label: `Análise preliminar versão ${brief.version}${brief.demo ? " (simulação)" : ""}, dado do cadastro do processo lido na geração`,
            recordedAt: iso(brief.generatedAt ?? brief.createdAt),
          },
        });
        return true;
      }
      if (provenance === "illustrative") {
        push({
          section,
          content: `Simulação (análise preliminar simulada; não é fato do processo nem orientação). ${prefix}: ${clip(text, 400)}`,
          origin: "analysis",
          simulated: true,
          recordSource: {
            table: "case_briefs",
            field: sourceField,
            recordId: brief.id,
            label: `Análise preliminar versão ${brief.version} (simulação), item ilustrativo`,
            recordedAt: iso(brief.generatedAt ?? brief.createdAt),
          },
        });
        return true;
      }
      return false;
    };
    let n = 0;
    for (const u of brief.content.urgencies) {
      if (n >= BRIEF_ATTENTION_MAX) break;
      if (briefItem("attention", u.text, u, "Urgência apontada", "urgencies")) n += 1;
    }
    n = 0;
    // Só datas a partir da data-base: um "possível prazo" já passado não é ponto de atenção.
    for (const d of brief.content.possibleDeadlines) {
      if (n >= BRIEF_ATTENTION_MAX || !d.date || d.date < baseDate) continue;
      if (d.provenance !== "extracted" && d.provenance !== "reviewer") continue;
      if (
        briefItem(
          "attention",
          `${d.description} (${day(d.date)}; possível prazo a conferir, não é prazo cadastrado nem contado pelo sistema)`,
          d,
          "Possível prazo",
          "possibleDeadlines",
        )
      )
        n += 1;
    }
    n = 0;
    for (const s of brief.content.nextSteps) {
      if (n >= BRIEF_ATTENTION_MAX) break;
      if (briefItem("attention", s.description, s, "Próximo passo", "nextSteps")) n += 1;
    }

    // Lacunas da análise (proveniência "lacuna" em qualquer seção, e lacunas incluídas pelo revisor): todas viram
    // Lacuna. As que citam o cadastro (REG) não são repetidas: o cadastro é lido diretamente na data-base e as
    // lacunas atuais dele estão marcadas nos itens (repetir a da análise poderia contradizer um cadastro já corrigido).
    const seen = new Set<string>();
    const briefGap = (label: string, kind: GapKind) => {
      const dedupe = label.toLocaleLowerCase("pt-BR");
      if (seen.has(dedupe)) return;
      seen.add(dedupe);
      gap("attention", label, kind);
      briefGapCount += 1;
    };
    for (const m of brief.content.missingDocuments) {
      if (m.provenance !== "missing") continue;
      if (m.citations.some((c) => c.ref === "REG")) {
        briefRecordGaps += 1;
        continue;
      }
      const name = clip(m.text.split(":")[0] ?? m.text, 90).replace(/[.;:,\s]+$/, "");
      briefGap(`Documento indicado como faltante: ${name}${briefGapSuffix}`, "brief_doc");
    }
    const sections = brief.content as unknown as Record<string, unknown>;
    for (const section of CASE_BRIEF_SECTIONS) {
      if (section.key === "timeline" || section.key === "missingDocuments") continue;
      const list = sections[section.key];
      if (!Array.isArray(list)) continue;
      for (const raw of list as unknown[]) {
        if (!raw || typeof raw !== "object") continue;
        const it = raw as BriefItemLike & { citations?: BriefCitation[]; note?: string | null };
        const byReviewer = section.key === "gaps" && it.provenance === "reviewer";
        if (it.provenance !== "missing" && !byReviewer) continue;
        if ((it.citations ?? []).some((c) => c.ref === "REG")) {
          briefRecordGaps += 1;
          continue;
        }
        const text = briefMissingText(section.key, it);
        if (!text) continue;
        const where = section.key === "gaps" ? "" : `${section.label}: `;
        const suffix = byReviewer ? ` (incluído na revisão da ${briefLabel})` : briefGapSuffix;
        briefGap(`${where}${clip(text, 220)}${suffix}`, "brief");
      }
    }
  }

  // ===== 3. Síntese executiva (3 a 6 pontos) =============================
  // Instância atual, tribunal e órgão julgador: da linha da instância atual (os campos do cadastro do processo
  // guardam os da origem, preenchidos pela consulta ao DataJud); sem instâncias registradas, do cadastro.
  const instValue = currentInstance ? PROCESS_INSTANCE_LABELS[currentInstance.instance] : instanceLabel(p.instance);
  const instWhere = currentInstance
    ? clean([currentInstance.court, currentInstance.courtDivision].filter(Boolean).join(", "))
    : sortedInstances.length === 0
      ? clean([p.court, p.courtDivision].filter(Boolean).join(", "))
      : "";
  push({
    section: "synthesis",
    content: `Fase e instância: processo na fase de ${phaseLabel ?? GAP_MARKER}, instância atual ${instValue ?? GAP_MARKER}${instWhere ? ` (${instWhere})` : ""}.`,
    origin: "record",
    recordSource: currentInstance
      ? {
          table: "process_instances",
          field: "instance, court, court_division (instância atual); legal_processes.phase",
          recordId: currentInstance.id,
          label: "Instância atual com tribunal e órgão julgador (instâncias do processo) e fase (cadastro do processo)",
          recordedAt: latestIso([currentInstance.updatedAt, p.updatedAt ?? p.createdAt], recordedAt),
          dateBasis: "latest",
        }
      : processSource("phase, instance, court, court_division", "Fase, instância e tribunal"),
    gapRefs: [phaseLabel ? null : phaseGapKey, instValue ? null : instanceGapKey].filter((k): k is string => !!k),
  });
  if (valuesSummary) {
    push({
      section: "synthesis",
      content: valuesSummary.content,
      origin: "record",
      recordSource: valuesSummary.recordSource,
      gapRefs: valuesSummary.gapRefs,
    });
  } else {
    gap("synthesis", "Valores vigentes do processo (perfil de quem gerou sem acesso a valores)");
  }
  if (exposureKey && position) {
    const e = position.exposure;
    push({
      section: "synthesis",
      content:
        e.basis === "liquidated" && e.exposureCents !== null
          ? `Exposição líquida de ${money(e.exposureCents)}: valor apurado vigente menos garantias vinculadas (detalhe na seção 6).`
          : "Exposição líquida não calculada: não há valor apurado vigente (a estimativa, quando houver, aparece separada na seção 6, rotulada como estimada).",
      origin: "inference",
      derivedFrom: [exposureKey],
    });
  }
  if (riskSummary) {
    push({ section: "synthesis", content: riskSummary.content.replace(/\. Parecer: .*$/, " (parecer na seção 6)."), origin: riskSummary.origin, recordSource: riskSummary.recordSource });
  } else if (readValues) {
    gap("synthesis", "Classificação de risco vigente");
  }
  if (nextAct) push({ section: "synthesis", content: nextAct.content, origin: "record", recordSource: nextAct.source });
  else gap("synthesis", "Próximo ato processual registrado");
  // Ponto das lacunas (só cabe se ainda houver espaço: máximo de 6 pontos). É uma inferência que resume os
  // itens de lacuna (do cadastro e da análise preliminar), com a referência a cada um deles.
  const synthesisCount = items.filter((i) => i.section === "synthesis").length;
  const recordGaps: typeof gapList = [];
  for (const g of gapList) {
    if (g.kind !== "record" || /perfil de quem gerou/.test(g.label) || recordGaps.some((r) => r.label === g.label)) continue;
    if (recordGaps.length < 4) recordGaps.push(g);
  }
  const docGaps = gapList.filter((g) => g.kind === "brief_doc");
  const otherBriefGaps = gapList.filter((g) => g.kind === "brief");
  const mainGaps = recordGaps.map((g) => {
    const short = g.label.replace(/\s*\(.*\)$/, "");
    return short.charAt(0).toLocaleLowerCase("pt-BR") + short.slice(1);
  });
  if (docGaps.length > 0) {
    mainGaps.push(`${plural(docGaps.length, "documento apontado", "documentos apontados")} como ${docGaps.length === 1 ? "faltante" : "faltantes"} pela análise preliminar`);
  }
  if (otherBriefGaps.length > 0) {
    mainGaps.push(
      `${plural(otherBriefGaps.length, "outra informação apontada", "outras informações apontadas")} como não ${otherBriefGaps.length === 1 ? "localizada" : "localizadas"} pela análise preliminar`,
    );
  }
  if (synthesisCount < 6 && mainGaps.length > 0) {
    push({
      section: "synthesis",
      content: `Principais dados não localizados: ${mainGaps.join("; ")} (lista completa na seção 10).`,
      origin: "inference",
      derivedFrom: [...recordGaps, ...docGaps, ...otherBriefGaps].map((g) => g.key),
      summarizesGaps: true,
    });
  }

  // ===== 2. Nota metodológica (gerada dos dados) ===========================
  // Mesma regra da lista "Dados não localizados" das pendências (itens de lacuna e células vazias de colunas de lacuna).
  const gapCount = items.reduce((total, i) => total + itemGapLabels(i).length, 0);
  const methodology = [
    `Relatório gerado em ${day(baseDate)} (data-base) a partir da base do Praetor para o processo ${p.number}. Base examinada: ${documentsSummary(counts)}, ${valuationsSummary(counts)}, ${plural(counts.claims, "pedido confirmado", "pedidos confirmados")} (${counts.claimsAssessed} com avaliação de risco vigente), ${plural(counts.guarantees, "garantia registrada", "garantias registradas")}, ${plural(counts.movements, "movimentação", "movimentações")} (${counts.movementsDataJud} coletadas do DataJud) e ${plural(counts.scenarios, "cenário", "cenários")}${counts.scenariosProposed ? ` (${counts.scenariosProposed} ${counts.scenariosProposed === 1 ? "proposto" : "propostos"} pelo sistema nesta geração, a partir das avaliações dos pedidos, e ${counts.scenariosProposed === 1 ? "registrado" : "registrados"} na emissão deste relatório)` : ""}.`,
    brief
      ? `Análise preliminar usada: versão ${brief.version} (${brief.approvedAt ? `aprovada${brief.approvedByName ? ` por ${brief.approvedByName}` : ""} em ${day(brief.approvedAt)}` : `${CASE_BRIEF_STATUS_LABELS[brief.status].toLocaleLowerCase("pt-BR")}, ainda não aprovada`})${brief.demo ? ", gerada por simulação nesta versão do sistema" : ""}. Itens extraídos de documentos entram como Documentado só com trecho literal conferido na página (${plural(briefDocumented, "item", "itens")}; ${plural(briefSkipped, "item sem citação utilizável foi deixado", "itens sem citação utilizável foram deixados")} de fora); itens de cadastro da análise entram como Cadastro, com a data da geração da análise, e na linha do tempo não são repetidos (o cadastro e as movimentações são lidos diretamente da base); itens ilustrativos aparecem só nas seções 3 e 8, marcados como Simulação, nunca como fato; itens incluídos pelo revisor aparecem como Análise, com o autor e a data da revisão que os incluiu. Lacunas apontadas pela análise: ${plural(briefGapCount + timelineGaps.length, "entra", "entram")} como Lacuna (seções 4 e 8)${briefRecordGaps ? `; ${plural(briefRecordGaps, "lacuna sobre o cadastro não é repetida", "lacunas sobre o cadastro não são repetidas")}, porque o cadastro é lido diretamente na data-base e as lacunas atuais dele estão marcadas nos itens` : ""}.`
      : "Não há análise preliminar com conteúdo disponível para quem gerou este relatório; nenhum item vem dela.",
    `Lacunas: ${plural(gapCount, "dado não localizado", "dados não localizados")} (itens de lacuna e células de tabela sem o dado), cada um marcado como ${GAP_MARKER} onde aparece e listado uma vez na seção 10, com o item correspondente; a síntese pode repetir o marcador de um dado já listado. Nenhuma lacuna é preenchida por presunção. Conferência das fontes: na emissão, cada trecho citado é procurado na página indicada do documento, com o hash da versão lida; dados de cadastro são lidos diretamente da base na geração e datados.`,
    "Minimização de dados: o relatório não traz CPF nem CNPJ. As partes aparecem pelo nome e polo; números de CPF ou CNPJ em textos livres (títulos, notas, textos da análise preliminar) são substituídos por [CPF omitido] ou [CNPJ omitido], e trecho de documento que contenha esses números não é citado. Documentos de saúde (atestado, laudo, CAT) são apenas referenciados, sem transcrição. O relatório só aparece para perfis que podem ver todo o conteúdo que ele traz: os documentos citados e, conforme o caso, a análise preliminar, os prazos e os valores.",
    "Valores atualizados são calculados na geração pelo índice escolhido para cada valor (séries mensais do Banco Central) e nunca gravados; meses sem taxa tornam a atualização indisponível, sem estimativa. Valor da causa, valor apurado e valor pleiteado por pedido são grandezas diferentes e aparecem separados, sem soma entre eles.",
  ];
  if (brief?.demo) methodology.push(`Aviso da análise preliminar: ${CASE_BRIEF_DEMO_NOTICE}`);

  const planned = plannedScenarios;
  return {
    type: "process_report",
    title: PROCESS_REPORT_TITLE,
    subtitle: clip(`Processo ${p.number} · ${p.title}`, 180),
    scope: { processId: p.id },
    scopeLabel: `Processo ${p.number}`,
    baseDate,
    isSample: false,
    generator: PROCESS_REPORT_GENERATOR,
    generatorVersion: PROCESS_REPORT_VERSION,
    sections: PROCESS_REPORT_SECTIONS.map((s) => ({ ...s })),
    methodology,
    items,
    layout: "process_report",
    purpose: PROCESS_REPORT_PURPOSE,
    // Os cenários propostos entram como já gravados: a emissão os grava com estes ids.
    dataFingerprint: await processReportFingerprint(orgId, p.id, db, { plannedScenarioIds: planned.map((s) => s.id) }),
    requiredPermissions: [...requiredPermissions],
    onIssue: planned.length
      ? (tx, issuer, issued) => insertScenarioProposals(tx, issuer, p.id, planned, { reportReference: issued.reference })
      : undefined,
  };
}

/** Texto de um item "lacuna" da análise preliminar (rótulo e nota do campo, ou o texto do item). */
function briefMissingText(section: string, item: BriefItemLike & { note?: string | null }): string | null {
  const strip = (t: string) => t.replace(/\s+/g, " ").trim().replace(/[.;:,\s]+$/, "");
  if (section === "identification" || section === "amounts") {
    if (!item.label) return null;
    const note = item.note ? strip(item.note) : "";
    return note ? `${strip(item.label)}: ${note.charAt(0).toLocaleLowerCase("pt-BR")}${note.slice(1)}` : `${strip(item.label)}: não localizado`;
  }
  const text = item.text ?? item.description ?? null;
  return text ? strip(text) : null;
}

/** "6 documentos vinculados (5 examinados com texto extraído; não examinado: 1 sensível, apenas referenciado)". */
function documentsSummary(c: ProcessReportCounts): string {
  const notExamined = [
    c.documentsWithoutText ? `${c.documentsWithoutText} sem texto extraído` : null,
    c.documentsUnsupported ? `${c.documentsUnsupported} em formato sem extração de texto` : null,
    c.documentsSensitive ? plural(c.documentsSensitive, "sensível, apenas referenciado", "sensíveis, apenas referenciados") : null,
  ].filter(Boolean);
  const examined = `${plural(c.documentsExamined, "examinado", "examinados")} com texto extraído`;
  return `${plural(c.documents, "documento vinculado", "documentos vinculados")} (${examined}${notExamined.length ? `; não ${c.documents - c.documentsExamined === 1 ? "examinado" : "examinados"}: ${notExamined.join(", ")}` : ""})`;
}

/** "5 valorações (2 oficiais, 1 substituída no histórico e 2 aguardando conferência)". */
function valuationsSummary(c: ProcessReportCounts): string {
  const parts = [
    `${c.valuationsOfficial} ${c.valuationsOfficial === 1 ? "oficial" : "oficiais"}`,
    c.valuationsSuperseded ? `${c.valuationsSuperseded} ${c.valuationsSuperseded === 1 ? "substituída" : "substituídas"} no histórico` : null,
    c.valuationsProposed ? `${c.valuationsProposed} aguardando conferência` : null,
    c.valuationsRejected ? `${c.valuationsRejected} ${c.valuationsRejected === 1 ? "rejeitada" : "rejeitadas"}` : null,
  ].filter((v): v is string => !!v);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} e ${parts[parts.length - 1]}` : parts[0];
  return `${plural(c.valuations, "valoração", "valorações")} (${list})`;
}

/** Dia (YYYY-MM-DD) de um instante no fuso da aplicação. */
function formatIsoDay(d: Date): string {
  return todayISO(d);
}
