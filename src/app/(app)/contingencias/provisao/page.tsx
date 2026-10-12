import { Download, FileSpreadsheet, Lock } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatBp, type MoneyBucket } from "@/domain/contingency";
import { LOSS_PROBABILITY_LABELS, type LossProbability } from "@/domain/enums";
import { formatDate, formatDateTime, formatMoneyCents, formatNumber, todayISO } from "@/lib/format";
import { pageParam, param, type SearchParams } from "@/lib/search-params";
import { cn } from "@/lib/utils";
import { ClassificationBadge, Delta, EstimateBadge, Money, SnapshotStatusBadge } from "@/modules/contingency/components/badges";
import { CloseSnapshotDialog, GenerateSnapshotButton } from "@/modules/contingency/components/snapshot-forms";
import { calculationMemo } from "@/modules/contingency/csv";
import { NOT_INFORMED } from "@/modules/contingency/labels";
import { formatPeriod, isValidPeriod, periodOf, recentPeriods } from "@/modules/contingency/rules";
import { getSnapshot, listSnapshots, type SnapshotView } from "@/modules/contingency/snapshot-service";
import { can } from "@/server/auth/permissions";
import { requirePageContext } from "@/server/auth/session";

export const metadata: Metadata = { title: "Provisão e fechamento mensal" };

