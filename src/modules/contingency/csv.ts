/**
 * CSV "pronto para a contabilidade" of a monthly close (RF-16, TE-06).
 * Conventions (MODULE_CONTRACTS): UTF-8 with BOM, `;` separator, decimal comma,
 * null money cells stay EMPTY (RN-03). Each row carries the memória de cálculo;
 * a header line warns about estimates (RN-07). Pure (no I/O).
 */
import { bpToPercent, provisionFor, type MoneyBucket, type SnapshotParams } from "@/domain/contingency";
import {
  LOSS_PROBABILITY_LABELS,
  PROCESS_INSTANCE_LABELS,
  SNAPSHOT_STATUS_LABELS,
  type LossProbability,
  type ProcessInstance,
  type SnapshotStatus,
  type StoredProcessPhase,
  processPhaseLabel,
} from "@/domain/enums";
import { formatDate, formatMoneyCents } from "@/lib/format";
import { formatPeriod } from "./rules";

export type CsvSnapshotRow = {
  number: string;
  companyName: string | null;
  unitName: string | null;
  court: string | null;
  instance: ProcessInstance | null;
  /** Items of a closed competência keep the phase frozen at the close (RN-10), possibly of the previous model. */
  phase: StoredProcessPhase | null;
  city: string | null;
  classification: LossProbability | null;
  percentageBp: number | null;
  claimAmountCents: number | null;
  liquidatedAmountCents: number | null;
  guaranteesCents: number;
  exposureCents: number | null;
  exposureIsEstimate: boolean;
  provisionCents: number | null;
  provisionIsEstimate: boolean;
  /** The process was deleted from the system after the competência was calculated (row kept, RN-10). */
  processDeleted?: boolean;
};

export type SnapshotCsvInput = {
  organizationName?: string | null;
  period: string;
  referenceDate: string;
  status: SnapshotStatus;
  params: SnapshotParams;
  rows: CsvSnapshotRow[];
  /** Totals shown to the viewer (org-wide or visible-only). */
  totals: MoneyBucket;
  /** Processes included in the totals but not listed (confidential, org-wide viewers). */
  hiddenCount: number;
  /** True when the totals are org-wide (include hidden processes). */
  totalsAreOrganizationWide: boolean;
};

const SEP = ";";

/** Plain-text money for memo cells ("R$ 1.234,56", regular spaces). */
function money(cents: number): string {
  return formatMoneyCents(cents).replace(/ /g, " ");
}

/** Decimal-comma number without thousands separator (accounting import friendly); null → "". */
export function csvMoney(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return "";
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const s = `${Math.floor(abs / 100)},${String(abs % 100).padStart(2, "0")}`;
  return negative ? `-${s}` : s;
}

function csvPercent(bp: number | null): string {
  if (bp === null) return "";
  return bpToPercent(bp).toFixed(2).replace(".", ",");
}

export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Free-text cell (process number, company, unit, court, city, labels): a value
 * starting with = + - @ tab or CR is prefixed with an apostrophe so spreadsheets
 * never evaluate it as a formula (CSV injection), like the other exports.
 */
export function csvText(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return csvCell(s);
}

/** Money/percent cell already formatted by `csvMoney`/`csvPercent`: never prefixed (negative amounts stay numbers). */
type NumericCell = { readonly numeric: string };
const num = (value: string): NumericCell => ({ numeric: value });
type Cell = string | null | undefined | NumericCell;

function line(cells: Cell[]): string {
  return cells.map((c) => (c !== null && typeof c === "object" ? csvCell(c.numeric) : csvText(c))).join(SEP);
}

/** Memória de cálculo of one process (RN-04, RN-05, RN-07). */
export function calculationMemo(r: CsvSnapshotRow): string {
  const p = provisionFor({
    liquidatedCents: r.liquidatedAmountCents,
    linkedGuaranteesCents: r.guaranteesCents,
    claimCents: r.claimAmountCents,
    riskPercentageBp: r.percentageBp,
  });
  if (r.percentageBp === null) return "Sem classificação de risco: provisão não calculada.";
  const pct = `${csvPercent(r.percentageBp)}%`;
  if (p.base === "net_liquidated" && p.baseCents !== null && p.provisionCents !== null) {
    return (
      `Base = valor liquidado ${money(r.liquidatedAmountCents ?? 0)} − garantias vinculadas ${money(r.guaranteesCents)} ` +
      `= ${money(p.baseCents)}; provisão = ${money(p.baseCents)} × ${pct} = ${money(p.provisionCents)}.`
    );
  }
  if (p.base === "claim" && p.baseCents !== null && p.provisionCents !== null) {
    return (
      `ESTIMATIVA: sem valor liquidado; base = valor da causa ${money(p.baseCents)}; ` +
      `provisão = ${money(p.baseCents)} × ${pct} = ${money(p.provisionCents)}.`
    );
  }
  return "Sem valor liquidado nem valor da causa: provisão não calculada.";
}

