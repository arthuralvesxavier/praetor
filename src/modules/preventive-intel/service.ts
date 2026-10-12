/**
 * Inteligência preventiva (RF-15..RF-18, TE-12).
 *
 * Indicators are computed from the processes VISIBLE to the viewer
 * (`processWhere`), filtered by empresa / tribunal. Each indicator carries its
 * basis (formula, population and number of processes). Recurring claims come
 * from the latest preliminary case analysis of each visible process
 * (`caseBriefWhere`), extracted items only, over fictitious demo documents.
 * Illustrative suggestions become occurrences / action-plan tasks only through
 * an explicit user action (`createOccurrenceFromSuggestion`,
 * `createActionPlanFromSuggestion`). No sensitive data (PD-06) in indicators.
 */
import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { BriefClaim } from "@/domain/case-brief";
import { parseCnj } from "@/domain/cnj";
import {
  CLOSURE_REASON_LABELS,
  PROCESS_PHASE_LABELS,
  type ClosureReason,
  type OccurrenceStatus,
  type ProcessPhase,
} from "@/domain/enums";
import { formatNumber, formatPercent, pluralize, todayISO } from "@/lib/format";
import { caseBriefWhere, hasOrganizationWideScope, processWhere, seesConfidential, taskWhere } from "@/server/auth/access";
import type { AuthContext } from "@/server/auth/context";
import { assertCan, can } from "@/server/auth/permissions";
import { getDb } from "@/server/db/client";
import { caseBriefs, companies, legalProcesses, processParties, tasks } from "@/server/db/schema";
import { ConflictError, ValidationError } from "@/server/lib/errors";
import { isPreventiveIndicatorKey } from "@/modules/occurrences/preventive-origin";
import { createOccurrence, findPreventiveIntelOccurrences, updateOccurrence } from "@/modules/occurrences/service";
import { cityGroup, courtGroup, divisionGroup, NONE_KEY, textKey } from "@/modules/reports/grouping";
import { createTask } from "@/modules/work/service";
import { aggregateClaims } from "./claims";
import { buildSuggestionFacts, buildSuggestions, SUGGESTION_LABEL, type KnowledgeByCourt } from "./suggestions";
import type {
  ClosureGroup,
  ClosureStat,
  CollectiveProcess,
  GroupStat,
  PreventiveIntelFilters,
  PreventiveIntelligence,
  PreventiveSuggestion,
  RatioStat,
  RepeatPlaintiff,
  RiskFactor,
  YearStat,
} from "./types";

/** Reference thresholds of the risk factors (fixed in this version, shown in each explanation). */
export const RISK_FACTOR_THRESHOLDS = {
  courtConcentration: 0.4,
  materializedShare: 0.25,
  verificationShare: 0.05,
  classDominance: 0.5,
  ratioAboveClaim: 1,
  ratioMinProcesses: 3,
  filingGrowth: 0.2,
  filingMinPerYear: 3,
} as const;

const TOP_N = 10;
const BRIEF_STATUSES = ["ready_for_review", "in_review", "approved"] as const;

const filtersSchema = z.object({
  companyId: z.guid({ error: "Empresa inválida." }).optional(),
  court: z.string().trim().min(1).max(120).optional(),
});

function parseFilters(filters: PreventiveIntelFilters): PreventiveIntelFilters {
  const parsed = filtersSchema.safeParse(filters ?? {});
  if (!parsed.success) {
    throw new ValidationError("Verifique os filtros.", z.flattenError(parsed.error).fieldErrors as Record<string, string[]>);
  }
  return parsed.data;
}

type ProcessRow = {
  id: string;
  number: string;
  title: string;
  court: string;
  courtDivision: string | null;
  city: string | null;
  processClass: string | null;
  phase: ProcessPhase;
  status: string;
  closureReason: ClosureReason | null;
  needsVerification: boolean;
  claim: number | null;
  liquidated: number | null;
  filedAt: string | null;
};

