import { formatDate, formatDateTime } from "@/lib/format";
import { renderPdf, type PdfBlock, type PdfDocumentSpec, type PdfTableColumn, type RenderedPdf } from "@/server/pdf";
import {
  baseKindLabel,
  CLASSIFICATION_ORDER,
  classificationLabel,
  effectiveFromText,
  estimateCaveatBody,
  generatedStatement,
  listedSumLabel,
  MEMO_CLASSIFICATION_SOURCE_LABELS,
  memoMoney,
  memoPercent,
  METHOD_LINES,
  NO_COMPANY_LABEL,
  NO_PROVISION_LABEL,
  NOT_ASSESSED_LABEL,
  NOT_INFORMED_LABEL,
  opinionText,
  overrideItemSituation,
  overrideRecordedText,
  parametersLabel,
  periodLabel,
  PREVIEW_LABEL,
  responsibleText,
  scopeLabel,
  SEPARATE_TOTALS_NOTE,
  statusLabel,
  totalsLineAmounts,
  UNCLASSIFIED_LABEL,
  type MemoTotalsLine,
  type ProvisionMemo,
  type ProvisionMemoRow,
} from "./memo";

/**
 * PDF da memória de cálculo pelo motor de relatórios (`@/server/pdf`: mesma
 * marca, cabeçalho e rodapé "Página X de Y"). É uma exportação operacional, não
 * um dos relatórios R1 a R4: sem marca d'água de aprovação; o rodapé diz que o
 * arquivo foi gerado a partir da competência (fechamento ou prévia) e quando.
 */

export const MEMO_HEADER_STRIPE = "CONFIDENCIAL · USO INTERNO";

const TOTALS_COLUMNS: PdfTableColumn[] = [
  { header: "", weight: 2.4 },
  { header: "Processos", weight: 0.9, align: "right" },
  { header: "Provisão apurada", weight: 1.5, align: "right" },
  { header: "Provisão estimada", weight: 1.5, align: "right" },
  { header: "Sem provisão", weight: 0.95, align: "right" },
];

/** Coluna de totais sem nenhum valor na linha: "Sem provisão", nunca R$ 0,00 (`totalsLineAmounts`). */
function totalsAmountCells(l: MemoTotalsLine): [string, string] {
  const a = totalsLineAmounts(l);
  return [
    a.officialCents === null ? NO_PROVISION_LABEL : memoMoney(a.officialCents),
    a.estimateCents === null ? NO_PROVISION_LABEL : `${memoMoney(a.estimateCents)}\n${l.estimateCount} estimada(s)`,
  ];
}

function totalsTable(caption: string, firstHeader: string, lines: MemoTotalsLine[], overall: MemoTotalsLine, note: string): PdfBlock {
  const row = (l: MemoTotalsLine) => [l.label, String(l.count), ...totalsAmountCells(l), String(l.withoutProvisionCount)];
  return {
    type: "table",
    caption,
    columns: TOTALS_COLUMNS.map((c, i) => (i === 0 ? { ...c, header: firstHeader } : c)),
    rows: lines.map(row),
    totals: row(overall),
    note,
    emptyText: "Nenhum processo nesta competência.",
  };
}

function processCell(r: ProvisionMemoRow): string {
  const lines = [r.number, r.companyName ?? NO_COMPANY_LABEL];
  if (r.processDeleted) lines.push("Excluído do sistema depois do cálculo");
  if (r.inCloseOverride) lines.push("Na ressalva do fechamento");
  return lines.join("\n");
}

function baseCell(r: ProvisionMemoRow): string {
  if (r.baseKind === "none") return `Sem base\nValor apurado: ${NOT_ASSESSED_LABEL}\nValor da causa: ${NOT_INFORMED_LABEL}`;
  const lines = [baseKindLabel(r), r.baseCents !== null ? memoMoney(r.baseCents) : NOT_INFORMED_LABEL];
  if (r.baseKind === "net_liquidated") {
    lines.push(`Valor apurado ${r.liquidatedAmountCents !== null ? memoMoney(r.liquidatedAmountCents) : NOT_ASSESSED_LABEL}`);
    lines.push(`Garantias abatidas ${memoMoney(r.guaranteesDeductedCents ?? 0)}`);
  } else {
    lines.push(`Valor apurado: ${NOT_ASSESSED_LABEL}`);
    lines.push(r.guaranteesCents > 0 ? `Garantias ${memoMoney(r.guaranteesCents)} não abatidas` : "Sem garantias vinculadas");
  }
  return lines.join("\n");
}

function classificationCell(r: ProvisionMemoRow): string {
  if (r.classification === null && r.percentageBp === null) return UNCLASSIFIED_LABEL;
  return `${classificationLabel(r.classification)} · ${memoPercent(r.percentageBp)}`;
}

