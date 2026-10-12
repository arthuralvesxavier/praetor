import { ArrowDownRight, ArrowRight, ArrowUpRight, ChevronRight, ClipboardCheck, Scale } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { StatCard } from "@/components/ui/stat-card";
import { addBasisCounts, emptyBasisCounts, provisionBasisForClass, type AmountBasisCounts, type MoneyBucket } from "@/domain/contingency";
import { LOSS_PROBABILITY_LABELS, PROCESS_INSTANCE_LABELS, type LossProbability } from "@/domain/enums";
import { formatMoneyCents, formatMonthYear, formatNumber, formatPercent, pluralize } from "@/lib/format";
import { cn } from "@/lib/utils";
import { MISSING_FIELD_LABELS } from "@/modules/processes/filters";
import { processTabUrl } from "@/modules/processes/tabs";
import { processesHref, type BiFilters } from "../bi-filters";
import {
  DEFAULT_DIMENSION,
  DIMENSION_DESCRIPTIONS,
  DIMENSION_LABELS,
  DIMENSION_NOUNS,
  DIMENSION_PARAM,
  DIMENSION_PARAMS,
  dimensionChartModel,
  type DimensionSeriesKey,
} from "../dimension-chart";
import { formatCompactMoneyCents } from "../format";
import {
  DIMENSIONS,
  coveragePercent,
  coverageStatement,
  delta,
  exposureBasisCounts,
  liquidatedCoverage,
  mergeBuckets,
  type DimensionKey,
  type LiquidatedCoverage,
} from "../portfolio";
import type { Dimension, PortfolioData, RegistrationGap, TopExposureItem } from "../portfolio-service";
import { BarChart } from "./charts/bar-chart";
import { ChartBody, ChartCard } from "./charts/chart-card";
import { SERIES } from "./charts/palette";
import { DimensionTabs } from "./dimension-tabs";

/** Compact value with the exact amount available on hover and to screen readers. */
function Money({ cents, className }: { cents: number; className?: string }) {
  const full = formatMoneyCents(cents);
  return (
    <span className={cn("tabular-nums", className)} title={full}>
      <span aria-hidden="true">{formatCompactMoneyCents(cents)}</span>
      <span className="sr-only">{full}</span>
    </span>
  );
}

const CLASSIFICATION_LABEL = (k: LossProbability | "unclassified") =>
  k === "unclassified" ? "Não classificada" : LOSS_PROBABILITY_LABELS[k];

