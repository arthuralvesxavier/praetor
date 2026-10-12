/**
 * Memória de cálculo da provisão (P1.10): modelo e regras de apresentação
 * (puro, sem I/O, client-safe). O serviço monta um `ProvisionMemo` a partir dos
 * itens GUARDADOS da competência; o XLSX e o PDF são gerados a partir do mesmo
 * objeto, então os números dos dois arquivos são idênticos.
 *
 * Regras:
 * - Base aplicável (RN-04/RN-05): valor apurado menos as garantias vinculadas na
 *   data-base (nunca negativa) ou, sem valor apurado, o valor da causa: provisão
 *   ESTIMADA (RN-07), sem abater garantias, como em `provisionFor`.
 * - Valor da causa e valor apurado nunca são somados (RN-02). Provisão apurada e
 *   provisão estimada ficam em colunas separadas e nunca formam um total único.
 * - Null não é zero (RN-03): valor ausente sai como texto ("Não apurado") no PDF e
 *   como célula vazia no XLSX; zero só quando o valor registrado é zero.
 */
import { formatBp, provisionFor, type SnapshotParams } from "@/domain/contingency";
import { LOSS_PROBABILITY_LABELS, type LossProbability, type SnapshotStatus } from "@/domain/enums";
import { formatDate, formatDateTime, formatMoneyCents } from "@/lib/format";

/** Acima disso o PDF fica impraticável (centenas de páginas): use o XLSX. A página esconde o botão do PDF. */
export const PROVISION_MEMO_PDF_ROW_LIMIT = 3000;

export const PREVIEW_LABEL = "Prévia, sujeita a alteração";
export const NOT_ASSESSED_LABEL = "Não apurado";
export const NOT_INFORMED_LABEL = "Não informado";
export const NO_PROVISION_LABEL = "Sem provisão";
export const NO_COMPANY_LABEL = "Sem empresa informada";
export const UNCLASSIFIED_LABEL = "Não classificado";

/** Mesma política de totais da página de provisão (`snapshotScope` do módulo de contingências). */
export type MemoScope = "all" | "org_wide" | "visible";

export type MemoBaseKind = "net_liquidated" | "claim" | "none";

export const MEMO_BASE_KIND_LABELS: Record<MemoBaseKind, string> = {
  net_liquidated: "Apurado líquido de garantias",
  claim: "Valor da causa (estimada)",
  none: "Sem base",
};

/**
 * De onde veio a classificação guardada no item da competência. Os `*_outside_panel`
 * seguem o módulo de pedidos: avaliação oficial sem vínculo com os pedidos,
 * registrada depois da primeira avaliação de pedido do processo, é mantida pelas
 * derivações (override "outside_panel"), qualquer que seja a origem.
 */
export type MemoClassificationSource =
  | "claims_derived"
  | "claims_override"
  | "outside_panel"
  | "rule_suggestion_outside_panel"
  | "imported_outside_panel"
  | "manual"
  | "rule_suggestion"
  | "imported"
  | "record"
  | "unclassified"
  | "not_located";

export const MEMO_CLASSIFICATION_SOURCE_LABELS: Record<MemoClassificationSource, string> = {
  claims_derived: "Derivada dos pedidos",
  claims_override: "Definida manualmente, diferente da derivada dos pedidos",
  outside_panel: "Registrada manualmente depois das avaliações de pedidos (prevalece sobre a derivação)",
  rule_suggestion_outside_panel:
    "Sugestão automática por regra, conferida por pessoa depois das avaliações de pedidos (prevalece sobre a derivação)",
  imported_outside_panel: "Importada depois das avaliações de pedidos (prevalece sobre a derivação)",
  manual: "Registrada manualmente",
  rule_suggestion: "Sugestão automática por regra, conferida por pessoa",
  imported: "Importada",
  record: "Somente no cadastro do processo, sem avaliação oficial",
  unclassified: "Sem classificação",
  not_located: "Avaliação oficial usada no cálculo não localizada",
};