const isActive = (p: ProcessRow) => p.status === "active" || p.status === "suspended";
const isClosed = (p: ProcessRow) => p.status === "closed" || p.status === "archived" || p.closureReason !== null;

function groupStats(
  items: ProcessRow[],
  keyOf: (p: ProcessRow) => { key: string; label: string },
  population: number,
): GroupStat[] {
  const map = new Map<string, GroupStat>();
  for (const p of items) {
    const g = keyOf(p);
    const s =
      map.get(g.key) ??
      ({ key: g.key, label: g.label, count: 0, share: 0, claimCents: 0, claimUnknown: 0, liquidatedCents: 0, liquidatedUnknown: 0 } as GroupStat);
    s.count += 1;
    if (p.claim === null) s.claimUnknown += 1;
    else s.claimCents += p.claim;
    if (p.liquidated === null) s.liquidatedUnknown += 1;
    else s.liquidatedCents += p.liquidated;
    map.set(g.key, s);
  }
  return [...map.values()]
    .map((s) => ({ ...s, share: population > 0 ? s.count / population : 0 }))
    .sort((a, b) => {
      if (a.key === NONE_KEY && b.key !== NONE_KEY) return 1;
      if (b.key === NONE_KEY && a.key !== NONE_KEY) return -1;
      return b.count - a.count || a.label.localeCompare(b.label, "pt-BR");
    });
}

function classGroup(p: ProcessRow): { key: string; label: string } {
  const v = (p.processClass ?? "").trim();
  return v ? { key: textKey(v), label: v } : { key: NONE_KEY, label: "Classe não informada" };
}

const CLOSURE_GROUPS: Record<ClosureReason, ClosureGroup> = {
  paid_extinct: "paid",
  settlement_fulfilled: "paid",
  dismissed: "no_burden",
  archived: "no_burden",
  returned_to_origin: "no_burden",
  lost_patronage: "lost_patronage",
  other: "other",
};

function isCollectiveClass(cls: string | null): boolean {
  if (!cls) return false;
  const v = textKey(cls).replace(/[^a-z]/g, "");
  return v.startsWith("acp") || v.includes("acaocivilpublica") || v.includes("acaocoletiva");
}

function scopeOf(ctx: AuthContext) {
  if (seesConfidential(ctx)) {
    return { orgWide: true, includesConfidential: true, label: "Carteira completa da organização, incluindo processos sigilosos." };
  }
  if (hasOrganizationWideScope(ctx)) {
    return { orgWide: true, includesConfidential: false, label: "Carteira da organização, exceto processos sigilosos." };
  }
  return {
    orgWide: false,
    includesConfidential: false,
    label: "Somente os processos visíveis para o seu perfil: os indicadores não representam a organização inteira.",
  };
}

async function filterSummary(ctx: AuthContext, f: PreventiveIntelFilters): Promise<string> {
  const parts: string[] = [];
  if (f.companyId) {
    const [c] = await getDb()
      .select({ name: companies.name })
      .from(companies)
      .where(and(eq(companies.id, f.companyId), eq(companies.organizationId, ctx.organizationId)));
    if (!c) throw new ValidationError("Empresa inválida.", { companyId: ["Selecione uma empresa válida."] });
    parts.push(`Empresa: ${c.name}`);
  }
  if (f.court) parts.push(`Tribunal: ${f.court}`);
  return parts.length > 0 ? parts.join(" · ") : "Sem filtros (todas as empresas e tribunais)";
}

function processFilter(ctx: AuthContext, f: PreventiveIntelFilters) {
  return and(
    processWhere(ctx),
    f.companyId ? eq(legalProcesses.companyId, f.companyId) : undefined,
    f.court ? eq(legalProcesses.court, f.court) : undefined,
  );
}

function pct(n: number): string {
  return formatPercent(n, 1);
}

// ---------------------------------------------------------------------------
// Indicators
// ---------------------------------------------------------------------------

