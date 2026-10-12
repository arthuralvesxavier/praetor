/**
 * "Exposição e processos por dimensão" (P0.3): ONE portfolio chart with a dimension
 * selector (tribunal, instância, fase, cidade, empresa, unidade; default tribunal).
 * Pure, client-safe view model: URL param, labels, and the bars of a dimension.
 *
 * Rules:
 * - every bar label of a chart is written in ONE money unit, chosen once from the
 *   largest drawn value (`moneyScaleFor`) and shown in the chart header; tooltips and
 *   accessible names carry the exact amount (R$ 1.234,56), never a compact "R$ 1,2 mi";
 * - official exposure (valor apurado − garantias) and estimated exposure (valor da causa
 *   × % de risco − garantias) are separate series, never summed (RN-04/RN-07);
 * - a row without any valor apurado reads "não apurado", never 0 (RN-03); processes
 *   without any basis are named ("sem base de cálculo"), never counted as zero;
 * - when no drawn row has a valor apurado the official series is dropped altogether.
 */
import { formatMoneyCents, formatNumber, pluralize } from "@/lib/format";
import { param, type SearchParams } from "@/lib/search-params";
import { MISSING_FIELD_PARAMS } from "@/modules/processes/filters";
import { formatInScale, moneyScaleFor, type MoneyScale } from "./format";
import { DIMENSIONS, exposureBasisCounts, type DimensionKey } from "./portfolio";
import type { DimensionRow } from "./portfolio-service";

/** `/dashboard?dimensao=tribunal|instancia|fase|cidade|empresa|unidade` (default tribunal). */
export const DIMENSION_PARAM = "dimensao";
export const DEFAULT_DIMENSION: DimensionKey = "court";

/** URL values: the same pt-BR slugs as `/processos?pendencia=`. */
export const DIMENSION_PARAMS: Record<DimensionKey, string> = MISSING_FIELD_PARAMS;

export const DIMENSION_LABELS: Record<DimensionKey, string> = {
  court: "Tribunal",
  instance: "Instância",
  phase: "Fase",
  city: "Cidade",
  company: "Empresa",
  unit: "Unidade",
};

/** Lower-case form used inside sentences ("por tribunal"). */
export const DIMENSION_NOUNS: Record<DimensionKey, string> = {
  court: "tribunal",
  instance: "instância",
  phase: "fase",
  city: "cidade",
  company: "empresa",
  unit: "unidade",
};

/** Extra reading notes of a dimension, shown above its chart. */
export const DIMENSION_DESCRIPTIONS: Partial<Record<DimensionKey, string>> = {
  instance: "Instância atual de cada processo (um processo conta uma vez).",
  city: "As 10 cidades com maior exposição; as demais aparecem somadas na tabela.",
};

/** Dimension selected by the URL; anything unknown falls back to tribunal. */
export function parseChartDimension(sp: SearchParams | null | undefined): DimensionKey {
  const value = param(sp, DIMENSION_PARAM);
  return DIMENSIONS.find((k) => DIMENSION_PARAMS[k] === value) ?? DEFAULT_DIMENSION;
}

export type DimensionSeriesKey = "official" | "estimate" | "count";

export type DimensionChartRow = {
  key: string;
  /** "TRT10 (3)": the group and, for money charts, its number of processes. */
  label: string;
  href: string;
  /** One value per series, in `series` order (cents, or processes for the count fallback). */
  values: number[];
  /** End-of-row text in the chart unit, without the unit ("1,30 · est. 0,57", "não apurado · est. 0,05"). */
  valueText: string;
  /** Tooltip and accessible text, with exact amounts. */
  tip: string;
};

export type DimensionChartModel = {
  /** "count" when no drawn row has any exposure: the bars show the number of processes. */
  kind: "exposure" | "count";
  series: DimensionSeriesKey[];
  /** Money unit shared by every bar of the chart (null for the count fallback). */
  scale: MoneyScale | null;
  /** Header of the value column (the chart's axis label): "R$ milhões", "R$ mil"… or "Processos". */
  unitLabel: string;
  rows: DimensionChartRow[];
  /** Whether the official series is drawn (some drawn row has a valor apurado). */
  withOfficial: boolean;
  /** Some drawn row has no valor apurado at all (the note explains "não apurado"). */
  someRowUnassessed: boolean;
};

/** What the bars read from a dimension row (the provision basis is only used by the table). */
export type ChartRow = Pick<DimensionRow, "key" | "label" | "bucket" | "href">;

/** Bars of one dimension: rows already ranked by the service; "Demais" stays in the table. */
export function dimensionChartModel(dimension: { rows: readonly ChartRow[] }): DimensionChartModel {
  const rows = dimension.rows;
  const hasExposure = rows.some((r) => r.bucket.exposureCents > 0 || r.bucket.exposureEstimateCents > 0);
  if (!hasExposure) {
    return {
      kind: "count",
      series: ["count"],
      scale: null,
      unitLabel: "Processos",
      withOfficial: false,
      someRowUnassessed: false,
      rows: rows.map((r) => ({
        key: r.key,
        label: r.label,
        href: r.href,
        values: [r.bucket.count],
        valueText: formatNumber(r.bucket.count),
        tip: `Processos: ${formatNumber(r.bucket.count)}`,
      })),
    };
  }

  const basis = new Map(rows.map((r) => [r.key, exposureBasisCounts(r.bucket)]));
  // Without any valor apurado in the drawn rows there is no official series at all (no "0" bars, no legend entry).
  const withOfficial = rows.some((r) => (basis.get(r.key)?.official ?? 0) > 0);
  const someRowUnassessed = rows.some((r) => (basis.get(r.key)?.official ?? 0) === 0);
  const values = (r: ChartRow) =>
    withOfficial ? [r.bucket.exposureCents, r.bucket.exposureEstimateCents] : [r.bucket.exposureEstimateCents];
  const scale = moneyScaleFor(rows.flatMap(values));

  return {
    kind: "exposure",
    series: withOfficial ? ["official", "estimate"] : ["estimate"],
    scale,
    unitLabel: scale.label,
    withOfficial,
    someRowUnassessed,
    rows: rows.map((r) => {
      const b = r.bucket;
      const counts = basis.get(r.key) ?? exposureBasisCounts(b);
      const text: string[] = [];
      const tip: string[] = [];
      if (withOfficial) {
        if (counts.official === 0) {
          text.push("não apurado");
          tip.push("Exposição apurada: não apurado");
        } else {
          text.push(formatInScale(b.exposureCents, scale));
          tip.push(
            `Exposição apurada: ${formatMoneyCents(b.exposureCents)} (apurado em ${formatNumber(counts.official)} de ${formatNumber(b.count)})`,
          );
        }
      }
      if (counts.estimate > 0) {
        text.push(`est. ${formatInScale(b.exposureEstimateCents, scale)}`);
        tip.push(`Exposição estimada: ${formatMoneyCents(b.exposureEstimateCents)}`);
      }
      if (counts.none > 0) {
        if (counts.official === 0 && counts.estimate === 0) text.push("sem base de cálculo");
        tip.push(`${pluralize(counts.none, "processo", "processos")} sem base de cálculo`);
      }
      return {
        key: r.key,
        label: `${r.label} (${formatNumber(b.count)})`,
        href: r.href,
        values: values(r),
        valueText: text.join(" · "),
        tip: tip.join(" · "),
      };
    }),
  };
}
