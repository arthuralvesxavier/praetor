/**
 * Catalog of the monthly index series collected from the Banco Central SGS
 * public API (client-safe constants).
 *
 * Every SGS code below was CONFIRMED on 2026-10-12 against the official SGS
 * metadata web service (`https://www3.bcb.gov.br/wssgs/services/FachadaWSSGS`,
 * method `getUltimoValorVO`: full name, source, periodicity "M" and unit) and
 * against the data API (`https://api.bcb.gov.br/dados/serie/bcdata.sgs.{code}/dados`).
 * Do not add a series without the same check.
 *
 *   433    Índice nacional de preços ao consumidor-amplo (IPCA)          IBGE       Var. % mensal
 *   188    Índice nacional de preços ao consumidor (INPC)                IBGE       Var. % mensal
 *   10764  Índice de Preços ao Consumidor-Amplo - Especial (IPCA-E)      IBGE       Var. % mensal
 *   4390   Taxa de juros - Selic acumulada no mês                        BCB-Demab  % a.m.
 *   7811   Taxa referencial (TR) - Primeiro dia do mês                   BCB-Demab  % a.m.
 *
 * The system does not decide which index applies to a case (lawyer's choice).
 */
import { CORRECTION_INDEX_LABELS, type IndexSeriesCode } from "@/domain/enums";
import { addMonths, isIsoDate, monthOfDate, monthRange, seriesGaps } from "./math";

export type IndexSeriesDefinition = {
  code: IndexSeriesCode;
  /** Short label used in the interface ("Valor atualizado por IPCA-E até 09/2026"). */
  label: string;
  /** Official series name in the SGS. */
  name: string;
  sgsCode: number;
  /** Source of the series according to the SGS metadata. */
  publisher: string;
  /** Unit according to the SGS metadata. */
  unit: string;
  /**
   * Day of month M+1 (São Paulo) from which month M may be stored. 1 = as soon
   * as the month ends (a value published once, final). Later for a series that
   * accumulates during the month and may still be incomplete at the source in
   * the first days of the next month (see `lastStorableMonth`).
   */
  confirmationDay: number;
};

export const INDEX_SERIES_CATALOG: readonly IndexSeriesDefinition[] = [
  {
    code: "ipca_e",
    label: CORRECTION_INDEX_LABELS.ipca_e,
    name: "Índice de Preços ao Consumidor-Amplo - Especial (IPCA-E)",
    sgsCode: 10764,
    publisher: "IBGE",
    unit: "Variação % mensal",
    confirmationDay: 1,
  },
  {
    code: "ipca",
    label: CORRECTION_INDEX_LABELS.ipca,
    name: "Índice nacional de preços ao consumidor-amplo (IPCA)",
    sgsCode: 433,
    publisher: "IBGE",
    unit: "Variação % mensal",
    confirmationDay: 1,
  },
  {
    code: "inpc",
    label: CORRECTION_INDEX_LABELS.inpc,
    name: "Índice nacional de preços ao consumidor (INPC)",
    sgsCode: 188,
    publisher: "IBGE",
    unit: "Variação % mensal",
    confirmationDay: 1,
  },
  {
    code: "selic",
    label: CORRECTION_INDEX_LABELS.selic,
    name: "Taxa de juros - Selic acumulada no mês",
    sgsCode: 4390,
    publisher: "Banco Central (Demab)",
    unit: "% ao mês",
    // 4390 is the running accumulation of the daily Selic (series 11): on 2026-10-12 the value for
    // 10/2026 was 0.36, i.e. 7 business days. The rate of the last business day of a month reaches the
    // SGS only on the next business day(s); day 10 of the next month leaves at least 4 business days.
    confirmationDay: 10,
  },
  {
    code: "tr",
    label: CORRECTION_INDEX_LABELS.tr,
    name: "Taxa referencial (TR) - Primeiro dia do mês",
    sgsCode: 7811,
    publisher: "Banco Central (Demab)",
    unit: "% ao mês",
    confirmationDay: 1,
  },
];

export function indexSeriesDefinition(code: IndexSeriesCode): IndexSeriesDefinition {
  const found = INDEX_SERIES_CATALOG.find((s) => s.code === code);
  if (!found) throw new RangeError(`Série desconhecida: ${code}`);
  return found;
}

/**
 * First month collected: July 1994 (start of the Real). Earlier amounts are not
 * in reais and the system does not convert currencies; a base date before
 * June 1994 shows "atualização indisponível (faltam meses: ...)".
 */
export const INDEX_SERIES_FIRST_MONTH = "1994-07";

/**
 * Most recent month of a series that may be stored on `today` ("YYYY-MM-DD",
 * São Paulo): the month before the current one once `today` reaches the
 * series' `confirmationDay`, otherwise the month before that. The current month
 * is never stored. A stored month is never rewritten, so a month that could
 * still be incomplete at the source must wait (nothing is stored as fact before
 * it is final).
 */
export function lastStorableMonth(def: Pick<IndexSeriesDefinition, "confirmationDay">, today: string): string {
  if (!isIsoDate(today)) throw new RangeError(`Data inválida: ${today}`);
  const day = Number(today.slice(8, 10));
  return addMonths(monthOfDate(today), day >= def.confirmationDay ? -1 : -2);
}

/**
 * Months a series still needs, up to `lastStorable`: the gaps between the
 * first and the last stored month plus every month after the last stored one
 * (or from July 1994 when nothing is stored). Sorted, no repetition.
 */
export function monthsToCollect(storedMonths: readonly string[], lastStorable: string): string[] {
  const gaps = seriesGaps(storedMonths).filter((m) => m <= lastStorable);
  const last = storedMonths.length > 0 ? storedMonths.reduce((a, b) => (b > a ? b : a)) : null;
  const tailFrom = last ? addMonths(last, 1) : INDEX_SERIES_FIRST_MONTH;
  return [...gaps, ...monthRange(tailFrom, lastStorable)];
}

/** Value of the `source` column of `index_series_values`. */
export function sgsSourceTag(sgsCode: number): string {
  return `bcb_sgs:${sgsCode}`;
}