export type ProvisionMemoRow = {
  processId: string;
  /** Número CNJ. */
  number: string;
  companyName: string | null;
  unitName: string | null;
  isConfidential: boolean;
  /** Processo excluído do sistema depois do cálculo (o item é mantido, RN-10). */
  processDeleted: boolean;
  /** Valores guardados no item da competência (null = ausente, nunca zero). */
  claimAmountCents: number | null;
  liquidatedAmountCents: number | null;
  /** Garantias vinculadas na data-base. */
  guaranteesCents: number;
  baseKind: MemoBaseKind;
  baseCents: number | null;
  /** Garantias abatidas da base (só na base apurada; null quando não se aplica). */
  guaranteesDeductedCents: number | null;
  classification: LossProbability | null;
  percentageBp: number | null;
  /** Provisão guardada no item e o sinal de estimativa guardado. */
  provisionCents: number | null;
  provisionIsEstimate: boolean;
  /** Divisão para exibição: no máximo uma das duas é não nula. */
  provisionOfficialCents: number | null;
  provisionEstimateCents: number | null;
  classificationSource: MemoClassificationSource;
  /** Avaliação oficial em vigor na data-base (quando localizada). */
  classificationEffectiveFrom: string | null;
  opinion: string | null;
  assessedByName: string | null;
  reviewedByName: string | null;
  /** Quando a classificação foi conferida (ou registrada). */
  classifiedAt: Date | null;
  /** Processo listado na ressalva do fechamento (sem classificação oficial na data-base). */
  inCloseOverride: boolean;
};

export type MemoTotalsLine = {
  key: string;
  label: string;
  count: number;
  /** Soma da provisão apurada (valores apurados). */
  provisionCents: number;
  /** Soma da provisão estimada (RN-07), nunca somada à apurada. */
  provisionEstimateCents: number;
  /** Processos com provisão estimada. */
  estimateCount: number;
  /** Processos sem provisão (sem classificação ou sem base). */
  withoutProvisionCount: number;
};

export type ProvisionMemoTotals = {
  scope: MemoScope;
  /** True quando os totais são da organização (podem incluir processos não listados). */
  organizationWide: boolean;
  /** Processos incluídos nos totais mas não listados na memória (sigilosos). */
  hiddenCount: number;
  overall: MemoTotalsLine;
  byClassification: MemoTotalsLine[];
  byCompany: MemoTotalsLine[];
};

export type ProvisionMemoOverride = {
  /** Null para quem só vê os próprios processos e não tem nenhum dos processos da ressalva. */
  reason: string | null;
  createdAt: Date;
  closedByName: string | null;
  count: number;
  hiddenCount: number;
  items: { processId: string; number: string; processDeleted: boolean }[];
};

export type ProvisionMemo = {
  organizationName: string | null;
  isDemoOrganization: boolean;
  snapshotId: string;
  /** Competência `YYYY-MM`. */
  period: string;
  referenceDate: string;
  status: SnapshotStatus;
  /** Quando a prévia (a que foi fechada, se fechada) foi calculada. */
  calculatedAt: Date;
  calculatedByName: string | null;
  closedAt: Date | null;
  closedByName: string | null;
  params: SnapshotParams;
  exportedAt: Date;
  exportedByName: string | null;
  scope: MemoScope;
  /** Texto sobre a abrangência dos totais quando o escopo é "visible". */
  scopeNote: string | null;
  rows: ProvisionMemoRow[];
  totals: ProvisionMemoTotals;
  /** Soma dos processos listados (pode diferir dos totais da organização). */
  listedTotals: MemoTotalsLine;
  deletedCount: number;
  override: ProvisionMemoOverride | null;
};

// ---------------------------------------------------------------------------
// Regras
// ---------------------------------------------------------------------------

export type StoredMemoValues = {
  claimAmountCents: number | null;
  liquidatedAmountCents: number | null;
  guaranteesCents: number;
  percentageBp: number | null;
  provisionCents: number | null;
  provisionIsEstimate: boolean;
};

/** Base aplicável do item (lida dos valores guardados, com as mesmas regras de `provisionFor`). */
export function memoBase(v: StoredMemoValues): {
  baseKind: MemoBaseKind;
  baseCents: number | null;
  guaranteesDeductedCents: number | null;
} {
  const p = provisionFor({
    liquidatedCents: v.liquidatedAmountCents,
    linkedGuaranteesCents: v.guaranteesCents,
    claimCents: v.claimAmountCents,
    riskPercentageBp: v.percentageBp,
  });
  if (p.base === "net_liquidated") {
    return { baseKind: "net_liquidated", baseCents: p.baseCents, guaranteesDeductedCents: Math.max(0, v.guaranteesCents) };
  }
  if (p.base === "claim") return { baseKind: "claim", baseCents: p.baseCents, guaranteesDeductedCents: null };
  // Sem classificação a provisão não é calculada, mas a base que seria usada continua informativa.
  if (v.liquidatedAmountCents !== null) {
    return {
      baseKind: "net_liquidated",
      baseCents: Math.max(0, v.liquidatedAmountCents - Math.max(0, v.guaranteesCents)),
      guaranteesDeductedCents: Math.max(0, v.guaranteesCents),
    };
  }
  if (v.claimAmountCents !== null) return { baseKind: "claim", baseCents: v.claimAmountCents, guaranteesDeductedCents: null };
  return { baseKind: "none", baseCents: null, guaranteesDeductedCents: null };
}

