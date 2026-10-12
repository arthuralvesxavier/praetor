import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  CASE_BRIEF_STATUS_LABELS,
  CORRECTION_INDEX_LABELS,
  LOSS_PROBABILITY_LABELS,
  PROBABILITY_BAND_LABELS,
  PROBABILITY_BANDS,
  PROCESS_INSTANCE_LABELS,
  SCENARIO_ORIGIN_LABELS,
  VALUATION_KIND_LABELS,
  processPhaseLabel,
} from "@/domain/enums";
import { totalOf, type LegalReportDraft, type ReportItemDraft } from "@/domain/legal-reports";
import { formatDate, formatMoneyCents, formatNumber, todayISO } from "@/lib/format";
import { historyOf, linkedGuaranteesAt, positionAt, riskAt, valuationAt } from "@/modules/contingency/position";
import type { OrganizationSettings } from "@/server/db/schema";
import {
  caseBriefWhere,
  documentWhere,
  guaranteeWhere,
  processWhere,
  riskAssessmentWhere,
  valuationWhere,
} from "@/server/auth/access";
import type { AuthContext } from "@/server/auth/context";
import { can } from "@/server/auth/permissions";
import { getDb } from "@/server/db/client";
import {
  caseBriefs,
  companies,
  documentVersions,
  documents,
  lawFirms,
  legalProcesses,
  organizations,
  processGuarantees,
  processRiskAssessments,
  processValuations,
  units,
  users,
} from "@/server/db/schema";
import { processScenarios } from "@/server/db/schema/legal-reports";
import { NotFoundError } from "@/server/lib/errors";

/**
 * Gerador do "Documento de teste do motor" (tipo process_report, marcado como
 * amostra): monta, a partir dos dados REAIS de um processo visível, itens de
 * todas as origens, uma lacuna, pendências e uma tabela longa (teste de
 * cabeçalho repetido). Itens de controle (trecho ausente, confiança baixa)
 * existem só aqui e são rotulados como controle.
 */

export const ENGINE_SAMPLE_GENERATOR = "engine_sample";
export const ENGINE_SAMPLE_VERSION = 1;
const PAGINATION_ROWS = 80;
const DOCUMENT_BANNER = /DOCUMENTO FICT[IÍ]CIO/i;
const DASHES = /[\u2012-\u2015]/;

const SECTIONS = [
  { key: "identification", title: "Identificação do processo" },
  { key: "values", title: "Valores registrados" },
  { key: "documents", title: "Trechos de documentos" },
  { key: "analysis", title: "Análises registradas" },
  { key: "parameters", title: "Parâmetros do relatório" },
  { key: "pagination", title: "Tabela de teste de paginação" },
] as const;

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

function instanceLabel(value: string | null): string | null {
  if (!value) return null;
  return (PROCESS_INSTANCE_LABELS as Record<string, string>)[value] ?? value;
}

function phaseLabel(value: string | null): string | null {
  return processPhaseLabel(value);
}

/** Frases citáveis de uma página: tamanho razoável, sem o aviso de documento fictício e sem travessão. */
export function quotableSentences(pageText: string): string[] {
  const candidates = pageText
    .split(/\n+|(?<=[.;])\s+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length >= 40 && s.length <= 220 && !DOCUMENT_BANNER.test(s) && !DASHES.test(s));
  // Frases narrativas (maioria de minúsculas) primeiro; cabeçalhos em caixa alta por último.
  const lowerRatio = (s: string) => {
    const letters = s.match(/\p{L}/gu) ?? [];
    const lower = letters.filter((c) => c !== c.toUpperCase());
    return letters.length ? lower.length / letters.length : 0;
  };
  return [...candidates.filter((s) => lowerRatio(s) >= 0.55), ...candidates.filter((s) => lowerRatio(s) < 0.55)];
}

function pageSlice(text: string, offsets: number[], page: number): string {
  const start = offsets[page - 1] ?? 0;
  const end = page < offsets.length ? offsets[page] : text.length;
  return text.slice(start, end);
}