export async function getPreventiveIntelligence(
  ctx: AuthContext,
  filters: PreventiveIntelFilters = {},
): Promise<PreventiveIntelligence> {
  assertCan(ctx, "preventive_intel:read");
  const f = parseFilters(filters);
  const summary = await filterSummary(ctx, f);
  const db = getDb();
  const lp = legalProcesses;
  const where = processFilter(ctx, f);

  const [procs, parties, briefRows] = await Promise.all([
    db
      .select({
        id: lp.id,
        number: lp.number,
        title: lp.title,
        court: lp.court,
        courtDivision: lp.courtDivision,
        city: lp.city,
        processClass: lp.processClass,
        phase: lp.phase,
        status: lp.status,
        closureReason: lp.closureReason,
        needsVerification: lp.needsVerification,
        claim: lp.claimAmountCents,
        liquidated: lp.liquidatedAmountCents,
        filedAt: lp.filedAt,
      })
      .from(lp)
      .where(where)
      .orderBy(asc(lp.number)),
    db
      .select({
        processId: processParties.processId,
        name: processParties.name,
        role: processParties.role,
        isClient: processParties.isClient,
      })
      .from(processParties)
      .innerJoin(lp, and(eq(lp.id, processParties.processId), where))
      .where(
        and(
          eq(processParties.organizationId, ctx.organizationId),
          inArray(processParties.role, ["plaintiff", "public_prosecutor"]),
        ),
      ),
    // Only the latest version (among the usable statuses) of each process: older versions'
    // claims are never loaded.
    db
      .selectDistinctOn([caseBriefs.processId], {
        processId: caseBriefs.processId,
        version: caseBriefs.version,
        claims: sql<BriefClaim[] | null>`${caseBriefs.content} -> 'claims'`,
      })
      .from(caseBriefs)
      .innerJoin(lp, and(eq(lp.id, caseBriefs.processId), where))
      .where(and(caseBriefWhere(ctx), inArray(caseBriefs.status, [...BRIEF_STATUSES]), isNotNull(caseBriefs.content)))
      .orderBy(caseBriefs.processId, desc(caseBriefs.version)),
  ]);

  const all = procs as ProcessRow[];
  const active = all.filter(isActive);
  const closed = all.filter(isClosed);

  // 1. Recorrência por classe (todos os processos visíveis).
  const classRows = groupStats(all, classGroup, all.length);

  // 2. Concentração (carteira ativa).
  const byCourt = groupStats(active, (p) => courtGroup(p.court), active.length);
  const byCity = groupStats(active, (p) => cityGroup(p.city), active.length);
  const byDivision = groupStats(active, (p) => divisionGroup(p.court, p.courtDivision), active.length).filter(
    (g) => !g.key.endsWith(`|${NONE_KEY}`),
  );

  // 3. Tendência de ajuizamento por ano.
  const currentYear = Number(todayISO().slice(0, 4));
  const years = new Map<number, YearStat>();
  let withoutYear = 0;
  for (const p of all) {
    const cnjYear = parseCnj(p.number)?.year ?? null;
    const filedYear = p.filedAt ? Number(p.filedAt.slice(0, 4)) : null;
    const valid = (y: number | null) => y !== null && y >= 1980 && y <= currentYear + 1;
    const year = valid(cnjYear) ? cnjYear! : valid(filedYear) ? filedYear! : null;
    if (year === null) {
      withoutYear += 1;
      continue;
    }
    const s = years.get(year) ?? { year, count: 0, fromCnj: 0, fromFiledAt: 0 };
    s.count += 1;
    if (valid(cnjYear)) s.fromCnj += 1;
    else s.fromFiledAt += 1;
    years.set(year, s);
  }
  const yearRows = [...years.values()].sort((a, b) => a.year - b.year);

  // 4. Distribuição por fase (carteira ativa).
  const phaseRows = groupStats(active, (p) => ({ key: p.phase, label: PROCESS_PHASE_LABELS[p.phase] }), active.length);
  const materialized = active.filter((p) => p.phase === "liquidation" || p.phase === "enforcement");

  // 5. Reclamantes recorrentes (todos os processos visíveis; cliente excluído).
  const visibleIds = new Set(all.map((p) => p.id));
  const plaintiffProcesses = new Map<string, { name: string; processes: Set<string> }>();
  const prosecutorProcesses = new Set<string>();
  for (const party of parties) {
    if (!visibleIds.has(party.processId)) continue;
    if (party.role === "public_prosecutor") {
      prosecutorProcesses.add(party.processId);
      continue;
    }
    if (party.isClient) continue;
    const key = textKey(party.name);
    if (!key) continue;
    const display = party.name.replace(/\s+/g, " ").trim();
    const entry = plaintiffProcesses.get(key) ?? { name: display, processes: new Set<string>() };
    // Prefer a mixed-case spelling ("João da Silva") over an all-caps one for display.
    if (entry.name === entry.name.toUpperCase() && display !== display.toUpperCase()) entry.name = display;
    entry.processes.add(party.processId);
    plaintiffProcesses.set(key, entry);
  }
  const repeated = [...plaintiffProcesses.values()].filter((e) => e.processes.size > 1);
  const repeatedProcessIds = new Set(repeated.flatMap((e) => [...e.processes]));
  const names: RepeatPlaintiff[] = repeated
    .map((e) => ({
      name: e.name,
      processCount: e.processes.size,
      href: `/processos?q=${encodeURIComponent(e.name)}&carteira=todas`,
    }))
    .sort((a, b) => b.processCount - a.processCount || a.name.localeCompare(b.name, "pt-BR"))
    .slice(0, 50);

  // 6. Ações coletivas / Ministério Público.
  const collective: CollectiveProcess[] = all
    .filter((p) => isCollectiveClass(p.processClass) || prosecutorProcesses.has(p.id))
    .map((p) => ({
      id: p.id,
      number: p.number,
      title: p.title,
      status: p.status as CollectiveProcess["status"],
      reason: [
        isCollectiveClass(p.processClass) ? `Classe ${p.processClass}` : null,
        prosecutorProcesses.has(p.id) ? "Ministério Público como parte" : null,
      ]
        .filter(Boolean)
        .join(" · "),
    }));

  // 7. Cadastros a verificar (carteira ativa).
  const verifyCount = active.filter((p) => p.needsVerification).length;

  // 8. Desfechos de encerramento.
  const closureMap = new Map<ClosureReason | "unknown", number>();
  for (const p of closed) closureMap.set(p.closureReason ?? "unknown", (closureMap.get(p.closureReason ?? "unknown") ?? 0) + 1);
  const closureRows: ClosureStat[] = [...closureMap.entries()]
    .map(([reason, count]) => ({
      reason,
      label: reason === "unknown" ? "Motivo não informado" : CLOSURE_REASON_LABELS[reason],
      group: reason === "unknown" ? ("other" as const) : CLOSURE_GROUPS[reason],
      count,
      share: closed.length > 0 ? count / closed.length : 0,
    }))
    .sort((a, b) => b.count - a.count);

  // 9. Razão liquidado / causa por tribunal (processos com os dois valores).
  const withBoth = all.filter((p) => p.claim !== null && p.claim > 0 && p.liquidated !== null);
  const ratioMap = new Map<string, RatioStat>();
  for (const p of withBoth) {
    const g = courtGroup(p.court);
    const s = ratioMap.get(g.key) ?? { court: g.label, processCount: 0, claimCents: 0, liquidatedCents: 0, ratio: 0 };
    s.processCount += 1;
    s.claimCents += p.claim!;
    s.liquidatedCents += p.liquidated!;
    ratioMap.set(g.key, s);
  }
  const ratioRows = [...ratioMap.values()]
    .map((s) => ({ ...s, ratio: s.claimCents > 0 ? s.liquidatedCents / s.claimCents : 0 }))
    .sort((a, b) => b.processCount - a.processCount || b.ratio - a.ratio);

  // Pedidos recorrentes (análises preliminares — documentos fictícios).
  const latestBrief = new Map<string, { version: number; claims: BriefClaim[] | null }>();
  for (const b of briefRows) {
    const prev = latestBrief.get(b.processId);
    if (!prev || b.version > prev.version) latestBrief.set(b.processId, { version: b.version, claims: b.claims });
  }
  const recurringClaims = aggregateClaims([...latestBrief.entries()].map(([processId, b]) => ({ processId, claims: b.claims })));

  const indicators = {
    totals: { all: all.length, active: active.length, closed: closed.length },
    classRecurrence: {
      basis: {
        formula: "Processos por classe processual ÷ total de processos visíveis.",
        population: "Processos ativos e encerrados",
        processCount: all.length,
      },
      rows: classRows,
    },
    concentration: {
      basis: {
        formula: "Processos ativos por tribunal, cidade e vara ÷ total da carteira ativa (variações de grafia da cidade agrupadas).",
        population: "Carteira ativa",
        processCount: active.length,
      },
      byCourt: byCourt.slice(0, TOP_N),
      byCity: byCity.slice(0, TOP_N),
      byDivision: byDivision.slice(0, TOP_N),
    },
    filingTrend: {
      basis: {
        formula: "Ano de ajuizamento extraído do número CNJ (posição AAAA); quando o número não segue o padrão, usa a data de distribuição cadastrada.",
        population: "Processos ativos e encerrados",
        processCount: all.length - withoutYear,
      },
      rows: yearRows,
      withoutYear,
    },
    phaseDistribution: {
      basis: {
        formula: "Processos ativos por fase ÷ total da carteira ativa. Passivo materializado = liquidação + execução.",
        population: "Carteira ativa",
        processCount: active.length,
      },
      rows: phaseRows,
      materializedCount: materialized.length,
      materializedShare: active.length > 0 ? materialized.length / active.length : 0,
      materializedLiquidatedCents: materialized.reduce((acc, p) => acc + (p.liquidated ?? 0), 0),
      materializedLiquidatedUnknown: materialized.filter((p) => p.liquidated === null).length,
    },
    repeatPlaintiffs: {
      basis: {
        formula: "Partes do polo ativo (exceto a empresa) com o mesmo nome (sem diferenciar acentos e maiúsculas) em mais de um processo.",
        population: "Processos ativos e encerrados",
        processCount: all.length,
      },
      plaintiffCount: repeated.length,
      processCount: repeatedProcessIds.size,
      names,
    },
    collectiveActions: {
      basis: {
        formula: "Classe de ação civil pública / ação coletiva (ACPCiv) ou parte com papel “Ministério Público”.",
        population: "Processos ativos e encerrados",
        processCount: all.length,
      },
      count: collective.length,
      processes: collective,
    },
    verification: {
      basis: {
        formula: "Processos ativos pendentes de conferência ÷ total da carteira ativa.",
        population: "Carteira ativa",
        processCount: active.length,
      },
      count: verifyCount,
      share: active.length > 0 ? verifyCount / active.length : 0,
    },
    closureOutcomes: {
      basis: {
        formula: "Processos encerrados por motivo de saída da carteira ÷ total de encerrados.",
        population: "Processos encerrados ou arquivados",
        processCount: closed.length,
      },
      rows: closureRows,
    },
    liquidatedRatio: {
      basis: {
        formula: "Soma do valor liquidado ÷ soma do valor da causa, por tribunal, somente processos com os dois valores informados (é uma razão, os valores não são somados entre si).",
        population: "Processos com valor da causa e valor liquidado",
        processCount: withBoth.length,
      },
      rows: ratioRows.slice(0, TOP_N),
    },
    recurringClaims,
  };

  const riskFactors = computeRiskFactors({
    active,
    byCourt,
    classRows,
    allCount: all.length,
    materializedCount: materialized.length,
    verifyCount,
    repeatedCount: repeated.length,
    repeatedProcessCount: repeatedProcessIds.size,
    collectiveCount: collective.length,
    ratioRows,
    yearRows,
  });

  // Conciliation candidate: court with most active processes in the knowledge phase.
  const knowledge = active.filter((p) => p.phase === "knowledge");
  const knowledgeByCourt = groupStats(knowledge, (p) => courtGroup(p.court), knowledge.length).filter((g) => g.key !== NONE_KEY);
  const knowledgeTop: KnowledgeByCourt | null = knowledgeByCourt[0]
    ? { court: knowledgeByCourt[0].label, count: knowledgeByCourt[0].count, totalKnowledge: knowledge.length }
    : null;

  const suggestions = buildSuggestions({ ...indicators, riskFactors }, knowledgeTop);
  const existing = can(ctx, "occurrence:read")
    ? await findPreventiveIntelOccurrences(
        ctx,
        suggestions.map((s) => s.key),
        { openOnly: true },
      )
    : new Map();

  return {
    generatedAt: new Date(),
    scope: scopeOf(ctx),
    filterSummary: summary,
    ...indicators,
    riskFactors,
    suggestions: suggestions.map((s) => ({ ...s, existingOccurrence: existing.get(s.key) ?? null })),
  };
}

