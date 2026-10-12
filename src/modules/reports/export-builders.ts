/**
 * Report -> tabular export (pure, client-safe). One builder per report type;
 * the CSV file carries the sheet at `csvSheet` (the report's main table) and
 * the XLSX carries every sheet plus a "Sobre" sheet with filters, scope and
 * the reading rules (RN-02 / RN-03 / RN-07).
 */
import type { MoneyBucket } from "@/domain/contingency";
import {
  PROCESS_INSTANCE_LABELS,
  PROCESS_PHASE_LABELS,
  CLOSURE_REASON_LABELS,
  VALUATION_KIND_LABELS,
} from "@/domain/enums";
import { formatDate, formatDateTime, formatMonthYear, toISODate } from "@/lib/format";
import { cell, type ExportCell, type ExportColumn, type ExportSheet, type ReportExport } from "./csv";
import {
  CLASSIFICATION_LABELS,
  MOVEMENT_EVENT_LABELS,
  PROVISION_MOVEMENT_LABELS,
  REPORT_TYPE_LABELS,
  type AuditLetterReport,
  type BucketRow,
  type ExposureReport,
  type MovementReport,
  type PortfolioReport,
  type ProvisionReport,
  type ReportData,
  type ResponsiblesReport,
} from "./types";

export const READING_RULES = [
  "Valor da causa e valor liquidado são grandezas distintas e nunca são somados (RN-02).",
  "Valores não informados ou não apurados não equivalem a zero: são contados à parte e ficam em branco nas exportações (RN-03).",
  "Exposição e provisão estimadas (calculadas sobre o valor da causa, sem valor liquidado) ficam em colunas próprias e devem ser lidas com ressalva (RN-07).",
];

/** Sum of known values, or null when every value of the group is unknown (RN-03). */
function knownSum(total: number, count: number, unknown: number): number | null {
  return count > 0 && unknown >= count ? null : total;
}

const BUCKET_COLUMNS: ExportColumn[] = [
  { header: "Processos (CNJ únicos)", width: 12 },
  { header: "Valor da causa (R$)", width: 18 },
  { header: "Processos sem valor da causa", width: 14 },
  { header: "Valor liquidado (R$)", width: 18 },
  { header: "Liquidado não apurado (processos)", width: 16 },
  { header: "Garantias vinculadas (R$)", width: 18 },
  { header: "Exposição oficial (R$)", width: 18 },
  { header: "Exposição estimada (R$) — RN-07", width: 20 },
  { header: "Exposição não calculável (processos)", width: 16 },
  { header: "Provisão (R$)", width: 18 },
  { header: "Provisão estimada (R$) — RN-07", width: 20 },
];

function bucketCells(processCount: number, b: MoneyBucket): ExportCell[] {
  return [
    cell.int(processCount),
    cell.money(knownSum(b.claimCents, b.count, b.claimUnknown)),
    cell.int(b.claimUnknown),
    cell.money(knownSum(b.liquidatedCents, b.count, b.liquidatedUnknown)),
    cell.int(b.liquidatedUnknown),
    cell.money(b.guaranteesCents),
    cell.money(b.exposureCents),
    cell.money(b.exposureEstimateCents),
    cell.int(b.exposureUnknown),
    cell.money(b.provisionCents),
    cell.money(b.provisionEstimateCents),
  ];
}

function bucketRowCells(group: string, r: BucketRow): ExportCell[] {
  return [cell.text(group), cell.text(r.label), ...bucketCells(r.processCount, r.bucket)];
}

function about(report: ReportData, extra: { label: string; value: string }[] = []): { label: string; value: string }[] {
  return [
    { label: "Relatório", value: REPORT_TYPE_LABELS[report.type] },
    { label: "Organização", value: report.organizationName },
    { label: "Emitido em", value: formatDateTime(report.generatedAt) },
    { label: "Filtros", value: report.filterSummary },
    { label: "Escopo", value: report.scope.label },
    ...extra,
    ...READING_RULES.map((rule, i) => ({ label: i === 0 ? "Regras de leitura" : "", value: rule })),
    { label: "Origem dos dados", value: "Gerado a partir dos registros do sistema; não constitui parecer jurídico." },
  ];
}

function fileBase(report: ReportData, suffix?: string): string {
  return `relatorio-${report.type}-${suffix ?? toISODate(report.generatedAt)}`;
}

function portfolioExport(r: PortfolioReport): ReportExport {
  const sheet: ExportSheet = {
    name: "Carteira",
    columns: [{ header: "Agrupamento", width: 16 }, { header: "Grupo", width: 34 }, ...BUCKET_COLUMNS],
    rows: [
      ...r.byCompany.map((row) => bucketRowCells("Empresa", row)),
      ...r.byUnit.map((row) => bucketRowCells("Unidade", row)),
      ...r.byClassification.map((row) => bucketRowCells("Classificação de risco", row)),
      bucketRowCells("Total", r.totals),
    ],
  };
  return { fileBase: fileBase(r), title: REPORT_TYPE_LABELS[r.type], about: about(r), sheets: [sheet], csvSheet: 0 };
}