/** Labelled figure used inside the KPI cards. */
function Figure({ label, value, hint, badge }: { label: string; value: ReactNode; hint?: ReactNode; badge?: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="flex flex-wrap items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {label}
        {badge}
      </p>
      <p className="mt-0.5 text-xl font-semibold tracking-tight text-slate-900">{value}</p>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function KpiCard({ title, children, footer }: { title: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 shadow-xs">
      <h3 className="text-sm font-medium text-muted-foreground">{title}</h3>
      {children}
      {footer ? <div className="mt-auto border-t border-border pt-2 text-xs text-muted-foreground">{footer}</div> : null}
    </section>
  );
}

function EstimateBadge() {
  return (
    <Badge tone="warning" className="px-1.5 py-0 text-[11px] leading-4">
      Estimativa
    </Badge>
  );
}

/** Where proposed values are confirmed by an identified reviewer (they become official only there). */
export const REVIEW_QUEUE_HREF = "/contingencias/revisao";

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "Apurado em 2 de 5 processos (40%)" — the statement that goes with every apurado-based amount. */
function coverageHint(c: LiquidatedCoverage): string {
  if (c.total === 0) return "Nenhum processo na carteira ativa";
  if (c.assessed === 0) return `Nenhum dos ${pluralize(c.total, "processo", "processos")} tem valor apurado`;
  return `Apurado em ${formatNumber(c.assessed)} de ${pluralize(c.total, "processo", "processos")} (${coveragePercent(c)})`;
}

/**
 * Amount based on the official liquidated value: always shown with its coverage,
 * and "Sem valor apurado" instead of a misleading R$ 0 when nothing is assessed.
 */
function OfficialFigure({
  label,
  cents,
  coverage,
  hint,
}: {
  label: string;
  cents: number;
  coverage: LiquidatedCoverage;
  hint?: ReactNode;
}) {
  return (
    <Figure
      label={label}
      value={
        coverage.assessed === 0 ? (
          <span className="text-base font-medium text-muted-foreground">Sem valor apurado</span>
        ) : (
          <Money cents={cents} />
        )
      }
      hint={
        <>
          <span className="block">{coverageHint(coverage)}</span>
          {hint ? <span className="block">{hint}</span> : null}
        </>
      }
    />
  );
}

/**
 * Coverage of the official liquidated value: "Valor apurado em X de Y processos (Z%)".
 * The statement opens the review queue; the secondary link lists the não apurados
 * of the active portfolio with the dashboard filters.
 */
export function CoverageCard({ coverage, filters }: { coverage: LiquidatedCoverage; filters: BiFilters }) {
  const missing = coverage.total - coverage.assessed;
  const width = coverage.ratio === null ? 0 : Math.min(100, Math.max(0, coverage.ratio * 100));
  return (
    <section aria-labelledby="cobertura-apurado" className="rounded-lg border border-border bg-surface p-4 shadow-xs">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0 flex-1 space-y-2">
          <h3 id="cobertura-apurado" className="text-sm font-medium text-muted-foreground">
            Cobertura do valor apurado
          </h3>
          <p className="text-lg font-semibold tracking-tight text-slate-900">
            <Link
              href={REVIEW_QUEUE_HREF}
              className="rounded-sm text-primary-700 underline decoration-primary-300 underline-offset-4 hover:decoration-primary-700 focus-visible:outline-2 focus-visible:outline-ring"
            >
              {capitalize(coverageStatement(coverage))}
            </Link>
          </p>
          {coverage.total > 0 ? (
            <div aria-hidden="true" className="h-2 w-full max-w-xl overflow-hidden rounded-full bg-slate-100">
              <div className="h-full rounded-full" style={{ width: `${width}%`, backgroundColor: SERIES.blue }} />
            </div>
          ) : null}
          <p className="text-xs text-muted-foreground">
            Valor liquidado, exposição e provisão apurados somam apenas os processos com valor apurado. Não apurado nunca
            entra como zero: esses processos aparecem como estimativa (valor da causa × % de risco) ou sem base de cálculo.
            Um valor proposto só se torna oficial após a conferência por um revisor identificado.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <ButtonLink href={REVIEW_QUEUE_HREF} variant="outline" size="sm">
            <ClipboardCheck aria-hidden="true" />
            Conferir valores propostos
          </ButtonLink>
          {missing > 0 ? (
            <ButtonLink href={processesHref(filters, { liquidado: "sem" })} variant="ghost" size="sm">
              Ver {pluralize(missing, "processo não apurado", "processos não apurados")}
              <ChevronRight aria-hidden="true" />
            </ButtonLink>
          ) : null}
        </div>
      </div>
    </section>
  );
}

export function PortfolioKpis({ data, filters }: { data: PortfolioData; filters: BiFilters }) {
  const t = data.totals;
  const coverage = data.coverage;
  return (
    <div className="space-y-4">
      <CoverageCard coverage={coverage} filters={filters} />
      {/* The net exposure (official and estimated) is the panel above the KPIs (NetExposureCard). */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard
          label="Processos na carteira ativa"
          value={formatNumber(data.activeProcesses)}
          hint="CNJ único: as instâncias não somam"
          href={processesHref(filters)}
          icon={<Scale />}
          tone="primary"
        />

        <KpiCard
          title="Valores da carteira"
          footer="Valor da causa e valor liquidado são grandezas diferentes e nunca são somados."
        >
          <div className="grid grid-cols-2 gap-3">
            <Figure
              label="Valor da causa"
              value={<Money cents={t.claimCents} />}
              hint={t.claimUnknown > 0 ? `${pluralize(t.claimUnknown, "processo", "processos")} sem valor informado` : "Todos informados"}
            />
            <OfficialFigure
              label="Valor liquidado"
              cents={t.liquidatedCents}
              coverage={coverage}
              hint={
                t.liquidatedUnknown > 0 ? (
                  <Link
                    href={processesHref(filters, { liquidado: "sem" })}
                    className="text-primary-700 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    {formatNumber(t.liquidatedUnknown)} não apurado{t.liquidatedUnknown === 1 ? "" : "s"}
                  </Link>
                ) : null
              }
            />
          </div>
        </KpiCard>

        <KpiCard title="Provisão" footer={<ProvisionSplit data={data} />}>
          <div className="grid grid-cols-2 gap-3">
            <ProvisionOfficialFigure cents={t.provisionCents} basis={totalProvisionBasis(data)} coverage={coverage} />
            <Figure
              label="Estimada"
              badge={<EstimateBadge />}
              value={
                totalProvisionBasis(data).estimate > 0 ? (
                  <Money cents={t.provisionEstimateCents} />
                ) : (
                  <span className="text-base font-medium text-muted-foreground">Sem estimativa</span>
                )
              }
              hint="Sem liquidação: valor da causa × %"
            />
          </div>
        </KpiCard>
      </div>
    </div>
  );
}

/** Provision basis of a classification row (exact counts when the service sent them). */
function rowProvisionBasis(c: PortfolioData["byClassification"][number]): AmountBasisCounts {
  return c.provisionBasis ?? provisionBasisForClass(c.bucket, c.key !== "unclassified");
}

function totalProvisionBasis(data: PortfolioData): AmountBasisCounts {
  return data.byClassification.reduce((acc, c) => addBasisCounts(acc, rowProvisionBasis(c)), emptyBasisCounts());
}

/**
 * Why a provision on the valor apurado does not exist (RN-03/RN-05): processes with a valor
 * apurado but no risk classification have none ("Não calculada"); without any valor apurado
 * there is nothing to calculate it on ("Sem valor apurado"). Never R$ 0.
 */
function provisionAbsence(assessed: number): Absence {
  return assessed > 0
    ? { label: "Não calculada", reason: "provisão não calculada" }
    : { label: "Sem valor apurado", reason: "sem valor apurado" };
}

/**
 * "Apurada" of the provision card: the sum only when some process has a provision on the
 * valor apurado (the provision basis, not the valor apurado coverage, decides it), with the
 * coverage and how many processes with a valor apurado have no classification.
 */
function ProvisionOfficialFigure({ cents, basis, coverage }: { cents: number; basis: AmountBasisCounts; coverage: LiquidatedCoverage }) {
  const withoutClassification = Math.max(0, coverage.assessed - basis.official);
  return (
    <Figure
      label="Apurada"
      value={
        basis.official > 0 ? (
          <Money cents={cents} />
        ) : (
          <span className="text-base font-medium text-muted-foreground">{provisionAbsence(coverage.assessed).label}</span>
        )
      }
      hint={
        <>
          <span className="block">{coverageHint(coverage)}</span>
          {withoutClassification > 0 ? (
            <span className="block">
              {pluralize(withoutClassification, "processo apurado", "processos apurados")} sem classificação de risco
            </span>
          ) : null}
          <span className="block">Base liquidada × % da classificação</span>
        </>
      }
    />
  );
}

function ProvisionSplit({ data }: { data: PortfolioData }) {
  return (
    <table className="w-full text-left text-xs">
      <caption className="sr-only">Provisão por classificação de risco</caption>
      <thead>
        <tr className="text-muted-foreground">
          <th scope="col" className="py-0.5 pr-2 font-medium">
            Classificação
          </th>
          <th scope="col" className="py-0.5 pr-2 text-right font-medium">
            <abbr title="Processos com valor apurado / processos na classificação" className="no-underline">
              Apur./proc.
            </abbr>
          </th>
          <th scope="col" className="py-0.5 pr-2 text-right font-medium">
            Apurada
          </th>
          <th scope="col" className="py-0.5 text-right font-medium">
            Estimada
          </th>
        </tr>
      </thead>
      <tbody>
        {data.byClassification.map((c) => {
          const cov = liquidatedCoverage(c.bucket);
          const basis = rowProvisionBasis(c);
          return (
            <tr key={c.key} className="text-slate-700">
              <th scope="row" className="py-0.5 pr-2 font-normal">
                {CLASSIFICATION_LABEL(c.key)}
              </th>
              <td className="py-0.5 pr-2 text-right tabular-nums">
                {formatNumber(cov.assessed)}/{formatNumber(cov.total)}
              </td>
              <td className="py-0.5 pr-2 text-right">
                {basis.official > 0 ? (
                  <Money cents={c.bucket.provisionCents} />
                ) : (
                  <Absent reason={cov.total === 0 ? "Nenhum processo" : cov.assessed === 0 ? "Sem valor apurado" : "Não calculada"} />
                )}
              </td>
              <td className="py-0.5 text-right">
                {basis.estimate > 0 ? (
                  <Money cents={c.bucket.provisionEstimateCents} />
                ) : (
                  <Absent reason={cov.total === 0 ? "Nenhum processo" : c.key === "unclassified" ? "Não calculada" : "Sem estimativa"} />
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Comparison with the previous closed month
// ---------------------------------------------------------------------------

/** A figure that was not calculated on one side: what the figure reads and the phrase used in the comparison lines. */
type Absence = { label: string; reason: string };

const NOT_ASSESSED: Absence = { label: "Sem valor apurado", reason: "sem valor apurado" };
const NO_ESTIMATE: Absence = { label: "Sem estimativa", reason: "sem estimativa" };

/** The sum when at least one process carries the amount on this basis; null otherwise (RN-03: never R$ 0). */
const amountOn = (cents: number, processes: number): number | null => (processes > 0 ? cents : null);

/**
 * Current figure × the closed competência. A side where the amount was not calculated (`null`)
 * reads its `absent` text and there is no Aumento/Redução: a delta needs the amount on both
 * sides, the same rule as `variationOf` in the reports (a delta against a zero that only means
 * "não calculado" would read null as zero).
 */
function DeltaFigure({
  label,
  current,
  previous,
  money,
  absentNow = NOT_ASSESSED,
  absentBefore = absentNow,
  coverage,
}: {
  label: string;
  /** null = not calculated now. */
  current: number | null;
  /** null = not calculated at the closing (read from the stored items). */
  previous: number | null;
  money: boolean;
  absentNow?: Absence;
  absentBefore?: Absence;
  /** For apurado-based amounts: coverage now and at the closing (read from the stored snapshot). */
  coverage?: { current: LiquidatedCoverage; previous: LiquidatedCoverage };
}) {
  const fmt = (n: number) => (money ? formatCompactMoneyCents(n) : formatNumber(n));
  const fmtFull = (n: number) => (money ? formatMoneyCents(n) : formatNumber(n));
  const coverageNote = coverage ? (
    <p className="mt-1 text-xs text-muted-foreground">
      Apurado em {formatNumber(coverage.current.assessed)} de {formatNumber(coverage.current.total)} agora ·{" "}
      {formatNumber(coverage.previous.assessed)} de {formatNumber(coverage.previous.total)} no fechamento
    </p>
  ) : null;
  let comparison: ReactNode = null;
  if (current !== null && previous !== null) {
    const d = delta(current, previous);
    const direction = d.diff > 0 ? "up" : d.diff < 0 ? "down" : "same";
    const Icon = direction === "up" ? ArrowUpRight : direction === "down" ? ArrowDownRight : ArrowRight;
    const word = direction === "up" ? "Aumento" : direction === "down" ? "Redução" : "Sem variação";
    const sign = d.diff > 0 ? "+" : d.diff < 0 ? "−" : "";
    comparison = (
      <p className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-slate-700">
        <Icon aria-hidden="true" className="size-3.5 shrink-0" />
        <span>
          {word}
          {direction === "same" ? "" : ` de ${sign}${fmt(Math.abs(d.diff))}`}
          {d.ratio !== null && direction !== "same" ? ` (${sign}${formatPercent(Math.abs(d.ratio), 1)})` : ""}
        </span>
      </p>
    );
  } else if (current !== null || previous !== null) {
    comparison = (
      <p className="mt-0.5 text-xs text-slate-700">
        Sem base de comparação: {current !== null ? `${absentBefore.reason} no fechamento` : `${absentNow.reason} agora`}
      </p>
    );
  }
  return (
    <div className="min-w-0 rounded-md border border-border bg-surface-muted p-3">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      {current !== null ? (
        <p className="mt-0.5 text-lg font-semibold text-slate-900 tabular-nums" title={fmtFull(current)}>
          {fmt(current)}
        </p>
      ) : (
        <p className="mt-0.5 text-base font-medium text-muted-foreground">{absentNow.label}</p>
      )}
      {comparison}
      {previous !== null ? (
        <p className="text-xs text-muted-foreground tabular-nums" title={fmtFull(previous)}>
          No fechamento: {fmt(previous)}
        </p>
      ) : current !== null ? (
        <p className="text-xs text-muted-foreground">No fechamento: {absentBefore.reason}</p>
      ) : null}
      {coverageNote}
    </div>
  );
}

/**
 * Current position × the latest closed competência. Each amount is compared on its own basis:
 * exposure and provision on the valor apurado, exposure estimate on the valor da causa. The
 * provision uses the provision basis (a valor apurado without risk classification has no
 * provision), never the valor apurado coverage.
 */
export function PreviousClosingCard({ data, closingsHref }: { data: PortfolioData; closingsHref: string | null }) {
  const prev = data.previous;
  const t = data.totals;
  const coverage = prev ? { current: data.coverage, previous: liquidatedCoverage(prev.totals) } : undefined;
  const exposureNow = exposureBasisCounts(t);
  const provisionNow = totalProvisionBasis(data);
  return (
    <Card>
      <CardHeader
        actions={
          closingsHref ? (
            <Link
              href={closingsHref}
              className="inline-flex items-center gap-0.5 text-xs font-medium text-primary-600 hover:text-primary focus-visible:outline-2 focus-visible:outline-ring"
            >
              Fechamentos mensais
              <ChevronRight aria-hidden="true" className="size-3.5" />
            </Link>
          ) : null
        }
      >
        <CardTitle className="text-base">Comparação com o fechamento anterior</CardTitle>
        <CardDescription>
          {prev
            ? `Posição atual × competência de ${formatMonthYear(prev.period)} (fechada e imutável), com o mesmo escopo e filtros.`
            : "Compara a posição atual com a última competência mensal fechada pela contabilidade."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {prev ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <DeltaFigure label="Processos na carteira" current={t.count} previous={prev.totals.count} money={false} />
            <DeltaFigure
              label="Exposição apurada"
              current={amountOn(t.exposureCents, exposureNow.official)}
              previous={amountOn(prev.totals.exposureCents, prev.exposureBasis.official)}
              money
              coverage={coverage}
            />
            <DeltaFigure
              label="Exposição estimada"
              current={amountOn(t.exposureEstimateCents, exposureNow.estimate)}
              previous={amountOn(prev.totals.exposureEstimateCents, prev.exposureBasis.estimate)}
              money
              absentNow={NO_ESTIMATE}
            />
            <DeltaFigure
              label="Provisão apurada"
              current={amountOn(t.provisionCents, provisionNow.official)}
              previous={amountOn(prev.totals.provisionCents, prev.provisionBasis.official)}
              money
              absentNow={provisionAbsence(exposureNow.official)}
              absentBefore={provisionAbsence(prev.exposureBasis.official)}
              coverage={coverage}
            />
          </div>
        ) : (
          <p className="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            Sem fechamento anterior. A comparação aparece depois que a primeira competência mensal for fechada.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Dimension charts
// ---------------------------------------------------------------------------

function unknownNote(n: number, word: string) {
  return n > 0 ? ` (${formatNumber(n)} ${word})` : "";
}

/** "sem instância informada" (from the shared "Sem instância informada" label). */
const missingPhrase = (field: RegistrationGap["field"]) => MISSING_FIELD_LABELS[field].replace(/^Sem /, "sem ");

/** A figure that does not exist (não apurado, sem base de cálculo…): the reason in muted text, never a dash or R$ 0. */
function Absent({ reason }: { reason: string }) {
  return (
    <span className="text-muted-foreground" title={reason}>
      {reason}
    </span>
  );
}

const SERIES_INFO: Record<DimensionSeriesKey, { label: string; color: string }> = {
  official: { label: "Exposição apurada", color: SERIES.blue },
  estimate: { label: "Exposição estimada", color: SERIES.orange },
  count: { label: "Processos", color: SERIES.blue },
};

/**
 * One dimension of the portfolio chart: exposure (official and estimated, never merged)
 * and process count per group, with deep links. Every bar label uses the chart's single
 * money unit, shown once in the value column header; tooltips, accessible names and the
 * table carry the exact amounts. Only informed values are categories: processes without
 * the field are counted in the note (and in "Pendências de cadastro"), never drawn as a
 * "Não informado" bar.
 */
export function DimensionPanel({ dimension }: { dimension: Dimension }) {
  const key = dimension.key;
  const dimensionLabel = DIMENSION_LABELS[key];
  const title = `Exposição e processos por ${DIMENSION_NOUNS[key]}`;
  const description = DIMENSION_DESCRIPTIONS[key];
  const rows = dimension.rows;
  const model = dimensionChartModel(dimension);
  const all = [...rows.map((r) => r.bucket), ...(dimension.others ? [dimension.others.bucket] : [])];
  const coverage = liquidatedCoverage(mergeBuckets(all));
  const tableRows: ReactNode[][] = [
    ...rows.map((r) => [r.label, r.bucket, r.provisionBasis] as const),
    ...(dimension.others
      ? [[`Demais (${formatNumber(dimension.others.groups)})`, dimension.others.bucket, dimension.others.provisionBasis] as const]
      : []),
  ].map(([label, b, provisionBasis]: readonly [string, MoneyBucket, AmountBasisCounts]) => {
    const c = liquidatedCoverage(b);
    const basis = exposureBasisCounts(b);
    // Processes with a valor apurado but no provision (no risk classification): never summed as R$ 0.
    const notCalculated = Math.max(0, c.assessed - provisionBasis.official);
    return [
      label,
      formatNumber(b.count),
      b.count > 0 && b.claimUnknown >= b.count ? (
        <Absent reason="Sem valor informado" />
      ) : (
        `${formatMoneyCents(b.claimCents)}${unknownNote(b.claimUnknown, "sem valor")}`
      ),
      c.assessed === 0 ? "Não apurado" : `${formatMoneyCents(b.liquidatedCents)}${unknownNote(b.liquidatedUnknown, "não apurados")}`,
      `${formatNumber(c.assessed)} de ${formatNumber(c.total)} (${coveragePercent(c)})`,
      c.assessed === 0 ? <Absent reason="Não apurado" /> : formatMoneyCents(b.exposureCents),
      basis.estimate > 0 ? (
        formatMoneyCents(b.exposureEstimateCents)
      ) : (
        <Absent reason={basis.none > 0 ? "Sem base de cálculo" : "Sem estimativa: todos com valor apurado"} />
      ),
      provisionBasis.official > 0 ? (
        `${formatMoneyCents(b.provisionCents)}${unknownNote(notCalculated, notCalculated === 1 ? "não calculada" : "não calculadas")}`
      ) : (
        <Absent reason={provisionAbsence(c.assessed).label} />
      ),
    ];
  });
  const missing = dimension.missing;
  const rowText = new Map(model.rows.map((r) => [r.key, r]));
  const unitPhrase = model.scale ? ` Barras em ${model.unitLabel}; o valor exato aparece na dica e na tabela.` : "";
  const estimatePhrase = model.rows.some((r) => r.valueText.includes("est. ")) ? " “est.” = exposição estimada." : "";
  const tail = " Entre parênteses, a quantidade de processos. Clique numa linha para abrir a carteira filtrada.";
  let leadNote: string;
  if (model.rows.length === 0) {
    leadNote = "Nenhum processo da carteira, nos filtros selecionados, tem este campo informado.";
  } else if (model.kind === "count") {
    leadNote =
      "Ainda não há exposição calculada para estes processos: as barras mostram a quantidade. Clique numa linha para abrir a carteira filtrada.";
  } else if (model.withOfficial) {
    const unassessed = model.someRowUnassessed ? " “Não apurado”: nenhum processo da linha tem valor apurado (não é zero)." : "";
    leadNote = `Exposição apurada calculada sobre o ${coverageStatement(coverage)}.${unassessed}${estimatePhrase}${unitPhrase}${tail}`;
  } else {
    const why =
      coverage.assessed === 0
        ? "nenhum processo deste gráfico tem valor apurado, então não há exposição apurada"
        : `nenhuma linha do gráfico tem valor apurado (o ${coverageStatement(coverage)} fica em “Demais”, na tabela)`;
    leadNote = `Estimativa: ${why}; as barras mostram a exposição estimada (valor da causa × % de risco − garantias).${unitPhrase}${tail}`;
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      <ChartBody
        legend={model.withOfficial ? model.series.map((s) => SERIES_INFO[s]) : undefined}
        note={
          <>
            {leadNote}
            {dimension.others ? ` ${pluralize(dimension.others.groups, "grupo menor está somado", "grupos menores estão somados")} em “Demais” (veja a tabela).` : ""}
            {missing ? (
              <>
                {" "}
                {pluralize(missing.bucket.count, "processo", "processos")} {missingPhrase(key)}{" "}
                {missing.bucket.count === 1 ? "fica" : "ficam"} fora deste gráfico:{" "}
                <Link
                  href={missing.href}
                  className="font-medium text-primary-700 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                >
                  completar o cadastro
                </Link>
                .
              </>
            ) : null}
          </>
        }
        table={{
          caption: title,
          headers: [
            dimensionLabel,
            "Processos",
            "Valor da causa",
            "Valor liquidado",
            "Valor apurado em",
            "Exposição apurada",
            "Exposição estimada",
            "Provisão apurada",
          ],
          rows: tableRows,
        }}
      >
        <BarChart
          label={model.scale ? `${title} (valores em ${model.unitLabel})` : `Processos por ${DIMENSION_NOUNS[key]}`}
          header={{ label: model.scale ? `${dimensionLabel} (processos)` : dimensionLabel, value: model.unitLabel }}
          series={model.series.map((s) => ({ key: s, ...SERIES_INFO[s] }))}
          valueText={(row) => rowText.get(row.key)?.valueText ?? ""}
          tipValue={(row) => rowText.get(row.key)?.tip ?? ""}
          rows={model.rows.map((r) => ({ key: r.key, label: r.label, values: r.values, href: r.href }))}
        />
      </ChartBody>
    </div>
  );
}

/**
 * P0.3 — ONE block for the portfolio by tribunal, instância, fase, cidade, empresa and
 * unidade: a dimension selector (tablist, default tribunal, `?dimensao=`) over the chart
 * and the "Ver dados em tabela" view of the selected dimension.
 */
export function ExposureByDimension({
  dimensions,
  initial = DEFAULT_DIMENSION,
  filterFormId,
  className,
}: {
  dimensions: Record<DimensionKey, Dimension>;
  /** Selected dimension on load (from `parseChartDimension(searchParams)`). */
  initial?: DimensionKey;
  /** Id of the page's filter form, so the selected dimension survives filtering. */
  filterFormId?: string;
  className?: string;
}) {
  return (
    <Card className={cn("min-w-0", className)}>
      <CardHeader>
        <CardTitle className="text-base">Exposição e processos por dimensão</CardTitle>
        <CardDescription>
          Exposição apurada e estimada (lado a lado, nunca somadas) e quantidade de processos da carteira ativa, agrupadas
          pela dimensão escolhida.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <DimensionTabs
          label="Agrupar por"
          param={DIMENSION_PARAM}
          initial={initial}
          fallback={DEFAULT_DIMENSION}
          formId={filterFormId}
          tabs={DIMENSIONS.map((k) => ({
            value: k,
            label: DIMENSION_LABELS[k],
            slug: DIMENSION_PARAMS[k],
            panel: <DimensionPanel dimension={dimensions[k]} />,
          }))}
        />
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Registration gaps ("Pendências de cadastro")
// ---------------------------------------------------------------------------

/**
 * Active processes without a field used by the charts, with the count and a link that
 * opens the portfolio filtered on the missing field (`/processos?pendencia=<campo>`).
 * Renders nothing when every process is complete.
 */
export function RegistrationGaps({
  gaps,
  className,
  description = "Processos da carteira ativa sem um dos campos usados nos gráficos. Eles ficam fora do gráfico correspondente até o cadastro ser completado.",
}: {
  gaps: RegistrationGap[];
  className?: string;
  description?: string;
}) {
  if (gaps.length === 0) return null;
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="text-base">Pendências de cadastro</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {gaps.map((g) => (
            <li key={g.field}>
              <Link
                href={g.href}
                className="group flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 transition-colors hover:border-primary-300 hover:bg-primary-50/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="text-lg font-semibold text-slate-900 tabular-nums">{formatNumber(g.count)}</span>
                  <span className="truncate text-sm text-slate-800">{MISSING_FIELD_LABELS[g.field]}</span>
                </span>
                <span className="inline-flex shrink-0 items-center gap-0.5 text-xs font-medium text-primary-600 group-hover:text-primary">
                  Completar cadastro
                  <ChevronRight aria-hidden="true" className="size-3.5" />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Largest exposures
// ---------------------------------------------------------------------------

export function TopExposures({ items, className }: { items: TopExposureItem[]; className?: string }) {
  return (
    <ChartCard
      className={className}
      title="Maiores exposições"
      description="Processos da carteira ativa com maior exposição líquida. Exposições estimadas aparecem identificadas."
    >
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nenhum processo com exposição calculada nos filtros selecionados.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Maiores exposições da carteira ativa</caption>
            <thead>
              <tr className="border-b border-border text-xs text-muted-foreground">
                <th scope="col" className="py-2 pr-3 font-medium">
                  Processo
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Tribunal / instância
                </th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">
                  Valor da causa
                </th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">
                  Valor liquidado
                </th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">
                  Exposição
                </th>
                <th scope="col" className="py-2 font-medium">
                  Risco
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((p) => (
                <tr key={p.processId} className="border-b border-border/60 align-top last:border-0">
                  <td className="max-w-64 py-2 pr-3">
                    <Link
                      href={processTabUrl(p.processId, "valores-e-acordos")}
                      className="font-medium whitespace-nowrap text-primary-600 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      {p.number}
                    </Link>
                    <p className="truncate text-xs text-muted-foreground" title={p.title}>
                      {p.title}
                    </p>
                  </td>
                  <td className="py-2 pr-3 whitespace-nowrap">
                    {p.court}
                    <span className="block text-xs text-muted-foreground">
                      {p.instance ? PROCESS_INSTANCE_LABELS[p.instance] : "Instância não informada"}
                    </span>
                  </td>
                  <td className="py-2 pr-3 text-right whitespace-nowrap tabular-nums">
                    {p.claimCents === null ? <span className="text-muted-foreground">Não informado</span> : formatMoneyCents(p.claimCents)}
                  </td>
                  <td className="py-2 pr-3 text-right whitespace-nowrap tabular-nums">
                    {p.liquidatedCents === null ? (
                      <span className="text-muted-foreground">Não apurado</span>
                    ) : (
                      formatMoneyCents(p.liquidatedCents)
                    )}
                  </td>
                  <td className="py-2 pr-3 text-right whitespace-nowrap tabular-nums">
                    {p.exposureCents === null ? <span className="text-muted-foreground">Não calculada</span> : formatMoneyCents(p.exposureCents)}
                    {p.exposureIsEstimate ? (
                      <span className="mt-0.5 block">
                        <EstimateBadge />
                      </span>
                    ) : null}
                  </td>
                  <td className="py-2 whitespace-nowrap">{p.classification ? LOSS_PROBABILITY_LABELS[p.classification] : "Não classificado"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </ChartCard>
  );
}