function computeRiskFactors(d: {
  active: ProcessRow[];
  byCourt: GroupStat[];
  classRows: GroupStat[];
  allCount: number;
  materializedCount: number;
  verifyCount: number;
  repeatedCount: number;
  repeatedProcessCount: number;
  collectiveCount: number;
  ratioRows: RatioStat[];
  yearRows: YearStat[];
}): RiskFactor[] {
  const t = RISK_FACTOR_THRESHOLDS;
  const out: RiskFactor[] = [];
  const activeCount = d.active.length;

  const topCourt = d.byCourt.find((g) => g.key !== NONE_KEY);
  if (topCourt && activeCount > 0 && topCourt.share >= t.courtConcentration) {
    out.push({
      key: "court-concentration",
      title: `Concentração no ${topCourt.label}`,
      value: `${pct(topCourt.share)} da carteira ativa`,
      explanation: `${formatNumber(topCourt.count)} de ${formatNumber(activeCount)} processos ativos estão no ${topCourt.label}. Limiar de referência: ${pct(t.courtConcentration)}.`,
    });
  }
  if (activeCount > 0 && d.materializedCount / activeCount >= t.materializedShare) {
    out.push({
      key: "materialized",
      title: "Passivo materializado elevado",
      value: `${pct(d.materializedCount / activeCount)} em liquidação ou execução`,
      explanation: `${formatNumber(d.materializedCount)} de ${formatNumber(activeCount)} processos ativos estão em liquidação ou execução (dívida em apuração ou cobrança). Limiar de referência: ${pct(t.materializedShare)}.`,
    });
  }
  if (d.repeatedCount > 0) {
    out.push({
      key: "repeat-plaintiffs",
      title: "Reclamantes recorrentes",
      value: pluralize(d.repeatedCount, "parte autora", "partes autoras"),
      explanation: `${pluralize(d.repeatedCount, "parte autora aparece", "partes autoras aparecem")} em mais de um processo (${pluralize(d.repeatedProcessCount, "processo envolvido", "processos envolvidos")}). Qualquer ocorrência gera o sinal.`,
    });
  }
  if (d.collectiveCount > 0) {
    out.push({
      key: "collective",
      title: "Ações coletivas ou com o Ministério Público",
      value: pluralize(d.collectiveCount, "processo", "processos"),
      explanation: "Classe de ação civil pública / coletiva ou Ministério Público como parte. Qualquer ocorrência gera o sinal.",
    });
  }
  if (activeCount > 0 && d.verifyCount / activeCount >= t.verificationShare) {
    out.push({
      key: "verification",
      title: "Cadastros pendentes de conferência",
      value: `${pct(d.verifyCount / activeCount)} da carteira ativa`,
      explanation: `${formatNumber(d.verifyCount)} de ${formatNumber(activeCount)} processos ativos estão pendentes de conferência (dados incompletos ou divergentes). Limiar de referência: ${pct(t.verificationShare)}.`,
    });
  }
  const topClass = d.classRows.find((g) => g.key !== NONE_KEY);
  if (topClass && d.allCount > 0 && topClass.share >= t.classDominance) {
    out.push({
      key: "class-dominance",
      title: `Predominância da classe ${topClass.label}`,
      value: `${pct(topClass.share)} dos processos`,
      explanation: `${formatNumber(topClass.count)} de ${formatNumber(d.allCount)} processos são da classe ${topClass.label}. Limiar de referência: ${pct(t.classDominance)}.`,
    });
  }
  for (const r of d.ratioRows) {
    if (r.processCount >= t.ratioMinProcesses && r.ratio > t.ratioAboveClaim) {
      out.push({
        key: `ratio-${textKey(r.court).replace(/[^a-z0-9]+/g, "-")}`,
        title: `Liquidado acima do valor da causa no ${r.court}`,
        value: `razão ${r.ratio.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}`,
        explanation: `Nos ${formatNumber(r.processCount)} processos do ${r.court} com os dois valores, o valor liquidado soma ${r.ratio.toLocaleString("pt-BR", { maximumFractionDigits: 2 })} vez(es) o valor da causa. Sinal gerado quando a razão passa de 1 com pelo menos ${t.ratioMinProcesses} processos.`,
      });
    }
  }
  const lastFull = Number(todayISO().slice(0, 4)) - 1;
  const y1 = d.yearRows.find((y) => y.year === lastFull);
  const y0 = d.yearRows.find((y) => y.year === lastFull - 1);
  if (y1 && y0 && y0.count >= t.filingMinPerYear && y1.count >= t.filingMinPerYear && (y1.count - y0.count) / y0.count >= t.filingGrowth) {
    out.push({
      key: "filing-growth",
      title: "Aumento de ajuizamentos",
      value: `${formatNumber(y1.count)} em ${lastFull} × ${formatNumber(y0.count)} em ${lastFull - 1}`,
      explanation: `Crescimento de ${pct((y1.count - y0.count) / y0.count)} no número de processos ajuizados no último ano completo. Limiar de referência: ${pct(t.filingGrowth)} (mínimo de ${t.filingMinPerYear} processos por ano).`,
    });
  }
  return out;
}