function exposureExport(r: ExposureReport): ReportExport {
  const prevHeader = r.comparison ? ` — ${formatMonthYear(`${r.comparison.period}-01`)}` : " — competência anterior";
  const rows: ExportCell[][] = [];
  const push = (dimension: string, row: ExposureReport["totals"]) => {
    const p = row.previous;
    rows.push([
      ...bucketRowCells(dimension, row),
      cell.int(p ? p.processCount : null),
      cell.money(p ? p.exposureCents : null),
      cell.money(p ? p.exposureEstimateCents : null),
      cell.money(p ? row.bucket.exposureCents - p.exposureCents : null),
      cell.money(p ? row.bucket.exposureEstimateCents - p.exposureEstimateCents : null),
    ]);
  };
  for (const dim of r.dimensions) for (const row of dim.rows) push(dim.label, row);
  push("Total", r.totals);
  const sheet: ExportSheet = {
    name: "Exposição",
    columns: [
      { header: "Dimensão", width: 12 },
      { header: "Grupo", width: 34 },
      ...BUCKET_COLUMNS,
      { header: `Processos${prevHeader}`, width: 14 },
      { header: `Exposição oficial (R$)${prevHeader}`, width: 20 },
      { header: `Exposição estimada (R$)${prevHeader}`, width: 20 },
      { header: "Variação da exposição oficial (R$)", width: 20 },
      { header: "Variação da exposição estimada (R$)", width: 20 },
    ],
    rows,
  };
  const extra = [
    {
      label: "Comparação",
      value: r.comparison
        ? `Fechamento de ${formatMonthYear(`${r.comparison.period}-01`)} (${r.comparison.status === "closed" ? "competência fechada" : "prévia"}).`
        : (r.comparisonNote ?? "Sem comparação."),
    },
  ];
  return { fileBase: fileBase(r), title: REPORT_TYPE_LABELS[r.type], about: about(r, extra), sheets: [sheet], csvSheet: 0 };
}

function provisionExport(r: ProvisionReport): ReportExport {
  const byClass: ExportSheet = {
    name: "Por classificação",
    columns: [
      { header: "Classificação", width: 20 },
      { header: "Percentual (%)", width: 12 },
      { header: "Processos", width: 12 },
      { header: "Provisão (R$)", width: 18 },
      { header: "Provisão estimada (R$) — RN-07", width: 20 },
      { header: "Processos (competência anterior)", width: 14 },
      { header: "Provisão (R$) — competência anterior", width: 20 },
      { header: "Provisão estimada (R$) — competência anterior", width: 20 },
    ],
    rows: [...r.byClassification, r.totals].map((c, i, all) => [
      cell.text(i === all.length - 1 ? c.label : CLASSIFICATION_LABELS[c.key]),
      cell.bp(c.percentageBp),
      cell.int(c.processCount),
      cell.money(c.current.provisionCents),
      cell.money(c.current.provisionEstimateCents),
      cell.int(c.previous ? c.previous.processCount : null),
      cell.money(c.previous ? c.previous.provisionCents : null),
      cell.money(c.previous ? c.previous.provisionEstimateCents : null),
    ]),
  };
  const movement: ExportSheet = {
    name: "Movimentação",
    columns: [
      { header: "Movimento", width: 34 },
      { header: "Processos", width: 12 },
      { header: "Provisão (R$)", width: 18 },
      { header: "Provisão estimada (R$) — RN-07", width: 20 },
    ],
    rows: r.movement
      ? [
          [cell.text("Saldo da competência anterior"), cell.int(null), cell.money(r.movement.opening.provisionCents), cell.money(r.movement.opening.provisionEstimateCents)],
          ...r.movement.rows.map((m) => [
            cell.text(PROVISION_MOVEMENT_LABELS[m.kind]),
            cell.int(m.processCount),
            cell.money(m.provisionCents),
            cell.money(m.provisionEstimateCents),
          ]),
          [cell.text("Saldo da competência"), cell.int(null), cell.money(r.movement.closing.provisionCents), cell.money(r.movement.closing.provisionEstimateCents)],
        ]
      : [],
  };
  const items: ExportSheet = {
    name: "Processos",
    columns: [
      { header: "Nº do processo", width: 28 },
      { header: "Classificação", width: 16 },
      { header: "Percentual (%)", width: 12 },
      { header: "Valor da causa (R$)", width: 18 },
      { header: "Valor liquidado (R$)", width: 18 },
      { header: "Garantias vinculadas (R$)", width: 18 },
      { header: "Provisão (R$)", width: 18 },
      { header: "Provisão estimada (RN-07)", width: 14 },
      { header: "Provisão anterior (R$)", width: 18 },
      { header: "Provisão anterior estimada", width: 14 },
      { header: "Movimento", width: 30 },
    ],
    rows: r.items.map((i) => [
      cell.text(i.number),
      cell.text(i.movement === "left" ? "Fora da competência" : CLASSIFICATION_LABELS[i.classification ?? "unclassified"]),
      cell.bp(i.percentageBp),
      cell.money(i.claimCents),
      cell.money(i.liquidatedCents),
      cell.money(i.movement === "left" ? null : i.guaranteesCents),
      cell.money(i.provisionCents),
      cell.bool(i.movement === "left" ? null : i.provisionIsEstimate),
      cell.money(i.previousProvisionCents),
      cell.bool(i.previousProvisionCents === null ? null : i.previousIsEstimate),
      cell.text(i.movement ? PROVISION_MOVEMENT_LABELS[i.movement] : null),
    ]),
  };
  const extra = r.snapshot
    ? [
        { label: "Competência", value: `${formatMonthYear(`${r.snapshot.period}-01`)} (data-base ${formatDate(r.snapshot.referenceDate)}), fechada${r.snapshot.closedAt ? ` em ${formatDateTime(r.snapshot.closedAt)}` : ""}${r.snapshot.closedByName ? ` por ${r.snapshot.closedByName}` : ""}.` },
        {
          label: "Competência anterior",
          value: r.previous ? formatMonthYear(`${r.previous.period}-01`) : "Não há competência fechada anterior: movimentação não calculada.",
        },
      ]
    : [{ label: "Competência", value: "Nenhuma competência fechada disponível." }];
  return {
    fileBase: fileBase(r, r.snapshot ? `${r.snapshot.period}` : undefined),
    title: REPORT_TYPE_LABELS[r.type],
    about: about(r, extra),
    sheets: [byClass, movement, items],
    csvSheet: 2,
  };
}

