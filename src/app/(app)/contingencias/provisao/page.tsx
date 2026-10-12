import { Download, FileSpreadsheet, FileText, Lock, RefreshCw } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  addBasisCounts,
  emptyBasisCounts,
  exposureBasisCounts,
  formatBp,
  provisionBasisForClass,
  type AmountBasisCounts,
  type MoneyBucket,
} from "@/domain/contingency";
import { LOSS_PROBABILITY_LABELS, type LossProbability } from "@/domain/enums";
import { formatDate, formatDateTime, formatMoneyCents, formatNumber, todayISO } from "@/lib/format";
import { pageParam, param, type SearchParams } from "@/lib/search-params";
import { cn } from "@/lib/utils";
import { ClassificationBadge, Delta, EstimateBadge, Money, SnapshotStatusBadge } from "@/modules/contingency/components/badges";
import { CloseSnapshotDialog, GenerateSnapshotButton } from "@/modules/contingency/components/snapshot-forms";
import { stalePreviewReasons } from "@/modules/contingency/close-gate";
import { calculationMemo } from "@/modules/contingency/csv";
import { NOT_INFORMED } from "@/modules/contingency/labels";
import { formatPeriod, isValidPeriod, periodOf, recentPeriods } from "@/modules/contingency/rules";
import {
  getCloseGate,
  getSnapshot,
  listSnapshots,
  type CloseGateView,
  type ProvisionChange as SnapshotMovementChange,
  type SnapshotView,
} from "@/modules/contingency/snapshot-service";
import { PROCESS_SECTION_IDS, processTabUrl } from "@/modules/processes/tabs";
import { PROVISION_MEMO_PDF_ROW_LIMIT } from "@/modules/provision-memo/memo";
import { can } from "@/server/auth/permissions";
import { requirePageContext } from "@/server/auth/session";
import { CloseWithJustificationDialog } from "./close-gate-forms";

export const metadata: Metadata = { title: "Provisão e fechamento mensal" };