/** Filter options of /inteligencia-preventiva (courts of the processes visible to ctx). */
export async function listPreventiveIntelFilterOptions(
  ctx: AuthContext,
): Promise<{ companies: { id: string; name: string }[]; courts: string[] }> {
  assertCan(ctx, "preventive_intel:read");
  const db = getDb();
  const [companyRows, courtRows] = await Promise.all([
    db
      .select({ id: companies.id, name: companies.name })
      .from(companies)
      .where(and(eq(companies.organizationId, ctx.organizationId), eq(companies.isActive, true)))
      .orderBy(asc(companies.name)),
    db
      .selectDistinct({ court: legalProcesses.court })
      .from(legalProcesses)
      .where(processWhere(ctx))
      .orderBy(asc(legalProcesses.court)),
  ]);
  return { companies: companyRows, courts: courtRows.map((r) => r.court).filter((c) => c.trim() !== "") };
}

// ---------------------------------------------------------------------------
// Explicit actions: occurrence and action plan from a suggestion
// ---------------------------------------------------------------------------

const PLAN_TASK_DESCRIPTION = `Item de plano de ação sugerido pela inteligência preventiva (${SUGGESTION_LABEL.toLowerCase()}). Ajuste, atribua um responsável e defina o prazo.`;

async function activeSuggestion(
  ctx: AuthContext,
  key: string,
  filters: PreventiveIntelFilters,
): Promise<{ intel: PreventiveIntelligence; suggestion: PreventiveIntelligence["suggestions"][number] }> {
  if (!isPreventiveIndicatorKey(key)) throw new ValidationError("Sugestão inválida.", { key: ["Sugestão inválida."] });
  // Recomputed on the server: the indicator text never comes from the client.
  const intel = await getPreventiveIntelligence(ctx, filters);
  const suggestion = intel.suggestions.find((s) => s.key === key);
  if (!suggestion) {
    throw new ConflictError("Este indicador não está mais ativo com os filtros atuais. Atualize a página e tente novamente.");
  }
  return { intel, suggestion };
}