/**
 * Rótulo da base do item. Sem classificação de risco a provisão não é
 * calculada: a base que seria usada é mostrada sem o rótulo de estimativa.
 */
export function baseKindLabel(r: Pick<ProvisionMemoRow, "baseKind" | "provisionCents">): string {
  if (r.baseKind === "none" || r.provisionCents !== null) return MEMO_BASE_KIND_LABELS[r.baseKind];
  return r.baseKind === "claim" ? "Valor da causa (sem classificação)" : "Apurado líquido de garantias (sem classificação)";
}

/** Provisão guardada dividida em apurada / estimada (nunca somadas). */
export function splitProvision(v: Pick<StoredMemoValues, "provisionCents" | "provisionIsEstimate">): {
  provisionOfficialCents: number | null;
  provisionEstimateCents: number | null;
} {
  if (v.provisionCents === null) return { provisionOfficialCents: null, provisionEstimateCents: null };
  return v.provisionIsEstimate
    ? { provisionOfficialCents: null, provisionEstimateCents: v.provisionCents }
    : { provisionOfficialCents: v.provisionCents, provisionEstimateCents: null };
}

export function emptyTotalsLine(key: string, label: string): MemoTotalsLine {
  return { key, label, count: 0, provisionCents: 0, provisionEstimateCents: 0, estimateCount: 0, withoutProvisionCount: 0 };
}

/** Soma um item a uma linha de totais (cada grandeza na sua coluna; null conta como "sem provisão"). */
export function addToTotalsLine(line: MemoTotalsLine, v: Pick<StoredMemoValues, "provisionCents" | "provisionIsEstimate">): MemoTotalsLine {
  line.count += 1;
  if (v.provisionCents === null) line.withoutProvisionCount += 1;
  else if (v.provisionIsEstimate) {
    line.provisionEstimateCents += v.provisionCents;
    line.estimateCount += 1;
  } else line.provisionCents += v.provisionCents;
  return line;
}

/**
 * Valores EXIBIDOS de uma linha de totais (PDF e XLSX). A soma de uma coluna só
 * aparece quando algum processo da linha tem valor nela; sem nenhum valor, null
 * ("Sem provisão" no PDF, célula vazia no XLSX), porque soma de nada não é uma
 * provisão zero (RN-03). Uma provisão registrada como zero conta como valor.
 * Os números da linha (`provisionCents`...) continuam os da página de provisão.
 */
export function totalsLineAmounts(line: MemoTotalsLine): { officialCents: number | null; estimateCents: number | null } {
  const officialCount = line.count - line.estimateCount - line.withoutProvisionCount;
  return {
    officialCents: officialCount > 0 ? line.provisionCents : null,
    estimateCents: line.estimateCount > 0 ? line.provisionEstimateCents : null,
  };
}

export const CLASSIFICATION_ORDER = ["probable", "possible", "remote", "unclassified"] as const;

export function classificationLabel(key: LossProbability | "unclassified" | null): string {
  return key === null || key === "unclassified" ? UNCLASSIFIED_LABEL : LOSS_PROBABILITY_LABELS[key];
}

export type TotalsItem = Pick<StoredMemoValues, "provisionCents" | "provisionIsEstimate"> & {
  classification: LossProbability | null;
  companyId: string | null;
};

const NONE = "__none__";

/** Totais por classificação (ordem fixa, todas as linhas) e por empresa (ordem alfabética; sem empresa por último). */
export function buildTotals(
  items: readonly TotalsItem[],
  companyNames: ReadonlyMap<string, string>,
): { overall: MemoTotalsLine; byClassification: MemoTotalsLine[]; byCompany: MemoTotalsLine[] } {
  const overall = emptyTotalsLine("total", "Total");
  const byClass = new Map<string, MemoTotalsLine>(CLASSIFICATION_ORDER.map((k) => [k, emptyTotalsLine(k, classificationLabel(k))]));
  const byCompany = new Map<string, MemoTotalsLine>();
  for (const i of items) {
    addToTotalsLine(overall, i);
    addToTotalsLine(byClass.get(i.classification ?? "unclassified")!, i);
    const key = i.companyId ?? NONE;
    let line = byCompany.get(key);
    if (!line) {
      line = emptyTotalsLine(key, key === NONE ? NO_COMPANY_LABEL : (companyNames.get(key) ?? "Empresa não localizada"));
      byCompany.set(key, line);
    }
    addToTotalsLine(line, i);
  }
  const companies = [...byCompany.values()].sort((a, b) => {
    if (a.key === NONE) return 1;
    if (b.key === NONE) return -1;
    return a.label.localeCompare(b.label, "pt-BR");
  });
  return { overall, byClassification: [...byClass.values()], byCompany: companies };
}