export default async function ProvisionPage(props: { searchParams: Promise<SearchParams> }) {
  const ctx = await requirePageContext("contingency:read");
  const sp = await props.searchParams;
  const current = periodOf(todayISO());
  const requested = param(sp, "competencia");
  const period = requested && isValidPeriod(requested) && requested <= current ? requested : current;

  const [snapshots, view] = await Promise.all([listSnapshots(ctx), getSnapshot(ctx, period, { page: pageParam(sp) })]);
  const canGenerate = can(ctx, "contingency:approve");
  const canClose = can(ctx, "snapshot:close");
  const byPeriod = new Map(snapshots.map((s) => [s.period, s]));
  const periods = [...new Set([...recentPeriods(current, 12), ...snapshots.map((s) => s.period)])].sort().reverse();

  return (
    <>
      <PageHeader
        title="Provisão e fechamento mensal"
        description="A prévia recalcula a carteira na data-base (último dia do mês) com os valores oficiais, a classificação em vigor e as garantias vinculadas. Uma competência fechada é imutável (RN-10)."
        breadcrumbs={[{ label: "Contingências", href: "/contingencias" }, { label: "Provisão e fechamento" }]}
        actions={
          view ? (
            <a
              href={`/api/contingency/snapshots/${period}/csv`}
              className={buttonVariants({ variant: "outline" })}
              download
            >
              <Download aria-hidden="true" />
              Exportar CSV (contabilidade)
            </a>
          ) : null
        }
      />

      <div className="grid gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <nav aria-label="Competências" className="min-w-0">
          <Card className="py-3">
            <CardHeader className="px-4">
              <CardTitle as="h2" className="text-sm">
                Competências
              </CardTitle>
            </CardHeader>
            <ul className="flex gap-1 overflow-x-auto px-2 pb-1 lg:flex-col lg:overflow-visible">
              {periods.map((p) => {
                const s = byPeriod.get(p);
                const active = p === period;
                return (
                  <li key={p} className="shrink-0">
                    <Link
                      href={`/contingencias/provisao?competencia=${p}`}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "flex items-center justify-between gap-3 rounded-md px-3 py-2 text-sm transition-colors hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                        active && "bg-primary-50 font-semibold text-primary-900 hover:bg-primary-50",
                      )}
                    >
                      <span className="tabular-nums">{formatPeriod(p)}</span>
                      {s ? (
                        <SnapshotStatusBadge status={s.status} />
                      ) : (
                        <span className="text-xs text-muted-foreground">não gerada</span>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </Card>
        </nav>

        <div className="min-w-0 space-y-6">
          {view ? (
            <SnapshotDetail view={view} canGenerate={canGenerate} canClose={canClose} current={current} sp={sp} />
          ) : (
            <EmptyState
              icon={<FileSpreadsheet />}
              title={`Competência ${formatPeriod(period)} ainda não calculada`}
              description={
                canGenerate
                  ? "Gere a prévia para calcular a posição da carteira na data-base. A rotina diária também mantém a prévia do mês atual."
                  : "A prévia é gerada pela contabilidade/gestão jurídica ou pela rotina diária do mês atual."
              }
              action={canGenerate ? <GenerateSnapshotButton period={period} exists={false} /> : undefined}
            />
          )}
        </div>
      </div>
    </>
  );
}

function SnapshotDetail({
  view,
  canGenerate,
  canClose,
  current,
  sp,
}: {
  view: SnapshotView;
  canGenerate: boolean;
  canClose: boolean;
  current: string;
  sp: SearchParams;
}) {
  const t = view.totals;
  const prev = view.previous;
  const v = view.variation;
  const isPreview = view.status === "preview";
  return (
    <>
      <Card>
        <CardHeader
          actions={
            isPreview ? (
              <>
                {canGenerate ? <GenerateSnapshotButton period={view.period} exists /> : null}
                {canClose ? (
                  <CloseSnapshotDialog
                    period={view.period}
                    periodLabel={formatPeriod(view.period)}
                    generatedAtLabel={formatDateTime(view.generatedAt)}
                    monthNotOver={view.period === current}
                    estimateCount={view.estimateCount}
                  />
                ) : null}
              </>
            ) : null
          }
        >
          <CardTitle className="flex flex-wrap items-center gap-2">
            Competência {formatPeriod(view.period)}
            <SnapshotStatusBadge status={view.status} long />
          </CardTitle>
          <CardDescription>
            Data-base {formatDate(view.referenceDate)} · calculada em {formatDateTime(view.generatedAt)}
            {view.generatedByName ? ` por ${view.generatedByName}` : " pela rotina automática"}
            {view.closedAt ? ` · fechada em ${formatDateTime(view.closedAt)}${view.closedByName ? ` por ${view.closedByName}` : ""}` : ""}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-slate-700">
            Parâmetros usados: remota {view.params.riskPercentages.remote}% · possível {view.params.riskPercentages.possible}% ·
            provável {view.params.riskPercentages.probable}% · versão {view.params.rulesVersion} das regras de risco.
          </p>
          {view.status === "closed" ? (
            <Callout tone="success" title="Competência fechada">
              Os valores abaixo são exatamente os do fechamento e não mudam com lançamentos posteriores (RN-10).
            </Callout>
          ) : (
            <Callout tone="info" title="Prévia recalculável">
              Os valores podem mudar até o fechamento. Valores propostos e não conferidos não entram no cálculo (RN-11).
            </Callout>
          )}
          {view.estimateCount > 0 ? (
            <Callout tone="warning" title={`${formatNumber(view.estimateCount)} processo(s) com valores estimados (RN-07)`}>
              Sem valor liquidado, a base é o valor da causa ponderado pelo risco. Estimativas são separadas dos valores apurados e
              saem com ressalva no CSV.
            </Callout>
          ) : null}
          {view.scope === "org_wide" && view.hiddenCount > 0 ? (
            <Callout tone="info" icon={<Lock />}>
              Os totais da organização incluem {formatNumber(view.hiddenCount)} processo(s) sigiloso(s) não listado(s).
            </Callout>
          ) : null}
          {view.scope === "visible" ? (
            <Callout tone="info">Totais calculados somente sobre os processos que você pode ver.</Callout>
          ) : null}
        </CardContent>
      </Card>

      <section aria-label="Totais da competência" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Total label="Processos" value={formatNumber(t.count)} delta={v ? <CountDelta n={v.count} /> : null} />
        <Total
          label="Valor da causa (declarado)"
          value={formatMoneyCents(t.claimCents)}
          hint={`${formatNumber(t.claimUnknown)} sem valor`}
          delta={v ? <Delta cents={v.claimCents} /> : null}
        />
        <Total
          label="Valor liquidado (apurado)"
          value={formatMoneyCents(t.liquidatedCents)}
          hint={`${formatNumber(t.liquidatedUnknown)} não apurado(s)`}
          delta={v ? <Delta cents={v.liquidatedCents} /> : null}
        />
        <Total label="Garantias vinculadas" value={formatMoneyCents(t.guaranteesCents)} delta={v ? <Delta cents={v.guaranteesCents} /> : null} />
        <Total label="Exposição oficial" value={formatMoneyCents(t.exposureCents)} delta={v ? <Delta cents={v.exposureCents} /> : null} />
        <Total
          label="Exposição estimada"
          value={formatMoneyCents(t.exposureEstimateCents)}
          estimate
          delta={v ? <Delta cents={v.exposureEstimateCents} /> : null}
        />
        <Total label="Provisão (valores apurados)" value={formatMoneyCents(t.provisionCents)} strong delta={v ? <Delta cents={v.provisionCents} /> : null} />
        <Total
          label="Provisão estimada"
          value={formatMoneyCents(t.provisionEstimateCents)}
          estimate
          delta={v ? <Delta cents={v.provisionEstimateCents} /> : null}
        />
      </section>
      <p className="-mt-3 text-xs text-muted-foreground">
        {prev
          ? `Variação em relação a ${formatPeriod(prev.period)} (${prev.status === "closed" ? "fechada" : "prévia"}).`
          : "Sem competência anterior calculada para comparação."}{" "}
        Valor da causa e valor liquidado nunca são somados (RN-02).
      </p>

      <Card>
        <CardHeader>
          <CardTitle>Provisão por classificação</CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          <Table aria-label="Provisão por classificação">
            <TableHeader>
              <TableRow>
                <TableHead>Classificação</TableHead>
                <TableHead className="text-right">Processos</TableHead>
                <TableHead className="text-right">Provisão apurada</TableHead>
                <TableHead className="text-right">Provisão estimada</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.byClassification.map(({ key, bucket }) => (
                <ClassRow key={key} label={key === "unclassified" ? "Não classificado" : LOSS_PROBABILITY_LABELS[key as LossProbability]} bucket={bucket} />
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {view.movement && prev ? (
        <Card>
          <CardHeader>
            <CardTitle>Movimentação do período</CardTitle>
            <CardDescription>
              Comparação com {formatPeriod(prev.period)}: {formatNumber(view.movement.addedCount)} processo(s) entraram,{" "}
              {formatNumber(view.movement.removedCount)} saíram e {formatNumber(view.movement.changedCount)} tiveram a provisão alterada.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 lg:grid-cols-3">
            <MovementList
              title="Entraram na carteira"
              empty="Nenhum processo entrou."
              items={view.movement.added.map((a) => ({ id: a.processId, number: a.number, right: <Money cents={a.provisionCents} fallback="sem provisão" /> }))}
            />
            <MovementList
              title="Saíram da carteira"
              empty="Nenhum processo saiu."
              items={view.movement.removed.map((a) => ({ id: a.processId, number: a.number, right: <Money cents={a.provisionCents} fallback="sem provisão" /> }))}
            />
            <MovementList
              title="Maiores variações de provisão"
              empty="Nenhuma variação."
              items={view.movement.provisionChanges.slice(0, 15).map((c) => ({ id: c.processId, number: c.number, right: <Delta cents={c.deltaCents} /> }))}
            />
          </CardContent>
        </Card>
      ) : null}

      <Card className="pb-3">
        <CardHeader>
          <CardTitle>Memória de cálculo</CardTitle>
          <CardDescription>
            Uma linha por processo listado: base (liquidado − garantias, ou valor da causa como estimativa) × percentual da
            classificação em vigor na data-base.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <Table aria-label="Memória de cálculo por processo">
            <TableHeader>
              <TableRow>
                <TableHead>Processo</TableHead>
                <TableHead>Classificação</TableHead>
                <TableHead className="text-right">Valor da causa</TableHead>
                <TableHead className="text-right">Valor liquidado</TableHead>
                <TableHead className="text-right">Garantias</TableHead>
                <TableHead className="text-right">Provisão</TableHead>
                <TableHead>Cálculo</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.items.length === 0 ? (
                <TableEmpty colSpan={7} message="Nenhum processo listado para o seu perfil nesta competência." />
              ) : (
                view.items.map((i) => (
                  <TableRow key={i.processId}>
                    <TableCell className="min-w-44">
                      <Link href={`/processos/${i.processId}?aba=valores`} className="font-medium tabular-nums text-primary-700 hover:underline">
                        {i.number}
                      </Link>
                      <span className="block text-xs text-muted-foreground">
                        {[i.court, i.companyName].filter(Boolean).join(" · ") || "—"}
                      </span>
                    </TableCell>
                    <TableCell>
                      <ClassificationBadge classification={i.classification} percentageBp={i.percentageBp} />
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      <Money cents={i.claimAmountCents} fallback={NOT_INFORMED} />
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      <Money cents={i.liquidatedAmountCents} />
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap tabular-nums">{formatMoneyCents(i.guaranteesCents)}</TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      <Money cents={i.provisionCents} fallback="—" />
                      {i.provisionIsEstimate ? <EstimateBadge className="mt-1" /> : null}
                    </TableCell>
                    <TableCell className="min-w-72 text-xs text-slate-600">
                      {calculationMemo(i)}
                      {i.percentageBp !== null && i.provision.base !== "none" ? (
                        <span className="sr-only"> Percentual {formatBp(i.percentageBp)}.</span>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <Pagination page={view.page} pageSize={view.pageSize} total={view.itemsTotal} basePath="/contingencias/provisao" searchParams={sp} />
    </>
  );
}

function Total({
  label,
  value,
  hint,
  delta,
  estimate = false,
  strong = false,
}: {
  label: string;
  value: string;
  hint?: string;
  delta?: React.ReactNode;
  estimate?: boolean;
  strong?: boolean;
}) {
  return (
    <div className={cn("rounded-lg border bg-surface p-4 shadow-xs", strong ? "border-primary-300" : "border-border")}>
      <p className="flex flex-wrap items-center gap-2 text-xs font-medium text-muted-foreground">
        {label}
        {estimate ? <EstimateBadge /> : null}
      </p>
      <p className="mt-1 text-xl font-semibold text-slate-900 tabular-nums">{value}</p>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      {delta ? <p className="mt-1 text-xs">{delta}</p> : null}
    </div>
  );
}

function CountDelta({ n }: { n: number }) {
  if (n === 0) return <span className="text-muted-foreground">sem variação</span>;
  return <span className="tabular-nums">{n > 0 ? `+${formatNumber(n)}` : `−${formatNumber(Math.abs(n))}`} processo(s)</span>;
}

function ClassRow({ label, bucket }: { label: string; bucket: MoneyBucket }) {
  return (
    <TableRow>
      <TableCell className="font-medium">{label}</TableCell>
      <TableCell className="text-right tabular-nums">{formatNumber(bucket.count)}</TableCell>
      <TableCell className="text-right tabular-nums">{formatMoneyCents(bucket.provisionCents)}</TableCell>
      <TableCell className="text-right tabular-nums">{formatMoneyCents(bucket.provisionEstimateCents)}</TableCell>
    </TableRow>
  );
}

function MovementList({
  title,
  empty,
  items,
}: {
  title: string;
  empty: string;
  items: { id: string; number: string; right: React.ReactNode }[];
}) {
  return (
    <div className="rounded-md border border-border">
      <p className="border-b border-border bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-700">{title}</p>
      {items.length === 0 ? (
        <p className="px-3 py-3 text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="max-h-72 divide-y divide-border overflow-y-auto text-sm">
          {items.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <Link href={`/processos/${i.id}?aba=valores`} className="tabular-nums text-primary-700 hover:underline">
                {i.number}
              </Link>
              <span className="text-xs">{i.right}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