async function createFromSuggestion(
  ctx: AuthContext,
  s: PreventiveSuggestion,
  filterText: string,
): Promise<{ occurrenceId: string }> {
  const { id } = await createOccurrence(ctx, {
    title: `Inteligência preventiva: ${s.title}`.slice(0, 200),
    facts: buildSuggestionFacts(s, { today: todayISO(), filterSummary: filterText }),
    category: "labor",
    riskLevel: "medium",
    areasInvolved: ["Jurídico", "Recursos Humanos"],
    responsibleId: ctx.kind === "user" ? ctx.userId : null,
  });
  return { occurrenceId: id };
}

/**
 * Creates a preventive occurrence (category labor) describing the indicator
 * of the suggestion. Requires `preventive_intel:read` and `occurrence:write`.
 * Refuses when an open occurrence from the same indicator already exists.
 */
export async function createOccurrenceFromSuggestion(
  ctx: AuthContext,
  key: string,
  filters: PreventiveIntelFilters = {},
): Promise<{ occurrenceId: string }> {
  assertCan(ctx, "preventive_intel:read");
  assertCan(ctx, "occurrence:write");
  const { intel, suggestion } = await activeSuggestion(ctx, key, filters);
  if (suggestion.existingOccurrence) {
    throw new ConflictError("Já existe uma ocorrência em aberto criada a partir deste indicador.");
  }
  return createFromSuggestion(ctx, suggestion, intel.filterSummary);
}