// ---------------------------------------------------------------------------
// Textos (pt-BR, sem travessão)
// ---------------------------------------------------------------------------

/** "R$ 1.234,56" com espaço comum (busca e cópia no PDF). */
export function memoMoney(cents: number): string {
  return formatMoneyCents(cents, "").replace(/ /g, " ");
}

export function memoPercent(bp: number | null): string {
  return formatBp(bp, "Sem percentual");
}

export function periodLabel(period: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  return m ? `${m[2]}/${m[1]}` : period;
}

export function statusLabel(memo: Pick<ProvisionMemo, "status" | "closedAt" | "closedByName">): string {
  if (memo.status !== "closed") return PREVIEW_LABEL;
  const when = memo.closedAt ? ` em ${formatDateTime(memo.closedAt, "data não registrada")}` : "";
  return `Fechada${when}${memo.closedByName ? ` por ${memo.closedByName}` : ""}`;
}

/** Frase "gerado a partir de" (rodapé do PDF e cabeçalho do XLSX). */
export function generatedStatement(memo: Pick<ProvisionMemo, "status" | "period" | "calculatedAt" | "closedAt" | "exportedAt">): string {
  const when = formatDateTime(memo.exportedAt, "");
  const period = periodLabel(memo.period);
  if (memo.status === "closed") {
    return `Gerado em ${when} a partir do fechamento da competência ${period}, fechada em ${formatDateTime(memo.closedAt, "data não registrada")}.`;
  }
  return `Gerado em ${when} a partir da prévia da competência ${period}, calculada em ${formatDateTime(memo.calculatedAt, "")}. ${PREVIEW_LABEL}.`;
}

export function parametersLabel(params: SnapshotParams): string {
  const r = params.riskPercentages;
  return `Remota ${r.remote}%, possível ${r.possible}%, provável ${r.probable}% (versão ${params.rulesVersion} das regras de risco)`;
}

export function scopeLabel(memo: Pick<ProvisionMemo, "scope" | "scopeNote" | "totals">): string {
  if (memo.scope === "all") return "Todos os processos da competência";
  if (memo.scope === "org_wide") {
    const n = memo.totals.hiddenCount;
    return n > 0
      ? `Totais da organização, incluindo ${n} processo(s) sigiloso(s) não listado(s) nesta memória`
      : "Totais da organização";
  }
  return memo.scopeNote ?? "Totais calculados somente sobre os processos que você pode ver.";
}

/** Ressalva RN-07 (sem o prefixo "Atenção", usado onde já há um título). */
export function estimateCaveatBody(estimateCount: number): string {
  return (
    `${estimateCount} processo(s) sem valor apurado têm a provisão calculada sobre o valor da causa. ` +
    "A provisão estimada não é valor apurado, fica em coluna própria, nunca é somada à provisão apurada e deve ser tratada com ressalva."
  );
}

export function estimateCaveat(estimateCount: number): string {
  return `Atenção: ${estimateCaveatBody(estimateCount)}`;
}

export const METHOD_LINES = [
  "Base aplicável: valor apurado (liquidado) menos as garantias vinculadas na data-base, nunca negativa. Sem valor apurado, a base é o valor da causa, sem abater garantias, e a provisão é uma estimativa.",
  "Provisão = base aplicável × percentual da classificação de risco em vigor na data-base. Valor da causa e valor apurado são grandezas diferentes e nunca são somados.",
  "Valor ausente aparece como Não apurado, Não informado ou Sem provisão (no XLSX, célula vazia), nunca como zero, inclusive no total de uma coluna sem nenhum valor. Zero só aparece quando o valor registrado é zero, como numa quitação.",
];

export const SEPARATE_TOTALS_NOTE =
  "Provisão apurada e provisão estimada são grandezas separadas: cada coluna soma só a sua grandeza e não há total único.";

