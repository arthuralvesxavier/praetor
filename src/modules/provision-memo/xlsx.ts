import writeXlsxFile, { type Cell, type Row, type Sheet } from "write-excel-file/node";
import { formatDate, formatDateTime } from "@/lib/format";
import {
  baseKindLabel,
  CLASSIFICATION_ORDER,
  classificationLabel,
  estimateCaveat,
  generatedStatement,
  MEMO_CLASSIFICATION_SOURCE_LABELS,
  METHOD_LINES,
  listedSumLabel,
  opinionText,
  overrideItemSituation,
  overrideRecordedText,
  parametersLabel,
  periodLabel,
  PREVIEW_LABEL,
  rowFormula,
  scopeLabel,
  SEPARATE_TOTALS_NOTE,
  statusLabel,
  totalsLineAmounts,
  type MemoTotalsLine,
  type ProvisionMemo,
  type ProvisionMemoRow,
} from "./memo";

/**
 * XLSX da memória de cálculo (write-excel-file/node): abas "Memória" (uma linha
 * por processo listado) e "Totais" (por classificação e por empresa, com as
 * ressalvas). Dinheiro em reais com 2 casas, percentual como fração com formato
 * %, datas como datas do Excel (construídas em UTC, sem deslocar o dia) e valor
 * ausente como célula VAZIA (RN-03). Texto entra como texto (nunca fórmula).
 */

const MONEY_FORMAT = "#,##0.00";
const PERCENT_FORMAT = "0.00%";
const DATE_FORMAT = "dd/mm/yyyy";

export const MEMO_SHEET = "Memória";
export const TOTALS_SHEET = "Totais";

type Kind = "text" | "money" | "bp" | "date";
type Column = { header: string; kind: Kind; width: number; value: (r: ProvisionMemoRow) => string | number | null };

/** Colunas da aba "Memória" (os testes leem pelos cabeçalhos). */
export const MEMO_COLUMNS: Column[] = [
  { header: "Processo (CNJ)", kind: "text", width: 27, value: (r) => r.number },
  { header: "Empresa", kind: "text", width: 28, value: (r) => r.companyName },
  { header: "Unidade", kind: "text", width: 16, value: (r) => r.unitName },
  { header: "Valor da causa (R$)", kind: "money", width: 17, value: (r) => r.claimAmountCents },
  { header: "Valor apurado (R$)", kind: "money", width: 17, value: (r) => r.liquidatedAmountCents },
  { header: "Garantias vinculadas na data-base (R$)", kind: "money", width: 19, value: (r) => r.guaranteesCents },
  { header: "Base aplicável", kind: "text", width: 27, value: (r) => baseKindLabel(r) },
  { header: "Base aplicável (R$)", kind: "money", width: 17, value: (r) => r.baseCents },
  { header: "Garantias abatidas (R$)", kind: "money", width: 17, value: (r) => r.guaranteesDeductedCents },
  { header: "Classificação", kind: "text", width: 15, value: (r) => classificationLabel(r.classification) },
  { header: "Percentual", kind: "bp", width: 11, value: (r) => r.percentageBp },
  { header: "Provisão apurada (R$)", kind: "money", width: 18, value: (r) => r.provisionOfficialCents },
  { header: "Provisão estimada (R$)", kind: "money", width: 18, value: (r) => r.provisionEstimateCents },
  { header: "Origem da classificação", kind: "text", width: 34, value: (r) => MEMO_CLASSIFICATION_SOURCE_LABELS[r.classificationSource] },
  { header: "Vigência da classificação", kind: "date", width: 14, value: (r) => r.classificationEffectiveFrom },
  { header: "Avaliada por", kind: "text", width: 22, value: (r) => r.assessedByName },
  { header: "Conferida por", kind: "text", width: 22, value: (r) => r.reviewedByName },
  { header: "Conferida em", kind: "text", width: 17, value: (r) => (r.classifiedAt ? formatDateTime(r.classifiedAt, "") : null) },
  { header: "Parecer em vigor na data-base", kind: "text", width: 60, value: (r) => opinionText(r) },
  { header: "Memória do cálculo e observações", kind: "text", width: 70, value: (r) => rowFormula(r) },
];