/**
 * Creates the illustrative action plan (tasks of kind `action_plan`) of a
 * suggestion, linked to the open occurrence of the indicator (created first
 * when none exists). Items already present are not duplicated. Requires
 * `preventive_intel:read` and `task:write` (+ `occurrence:write` to create the occurrence).
 */
export async function createActionPlanFromSuggestion(
  ctx: AuthContext,
  key: string,
  filters: PreventiveIntelFilters = {},
): Promise<{ occurrenceId: string; created: number; skipped: number; createdOccurrence: boolean }> {
  assertCan(ctx, "preventive_intel:read");
  assertCan(ctx, "task:write");
  const { intel, suggestion } = await activeSuggestion(ctx, key, filters);

  let occurrenceId = suggestion.existingOccurrence?.id ?? null;
  let status: OccurrenceStatus = (suggestion.existingOccurrence?.status as OccurrenceStatus | undefined) ?? "open";
  let createdOccurrence = false;
  if (!occurrenceId) {
    assertCan(ctx, "occurrence:write");
    occurrenceId = (await createFromSuggestion(ctx, suggestion, intel.filterSummary)).occurrenceId;
    status = "open";
    createdOccurrence = true;
  }

  const existingTasks = await getDb()
    .select({ title: tasks.title })
    .from(tasks)
    .where(and(taskWhere(ctx), eq(tasks.occurrenceId, occurrenceId), eq(tasks.kind, "action_plan")));
  const present = new Set(existingTasks.map((t) => textKey(t.title)));

  let created = 0;
  let skipped = 0;
  for (const item of suggestion.planItems) {
    if (present.has(textKey(item))) {
      skipped += 1;
      continue;
    }
    await createTask(ctx, {
      title: item,
      description: PLAN_TASK_DESCRIPTION,
      kind: "action_plan",
      priority: "medium",
      occurrenceId,
    });
    created += 1;
  }

  if (created > 0 && can(ctx, "occurrence:write") && (status === "open" || status === "under_analysis")) {
    await updateOccurrence(ctx, occurrenceId, { status: "action_plan" });
  }
  return { occurrenceId, created, skipped, createdOccurrence };
}
