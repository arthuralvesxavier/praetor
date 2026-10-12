import { ArrowDownRight, ArrowRight, ArrowUpRight, ChevronRight, Scale } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { StatCard } from "@/components/ui/stat-card";
import type { MoneyBucket } from "@/domain/contingency";
import { LOSS_PROBABILITY_LABELS, PROCESS_INSTANCE_LABELS, type LossProbability } from "@/domain/enums";
import { formatMoneyCents, formatMonthYear, formatNumber, formatPercent, pluralize } from "@/lib/format";
import { cn } from "@/lib/utils";
import { processesHref, type BiFilters } from "../bi-filters";
import { formatCompactMoneyCents } from "../format";
import { delta, mergeBuckets } from "../portfolio";
import type { Dimension, PortfolioData, TopExposureItem } from "../portfolio-service";
import { BarChart } from "./charts/bar-chart";
import { ChartCard } from "./charts/chart-card";
import { SERIES } from "./charts/palette";

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

export function PortfolioKpis({ data, filters }: { data: PortfolioData; filters: BiFilters }) {
  const t = data.totals;
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard
        label="Processos na carteira ativa"
        value={formatNumber(data.activeProcesses)}
        hint="Número CNJ único: as instâncias de um mesmo processo não somam"
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
          <Figure
            label="Valor liquidado"
            value={<Money cents={t.liquidatedCents} />}
            hint={
              t.liquidatedUnknown > 0 ? (
                <Link
                  href={processesHref(filters, { liquidado: "sem" })}
                  className="text-primary-700 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                >
                  {formatNumber(t.liquidatedUnknown)} não apurado{t.liquidatedUnknown === 1 ? "" : "s"}
                </Link>
              ) : (
                "Todos apurados"
              )
            }
          />
        </div>
      </KpiCard>

      <KpiCard
        title="Exposição líquida"
        footer={
          t.exposureUnknown > 0
            ? `${pluralize(t.exposureUnknown, "processo", "processos")} sem base de cálculo (sem valor liquidado nem classificação de risco).`
            : "Oficial e estimada são apresentadas separadamente."
        }
      >
        <div className="grid grid-cols-2 gap-3">
          <Figure label="Oficial" value={<Money cents={t.exposureCents} />} hint="Liquidado − garantias vinculadas" />
          <Figure
            label="Estimada"
            badge={<EstimateBadge />}
            value={<Money cents={t.exposureEstimateCents} />}
            hint="Valor da causa × % de risco − garantias"
          />
        </div>
      </KpiCard>

      <KpiCard title="Provisão" footer={<ProvisionSplit data={data} />}>
        <div className="grid grid-cols-2 gap-3">
          <Figure label="Oficial" value={<Money cents={t.provisionCents} />} hint="Base liquidada × % da classificação" />
          <Figure
            label="Estimada"
            badge={<EstimateBadge />}
            value={<Money cents={t.provisionEstimateCents} />}
            hint="Sem liquidação: valor da causa × %"
          />
        </div>
      </KpiCard>
    </div>
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
            Proc.
          </th>
          <th scope="col" className="py-0.5 pr-2 text-right font-medium">
            Oficial
          </th>
          <th scope="col" className="py-0.5 text-right font-medium">
            Estimada
          </th>
        </tr>
      </thead>
      <tbody>
        {data.byClassification.map((c) => (
          <tr key={c.key} className="text-slate-700">
            <th scope="row" className="py-0.5 pr-2 font-normal">
              {CLASSIFICATION_LABEL(c.key)}
            </th>
            <td className="py-0.5 pr-2 text-right tabular-nums">{formatNumber(c.bucket.count)}</td>
            <td className="py-0.5 pr-2 text-right">
              <Money cents={c.bucket.provisionCents} />
            </td>
            <td className="py-0.5 text-right">
              <Money cents={c.bucket.provisionEstimateCents} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Comparison with the previous closed month
// ---------------------------------------------------------------------------

function DeltaFigure({ label, current, previous, money }: { label: string; current: number; previous: number; money: boolean }) {
  const d = delta(current, previous);
  const fmt = (n: number) => (money ? formatCompactMoneyCents(n) : formatNumber(n));
  const fmtFull = (n: number) => (money ? formatMoneyCents(n) : formatNumber(n));
  const direction = d.diff > 0 ? "up" : d.diff < 0 ? "down" : "same";
  const Icon = direction === "up" ? ArrowUpRight : direction === "down" ? ArrowDownRight : ArrowRight;
  const word = direction === "up" ? "Aumento" : direction === "down" ? "Redução" : "Sem variação";
  const sign = d.diff > 0 ? "+" : d.diff < 0 ? "−" : "";
  return (
    <div className="min-w-0 rounded-md border border-border bg-surface-muted p-3">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-lg font-semibold text-slate-900 tabular-nums" title={fmtFull(current)}>
        {fmt(current)}
      </p>
      <p className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-slate-700">
        <Icon aria-hidden="true" className="size-3.5 shrink-0" />
        <span>
          {word}
          {direction === "same" ? "" : ` de ${sign}${fmt(Math.abs(d.diff))}`}
          {d.ratio !== null && direction !== "same" ? ` (${sign}${formatPercent(Math.abs(d.ratio), 1)})` : ""}
        </span>
      </p>
      <p className="text-xs text-muted-foreground tabular-nums" title={fmtFull(previous)}>
        No fechamento: {fmt(previous)}
      </p>
    </div>
  );
}

export function PreviousClosingCard({ data, closingsHref }: { data: PortfolioData; closingsHref: string | null }) {
  const prev = data.previous;
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
            <DeltaFigure label="Processos na carteira" current={data.totals.count} previous={prev.totals.count} money={false} />
            <DeltaFigure
              label="Exposição oficial"
              current={data.totals.exposureCents}
              previous={prev.totals.exposureCents}
              money
            />
            <DeltaFigure
              label="Exposição estimada"
              current={data.totals.exposureEstimateCents}
              previous={prev.totals.exposureEstimateCents}
              money
            />
            <DeltaFigure label="Provisão oficial" current={data.totals.provisionCents} previous={prev.totals.provisionCents} money />
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

/** Exposure (official and estimated, never merged) and process count per group, with deep links. */
export function DimensionChart({
  title,
  description,
  dimension,
  dimensionLabel,
  className,
  note,
}: {
  title: string;
  description?: ReactNode;
  dimension: Dimension;
  dimensionLabel: string;
  className?: string;
  note?: ReactNode;
}) {
  const rows = dimension.rows;
  const all = [...rows.map((r) => r.bucket), ...(dimension.others ? [dimension.others.bucket] : [])];
  const totals = mergeBuckets(all);
  const hasExposure = totals.exposureCents + totals.exposureEstimateCents > 0;
  const money = formatCompactMoneyCents;
  const tableRows: ReactNode[][] = [
    ...rows.map((r) => [r.label, r.bucket] as const),
    ...(dimension.others ? [[`Demais (${formatNumber(dimension.others.groups)})`, dimension.others.bucket] as const] : []),
  ].map(([label, b]: readonly [string, MoneyBucket]) => [
    label,
    formatNumber(b.count),
    `${formatMoneyCents(b.claimCents)}${unknownNote(b.claimUnknown, "sem valor")}`,
    `${formatMoneyCents(b.liquidatedCents)}${unknownNote(b.liquidatedUnknown, "não apurados")}`,
    formatMoneyCents(b.exposureCents),
    formatMoneyCents(b.exposureEstimateCents),
    formatMoneyCents(b.provisionCents),
  ]);

  return (
    <ChartCard
      className={className}
      title={title}
      description={description}
      legend={
        hasExposure
          ? [
              { label: "Exposição oficial", color: SERIES.blue },
              { label: "Exposição estimada", color: SERIES.orange },
            ]
          : undefined
      }
      note={
        <>
          {hasExposure
            ? "Entre parênteses, a quantidade de processos. Clique numa linha para abrir a carteira filtrada."
            : "Ainda não há exposição calculada para estes processos: as barras mostram a quantidade. Clique numa linha para abrir a carteira filtrada."}
          {dimension.others ? ` ${pluralize(dimension.others.groups, "grupo menor está somado", "grupos menores estão somados")} em “Demais” (veja a tabela).` : ""}
          {note ? <> {note}</> : null}
        </>
      }
      table={{
        caption: title,
        headers: [dimensionLabel, "Processos", "Valor da causa", "Valor liquidado", "Exposição oficial", "Exposição estimada", "Provisão oficial"],
        rows: tableRows,
      }}
    >
      {hasExposure ? (
        <BarChart
          label={title}
          format={money}
          series={[
            { key: "official", label: "Exposição oficial", color: SERIES.blue },
            { key: "estimate", label: "Exposição estimada", color: SERIES.orange },
          ]}
          valueText={(row) => `${money(row.values[0] ?? 0)} · est. ${money(row.values[1] ?? 0)}`}
          rows={rows.map((r) => ({
            key: r.key ?? "__none__",
            label: `${r.label} (${formatNumber(r.bucket.count)})`,
            values: [r.bucket.exposureCents, r.bucket.exposureEstimateCents],
            href: r.href ?? undefined,
          }))}
        />
      ) : (
        <BarChart
          label={title}
          series={[{ key: "count", label: "Processos", color: SERIES.blue }]}
          format={(n) => formatNumber(n)}
          rows={rows.map((r) => ({
            key: r.key ?? "__none__",
            label: r.label,
            values: [r.bucket.count],
            href: r.href ?? undefined,
          }))}
        />
      )}
    </ChartCard>
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
                      href={`/processos/${p.processId}?aba=valores`}
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
                    {formatMoneyCents(p.exposureCents)}
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