const HEADER_STYLE = { fontWeight: "bold" as const, backgroundColor: "#0B1A2C", textColor: "#FFFFFF", wrap: true };
const TITLE_STYLE = { fontWeight: "bold" as const, fontSize: 13, textColor: "#0B1A2C" };
const SECTION_STYLE = { fontWeight: "bold" as const, textColor: "#0B1A2C" };
const WARNING_STYLE = { fontWeight: "bold" as const, textColor: "#7F1D1D" };
const TOTAL_STYLE = { fontWeight: "bold" as const, backgroundColor: "#FBF6EA" };

function cell(value: string | number | null, kind: Kind, style: Record<string, unknown> = {}): Cell {
  if (value === null || value === "") return null;
  switch (kind) {
    case "money":
      return { type: Number, value: Number(value) / 100, format: MONEY_FORMAT, ...style };
    case "bp":
      return { type: Number, value: Number(value) / 10_000, format: PERCENT_FORMAT, ...style };
    case "date": {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
      if (!m) return { type: String, value: String(value), ...style };
      return { type: Date, value: new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))), format: DATE_FORMAT, ...style };
    }
    default:
      return { type: String, value: String(value), ...style };
  }
}

const text = (value: string, style: Record<string, unknown> = {}): Cell => ({ type: String, value, ...style });

/** Linhas de cabeçalho comuns às duas abas: identificação, situação, origem dos dados e ressalvas. */
function headerLines(memo: ProvisionMemo, title: string): Row[] {
  const lines: Row[] = [
    [text(`${title} · Competência ${periodLabel(memo.period)} · Data-base ${formatDate(memo.referenceDate, "")}`, TITLE_STYLE)],
  ];
  if (memo.organizationName) lines.push([text(memo.organizationName)]);
  lines.push([
    memo.status === "closed"
      ? text(`Situação: ${statusLabel(memo)}. Valores lidos do fechamento, que não mudam com lançamentos posteriores.`)
      : text(`${PREVIEW_LABEL.toUpperCase()}: os valores podem mudar até o fechamento da competência.`, WARNING_STYLE),
  ]);
  lines.push([text(generatedStatement(memo))]);
  lines.push([text(`Parâmetros de risco: ${parametersLabel(memo.params)}.`)]);
  lines.push([text(`Abrangência dos totais: ${scopeLabel(memo)}.`)]);
  if (memo.isDemoOrganization) lines.push([text("Organização de demonstração: dados fictícios.")]);
  return lines;
}

function memoSheet(memo: ProvisionMemo): Sheet<never> {
  const top = headerLines(memo, "Memória de cálculo da provisão");
  for (const line of METHOD_LINES) top.push([text(line)]);
  const estimates = memo.rows.filter((r) => r.provisionEstimateCents !== null).length;
  if (estimates > 0) top.push([text(estimateCaveat(estimates), WARNING_STYLE)]);
  if (memo.totals.hiddenCount > 0) {
    top.push([text(`Os totais da organização (aba Totais) incluem ${memo.totals.hiddenCount} processo(s) sigiloso(s) não listado(s) nesta aba.`)]);
  }
  if (memo.deletedCount > 0) {
    top.push([
      text(
        `${memo.deletedCount} processo(s) listado(s) foram excluídos do sistema depois do ${memo.status === "closed" ? "fechamento" : "cálculo da prévia"}; a posição registrada na competência foi mantida.`,
      ),
    ]);
  }
  top.push([]);
  const headerIndex = top.length;
  const data: Row[] = [
    ...top,
    MEMO_COLUMNS.map((c) => text(c.header, HEADER_STYLE)),
    ...memo.rows.map((r) => MEMO_COLUMNS.map((c) => cell(c.value(r), c.kind, c.kind === "text" && c.width >= 60 ? { wrap: true } : {}))),
  ];
  if (memo.rows.length > 0) {
    const totals: Row = MEMO_COLUMNS.map(() => null);
    totals[0] = text(listedSumLabel(memo.rows.length), TOTAL_STYLE);
    const official = MEMO_COLUMNS.findIndex((c) => c.header === "Provisão apurada (R$)");
    const estimate = MEMO_COLUMNS.findIndex((c) => c.header === "Provisão estimada (R$)");
    const listed = totalsLineAmounts(memo.listedTotals);
    totals[official] = cell(listed.officialCents, "money", TOTAL_STYLE);
    totals[estimate] = cell(listed.estimateCents, "money", TOTAL_STYLE);
    data.push(totals);
  } else {
    data.push([text("Nenhum processo listado para o seu perfil nesta competência.")]);
  }
  return {
    sheet: MEMO_SHEET,
    data,
    columns: MEMO_COLUMNS.map((c) => ({ width: c.width })),
    stickyRowsCount: headerIndex + 1,
  };
}