/** Memória do cálculo de um item, em uma frase (coluna "Observações" do XLSX). */
export function rowFormula(r: ProvisionMemoRow): string {
  const parts: string[] = [];
  if (r.percentageBp === null) {
    parts.push("Sem classificação de risco: provisão não calculada.");
  } else if (r.baseKind === "net_liquidated" && r.baseCents !== null && r.liquidatedAmountCents !== null) {
    const pct = memoPercent(r.percentageBp);
    parts.push(
      `Base = apurado ${memoMoney(r.liquidatedAmountCents)} menos garantias ${memoMoney(r.guaranteesDeductedCents ?? 0)}` +
        `${r.liquidatedAmountCents < (r.guaranteesDeductedCents ?? 0) ? " (limitada a zero)" : ""} = ${memoMoney(r.baseCents)}; ` +
        `provisão apurada = ${memoMoney(r.baseCents)} × ${pct}` +
        (r.provisionCents !== null ? ` = ${memoMoney(r.provisionCents)}.` : "."),
    );
  } else if (r.baseKind === "claim" && r.baseCents !== null) {
    const pct = memoPercent(r.percentageBp);
    parts.push(
      `Estimativa: sem valor apurado, base = valor da causa ${memoMoney(r.baseCents)}; ` +
        `provisão estimada = ${memoMoney(r.baseCents)} × ${pct}` +
        (r.provisionCents !== null ? ` = ${memoMoney(r.provisionCents)}.` : "."),
    );
  } else {
    parts.push("Sem valor apurado nem valor da causa: provisão não calculada.");
  }
  if (r.inCloseOverride) parts.push("Sem classificação de risco oficial em vigor na data-base: incluído na ressalva do fechamento.");
  if (r.processDeleted) parts.push("Processo excluído do sistema depois do cálculo da competência (posição mantida).");
  return parts.join(" ");
}

/** "Avaliada por X; conferida por Y em dd/mm/aaaa" (ou o motivo de não haver responsável). */
export function responsibleText(r: ProvisionMemoRow): string {
  if (r.classificationSource === "unclassified") return "Sem pessoa identificada";
  if (r.classificationSource === "record") return "Sem pessoa identificada (classificação só no cadastro)";
  if (r.classificationSource === "not_located") return "Não localizado";
  const when = r.classifiedAt ? ` em ${formatDateTime(r.classifiedAt, "")}` : "";
  const a = r.assessedByName;
  const v = r.reviewedByName;
  if (a && v && a !== v) return `Avaliada por ${a}; conferida por ${v}${when}`;
  if (a || v) return `${a ?? v}${when}`;
  return `Pessoa não registrada${when}`;
}

/** Parecer em vigor na data-base (ou o motivo de não haver). */
export function opinionText(r: ProvisionMemoRow): string {
  if (r.opinion) return r.opinion;
  if (r.classificationSource === "record") return "Sem parecer: a classificação está só no cadastro do processo, sem avaliação oficial.";
  if (r.classificationSource === "unclassified") return "Sem classificação de risco na data-base.";
  if (r.classificationSource === "not_located") {
    return "A classificação guardada na competência não corresponde a uma avaliação oficial localizada; confira o histórico de risco do processo.";
  }
  return "Parecer não registrado.";
}

export function effectiveFromText(r: ProvisionMemoRow): string | null {
  return r.classificationEffectiveFrom ? `Em vigor desde ${formatDate(r.classificationEffectiveFrom, "")}` : null;
}

/** Nome do arquivo baixado. */
export function provisionMemoFileName(memo: Pick<ProvisionMemo, "period" | "status">, ext: "xlsx" | "pdf"): string {
  return `memoria-provisao-${memo.period}${memo.status === "preview" ? "-previa" : ""}.${ext}`;
}

/** Situação de um processo da ressalva do fechamento (usa a linha da memória quando listada). */
export function overrideItemSituation(item: { processDeleted: boolean }, row: ProvisionMemoRow | undefined): string {
  const parts: string[] = [];
  if (row?.classificationSource === "record") {
    parts.push(
      `Classificação só no cadastro do processo (${classificationLabel(row.classification)}, ${memoPercent(row.percentageBp)}), sem avaliação oficial em vigor na data-base`,
    );
  } else {
    parts.push("Sem classificação de risco oficial em vigor na data-base");
  }
  if (item.processDeleted) parts.push("processo excluído do sistema depois do fechamento");
  return `${parts.join("; ")}.`;
}

/** "Clara Contadora em dd/mm/aaaa hh:mm" (quem fechou com justificativa e quando). */
export function overrideRecordedText(o: Pick<ProvisionMemoOverride, "closedByName" | "createdAt">): string {
  return `${o.closedByName ?? "Pessoa não registrada"} em ${formatDateTime(o.createdAt, "")}`;
}

/** Rótulo da linha de soma dos processos listados. */
export function listedSumLabel(count: number): string {
  return `Soma dos listados (${count})`;
}