function classificationOriginCell(r: ProvisionMemoRow): string {
  const lines = [classificationCell(r)];
  if (r.classificationSource !== "unclassified") lines.push(MEMO_CLASSIFICATION_SOURCE_LABELS[r.classificationSource]);
  const since = effectiveFromText(r);
  if (since) lines.push(since);
  return lines.join("\n");
}

function provisionCells(r: ProvisionMemoRow): [string, string] {
  if (r.provisionCents === null) return [NO_PROVISION_LABEL, ""];
  return r.provisionIsEstimate ? ["", `${memoMoney(r.provisionCents)}\nestimada`] : [memoMoney(r.provisionCents), ""];
}

export function buildProvisionMemoPdfSpec(memo: ProvisionMemo): PdfDocumentSpec {
  const period = periodLabel(memo.period);
  const baseDate = formatDate(memo.referenceDate, memo.referenceDate);
  const isPreview = memo.status !== "closed";
  const blocks: PdfBlock[] = [];
  const estimatesListed = memo.rows.filter((r) => r.provisionEstimateCents !== null).length;
  const estimatesTotal = memo.totals.overall.estimateCount;

  // Identificação.
  blocks.push(
    { type: "paragraph", style: "kicker", text: `Memória de cálculo da provisão · ${isPreview ? PREVIEW_LABEL : "Competência fechada"}` },
    { type: "paragraph", style: "title", text: `Competência ${period}`, spaceBefore: 6 },
  );
  if (memo.organizationName) blocks.push({ type: "paragraph", style: "subtitle", text: memo.organizationName });
  blocks.push(
    { type: "rule", width: 48, thickness: 1.6, color: "gold", spaceBefore: 12, spaceAfter: 4 },
    {
      type: "keyValues",
      pairs: [
        { label: "Competência", value: period },
        { label: "Data-base", value: baseDate },
        { label: "Situação", value: statusLabel(memo) },
        {
          label: "Cálculo da competência",
          value: `${formatDateTime(memo.calculatedAt, "")} ${memo.calculatedByName ? `por ${memo.calculatedByName}` : "pela rotina automática"}`,
        },
        { label: "Parâmetros de risco", value: parametersLabel(memo.params) },
        { label: "Abrangência dos totais", value: scopeLabel(memo) },
        { label: "Processos listados", value: String(memo.rows.length) },
        { label: "Gerado em", value: `${formatDateTime(memo.exportedAt, "")}${memo.exportedByName ? ` por ${memo.exportedByName}` : ""}` },
      ],
    },
  );

  if (isPreview) {
    blocks.push({
      type: "callout",
      tone: "warning",
      title: PREVIEW_LABEL,
      lines: ["Os valores desta memória podem mudar até o fechamento da competência. Não use como posição contábil final."],
    });
  } else {
    blocks.push({
      type: "callout",
      tone: "info",
      title: "Competência fechada",
      lines: ["Valores lidos dos itens guardados no fechamento: lançamentos posteriores não alteram esta memória."],
    });
  }
  if (estimatesTotal > 0 || estimatesListed > 0) {
    blocks.push({
      type: "callout",
      tone: "warning",
      title: "Valores estimados",
      lines: [estimateCaveatBody(Math.max(estimatesTotal, estimatesListed))],
    });
  }
  if (memo.totals.hiddenCount > 0) {
    blocks.push({
      type: "callout",
      tone: "info",
      lines: [`Os totais da organização incluem ${memo.totals.hiddenCount} processo(s) sigiloso(s) não listado(s) nesta memória.`],
    });
  }
  if (memo.scope === "visible" && memo.scopeNote) blocks.push({ type: "callout", tone: "info", lines: [memo.scopeNote] });
  if (memo.deletedCount > 0) {
    blocks.push({
      type: "callout",
      tone: "info",
      lines: [
        `${memo.deletedCount} processo(s) listado(s) foram excluídos do sistema depois do ${isPreview ? "cálculo da prévia" : "fechamento"}: a posição registrada na competência foi mantida.`,
      ],
    });
  }
  if (memo.override) {
    blocks.push({
      type: "callout",
      tone: "warning",
      title: "Fechada com justificativa",
      lines:
        memo.override.reason === null
          ? ["A ressalva registrada no fechamento se refere a processos que não estão na sua lista."]
          : [`${memo.override.count} processo(s) sem classificação de risco oficial na data-base. Detalhes na seção 6.`],
    });
  }
  if (memo.isDemoOrganization) {
    blocks.push({ type: "callout", tone: "info", lines: ["Organização de demonstração: dados fictícios."] });
  }

  // 1. Como ler.
  blocks.push({ type: "heading", number: "1", text: "Como ler esta memória" });
  for (const line of METHOD_LINES) blocks.push({ type: "paragraph", text: line });

  // 2 e 3. Totais.
  const totalsNote = `${SEPARATE_TOTALS_NOTE} ${memo.totals.organizationWide ? "Totais da organização." : "Totais dos processos listados."}${
    memo.totals.hiddenCount > 0 ? ` Incluem ${memo.totals.hiddenCount} processo(s) sigiloso(s) não listado(s).` : ""
  }`;
  const byClass = new Map(memo.totals.byClassification.map((l) => [l.key, l]));
  blocks.push({ type: "heading", number: "2", text: "Totais por classificação" });
  blocks.push(
    totalsTable(
      "Provisão por classificação de risco na data-base",
      "Classificação",
      CLASSIFICATION_ORDER.map((k) => byClass.get(k)).filter((l): l is MemoTotalsLine => !!l),
      memo.totals.overall,
      totalsNote,
    ),
  );
  blocks.push({ type: "heading", number: "3", text: "Totais por empresa" });
  blocks.push(totalsTable("Provisão por empresa", "Empresa", memo.totals.byCompany, memo.totals.overall, totalsNote));

  // 4. Memória por processo.
  blocks.push({ type: "heading", number: "4", text: "Memória por processo" });
  blocks.push({
    type: "table",
    caption: "Valores guardados na competência, um processo por linha. Provisão = base aplicável × percentual.",
    columns: [
      { header: "Processo (CNJ) e empresa", weight: 2.3 },
      { header: "Base aplicável", weight: 2.65 },
      { header: "Classificação e percentual", weight: 1.45 },
      { header: "Provisão apurada", weight: 1.3, align: "right" },
      { header: "Provisão estimada", weight: 1.3, align: "right" },
    ],
    rows: memo.rows.map((r) => [processCell(r), baseCell(r), classificationCell(r), ...provisionCells(r)]),
    totals: memo.rows.length > 0 ? [listedSumLabel(memo.rows.length), "", "", ...totalsAmountCells(memo.listedTotals)] : null,
    note: SEPARATE_TOTALS_NOTE,
    emptyText: "Nenhum processo listado para o seu perfil nesta competência.",
  });

  // 5. Classificação, parecer e responsável.
  blocks.push({ type: "heading", number: "5", text: "Classificação, parecer e responsável" });
  blocks.push({
    type: "table",
    caption: "Avaliação oficial em vigor na data-base quando a competência foi calculada.",
    columns: [
      { header: "Processo (CNJ)", weight: 2.2 },
      { header: "Classificação e origem", weight: 2.2 },
      { header: "Responsável pela classificação", weight: 1.6 },
      { header: "Parecer em vigor na data-base", weight: 3.15 },
    ],
    rows: memo.rows.map((r) => [r.number, classificationOriginCell(r), responsibleText(r), opinionText(r)]),
    emptyText: "Nenhum processo listado para o seu perfil nesta competência.",
  });

  // 6. Ressalva do fechamento.
  const o = memo.override;
  if (o) {
    blocks.push({ type: "heading", number: "6", text: "Fechamento com justificativa" });
    if (o.reason === null) {
      blocks.push({
        type: "paragraph",
        text: "Nenhum dos processos que você pode ver estava sem classificação de risco oficial na data-base. A ressalva registrada no fechamento se refere a processos que não estão na sua lista.",
      });
    } else {
      blocks.push({
        type: "keyValues",
        columns: 1,
        pairs: [
          { label: "Justificativa", value: o.reason },
          { label: "Registrada por", value: overrideRecordedText(o) },
          {
            label: "Processos sem classificação",
            value: `${o.count}${o.hiddenCount > 0 ? ` (inclui ${o.hiddenCount} sigiloso(s) não listado(s))` : ""}`,
          },
        ],
      });
      const rowBy = new Map(memo.rows.map((r) => [r.processId, r]));
      blocks.push({
        type: "table",
        caption: "Processos sem classificação de risco oficial na data-base",
        columns: [
          { header: "Processo (CNJ)", weight: 2 },
          { header: "Situação no fechamento", weight: 4 },
        ],
        rows: o.items.map((i) => [i.number, overrideItemSituation(i, rowBy.get(i.processId))]),
        emptyText: "Nenhum processo da ressalva está na sua lista.",
      });
    }
  }

  return {
    info: {
      title: `Memória de cálculo da provisão · Competência ${period}${isPreview ? " (prévia)" : ""}`,
      subject: "Memória de cálculo da provisão",
      keywords: ["Praetor", "provisão", period],
      createdAt: memo.exportedAt,
    },
    headerStripe: MEMO_HEADER_STRIPE,
    footer: {
      reference: `Memória de cálculo · Competência ${period}`,
      baseDateLabel: `Data-base ${baseDate}`,
      statement: generatedStatement(memo),
    },
    watermark: null,
    blocks,
  };
}

export async function renderProvisionMemoPdf(memo: ProvisionMemo): Promise<RenderedPdf> {
  return renderPdf(buildProvisionMemoPdfSpec(memo));
}