export async function buildEngineSampleDraft(
  ctx: AuthContext,
  input: { processId: string },
  settings: OrganizationSettings,
): Promise<LegalReportDraft> {
  const db = getDb();
  const [p] = await db
    .select({
      id: legalProcesses.id,
      number: legalProcesses.number,
      title: legalProcesses.title,
      court: legalProcesses.court,
      courtDivision: legalProcesses.courtDivision,
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
      lastMovementAt: legalProcesses.lastMovementAt,
      createdAt: legalProcesses.createdAt,
      updatedAt: legalProcesses.updatedAt,
      responsibleName: users.name,
      unitName: units.name,
      companyName: companies.name,
      lawFirmName: lawFirms.name,
    })
    .from(legalProcesses)
    .leftJoin(users, eq(users.id, legalProcesses.responsibleId))
    .leftJoin(units, eq(units.id, legalProcesses.unitId))
    .leftJoin(companies, eq(companies.id, legalProcesses.companyId))
    .leftJoin(lawFirms, eq(lawFirms.id, legalProcesses.lawFirmId))
    .where(and(eq(legalProcesses.id, input.processId), processWhere(ctx)))
    .limit(1);
  if (!p) throw new NotFoundError("Processo não encontrado ou sem permissão de acesso.");

  const baseDate = todayISO();
  const items: ReportItemDraft[] = [];
  let seq = 0;
  const push = (item: Omit<ReportItemDraft, "key"> & { key?: string }): string => {
    seq += 1;
    const key = item.key ?? `i${seq}`;
    items.push({ ...item, key });
    return key;
  };
  const recordedAt = (p.updatedAt ?? p.createdAt).toISOString();
  // Fontes com várias linhas: data do registro mais recente; consulta sem linhas: data da consulta.
  const queriedAt = new Date().toISOString();
  const latestOf = (dates: readonly Date[]): string => new Date(Math.max(...dates.map((d) => d.getTime()))).toISOString();
  const processSource = (field: string, label: string) => ({
    table: "legal_processes",
    field,
    recordId: p.id,
    label: `Cadastro do processo, campo ${label}`,
    recordedAt,
  });

  // --- Identificação -------------------------------------------------------
  const fields: { field: string; label: string; value: string | null }[] = [
    { field: "number", label: "Número do processo", value: p.number },
    { field: "title", label: "Título", value: p.title },
    { field: "court", label: "Tribunal", value: p.court },
    { field: "court_division", label: "Vara ou órgão julgador", value: p.courtDivision },
    { field: "instance", label: "Instância atual", value: instanceLabel(p.instance) },
    {
      field: "phase",
      label: "Fase",
      value: [phaseLabel(p.phase), p.phaseDetail ? `(como consta na fonte: ${p.phaseDetail})` : null].filter(Boolean).join(" ") || null,
    },
    { field: "city", label: "Cidade e UF", value: [p.city, p.state].filter(Boolean).join("/") || null },
    { field: "filed_at", label: "Data de ajuizamento", value: p.filedAt ? formatDate(p.filedAt, p.filedAt) : null },
    { field: "company_id", label: "Empresa do grupo", value: p.companyName },
    { field: "unit_id", label: "Unidade", value: p.unitName },
    { field: "responsible_id", label: "Responsável", value: p.responsibleName },
    { field: "law_firm_id", label: "Escritório externo", value: p.lawFirmName },
    { field: "last_movement_at", label: "Última movimentação registrada", value: p.lastMovementAt ? formatDate(p.lastMovementAt, p.lastMovementAt) : null },
  ];
  for (const f of fields) {
    if (f.value) push({ section: "identification", content: `${f.label}: ${f.value}.`, origin: "record", recordSource: processSource(f.field, f.label) });
    else push({ section: "identification", content: f.label, origin: "gap" });
  }
  // Dado que o cadastro não guarda: lacuna declarada (nunca presumida).
  push({ section: "identification", content: "Data do trânsito em julgado (campo não existe no cadastro)", origin: "gap" });

  // --- Valores (mesma posição do sistema: `positionAt`, como a ficha e o fechamento) ------
  let valuationCount = 0;
  let proposedCount = 0;
  let officialCount = 0;
  let guaranteeCount = 0;
  let riskCount = 0;
  let proposedWithSource: {
    id: string;
    kind: string;
    amountCents: number;
    baseDate: string;
    documentId: string;
    documentVersionId: string;
    documentSha256: string;
    page: number;
    excerpt: string;
    confidence: number | null;
  }[] = [];

  if (can(ctx, "contingency:read")) {
    const [valuations, risks, guarantees] = await Promise.all([
      db
        .select({
          id: processValuations.id,
          kind: processValuations.kind,
          amountCents: processValuations.amountCents,
          baseDate: processValuations.baseDate,
          status: processValuations.status,
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
        .leftJoin(users, eq(users.id, processRiskAssessments.assessedById))
        .where(and(eq(processRiskAssessments.processId, p.id), riskAssessmentWhere(ctx))),
      db
        .select({
          id: processGuarantees.id,
          amountCents: processGuarantees.amountCents,
          status: processGuarantees.status,
          depositedAt: processGuarantees.depositedAt,
          statusChangedAt: processGuarantees.statusChangedAt,
          createdAt: processGuarantees.createdAt,
          updatedAt: processGuarantees.updatedAt,
          deletedAt: processGuarantees.deletedAt,
        })
        .from(processGuarantees)
        .where(and(eq(processGuarantees.processId, p.id), guaranteeWhere(ctx))),
    ]);
    valuationCount = valuations.length;
    officialCount = valuations.filter((v) => v.status === "official").length;
    proposedCount = valuations.filter((v) => v.status === "proposed").length;
    riskCount = risks.filter((r) => r.status === "official" && r.effectiveFrom <= baseDate).length;

    // A mesma regra da ficha do processo e do fechamento mensal: histórico oficial na data-base,
    // ou o valor do cadastro quando não há histórico daquele tipo.
    const history = historyOf(valuations, risks);
    const position = positionAt({
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

    const valueItem = (
      kind: "claim" | "liquidated",
      label: string,
      cents: number | null,
      fromHistory: boolean,
      recordField: string,
      fieldLabel: string,
    ): string => {
      if (cents === null) return push({ section: "values", content: label, origin: "gap" });
      if (!fromHistory) {
        return push({
          section: "values",
          content: `${label}: ${formatMoneyCents(cents, "")} (valor do cadastro do processo, sem histórico de valorações; data-base e índice de atualização não registrados).`,
          origin: "record",
          recordSource: processSource(recordField, fieldLabel),
        });
      }
      const inForce = valuationAt(valuations, kind, baseDate);
      const row = valuations.find((v) => v.id === inForce?.id);
      if (!row) return push({ section: "values", content: label, origin: "gap" });
      const kindLabel = VALUATION_KIND_LABELS[kind].toLocaleLowerCase("pt-BR");
      return push({
        section: "values",
        content: `${label}: ${formatMoneyCents(row.amountCents, "")} (data-base ${formatDate(row.baseDate, row.baseDate)}, índice de atualização: ${row.correctionIndex ? CORRECTION_INDEX_LABELS[row.correctionIndex] : "não informado"}).`,
        origin: "record",
        recordSource: {
          table: "process_valuations",
          field: "amount_cents",
          recordId: row.id,
          label:
            row.status === "official"
              ? `Valoração oficial do tipo ${kindLabel}`
              : `Valoração do tipo ${kindLabel} vigente na data-base (depois substituída)`,
          recordedAt: (row.reviewedAt ?? row.createdAt).toISOString(),
        },
      });
    };
    const claimKey = valueItem("claim", "Valor da causa", position.claimCents, history.claim, "claim_amount_cents", "Valor da causa");
    const liquidatedKey = valueItem(
      "liquidated",
      "Valor apurado (liquidado) vigente",
      position.liquidatedCents,
      history.liquidated,
      "liquidated_amount_cents",
      "Valor apurado",
    );

    const linked = guarantees.filter((g) => linkedGuaranteesAt([g], baseDate) > 0);
    guaranteeCount = linked.length;
    const guaranteesKey = push({
      section: "values",
      content:
        guaranteeCount === 0
          ? "Garantias vinculadas na data-base: nenhuma."
          : `Garantias vinculadas na data-base: ${formatMoneyCents(position.linkedGuaranteesCents, "")} em ${guaranteeCount} ${guaranteeCount === 1 ? "registro" : "registros"}.`,
      origin: "record",
      recordSource: {
        table: "process_guarantees",
        field: "amount_cents (vinculadas na data-base)",
        recordId: linked.length === 1 ? linked[0].id : null,
        label: "Garantias do processo vinculadas na data-base",
        recordedAt: linked.length ? latestOf(linked.map((g) => g.updatedAt)) : queriedAt,
        dateBasis: linked.length === 0 ? "query" : linked.length === 1 ? "record" : "latest",
      },
    });

    // Classificação de risco vigente (seção de análises): avaliação oficial, ou o cadastro sem histórico.
    let riskKey: string | null = null;
    const riskInForce = riskAt(risks, baseDate);
    const riskRow = risks.find((r) => r.id === riskInForce?.id);
    if (history.risk && riskRow) {
      riskKey = push({
        section: "analysis",
        content: `Classificação de risco vigente: ${LOSS_PROBABILITY_LABELS[riskRow.classification]} (${formatNumber(riskRow.percentageBp / 100)}%), vigente desde ${formatDate(riskRow.effectiveFrom, riskRow.effectiveFrom)}${riskRow.assessedByName ? `, registrada por ${riskRow.assessedByName}` : ""}. Parecer: ${clip(riskRow.opinion, 280)}`,
        origin: "analysis",
        recordSource: {
          table: "process_risk_assessments",
          field: "opinion",
          recordId: riskRow.id,
          label: "Classificação de risco oficial com parecer",
          recordedAt: (riskRow.reviewedAt ?? riskRow.createdAt).toISOString(),
        },
      });
    } else if (!history.risk && (position.classification !== null || position.percentageBp !== null)) {
      const pct = position.percentageBp !== null ? ` (${formatNumber(position.percentageBp / 100)}%)` : "";
      riskKey = push({
        section: "analysis",
        content: `Classificação de risco: ${position.classification ? LOSS_PROBABILITY_LABELS[position.classification] : "não informada"}${pct}, conforme o cadastro do processo (não há classificação oficial no histórico).`,
        origin: "record",
        recordSource: processSource("loss_probability", "Classificação de risco"),
      });
    } else {
      push({ section: "analysis", content: "Classificação de risco oficial vigente", origin: "gap" });
    }

    const exposure = position.exposure;
    if (exposure.basis === "liquidated" && exposure.exposureCents !== null) {
      push({
        section: "values",
        content: `Exposição líquida calculada: ${formatMoneyCents(exposure.exposureCents, "")} (valor apurado vigente menos garantias vinculadas, nunca negativa).`,
        origin: "inference",
        derivedFrom: [liquidatedKey, guaranteesKey],
      });
    } else if (exposure.basis === "claim_weighted" && exposure.exposureCents !== null) {
      push({
        section: "values",
        content: `Exposição líquida: não calculada, porque não há valor apurado vigente. O sistema registra uma estimativa de ${formatMoneyCents(exposure.exposureCents, "")} (valor da causa ponderado pelo percentual de risco vigente, menos garantias vinculadas), que não é valor apurado.`,
        origin: "inference",
        derivedFrom: [liquidatedKey, claimKey, guaranteesKey, ...(riskKey ? [riskKey] : [])],
      });
    } else {
      push({
        section: "values",
        content: "Exposição líquida: não calculada, porque não há valor apurado vigente (a exposição nunca usa zero no lugar de um valor ausente).",
        origin: "inference",
        derivedFrom: [liquidatedKey, guaranteesKey],
      });
    }

    // Valores propostos com fonte em documento visível: o hash da versão vai junto para a conferência.
    const proposals = valuations.filter(
      (v) => v.status === "proposed" && v.documentId && v.documentVersionId && v.page && v.excerpt && v.excerpt.trim().length > 0,
    );
    const versionIds = [...new Set(proposals.map((v) => v.documentVersionId as string))];
    const hashes =
      versionIds.length > 0 && can(ctx, "document:read")
        ? await db
            .select({ id: documentVersions.id, sha256: documentVersions.sha256 })
            .from(documentVersions)
            .innerJoin(documents, eq(documents.id, documentVersions.documentId))
            .where(and(inArray(documentVersions.id, versionIds), documentWhere(ctx)))
        : [];
    const shaOf = new Map(hashes.map((h) => [h.id, h.sha256]));
    proposedWithSource = proposals
      .filter((v) => shaOf.has(v.documentVersionId as string))
      .slice(0, 3)
      .map((v) => ({
        id: v.id,
        kind: v.kind,
        amountCents: v.amountCents,
        baseDate: v.baseDate,
        documentId: v.documentId as string,
        documentVersionId: v.documentVersionId as string,
        documentSha256: shaOf.get(v.documentVersionId as string) as string,
        page: v.page as number,
        excerpt: v.excerpt as string,
        confidence: v.confidence,
      }));
  } else {
    push({ section: "values", content: "Valores do processo (perfil de quem gerou sem acesso a valores)", origin: "gap" });
  }

  // --- Documentos --------------------------------------------------------------
  let docCount = 0;
  let pagedDocCount = 0;
  const docRows = can(ctx, "document:read")
    ? await db
        .select({
          documentId: documents.id,
          title: documents.title,
          category: documents.category,
          versionId: documentVersions.id,
          sha256: documentVersions.sha256,
          text: documentVersions.extractedText,
          pageOffsets: documentVersions.pageOffsets,
          extractionStatus: documentVersions.extractionStatus,
        })
        .from(documents)
        .innerJoin(documentVersions, eq(documentVersions.id, documents.currentVersionId))
        .where(and(eq(documents.processId, p.id), documentWhere(ctx)))
        .orderBy(asc(documents.createdAt))
    : [];
  docCount = docRows.length;
  // Documentos de saúde (PD-04) nunca são transcritos: ficam fora das citações do documento de teste.
  const paged = docRows.filter(
    (d) =>
      d.category !== "sensitive_health" &&
      d.extractionStatus === "succeeded" &&
      d.text &&
      Array.isArray(d.pageOffsets) &&
      d.pageOffsets.length > 0,
  );
  pagedDocCount = paged.length;
  let firstDoc: (typeof paged)[number] | null = null;
  for (const d of paged) {
    if (items.filter((i) => i.section === "documents" && i.origin === "documented").length >= 3) break;
    const offsets = d.pageOffsets as number[];
    for (let page = 1; page <= Math.min(offsets.length, 2); page += 1) {
      const sentence = quotableSentences(pageSlice(d.text as string, offsets, page))[0];
      if (!sentence) continue;
      firstDoc ??= d;
      push({
        section: "documents",
        content: `Trecho do documento "${clip(d.title, 90)}", página ${page}.`,
        origin: "documented",
        documentId: d.documentId,
        documentVersionId: d.versionId,
        page,
        excerpt: sentence,
        documentSha256: d.sha256,
      });
      break;
    }
  }
  if (!firstDoc) {
    push({ section: "documents", content: "Documento do processo com texto paginado para citação literal", origin: "gap" });
  } else {
    // Controle do verificador: trecho propositalmente ausente da página citada.
    push({
      section: "documents",
      content: "Controle do verificador de fontes: trecho propositalmente ausente da página citada (deve ir para Não confirmado).",
      origin: "documented",
      documentId: firstDoc.documentId,
      documentVersionId: firstDoc.versionId,
      page: 1,
      excerpt: "Trecho de controle inexistente nesta página, usado apenas para testar a conferência automática.",
      documentSha256: firstDoc.sha256,
    });
  }
  for (const v of proposedWithSource) {
    push({
      section: "values",
      content: `Valor indicado em documento, ainda pendente de conferência humana: ${formatMoneyCents(v.amountCents, "")} (${VALUATION_KIND_LABELS[v.kind as keyof typeof VALUATION_KIND_LABELS] ?? v.kind}, data-base ${formatDate(v.baseDate, v.baseDate)}).`,
      origin: "documented",
      documentId: v.documentId,
      documentVersionId: v.documentVersionId,
      documentSha256: v.documentSha256,
      page: v.page,
      excerpt: v.excerpt,
      confidence: v.confidence,
    });
  }

  // --- Análises (a classificação de risco vigente entra junto com os valores, acima) ------
  if (can(ctx, "brief:read")) {
    const [brief] = await db
      .select({ id: caseBriefs.id, version: caseBriefs.version, status: caseBriefs.status, mode: caseBriefs.mode, createdAt: caseBriefs.createdAt })
      .from(caseBriefs)
      .where(and(eq(caseBriefs.processId, p.id), caseBriefWhere(ctx), isNotNull(caseBriefs.content)))
      .orderBy(desc(caseBriefs.version))
      .limit(1);
    if (brief) {
      push({
        section: "analysis",
        content: `Há análise preliminar registrada (versão ${brief.version}, situação "${CASE_BRIEF_STATUS_LABELS[brief.status]}"). O conteúdo não é reproduzido neste documento de teste.`,
        origin: "analysis",
        simulated: brief.mode === "demo",
        recordSource: {
          table: "case_briefs",
          field: "content",
          recordId: brief.id,
          label: `Análise preliminar, versão ${brief.version}`,
          recordedAt: brief.createdAt.toISOString(),
        },
      });
    }
  }
  const scenarios = await db
    .select({
      id: processScenarios.id,
      description: processScenarios.description,
      band: processScenarios.probabilityBand,
      min: processScenarios.percentMin,
      max: processScenarios.percentMax,
      origin: processScenarios.origin,
      createdAt: processScenarios.createdAt,
      authorName: users.name,
    })
    .from(processScenarios)
    .leftJoin(users, eq(users.id, processScenarios.authorId))
    .where(and(eq(processScenarios.processId, p.id), eq(processScenarios.organizationId, ctx.organizationId)))
    .orderBy(asc(processScenarios.createdAt));
  if (scenarios.length > 0) {
    push({
      section: "analysis",
      content: "Cenários registrados para o processo (registros datados, nunca sobrescritos)",
      origin: "analysis",
      recordSource: {
        table: "process_scenarios",
        field: "*",
        recordId: scenarios.length === 1 ? scenarios[0].id : null,
        label: "Cenários do processo",
        recordedAt: latestOf(scenarios.map((s) => s.createdAt)),
        dateBasis: scenarios.length === 1 ? "record" : "latest",
      },
      data: {
        kind: "table",
        columns: [
          { header: "Cenário", weight: 3 },
          { header: "Faixa", weight: 1.1 },
          { header: "Percentual", weight: 1, align: "right" },
          { header: "Origem", weight: 1.3 },
          { header: "Registrado em", weight: 1.3 },
        ],
        rows: scenarios.map((s) => [
          clip(s.description, 160),
          PROBABILITY_BAND_LABELS[s.band],
          `${s.min}% a ${s.max}%`,
          `${SCENARIO_ORIGIN_LABELS[s.origin]}${s.authorName ? ` (${s.authorName})` : ""}`,
          formatDate(s.createdAt, "Não informado"),
        ]),
        totals: null,
        note: null,
      },
    });
  }
  // Controle do limite de confiança: inferência com confiança 50 (vai para Pendências).
  const anchor = items.find((i) => i.origin === "record");
  if (anchor) {
    push({
      section: "analysis",
      content: "Controle do limite de confiança: item com confiança 50, abaixo do limite (deve ir para Pendências do relatório).",
      origin: "inference",
      derivedFrom: [anchor.key],
      confidence: 50,
    });
  }

  // --- Parâmetros --------------------------------------------------------------
  const lr = settings.legalReports;
  // Faixas salvas pela organização (data do registro) ou padrão do sistema (nada salvo: data da consulta).
  const [org] = await db
    .select({ settings: organizations.settings, updatedAt: organizations.updatedAt })
    .from(organizations)
    .where(eq(organizations.id, ctx.organizationId))
    .limit(1);
  const savedBands = !!(org?.settings as { legalReports?: { bands?: unknown } } | null)?.legalReports?.bands;
  push({
    section: "parameters",
    content: "Faixas de probabilidade dos cenários (configuração da organização)",
    origin: "record",
    recordSource: {
      table: "organizations",
      field: "settings.legalReports.bands",
      recordId: ctx.organizationId,
      label: savedBands
        ? "Configurações da organização, faixas de probabilidade"
        : "Faixas de probabilidade padrão do sistema (a organização não alterou os parâmetros)",
      recordedAt: savedBands && org ? org.updatedAt.toISOString() : queriedAt,
      dateBasis: savedBands ? "record" : "query",
    },
    data: {
      kind: "table",
      columns: [
        { header: "Faixa", weight: 2 },
        { header: "Mínimo", weight: 1, align: "right" },
        { header: "Máximo", weight: 1, align: "right" },
      ],
      rows: PROBABILITY_BANDS.map((b) => [PROBABILITY_BAND_LABELS[b], `${lr.bands[b].min}%`, `${lr.bands[b].max}%`]),
      totals: null,
      note: null,
    },
  });

  // --- Tabela longa (cabeçalho repetido) --------------------------------------
  const portfolio = await db
    .select({
      number: legalProcesses.number,
      court: legalProcesses.court,
      instance: legalProcesses.instance,
      phase: legalProcesses.phase,
      claimAmountCents: legalProcesses.claimAmountCents,
      liquidatedAmountCents: legalProcesses.liquidatedAmountCents,
      updatedAt: legalProcesses.updatedAt,
    })
    .from(legalProcesses)
    .where(processWhere(ctx))
    .orderBy(asc(legalProcesses.number))
    .limit(PAGINATION_ROWS);
  const showValues = can(ctx, "contingency:read");
  const claimTotal = totalOf(portfolio.map((r) => ({ quantity: "claim" as const, cents: r.claimAmountCents })), "claim");
  const liquidatedTotal = totalOf(
    portfolio.map((r) => ({ quantity: "liquidated" as const, cents: r.liquidatedAmountCents })),
    "liquidated",
  );
  push({
    section: "pagination",
    content: `Processos visíveis da carteira, por número (até ${PAGINATION_ROWS})`,
    origin: "record",
    recordSource: {
      table: "legal_processes",
      field: "number, court, instance, phase, claim_amount_cents, liquidated_amount_cents",
      recordId: null,
      label: "Cadastro dos processos visíveis ao perfil",
      recordedAt: portfolio.length ? latestOf(portfolio.map((r) => r.updatedAt)) : queriedAt,
      dateBasis: portfolio.length ? "latest" : "query",
    },
    data: {
      kind: "table",
      columns: [
        { header: "Nº do processo", weight: 2.2 },
        { header: "Tribunal", weight: 1, nullLabel: "Não informado" },
        { header: "Instância", weight: 1.3, nullLabel: "Não informada" },
        { header: "Fase", weight: 1.5, nullLabel: "Não informada" },
        { header: "Valor da causa", weight: 1.35, align: "right", quantity: "claim", nullLabel: "Não informado" },
        { header: "Valor apurado", weight: 1.35, align: "right", quantity: "liquidated", nullLabel: "Não apurado" },
      ],
      rows: portfolio.map((r) => [
        r.number,
        r.court,
        instanceLabel(r.instance),
        phaseLabel(r.phase),
        showValues && r.claimAmountCents !== null ? formatMoneyCents(r.claimAmountCents, "") : null,
        showValues && r.liquidatedAmountCents !== null ? formatMoneyCents(r.liquidatedAmountCents, "") : null,
      ]),
      totals: showValues
        ? [
            `Totais (${portfolio.length} processos)`,
            "",
            "",
            "",
            `${formatMoneyCents(claimTotal.cents, "")}\n${claimTotal.counted} com valor`,
            `${formatMoneyCents(liquidatedTotal.cents, "")}\n${liquidatedTotal.counted} com valor`,
          ]
        : null,
      note: showValues
        ? `Valor da causa e valor apurado são totalizados em separado e nunca somados entre si. Sem valor da causa: ${claimTotal.unknown}; sem valor apurado: ${liquidatedTotal.unknown} (não contados como zero).`
        : "Perfil sem acesso a valores: as colunas de valores ficam sem dado.",
    },
  });

  const methodology = [
    `Documento de teste gerado em ${formatDate(baseDate, baseDate)} a partir do cadastro do processo ${p.number} (${p.court}, fase ${phaseLabel(p.phase) ?? "não informada"}). Base consultada: ${docCount} ${docCount === 1 ? "documento vinculado" : "documentos vinculados"} (${pagedDocCount} com texto paginado), ${valuationCount} ${valuationCount === 1 ? "valoração" : "valorações"} (${officialCount} oficiais, ${proposedCount} propostas), ${guaranteeCount} ${guaranteeCount === 1 ? "garantia vinculada" : "garantias vinculadas"}, ${riskCount} ${riskCount === 1 ? "classificação de risco oficial" : "classificações de risco oficiais"} e ${scenarios.length} ${scenarios.length === 1 ? "cenário" : "cenários"}.`,
    "Todos os itens vêm da base na data-base (nada é inventado). Os itens marcados como controle existem só neste documento de teste, para demonstrar a conferência de fontes e o limite de confiança.",
  ];

  return {
    type: "process_report",
    title: `Documento de teste do motor: processo ${p.number}`,
    subtitle: clip(p.title, 160),
    scope: { processId: p.id },
    scopeLabel: `Processo ${p.number}`,
    baseDate,
    isSample: true,
    generator: ENGINE_SAMPLE_GENERATOR,
    generatorVersion: ENGINE_SAMPLE_VERSION,
    sections: SECTIONS.map((s) => ({ ...s })),
    methodology,
    items,
  };
}

/** Resolve um processo visível pelo número (com ou sem pontuação). */
export async function findVisibleProcessByNumber(ctx: AuthContext, number: string): Promise<{ id: string } | null> {
  const digits = number.replace(/\D/g, "");
  const raw = number.trim();
  if (!raw) return null;
  const rows = await getDb()
    .select({ id: legalProcesses.id })
    .from(legalProcesses)
    .where(
      and(
        processWhere(ctx),
        digits.length >= 7
          ? sql`(${legalProcesses.number} = ${raw} or regexp_replace(${legalProcesses.number}, '\\D', '', 'g') = ${digits})`
          : eq(legalProcesses.number, raw),
      ),
    )
    .limit(2);
  return rows.length === 1 ? rows[0] : null;
}

/** Processos visíveis (id + número) para o seletor do documento de teste. */
export async function listSampleProcessOptions(ctx: AuthContext, limit = 50): Promise<{ id: string; number: string; title: string }[]> {
  return getDb()
    .select({ id: legalProcesses.id, number: legalProcesses.number, title: legalProcesses.title })
    .from(legalProcesses)
    .where(and(processWhere(ctx), inArray(legalProcesses.status, ["active", "suspended"])))
    .orderBy(desc(legalProcesses.updatedAt))
    .limit(limit);
}