export function buildSnapshotCsv(input: SnapshotCsvInput): string {
  const { params, totals } = input;
  const estimates = input.rows.filter((r) => r.provisionIsEstimate || r.exposureIsEstimate).length;
  const out: string[] = [];
  out.push(
    line([
      `Fechamento da carteira, competência ${formatPeriod(input.period)}, data-base ${formatDate(input.referenceDate)}: ` +
        `${SNAPSHOT_STATUS_LABELS[input.status]}${input.organizationName ? ` (${input.organizationName})` : ""}`,
    ]),
  );
  out.push(
    line([
      `Percentuais por classificação: remota ${params.riskPercentages.remote}% · possível ${params.riskPercentages.possible}% · ` +
        `provável ${params.riskPercentages.probable}% (versão ${params.rulesVersion} das regras de risco). ` +
        "Valor da causa e valor liquidado são grandezas diferentes e nunca são somados; células vazias = não apurado.",
    ]),
  );
  if (estimates > 0) {
    out.push(
      line([
        `ATENÇÃO: ${estimates} processo(s) com valores ESTIMADOS. Sem valor liquidado, a base é o valor da causa ` +
          "ponderado pelo risco. Estimativas não são valores apurados e devem ser tratadas com ressalva.",
      ]),
    );
  }
  if (input.hiddenCount > 0) {
    out.push(
      line([
        `Os totais da organização incluem ${input.hiddenCount} processo(s) sigiloso(s) não listado(s) neste arquivo.`,
      ]),
    );
  }
  const deleted = input.rows.filter((r) => r.processDeleted).length;
  if (deleted > 0) {
    out.push(
      line([
        `${deleted} processo(s) listado(s) foram excluídos do sistema após o ${input.status === "closed" ? "fechamento" : "cálculo da prévia"}; ` +
          "a posição registrada na competência foi mantida.",
      ]),
    );
  }
  if (input.status === "preview") {
    out.push(line(["PRÉVIA: valores recalculáveis até o fechamento da competência."]));
  }
  out.push("");
  out.push(
    line([
      "Processo (CNJ)",
      "Empresa",
      "Unidade",
      "Tribunal",
      "Instância",
      "Fase",
      "Cidade",
      "Classificação de risco",
      "Percentual (%)",
      "Valor da causa (R$)",
      "Valor liquidado (R$)",
      "Garantias vinculadas (R$)",
      "Base da provisão",
      "Base de cálculo (R$)",
      "Provisão (R$)",
      "Provisão estimada",
      "Exposição líquida (R$)",
      "Exposição estimada",
      "Memória de cálculo",
    ]),
  );
  for (const r of input.rows) {
    const p = provisionFor({
      liquidatedCents: r.liquidatedAmountCents,
      linkedGuaranteesCents: r.guaranteesCents,
      claimCents: r.claimAmountCents,
      riskPercentageBp: r.percentageBp,
    });
    const baseLabel =
      p.base === "net_liquidated" ? "Liquidado líquido de garantias" : p.base === "claim" ? "Valor da causa (estimativa)" : "Sem base";
    out.push(
      line([
        r.number,
        r.companyName,
        r.unitName,
        r.court,
        r.instance ? PROCESS_INSTANCE_LABELS[r.instance] : "",
        processPhaseLabel(r.phase) ?? "",
        r.city,
        r.classification ? LOSS_PROBABILITY_LABELS[r.classification] : "Não classificado",
        num(csvPercent(r.percentageBp)),
        num(csvMoney(r.claimAmountCents)),
        num(csvMoney(r.liquidatedAmountCents)),
        num(csvMoney(r.guaranteesCents)),
        baseLabel,
        num(csvMoney(p.baseCents)),
        num(csvMoney(r.provisionCents)),
        r.provisionCents === null ? "" : r.provisionIsEstimate ? "Sim" : "Não",
        num(csvMoney(r.exposureCents)),
        r.exposureCents === null ? "" : r.exposureIsEstimate ? "Sim" : "Não",
        r.processDeleted ? `${calculationMemo(r)} Processo excluído do sistema após o cálculo da competência.` : calculationMemo(r),
      ]),
    );
  }
  out.push("");
  const scope = input.totalsAreOrganizationWide ? "Totais da organização" : "Totais dos processos listados";
  out.push(line([scope, `${totals.count} processo(s)`]));
  out.push(line(["Valor da causa (R$)", num(csvMoney(totals.claimCents)), `${totals.claimUnknown} sem valor da causa`]));
  out.push(line(["Valor liquidado (R$)", num(csvMoney(totals.liquidatedCents)), `${totals.liquidatedUnknown} não apurado(s)`]));
  out.push(line(["Garantias vinculadas (R$)", num(csvMoney(totals.guaranteesCents))]));
  out.push(line(["Exposição líquida apurada (R$)", num(csvMoney(totals.exposureCents))]));
  out.push(
    line(["Exposição estimada (R$)", num(csvMoney(totals.exposureEstimateCents)), `${totals.exposureUnknown} sem base`]),
  );
  out.push(line(["Provisão sobre valores apurados (R$)", num(csvMoney(totals.provisionCents))]));
  out.push(line(["Provisão estimada (R$)", num(csvMoney(totals.provisionEstimateCents))]));
  return `﻿${out.join("\r\n")}\r\n`;
}