const TOTALS_HEADERS = ["Processos", "Provisão apurada (R$)", "Provisão estimada (R$)", "Processos com provisão estimada", "Processos sem provisão"];

/** Coluna sem nenhum valor na linha: célula vazia, nunca zero (`totalsLineAmounts`). */
function totalsRow(line: MemoTotalsLine, style: Record<string, unknown> = {}): Row {
  const amounts = totalsLineAmounts(line);
  return [
    text(line.label, style),
    { type: Number, value: line.count, ...style },
    cell(amounts.officialCents, "money", style),
    cell(amounts.estimateCents, "money", style),
    { type: Number, value: line.estimateCount, ...style },
    { type: Number, value: line.withoutProvisionCount, ...style },
  ];
}

function totalsSheet(memo: ProvisionMemo): Sheet<never> {
  const t = memo.totals;
  const data: Row[] = headerLines(memo, "Totais da memória de cálculo");
  data.push([text(SEPARATE_TOTALS_NOTE)]);
  data.push([]);

  data.push([text("Totais por classificação", SECTION_STYLE)]);
  data.push([text("Classificação", HEADER_STYLE), ...TOTALS_HEADERS.map((h) => text(h, HEADER_STYLE))]);
  const byClass = new Map(t.byClassification.map((l) => [l.key, l]));
  for (const key of CLASSIFICATION_ORDER) {
    const line = byClass.get(key);
    if (line) data.push(totalsRow(line));
  }
  data.push(totalsRow(t.overall, TOTAL_STYLE));
  data.push([]);

  data.push([text("Totais por empresa", SECTION_STYLE)]);
  data.push([text("Empresa", HEADER_STYLE), ...TOTALS_HEADERS.map((h) => text(h, HEADER_STYLE))]);
  if (t.byCompany.length === 0) data.push([text("Nenhum processo nesta competência.")]);
  for (const line of t.byCompany) data.push(totalsRow(line));
  data.push(totalsRow(t.overall, TOTAL_STYLE));
  data.push([]);

  if (t.overall.estimateCount > 0) data.push([text(estimateCaveat(t.overall.estimateCount), WARNING_STYLE)]);
  if (t.hiddenCount > 0) data.push([text(`Inclui ${t.hiddenCount} processo(s) sigiloso(s) não listado(s) na aba Memória.`)]);

  const o = memo.override;
  if (o) {
    data.push([]);
    data.push([text("Fechamento com justificativa", SECTION_STYLE)]);
    if (o.reason === null) {
      data.push([
        text(
          "Nenhum dos processos que você pode ver estava sem classificação de risco oficial na data-base. A ressalva registrada no fechamento se refere a processos que não estão na sua lista.",
        ),
      ]);
    } else {
      data.push([text("Justificativa", { fontWeight: "bold" }), text(o.reason, { wrap: true })]);
      data.push([text("Registrada por", { fontWeight: "bold" }), text(overrideRecordedText(o))]);
      data.push([
        text("Processos sem classificação", { fontWeight: "bold" }),
        { type: Number, value: o.count },
        text(o.hiddenCount > 0 ? `inclui ${o.hiddenCount} sigiloso(s) não listado(s)` : ""),
      ]);
      if (o.items.length > 0) {
        const rowBy = new Map(memo.rows.map((r) => [r.processId, r]));
        data.push([text("Processo (CNJ)", HEADER_STYLE), text("Situação no fechamento", HEADER_STYLE)]);
        for (const i of o.items) data.push([text(i.number), text(overrideItemSituation(i, rowBy.get(i.processId)))]);
      }
    }
  }

  return {
    sheet: TOTALS_SHEET,
    data,
    columns: [{ width: 38 }, { width: 14 }, { width: 20 }, { width: 20 }, { width: 18 }, { width: 16 }],
  };
}

export async function buildProvisionMemoXlsx(memo: ProvisionMemo): Promise<Buffer> {
  return writeXlsxFile([memoSheet(memo), totalsSheet(memo)], { fontFamily: "Calibri", fontSize: 11 }).toBuffer();
}