function auditExport(r: AuditLetterReport): ReportExport {
  const sheet: ExportSheet = {
    name: "Relação de processos",
    columns: [
      { header: "Nº do processo", width: 28 },
      { header: "Título", width: 40 },
      { header: "Tribunal", width: 12 },
      { header: "Vara / órgão julgador", width: 30 },
      { header: "Instância", width: 14 },
      { header: "Fase", width: 18 },
      { header: "Classificação de risco", width: 16 },
      { header: "Percentual (%)", width: 12 },
      { header: "Valor da causa (R$)", width: 18 },
      { header: "Valor liquidado (R$)", width: 18 },
      { header: "Garantias vinculadas (R$)", width: 18 },
      { header: "Exposição (R$)", width: 18 },
      { header: "Exposição estimada (RN-07)", width: 14 },
      { header: "Provisão (R$)", width: 18 },
      { header: "Provisão estimada (RN-07)", width: 14 },
      { header: "Ressalvas", width: 60 },
    ],
    rows: r.rows.map((p) => [
      cell.text(p.number),
      cell.text(p.title),
      cell.text(p.court),
      cell.text(p.courtDivision),
      cell.text(p.instance ? PROCESS_INSTANCE_LABELS[p.instance] : null),
      cell.text(p.phase ? PROCESS_PHASE_LABELS[p.phase] : null),
      cell.text(CLASSIFICATION_LABELS[p.classification ?? "unclassified"]),
      cell.bp(p.percentageBp),
      cell.money(p.claimCents),
      cell.money(p.liquidatedCents),
      cell.money(p.guaranteesCents),
      cell.money(p.exposureCents),
      cell.bool(p.exposureCents === null ? null : p.exposureIsEstimate),
      cell.money(p.provisionCents),
      cell.bool(p.provisionCents === null ? null : p.provisionIsEstimate),
      cell.text(p.caveats.length > 0 ? p.caveats.join(" ") : null),
    ]),
  };
  const extra = [
    { label: "Data-base", value: formatDate(r.baseDate) },
    {
      label: "Fonte das posições",
      value: r.snapshot
        ? `Competência ${formatMonthYear(`${r.snapshot.period}-01`)} fechada (imutável).`
        : "Posição atual na data de emissão (não corresponde a competência fechada).",
    },
    ...r.generalCaveats.map((c, i) => ({ label: i === 0 ? "Ressalvas gerais" : "", value: c })),
    { label: "Assinatura", value: "Advogado(a) responsável: ______________________  OAB nº ________  Data: ___/___/______" },
  ];
  return {
    fileBase: fileBase(r, r.baseDate),
    title: `${REPORT_TYPE_LABELS[r.type]} — data-base ${formatDate(r.baseDate)}`,
    about: about(r, extra),
    sheets: [sheet],
    csvSheet: 0,
  };
}