export default async function ProvisionPage(props: { searchParams: Promise<SearchParams> }) {
  const ctx = await requirePageContext("contingency:read");
  const sp = await props.searchParams;
  const current = periodOf(todayISO());
  const requested = param(sp, "competencia");
  const period = requested && isValidPeriod(requested) && requested <= current ? requested : current;

  const [snapshots, view, gate] = await Promise.all([
    listSnapshots(ctx),
    getSnapshot(ctx, period, { page: pageParam(sp) }),
    getCloseGate(ctx, period),
  ]);
  const canGenerate = can(ctx, "contingency:approve");
  const canClassify = can(ctx, "contingency:write");
  const canClose = can(ctx, "snapshot:close");
  const byPeriod = new Map(snapshots.map((s) => [s.period, s]));
  const periods = [...new Set([...recentPeriods(current, 12), ...snapshots.map((s) => s.period)])].sort().reverse();

  return (
    <>
      <PageHeader
        title="Provisão e fechamento mensal"
        description="A prévia recalcula a carteira na data-base (último dia do mês) com os valores oficiais, a classificação em vigor e as garantias vinculadas. Uma competência fechada é imutável."
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
            <SnapshotDetail
              view={view}
              gate={gate}
              canGenerate={canGenerate}
              canClose={canClose}
              canClassify={canClassify}
              current={current}
              sp={sp}
            />
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
  gate,
  canGenerate,
  canClose,
  canClassify,
  current,
  sp,
}: {
  view: SnapshotView;
  gate: CloseGateView;
  canGenerate: boolean;
  canClose: boolean;
  canClassify: boolean;
  current: string;
  sp: SearchParams;
}) {
  const t = view.totals;
  const exposureBasis = exposureBasisCounts(t);
  const provisionBasis = view.byClassification.reduce((acc, c) => addBasisCounts(acc, classProvisionBasis(c.key, c.bucket)), emptyBasisCounts());
  const prev = view.previous;
  const v = view.variation;
  // RN-03: a variation needs the amount on both sides; against a competência where it was not
  // calculated (no valor apurado, no estimate, no process) there is no increase or decrease.
  const pt = prev?.totals;
  const prevExposureBasis = pt ? exposureBasisCounts(pt) : null;
  const prevProvisionBasis = prev
    ? prev.byClassification.reduce((acc, c) => addBasisCounts(acc, classProvisionBasis(c.key, c.bucket)), emptyBasisCounts())
    : null;
  const compared = (current: number, previous: number | undefined, cents: number | undefined) =>
    cents === undefined ? null : <Compared show={current > 0 && (previous ?? 0) > 0} cents={cents} />;
  const isPreview = view.status === "preview";
  const closeAllowed = gate.canCloseWithoutJustification === true;
  return (
    <>
      <Card>
        <CardHeader
          actions={
            isPreview ? (
              <>
                {canGenerate ? <GenerateSnapshotButton period={view.period} exists /> : null}
                {canClose && closeAllowed ? (
                  <CloseSnapshotDialog
                    period={view.period}
                    periodLabel={formatPeriod(view.period)}
                    generatedAtLabel={formatDateTime(view.generatedAt)}
                    monthNotOver={view.period === current}
                    estimateCount={view.estimateCount}
                  />
                ) : null}
                {canClose && !closeAllowed ? (
                  <>
                    <Button type="button" disabled aria-describedby="close-gate-reason">
                      <Lock aria-hidden="true" />
                      Fechar competência
                    </Button>
                    {!gate.isStale && gate.count > 0 ? (
                      <CloseWithJustificationDialog
                        period={view.period}
                        periodLabel={formatPeriod(view.period)}
                        referenceDateLabel={formatDate(view.referenceDate)}
                        generatedAtLabel={formatDateTime(view.generatedAt)}
                        unclassifiedCount={gate.count}
                        hiddenCount={gate.hiddenCount}
                        monthNotOver={view.period === current}
                        estimateCount={view.estimateCount}
                      />
                    ) : null}
                  </>
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
              Os valores abaixo são exatamente os do fechamento e não mudam com lançamentos posteriores.
            </Callout>
          ) : null}
          {view.status === "closed" && gate.override ? <OverrideNotice gate={gate} /> : null}
          {view.status === "closed" ? null : (
            <Callout tone="info" title="Prévia recalculável">
              Os valores podem mudar até o fechamento. Valores propostos e não conferidos não entram no cálculo.
            </Callout>
          )}
          {view.estimateCount > 0 ? (
            <Callout tone="warning" title={`${formatNumber(view.estimateCount)} processo(s) com valores estimados`}>
              Sem valor liquidado, a base é o valor da causa ponderado pelo risco. Estimativas são separadas dos valores apurados e
              saem com ressalva no CSV.
            </Callout>
          ) : null}
          {view.scope === "org_wide" && view.hiddenCount > 0 ? (
            <Callout tone="info" icon={<Lock />}>
              Os totais da organização incluem {formatNumber(view.hiddenCount)} processo(s) sigiloso(s) não listado(s).
            </Callout>
          ) : null}
          {view.scope === "visible" && view.scopeNote ? <Callout tone="info">{view.scopeNote}</Callout> : null}
          {view.deletedCount > 0 ? (
            <Callout tone="info">
              {formatNumber(view.deletedCount)} processo(s) listado(s) foram excluídos do sistema após o{" "}
              {view.status === "closed" ? "fechamento" : "cálculo da prévia"}: a posição registrada na competência foi mantida.
            </Callout>
          ) : null}
        </CardContent>
      </Card>

      {isPreview ? <CloseGateCard gate={gate} canClose={canClose} canClassify={canClassify} /> : null}

      <section aria-label="Totais da competência" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Total label="Processos" value={formatNumber(t.count)} delta={v ? <CountDelta n={v.count} /> : null} />
        <Total
          label="Valor da causa (declarado)"
          value={amountOr(t.count - t.claimUnknown, t.claimCents, "Não informado", t.count)}
          hint={`${formatNumber(t.claimUnknown)} sem valor`}
          delta={compared(t.count - t.claimUnknown, pt && pt.count - pt.claimUnknown, v?.claimCents)}
        />
        <Total
          label="Valor liquidado (apurado)"
          value={amountOr(exposureBasis.official, t.liquidatedCents, "Não apurado", t.count)}
          hint={`${formatNumber(t.liquidatedUnknown)} não apurado(s)`}
          delta={compared(exposureBasis.official, prevExposureBasis?.official, v?.liquidatedCents)}
        />
        <Total label="Garantias vinculadas" value={formatMoneyCents(t.guaranteesCents)} delta={compared(t.count, pt?.count, v?.guaranteesCents)} />
        <Total
          label="Exposição apurada"
          value={amountOr(exposureBasis.official, t.exposureCents, "Não apurada", t.count)}
          delta={compared(exposureBasis.official, prevExposureBasis?.official, v?.exposureCents)}
        />
        <Total
          label="Exposição estimada"
          value={amountOr(exposureBasis.estimate, t.exposureEstimateCents, "Sem estimativa", t.count)}
          hint={exposureBasis.none > 0 ? `${formatNumber(exposureBasis.none)} sem base de cálculo` : undefined}
          estimate
          delta={compared(exposureBasis.estimate, prevExposureBasis?.estimate, v?.exposureEstimateCents)}
        />
        <Total
          label="Provisão (valores apurados)"
          value={amountOr(provisionBasis.official, t.provisionCents, exposureBasis.official > 0 ? "Não calculada" : "Não apurada", t.count)}
          strong
          delta={compared(provisionBasis.official, prevProvisionBasis?.official, v?.provisionCents)}
        />
        <Total
          label="Provisão estimada"
          value={amountOr(provisionBasis.estimate, t.provisionEstimateCents, "Sem estimativa", t.count)}
          estimate
          delta={compared(provisionBasis.estimate, prevProvisionBasis?.estimate, v?.provisionEstimateCents)}
        />
      </section>
      <p className="-mt-3 text-xs text-muted-foreground">
        {prev
          ? `Variação em relação a ${formatPeriod(prev.period)} (${prev.status === "closed" ? "fechada" : "prévia"}).`
          : "Sem competência anterior calculada para comparação."}{" "}
        Valor da causa e valor liquidado nunca são somados.
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
                <ClassRow
                  key={key}
                  label={key === "unclassified" ? "Não classificado" : LOSS_PROBABILITY_LABELS[key as LossProbability]}
                  bucket={bucket}
                  unclassified={key === "unclassified"}
                />
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
              items={view.movement.added.map((a) => ({ id: a.processId, number: a.number, deleted: a.processDeleted, right: <MovementAmount cents={a.provisionCents} isEstimate={a.provisionIsEstimate} /> }))}
            />
            <MovementList
              title="Saíram da carteira"
              empty="Nenhum processo saiu."
              items={view.movement.removed.map((a) => ({ id: a.processId, number: a.number, deleted: a.processDeleted, right: <MovementAmount cents={a.provisionCents} isEstimate={a.provisionIsEstimate} /> }))}
            />
            <MovementList
              title="Maiores variações de provisão"
              empty="Nenhuma variação."
              items={view.movement.provisionChanges.slice(0, 15).map((c) => ({ id: c.processId, number: c.number, deleted: c.processDeleted, right: <ProvisionChangeAmount change={c} /> }))}
            />
          </CardContent>
        </Card>
      ) : null}

      <Card className="pb-3">
        <CardHeader actions={<ProvisionMemoDownloads period={view.period} isPreview={isPreview} rows={view.itemsTotal} />}>
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
                      {i.processDeleted ? (
                        <>
                          <span className="font-medium tabular-nums text-slate-900">{i.number}</span>
                          <Badge tone="neutral" className="ml-1 align-middle">
                            Excluído
                          </Badge>
                        </>
                      ) : (
                        <Link href={processTabUrl(i.processId, "valores-e-acordos")} className="font-medium tabular-nums text-primary-700 hover:underline">
                          {i.number}
                        </Link>
                      )}
                      <span className="block text-xs text-muted-foreground">
                        {[i.court, i.companyName].filter(Boolean).join(" · ") || "Tribunal e empresa não informados"}
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
                      <Money cents={i.provisionCents} fallback="Sem provisão" />
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

/**
 * Downloads of the memória de cálculo (P1.10): read from the stored items of the competência; audited by the route.
 * `rows` = listed items (same visibility as the memo); above the PDF limit only the XLSX is offered.
 */
function ProvisionMemoDownloads({ period, isPreview, rows }: { period: string; isPreview: boolean; rows: number }) {
  const suffix = isPreview ? " (prévia, sujeita a alteração)" : "";
  const pdfAvailable = rows <= PROVISION_MEMO_PDF_ROW_LIMIT;
  return (
    <div className="flex flex-wrap gap-2">
      <a
        href={`/api/provision-memo/${period}?formato=xlsx`}
        className={buttonVariants({ variant: "outline", size: "sm" })}
        aria-label={`Baixar a memória de cálculo em XLSX${suffix}`}
        download
      >
        <FileSpreadsheet aria-hidden="true" />
        Memória em XLSX
      </a>
      {pdfAvailable ? (
        <a
          href={`/api/provision-memo/${period}?formato=pdf`}
          className={buttonVariants({ variant: "outline", size: "sm" })}
          aria-label={`Baixar a memória de cálculo em PDF${suffix}`}
          download
        >
          <FileText aria-hidden="true" />
          Memória em PDF
        </a>
      ) : (
        <>
          <Button type="button" variant="outline" size="sm" disabled aria-describedby="provision-memo-pdf-limit">
            <FileText aria-hidden="true" />
            Memória em PDF
          </Button>
          <p id="provision-memo-pdf-limit" className="w-full text-xs text-muted-foreground">
            O PDF da memória é gerado até {formatNumber(PROVISION_MEMO_PDF_ROW_LIMIT)} processos. Esta competência tem{" "}
            {formatNumber(rows)}: baixe o XLSX.
          </p>
        </>
      )}
    </div>
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
  value: React.ReactNode;
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

/** Variation of a total, or why there is none (the amount does not exist on one of the sides). */
function Compared({ show, cents }: { show: boolean; cents: number }) {
  return show ? <Delta cents={cents} /> : <span className="text-muted-foreground">sem base de comparação</span>;
}

/** "apurada" (on the valor apurado) or "estimada" (on the valor da causa): the basis of a provision amount. */
const basisWord = (isEstimate: boolean) => (isEstimate ? "estimada" : "apurada");

/** Provision of a process that entered or left the portfolio, with its basis (or "sem provisão"). */
function MovementAmount({ cents, isEstimate }: { cents: number | null; isEstimate: boolean }) {
  if (cents === null) return <Money cents={null} fallback="sem provisão" />;
  return (
    <span className="tabular-nums">
      {formatMoneyCents(cents)} <span className="text-muted-foreground">{basisWord(isEstimate)}</span>
    </span>
  );
}

/**
 * Provision change of one process. A difference is shown only between two provisions on the
 * same basis (RN-03/RN-07); a provision that appeared, disappeared or moved between the
 * estimate and the valor apurado shows both amounts with their basis, never a difference
 * that would mix them or read null as R$ 0.
 */
function ProvisionChangeAmount({ change: c }: { change: SnapshotMovementChange }) {
  if (c.fromCents === null && c.toCents !== null) {
    return (
      <span className="tabular-nums">
        {formatMoneyCents(c.toCents)} {basisWord(c.toIsEstimate)} <span className="text-muted-foreground">(antes sem provisão)</span>
      </span>
    );
  }
  if (c.toCents === null && c.fromCents !== null) {
    return (
      <span className="text-muted-foreground">
        Sem provisão (antes <span className="tabular-nums">{formatMoneyCents(c.fromCents)}</span> {basisWord(c.fromIsEstimate)})
      </span>
    );
  }
  if (c.deltaCents === null && c.fromCents !== null && c.toCents !== null) {
    return (
      <span className="tabular-nums">
        {formatMoneyCents(c.toCents)} {basisWord(c.toIsEstimate)}
        <span className="block text-muted-foreground">
          antes {formatMoneyCents(c.fromCents)} {basisWord(c.fromIsEstimate)} (mudança de base)
        </span>
      </span>
    );
  }
  return (
    <span>
      {c.deltaCents === null ? <span className="text-muted-foreground">sem provisão</span> : <Delta cents={c.deltaCents} />}
      {c.toIsEstimate ? <span className="text-muted-foreground"> estimada</span> : null}
    </span>
  );
}

function CountDelta({ n }: { n: number }) {
  if (n === 0) return <span className="text-muted-foreground">sem variação</span>;
  return <span className="tabular-nums">{n > 0 ? `+${formatNumber(n)}` : `−${formatNumber(Math.abs(n))}`} processo(s)</span>;
}

/**
 * Sum of a group, or a muted `empty` text when no process of it has this amount (RN-03:
 * nothing calculated is never R$ 0). An empty competência keeps the plain zero.
 */
function amountOr(count: number, cents: number, empty: string, total: number): React.ReactNode {
  if (count > 0 || total === 0) return formatMoneyCents(cents);
  return <span className="text-base font-medium text-muted-foreground">{empty}</span>;
}

/**
 * Provision basis of a classification row of the stored metrics. A process without
 * classification has no provision; amounts stored anyway (records from before the risk
 * history) are still shown as stored (RN-10).
 */
function classProvisionBasis(key: string, bucket: MoneyBucket): AmountBasisCounts {
  const basis = provisionBasisForClass(bucket, key !== "unclassified");
  if (key !== "unclassified") return basis;
  return { ...basis, official: bucket.provisionCents > 0 ? 1 : 0, estimate: bucket.provisionEstimateCents > 0 ? 1 : 0 };
}

function ClassRow({ label, bucket, unclassified }: { label: string; bucket: MoneyBucket; unclassified: boolean }) {
  const basis = classProvisionBasis(unclassified ? "unclassified" : "classified", bucket);
  const muted = (text: string) => <span className="text-muted-foreground">{text}</span>;
  return (
    <TableRow>
      <TableCell className="font-medium">{label}</TableCell>
      <TableCell className="text-right tabular-nums">{formatNumber(bucket.count)}</TableCell>
      {bucket.count === 0 ? (
        <TableCell colSpan={2} className="text-muted-foreground">
          Nenhum processo nesta classificação
        </TableCell>
      ) : (
        <>
          <TableCell className="text-right whitespace-nowrap tabular-nums">
            {basis.official > 0
              ? formatMoneyCents(bucket.provisionCents)
              : muted(unclassified || bucket.liquidatedUnknown < bucket.count ? "Não calculada" : "Não apurada")}
          </TableCell>
          <TableCell className="text-right whitespace-nowrap tabular-nums">
            {basis.estimate > 0 ? formatMoneyCents(bucket.provisionEstimateCents) : muted(unclassified ? "Não calculada" : "Sem estimativa")}
            {!unclassified && basis.none > 0 ? (
              <span className="block text-xs text-muted-foreground">{formatNumber(basis.none)} sem base de cálculo</span>
            ) : null}
          </TableCell>
        </>
      )}
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
  items: { id: string; number: string; deleted: boolean; right: React.ReactNode }[];
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
              {i.deleted ? (
                <span className="tabular-nums text-slate-700">
                  {i.number} <span className="text-xs text-muted-foreground">(excluído)</span>
                </span>
              ) : (
                <Link href={processTabUrl(i.id, "valores-e-acordos")} className="tabular-nums text-primary-700 hover:underline">
                  {i.number}
                </Link>
              )}
              <span className="text-xs">{i.right}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Before the close (P1.9): processes active on the reference date without official risk classification. */
function CloseGateCard({ gate, canClose, canClassify }: { gate: CloseGateView; canClose: boolean; canClassify: boolean }) {
  const ref = formatDate(gate.referenceDate);
  if (gate.count === 0 && !gate.isStale) {
    return (
      <Callout tone="success" title="Classificação de risco completa">
        Todos os processos da prévia, ativos em {ref}, têm classificação de risco oficial em vigor na data-base.
        {canClose ? " A competência pode ser fechada." : ""}
      </Callout>
    );
  }
  const reason = gate.isStale
    ? "A prévia está desatualizada em relação à carteira ou às classificações de risco com vigência até a data-base. Recalcule a prévia antes de fechar."
    : `O fechamento normal fica bloqueado enquanto houver processo nesta lista. Registre a classificação de cada um (com parecer, vigente até ${ref}) ou feche com justificativa.`;
  const staleReasons = gate.staleness ? stalePreviewReasons(gate.staleness) : [];
  return (
    <Card className="pb-3">
      <CardHeader>
        <CardTitle as="h2">
          {gate.count > 0
            ? `${formatNumber(gate.count)} processo(s) sem classificação de risco oficial em ${ref}`
            : "Prévia desatualizada: recalcule antes de fechar"}
        </CardTitle>
        <CardDescription id="close-gate-reason">{reason}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 px-0">
        {gate.isStale ? (
          <div className="px-5">
            <Callout tone="warning" icon={<RefreshCw />} title="Recalcule a prévia">
              <p>
                O fechamento congela os processos e valores guardados na prévia. Ao recalcular, a lista abaixo e a provisão passam a
                refletir a carteira e as classificações em vigor na data-base.
              </p>
              {staleReasons.length > 0 ? (
                <ul className="mt-1 list-disc pl-5">
                  {staleReasons.map((r) => (
                    <li key={r}>{r}.</li>
                  ))}
                </ul>
              ) : null}
            </Callout>
          </div>
        ) : null}
        {gate.hiddenCount > 0 ? (
          <div className="px-5">
            <Callout tone="info" icon={<Lock />}>
              Inclui {formatNumber(gate.hiddenCount)} processo(s) sigiloso(s) não listado(s) para o seu perfil.
            </Callout>
          </div>
        ) : null}
        {gate.scope === "visible" && gate.count > 0 ? (
          <p className="px-5 text-xs text-muted-foreground">Lista limitada aos processos que você pode ver.</p>
        ) : null}
        {gate.count > 0 || gate.itemsTotal > 0 ? (
          <Table aria-label="Processos sem classificação de risco oficial na data-base">
            <TableHeader>
              <TableRow>
                <TableHead>Processo</TableHead>
                <TableHead>Responsável</TableHead>
                <TableHead>Situação da classificação</TableHead>
                <TableHead>
                  <span className="sr-only">Ação</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {gate.items.length === 0 ? (
                <TableEmpty colSpan={4} message="Nenhum processo listado para o seu perfil." />
              ) : (
                gate.items.map((i) => (
                  <TableRow key={i.processId}>
                    <TableCell className="min-w-48">
                      <Link href={`/processos/${i.processId}`} className="font-medium tabular-nums text-primary-700 hover:underline">
                        {i.number}
                      </Link>
                      <span className="block max-w-md truncate text-xs text-muted-foreground" title={i.title}>
                        {i.title}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm">{i.responsibleName ?? <span className="text-muted-foreground">Sem responsável</span>}</TableCell>
                    <TableCell className="min-w-56">
                      <div className="flex flex-wrap gap-1">
                        {i.classifiedFrom ? (
                          <Badge tone="warning">Oficial só a partir de {formatDate(i.classifiedFrom)}</Badge>
                        ) : i.recordOnly ? (
                          <Badge tone="warning">Só no cadastro, sem parecer oficial</Badge>
                        ) : (
                          <Badge tone="neutral">Sem classificação</Badge>
                        )}
                        {i.pendingProposal ? <Badge tone="info">Sugestão aguardando conferência</Badge> : null}
                        {i.isConfidential ? <Badge tone="neutral">Sigiloso</Badge> : null}
                      </div>
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      <Link
                        href={processTabUrl(i.processId, "valores-e-acordos", PROCESS_SECTION_IDS.risk)}
                        className={buttonVariants({ variant: "outline", size: "sm" })}
                        aria-label={`${canClassify ? "Classificar" : "Ver risco do"} processo ${i.number}`}
                      >
                        {canClassify ? "Classificar" : "Ver risco"}
                      </Link>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        ) : null}
        {gate.itemsTotal > gate.items.length ? (
          <p className="px-5 text-xs text-muted-foreground">
            Mostrando {formatNumber(gate.items.length)} de {formatNumber(gate.itemsTotal)} processo(s), em ordem de número.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** Closed competência closed with a justification (immutable record of the override). */
function OverrideNotice({ gate }: { gate: CloseGateView }) {
  const o = gate.override!;
  if (o.reason === null) {
    // "Visible" scope with none of the unclassified processes listed: no org-level text, no count.
    return (
      <Callout tone="info" title="Fechada com ressalva">
        Nenhum dos processos que você pode ver estava sem classificação de risco oficial em {formatDate(gate.referenceDate)}. A
        ressalva registrada no fechamento se refere a processos que não estão na sua lista.
      </Callout>
    );
  }
  return (
    <Callout tone="warning" title="Fechada com justificativa">
      <p>
        Fechada com {formatNumber(o.count)} processo(s) sem classificação, justificativa: <q className="whitespace-pre-line">{o.reason}</q>
      </p>
      <p className="text-xs">
        Registrada {o.closedByName ? `por ${o.closedByName} ` : ""}em {formatDateTime(o.createdAt)}. Classificação considerada: oficial em
        vigor em {formatDate(gate.referenceDate)}.
        {o.hiddenCount > 0 ? ` Inclui ${formatNumber(o.hiddenCount)} processo(s) sigiloso(s) não listado(s).` : ""}
      </p>
      {o.items.length > 0 ? (
        <details className="text-xs">
          <summary className="cursor-pointer font-medium">Processos sem classificação no fechamento ({formatNumber(o.items.length)} listado(s))</summary>
          <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
            {o.items.map((i) => (
              <li key={i.processId} className="tabular-nums">
                {i.processDeleted ? (
                  <span>
                    {i.number} <span className="text-muted-foreground">(excluído)</span>
                  </span>
                ) : (
                  <Link href={processTabUrl(i.processId, "valores-e-acordos", PROCESS_SECTION_IDS.risk)}>{i.number}</Link>
                )}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </Callout>
  );
}