function movementExport(r: MovementReport): ReportExport {
  const events: ExportSheet = {
    name: "Movimentações",
    columns: [
      { header: "Data", width: 12 },
      { header: "Tipo de movimentação", width: 26 },
      { header: "Nº do processo", width: 28 },
      { header: "Título", width: 40 },
      { header: "Detalhe", width: 44 },
      { header: "Motivo de encerramento", width: 30 },
      { header: "Tipo de valor", width: 24 },
      { header: "Valor anterior (R$)", width: 18 },
      { header: "Valor novo (R$)", width: 18 },
      { header: "Estimativa (RN-07)", width: 12 },
    ],
    rows: r.events.map((e) => [
      cell.date(e.date),
      cell.text(MOVEMENT_EVENT_LABELS[e.kind]),
      cell.text(e.number),
      cell.text(e.title),
      cell.text(e.detail),
      cell.text(e.kind === "closed" ? (e.closureReason ? CLOSURE_REASON_LABELS[e.closureReason] : "Não informado") : null),
      cell.text(e.valuationKind ? VALUATION_KIND_LABELS[e.valuationKind] : null),
      cell.money(e.previousCents),
      cell.money(e.newCents),
      cell.bool(e.kind === "value_change" ? e.isEstimate : null),
    ]),
  };
  const summary: ExportSheet = {
    name: "Resumo",
    columns: [{ header: "Indicador", width: 44 }, { header: "Quantidade", width: 12 }],
    rows: [
      [cell.text("Entradas na carteira"), cell.int(r.summary.added)],
      [cell.text("Encerramentos"), cell.int(r.summary.closed)],
      ...r.summary.closedByReason.map((c) => [cell.text(`Encerramentos — ${c.label}`), cell.int(c.count)]),
      [cell.text("Alterações de valor oficial"), cell.int(r.summary.valueChanges)],
      [cell.text("Mudanças de fase"), cell.int(r.summary.phaseChanges)],
      [cell.text("Mudanças de situação"), cell.int(r.summary.statusChanges)],
      [cell.text("Valores propostos aguardando conferência (não listados)"), cell.int(r.pendingProposedValuations)],
    ],
  };
  const extra = [{ label: "Período", value: `${formatDate(r.from)} a ${formatDate(r.to)}` }];
  if (r.truncated) extra.push({ label: "Limite", value: "A lista foi limitada a 10.000 movimentações; reduza o período para ver todas." });
  return {
    fileBase: fileBase(r, `${r.from}_a_${r.to}`),
    title: REPORT_TYPE_LABELS[r.type],
    about: about(r, extra),
    sheets: [events, summary],
    csvSheet: 0,
  };
}

function responsiblesExport(r: ResponsiblesReport): ReportExport {
  const sheet: ExportSheet = {
    name: "Responsáveis",
    columns: [
      { header: "Agrupamento", width: 22 },
      { header: "Nome", width: 34 },
      ...BUCKET_COLUMNS,
      { header: "Sem classificação de risco (processos)", width: 16 },
    ],
    rows: [
      ...r.lawyers.map((row) => [...bucketRowCells("Advogado responsável", row), cell.int(row.unclassified)]),
      ...r.lawFirms.map((row) => [...bucketRowCells("Escritório externo", row), cell.int(row.unclassified)]),
      [...bucketRowCells("Total", r.totals), cell.int(r.totals.unclassified)],
    ],
  };
  return { fileBase: fileBase(r), title: REPORT_TYPE_LABELS[r.type], about: about(r), sheets: [sheet], csvSheet: 0 };
}

export function buildReportExport(report: ReportData): ReportExport {
  switch (report.type) {
    case "carteira":
      return portfolioExport(report);
    case "exposicao":
      return exposureExport(report);
    case "provisao":
      return provisionExport(report);
    case "auditoria":
      return auditExport(report);
    case "movimentacao":
      return movementExport(report);
    case "responsaveis":
      return responsiblesExport(report);
  }
}

/** What the CSV of each report contains (shown next to the export buttons). */
export const CSV_CONTENT_HINTS: Record<ReportData["type"], string> = {
  carteira: "uma linha por empresa, unidade e classificação, com o total",
  exposicao: "uma linha por tribunal, cidade, fase e instância, com a comparação",
  provisao: "a memória de cálculo por processo (o XLSX traz também os resumos)",
  auditoria: "a relação de processos com as ressalvas",
  movimentacao: "todas as movimentações do período (o XLSX traz também o resumo)",
  responsaveis: "uma linha por advogado e por escritório, com o total",
};
