import Link from "next/link";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Pagination } from "@/components/ui/pagination";
import { StatCard } from "@/components/ui/stat-card";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow, tableLinkClasses } from "@/components/ui/table";
import { formatBp } from "@/domain/contingency";
import { PROCESS_INSTANCE_LABELS, processPhaseLabel } from "@/domain/enums";
import { formatDate, formatDateTime, formatMoneyCents, formatMonthYear, formatNumber, pluralize } from "@/lib/format";
import { buildHref, type SearchParams } from "@/lib/search-params";
import { cn } from "@/lib/utils";
import {
  CLASSIFICATION_LABELS,
  MOVEMENT_EVENT_LABELS,
  PROVISION_MOVEMENT_LABELS,
  type AuditLetterReport,
  type ExposureReport,
  type ExposureRow,
  type MovementEventKind,
  type MovementReport,
  type PortfolioReport,
  type ProvisionReport,
  type ResponsibleRow,
  type ResponsiblesReport,
} from "../types";
import { exposureAmounts, previousExposureAmounts, provisionAmountsOn, variationOf, type BasisAmounts } from "../comparison";
import { BucketTable } from "./bucket-table";
import {
  CountCell,
  DeltaCount,
  DeltaMoney,
  EstimateBadge,
  EstimateMoneyCell,
  ExposureEstimateCell,
  MoneyGroupCell,
  MoneyValueCell,
  NumCell,
  NumHead,
  VariationLines,
} from "./report-cells";

function monthLabel(period: string): string {
  return formatMonthYear(`${period}-01`);
}

function SectionCard({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <Card className="print-avoid-break py-0">
      <CardHeader className="pt-5">
        <CardTitle>{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent className="px-0 pb-1">{children}</CardContent>
    </Card>
  );
}

/** Muted text of a cell without value (never a dash; never zero). */
function EmptyValue({ children }: { children: ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>;
}

function EstimatesCallout() {
  return (
    <Callout tone="warning" title="Há valores estimados">
      Exposições e provisões calculadas sobre o valor da causa, quando não há valor liquidado, aparecem nas colunas
      “estimada” e não devem ser lidas como valor apurado.
    </Callout>
  );
}

// ---------------------------------------------------------------------------
// Carteira
// ---------------------------------------------------------------------------

export function PortfolioReportView({ report }: { report: PortfolioReport }) {
  return (
    <div className="grid grid-cols-1 gap-6">
      {report.hasEstimates ? <EstimatesCallout /> : null}
      <SectionCard title="Por empresa" description="Processos da carteira ativa por empresa do grupo.">
        <BucketTable label="Carteira por empresa" groupHeader="Empresa" rows={report.byCompany} totals={report.totals} />
      </SectionCard>
      <SectionCard title="Por unidade" description="Processos da carteira ativa por unidade responsável.">
        <BucketTable label="Carteira por unidade" groupHeader="Unidade" rows={report.byUnit} totals={report.totals} />
      </SectionCard>
      <SectionCard
        title="Provisão por classificação de risco"
        description="Classificação vigente de cada processo (remota, possível, provável). Sem classificação, a provisão não é calculada."
      >
        <BucketTable
          label="Provisão por classificação de risco"
          groupHeader="Classificação"
          rows={report.byClassification}
          totals={report.totals}
        />
      </SectionCard>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Exposição
// ---------------------------------------------------------------------------

/**
 * Variation of an exposure against the previous competência, under the amount in the same
 * cell: the previous amount and the difference, only when both sides were calculated on that
 * basis. A group that had no process in the previous competência reads "antes sem processos";
 * one without valor apurado there, "antes não apurada" (RN-03).
 */
function ExposureVariation({ row, kind }: { row: ExposureRow; kind: "official" | "estimate" }) {
  if (!row.previous) return <ComparisonMissing />;
  const cur = exposureAmounts(row.bucket)[kind];
  const prev = previousExposureAmounts(row.previous)[kind];
  const previousEmpty = row.previous.processCount === 0 ? "sem processos" : kind === "official" ? "não apurada" : "sem estimativa";
  return <VariationLines previous={prev} previousEmpty={previousEmpty} delta={variationOf(cur, prev)} compact />;
}

/** Process count of the previous competência and the difference (a count of zero is a value). */
function CountVariation({ row }: { row: ExposureRow }) {
  if (!row.previous) return <ComparisonMissing />;
  return (
    <>
      <span className="mt-1 block text-xs font-normal text-muted-foreground">antes {formatNumber(row.previous.processCount)}</span>
      <span className="block text-xs font-normal">
        {row.processCount === row.previous.processCount ? (
          <EmptyValue>sem variação</EmptyValue>
        ) : (
          <DeltaCount delta={row.processCount - row.previous.processCount} />
        )}
      </span>
    </>
  );
}

function ComparisonMissing() {
  return <span className="mt-1 block text-xs font-normal text-muted-foreground">Sem comparação</span>;
}

/** Column header; with the comparison, a second line says the cell also carries the variation. */
function ExposureHead({ children, compare }: { children: ReactNode; compare: boolean }) {
  return (
    <NumHead className={compare ? "h-auto py-2 align-bottom" : undefined}>
      {children}
      {compare ? <span className="block text-[11px] font-normal text-muted-foreground">antes e variação</span> : null}
    </NumHead>
  );
}

/**
 * Exposure by group. With a comparison, the previous competência and the variation go under
 * each amount (processes, exposição apurada, exposição estimada) instead of three more columns,
 * so the table keeps six columns and fits its card on a desktop (it scrolls inside the card on
 * a phone).
 */
function ExposureTable({ label, header, rows, totals, compare }: { label: string; header: string; rows: ExposureRow[]; totals: ExposureRow; compare: boolean }) {
  const line = (r: ExposureRow, isTotal = false) => (
    // With the comparison every cell starts at the top, so the amounts of a row share one line.
    <TableRow key={r.key} className={cn(compare && "[&>td]:align-top", isTotal && "bg-slate-50 font-semibold")}>
      <TableCell className="min-w-44 max-w-72">{r.label}</TableCell>
      <NumCell>
        {formatNumber(r.processCount)}
        {compare ? <CountVariation row={r} /> : null}
      </NumCell>
      <MoneyGroupCell
        cents={r.bucket.claimCents}
        count={r.bucket.count}
        unknown={r.bucket.claimUnknown}
        unknownLabel="Não informado"
        unknownSingular="sem valor da causa"
        unknownPlural="sem valor da causa"
      />
      <MoneyGroupCell
        cents={r.bucket.liquidatedCents}
        count={r.bucket.count}
        unknown={r.bucket.liquidatedUnknown}
        unknownLabel="Não apurado"
        unknownSingular="não apurado"
        unknownPlural="não apurados"
      />
      <MoneyGroupCell
        cents={r.bucket.exposureCents}
        count={r.bucket.count}
        unknown={r.bucket.liquidatedUnknown}
        unknownLabel="Não apurada"
        unknownSingular="sem valor apurado"
        unknownPlural="sem valor apurado"
        showUnknownCount={false}
        footer={compare ? <ExposureVariation row={r} kind="official" /> : null}
      />
      <ExposureEstimateCell bucket={r.bucket} footer={compare ? <ExposureVariation row={r} kind="estimate" /> : null} />
    </TableRow>
  );
  return (
    <Table aria-label={label}>
      <TableHeader>
        <TableRow>
          <TableHead className={compare ? "h-auto py-2 align-bottom" : undefined}>{header}</TableHead>
          <ExposureHead compare={compare}>Processos</ExposureHead>
          <NumHead className={compare ? "h-auto py-2 align-bottom" : undefined}>Valor da causa</NumHead>
          <NumHead className={compare ? "h-auto py-2 align-bottom" : undefined}>Valor liquidado</NumHead>
          <ExposureHead compare={compare}>Exposição apurada</ExposureHead>
          <ExposureHead compare={compare}>Exposição estimada</ExposureHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 ? <TableEmpty colSpan={6} message="Nenhum processo com estes filtros." /> : rows.map((r) => line(r))}
        {rows.length > 0 ? line(totals, true) : null}
      </TableBody>
    </Table>
  );
}

export function ExposureReportView({ report }: { report: ExposureReport }) {
  const compare = report.comparison !== null;
  return (
    <div className="grid grid-cols-1 gap-6">
      {report.comparison ? (
        <Callout tone={report.comparison.status === "closed" ? "info" : "warning"} title="Comparação mensal">
          Variações calculadas contra o fechamento de {monthLabel(report.comparison.period)} (data-base{" "}
          {formatDate(report.comparison.referenceDate)},{" "}
          {report.comparison.status === "closed" ? "competência fechada" : "prévia ainda não fechada"}). Os valores do
          fechamento são lidos como foram registrados, sem recálculo.
          {report.comparisonNote ? <span className="block">{report.comparisonNote}</span> : null}
        </Callout>
      ) : (
        <Callout tone="info" title="Sem comparação">
          {report.comparisonNote}
        </Callout>
      )}
      {report.hasEstimates ? <EstimatesCallout /> : null}
      {report.dimensions.map((d) => (
        <SectionCard key={d.key} title={`Por ${d.label.toLowerCase()}`}>
          <ExposureTable label={`Exposição por ${d.label.toLowerCase()}`} header={d.label} rows={d.rows} totals={report.totals} compare={compare} />
        </SectionCard>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Provisão
// ---------------------------------------------------------------------------

/** Text of a provision that does not exist (RN-03): never R$ 0,00. */
function provisionEmptyLabel(processCount: number, liquidatedCount: number | undefined, unclassified = false): string {
  if (processCount === 0) return "Sem processos";
  return unclassified || (liquidatedCount ?? 0) > 0 ? "Não calculada" : "Não apurada";
}

/**
 * Variation of a classification against the previous closed competência: the provision on the
 * valor apurado, then the estimated one. Each difference needs both sides calculated.
 */
function ProvisionVariationCell({ current, previous }: { current: BasisAmounts; previous: BasisAmounts }) {
  const official = variationOf(current.official, previous.official);
  const estimate = variationOf(current.estimate, previous.estimate);
  const hasEstimate = current.estimate !== null || previous.estimate !== null;
  return (
    <NumCell>
      {official === null ? <EmptyValue>sem base de comparação</EmptyValue> : <DeltaMoney delta={official} />}
      {hasEstimate ? (
        <span className="block text-xs font-normal">
          <span className="text-muted-foreground">estimada: </span>
          {estimate === null ? <EmptyValue>sem base de comparação</EmptyValue> : <DeltaMoney delta={estimate} />}
        </span>
      ) : null}
    </NumCell>
  );
}

/** Opening or closing balance of the movement table, with the same reading as the classification table. */
function BalanceCells({
  amounts,
  basis,
  processCount,
  liquidatedCount,
}: {
  amounts: { provisionCents: number; provisionEstimateCents: number };
  basis: ProvisionReport["totals"]["currentBasis"];
  processCount: number;
  liquidatedCount: number | undefined;
}) {
  const on = provisionAmountsOn(amounts, basis, processCount);
  return (
    <>
      <NumCell>
        {on.official === null ? <EmptyValue>{provisionEmptyLabel(processCount, liquidatedCount)}</EmptyValue> : formatMoneyCents(on.official)}
      </NumCell>
      <EstimateMoneyCell
        cents={amounts.provisionEstimateCents}
        count={on.estimate === null ? 0 : basis?.estimate}
        emptyLabel={processCount === 0 ? "Sem processos" : "Sem estimativa"}
      />
    </>
  );
}

export function ProvisionReportView({ report }: { report: ProvisionReport }) {
  const snap = report.snapshot;
  if (!snap) return null;
  const hasPrev = report.previous !== null;
  return (
    <div className="grid grid-cols-1 gap-6">
      <Callout tone="info" title={`Competência ${monthLabel(snap.period)} fechada`}>
        Data-base {formatDate(snap.referenceDate)}
        {snap.closedAt ? `, fechada em ${formatDateTime(snap.closedAt)}` : ""}
        {snap.closedByName ? ` por ${snap.closedByName}` : ""}. Valores lidos do fechamento (imutável), com os
        percentuais da época: provável {snap.params.riskPercentages.probable}%, possível {snap.params.riskPercentages.possible}%,
        remota {snap.params.riskPercentages.remote}% (versão {snap.params.rulesVersion} das regras).
      </Callout>
      {report.hasEstimates ? (
        <Callout tone="warning" title="Ressalva: provisões estimadas">
          Parte da provisão foi calculada sobre o valor da causa, por falta de valor liquidado. Esses valores estão na coluna
          “Provisão estimada” e não devem ser contabilizados sem ressalva.
        </Callout>
      ) : null}

      <SectionCard title="Provisão por classificação">
        <Table aria-label="Provisão por classificação de risco">
          <TableHeader>
            <TableRow>
              <TableHead>Classificação</TableHead>
              <NumHead>Percentual</NumHead>
              <NumHead>Processos</NumHead>
              <NumHead>Provisão</NumHead>
              <NumHead>Provisão estimada</NumHead>
              {hasPrev ? <NumHead>Provisão em {monthLabel(report.previous!.period)}</NumHead> : null}
              {hasPrev ? <NumHead>Variação</NumHead> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {[...report.byClassification, report.totals].map((c, i, all) => {
              const isTotal = i === all.length - 1;
              const unclassified = !isTotal && c.key === "unclassified";
              // Without a classification the provision is never calculated (rows built without counts included).
              const notCalculated = { official: 0, estimate: 0, none: c.processCount };
              const curBasis = c.currentBasis ?? (unclassified ? notCalculated : undefined);
              const cur = provisionAmountsOn(c.current, curBasis, c.processCount);
              const prev = c.previous
                ? provisionAmountsOn(c.previous, c.previous.basis ?? (unclassified ? notCalculated : undefined), c.previous.processCount)
                : null;
              return (
                <TableRow key={isTotal ? "total" : c.key} className={isTotal ? "bg-slate-50 font-semibold" : undefined}>
                  <TableCell>{isTotal ? c.label : CLASSIFICATION_LABELS[c.key]}</TableCell>
                  <NumCell>{c.percentageBp === null ? <EmptyValue>Não se aplica</EmptyValue> : formatBp(c.percentageBp)}</NumCell>
                  <CountCell value={c.processCount} />
                  <NumCell>
                    {cur.official === null ? (
                      <EmptyValue>{provisionEmptyLabel(c.processCount, c.currentLiquidatedCount, unclassified)}</EmptyValue>
                    ) : (
                      formatMoneyCents(cur.official)
                    )}
                  </NumCell>
                  <EstimateMoneyCell
                    cents={c.current.provisionEstimateCents}
                    count={cur.estimate === null ? 0 : curBasis?.estimate}
                    emptyLabel={c.processCount === 0 ? "Sem processos" : unclassified ? "Não calculada" : "Sem estimativa"}
                    note={
                      !unclassified && curBasis && curBasis.none > 0 && !isTotal
                        ? pluralize(curBasis.none, "sem base de cálculo", "sem base de cálculo")
                        : null
                    }
                  />
                  {hasPrev ? (
                    c.previous && prev ? (
                      <NumCell>
                        {prev.official === null ? (
                          <EmptyValue>{provisionEmptyLabel(c.previous.processCount, c.previous.liquidatedCount, unclassified)}</EmptyValue>
                        ) : (
                          formatMoneyCents(prev.official)
                        )}
                        {prev.estimate !== null && (c.previous.basis || prev.estimate > 0) ? (
                          <span className="block text-xs text-amber-900">
                            {prev.official === null ? "" : "+ "}
                            {formatMoneyCents(prev.estimate)} estimada
                          </span>
                        ) : null}
                      </NumCell>
                    ) : (
                      <NumCell>
                        <EmptyValue>Sem comparação</EmptyValue>
                      </NumCell>
                    )
                  ) : null}
                  {hasPrev ? (
                    c.previous && c.processCount === 0 && c.previous.processCount === 0 ? (
                      <NumCell>
                        <EmptyValue>Sem processos</EmptyValue>
                      </NumCell>
                    ) : prev ? (
                      <ProvisionVariationCell current={cur} previous={prev} />
                    ) : (
                      <NumCell>
                        <EmptyValue>Sem comparação</EmptyValue>
                      </NumCell>
                    )
                  ) : null}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </SectionCard>

      <SectionCard
        title="Movimentação da provisão"
        description={
          report.previous
            ? `Desde a competência fechada anterior (${monthLabel(report.previous.period)}), processo a processo.`
            : undefined
        }
      >
        {report.movement ? (
          <Table aria-label="Movimentação da provisão">
            <TableHeader>
              <TableRow>
                <TableHead>Movimento</TableHead>
                <NumHead>Processos</NumHead>
                <NumHead>Provisão</NumHead>
                <NumHead>Provisão estimada</NumHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell>Saldo em {monthLabel(report.previous!.period)}</TableCell>
                <NumCell>
                  <EmptyValue>Não se aplica</EmptyValue>
                </NumCell>
                <BalanceCells
                  amounts={report.movement.opening}
                  basis={report.totals.previous?.basis}
                  processCount={report.totals.previous?.processCount ?? 0}
                  liquidatedCount={report.totals.previous?.liquidatedCount}
                />
              </TableRow>
              {report.movement.rows.map((m) => (
                <TableRow key={m.kind}>
                  <TableCell>{PROVISION_MOVEMENT_LABELS[m.kind]}</TableCell>
                  <CountCell value={m.processCount} />
                  <NumCell>
                    <DeltaMoney delta={m.provisionCents} />
                  </NumCell>
                  <NumCell>
                    <DeltaMoney delta={m.provisionEstimateCents} />
                  </NumCell>
                </TableRow>
              ))}
              <TableRow className="bg-slate-50 font-semibold">
                <TableCell>Saldo em {monthLabel(snap.period)}</TableCell>
                <NumCell>
                  <EmptyValue>Não se aplica</EmptyValue>
                </NumCell>
                <BalanceCells
                  amounts={report.movement.closing}
                  basis={report.totals.currentBasis}
                  processCount={report.totals.processCount}
                  liquidatedCount={report.totals.currentLiquidatedCount}
                />
              </TableRow>
            </TableBody>
          </Table>
        ) : (
          <p className="px-5 pb-4 text-sm text-muted-foreground">
            Não há competência fechada anterior a {monthLabel(snap.period)}: a movimentação do período não pode ser calculada.
          </p>
        )}
      </SectionCard>

      <p className="text-sm text-muted-foreground print:hidden">
        A memória de cálculo processo a processo ({pluralize(report.items.length, "linha", "linhas")}) está na exportação CSV/XLSX.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Carta de auditoria
// ---------------------------------------------------------------------------

/** Rows per screen page of the audit letter; the print version and the exports carry every row. */
export const AUDIT_LETTER_PAGE_SIZE = 200;

export function AuditLetterView({
  report,
  page = 1,
  sp = {},
  printAll = false,
}: {
  report: AuditLetterReport;
  page?: number;
  sp?: SearchParams;
  /** "Versão para impressão": render every row (no pagination). */
  printAll?: boolean;
}) {
  const t = report.totals;
  // Null is not zero: totals without any known value read "Não informado" / "Não apurado" / "Não calculada", never R$ 0,00.
  const claimUnknown = t.processCount > 0 && t.claimUnknown >= t.processCount;
  const liquidatedUnknown = t.processCount > 0 && t.liquidatedUnknown >= t.processCount;
  const provisionNotCalculated = report.rows.length > 0 && report.rows.every((r) => r.provisionCents === null);
  const paginated = !printAll && report.rows.length > AUDIT_LETTER_PAGE_SIZE;
  const pageCount = Math.max(1, Math.ceil(report.rows.length / AUDIT_LETTER_PAGE_SIZE));
  const current = Math.min(Math.max(1, page), pageCount);
  const start = (current - 1) * AUDIT_LETTER_PAGE_SIZE;
  const rows = paginated ? report.rows.slice(start, start + AUDIT_LETTER_PAGE_SIZE) : report.rows;
  const printHref = buildHref("/relatorios", sp, { impressao: "1", pagina: null });
  const screenHref = buildHref("/relatorios", sp, { impressao: null, pagina: null });
  return (
    <article className="rounded-lg border border-border bg-white p-5 shadow-xs sm:p-8 print:border-0 print:p-0 print:shadow-none" aria-label="Carta de auditoria">
      <header className="border-b border-slate-300 pb-4">
        <p className="text-xs font-semibold tracking-wide text-slate-500 uppercase">{report.organizationName}</p>
        <h2 className="mt-1 text-xl font-semibold text-slate-900">Carta de auditoria: relação de processos judiciais</h2>
        <dl className="mt-3 grid gap-x-8 gap-y-1 text-sm sm:grid-cols-2">
          <div className="flex gap-2">
            <dt className="font-medium text-slate-600">Data-base:</dt>
            <dd className="text-slate-900">{formatDate(report.baseDate)}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="font-medium text-slate-600">Emitida em:</dt>
            <dd className="text-slate-900">{formatDateTime(report.generatedAt)}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="font-medium text-slate-600">Fonte das posições:</dt>
            <dd className="text-slate-900">
              {report.snapshot ? `Competência ${monthLabel(report.snapshot.period)} (fechada)` : "Posição atual (não fechada)"}
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="font-medium text-slate-600">Filtros:</dt>
            <dd className="text-slate-900">{report.filterSummary}</dd>
          </div>
        </dl>
      </header>

      <p className="mt-4 text-sm leading-relaxed text-slate-800">
        Relação dos processos judiciais registrados no sistema, com a posição na data-base de {formatDate(report.baseDate)}:
        classificação de probabilidade de perda, percentual aplicado e provisão, conforme registrados e aprovados pelos
        responsáveis. Este documento é gerado a partir dos registros do sistema e não contém opinião jurídica além das
        classificações registradas.
      </p>

      <section className="mt-5" aria-label="Resumo">
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <SummaryItem label="Processos (CNJ únicos)" value={formatNumber(t.processCount)} />
          <SummaryItem
            label="Valor da causa"
            value={claimUnknown ? "Não informado" : formatMoneyCents(t.claimCents)}
            unknown={claimUnknown}
            hint={
              t.claimUnknown > 0 && t.claimUnknown < t.processCount
                ? `+ ${pluralize(t.claimUnknown, "sem valor informado", "sem valor informado")}`
                : undefined
            }
          />
          <SummaryItem
            label="Valor liquidado"
            value={liquidatedUnknown ? "Não apurado" : formatMoneyCents(t.liquidatedCents)}
            unknown={liquidatedUnknown}
            hint={t.liquidatedUnknown > 0 && !liquidatedUnknown ? `${pluralize(t.liquidatedUnknown, "não apurado", "não apurados")}` : undefined}
          />
          <SummaryItem
            label="Provisão"
            value={provisionNotCalculated ? "Não calculada" : formatMoneyCents(t.provisionCents)}
            unknown={provisionNotCalculated}
            hint={t.provisionEstimateCents > 0 ? `+ ${formatMoneyCents(t.provisionEstimateCents)} estimada` : undefined}
          />
        </dl>
        <p className="mt-2 text-xs text-muted-foreground">
          Por classificação: provável {t.byClassification.probable} · possível {t.byClassification.possible} · remota{" "}
          {t.byClassification.remote} · sem classificação {t.byClassification.unclassified}. Valor da causa e valor liquidado
          não são somados.
        </p>
      </section>

      {paginated ? (
        <Callout tone="info" title="Relação paginada" className="mt-5">
          Exibindo os processos {formatNumber(start + 1)} a {formatNumber(start + rows.length)} de{" "}
          {formatNumber(report.rows.length)}. A impressão desta tela inclui somente a página exibida; para imprimir ou salvar
          em PDF a relação completa, abra a <Link href={printHref}>versão para impressão</Link>. As exportações CSV/XLSX
          trazem todos os processos.
        </Callout>
      ) : null}
      {printAll && report.rows.length > AUDIT_LETTER_PAGE_SIZE ? (
        <p className="mt-5 text-sm text-muted-foreground print:hidden">
          Versão para impressão: relação completa ({formatNumber(report.rows.length)} processos).{" "}
          <Link href={screenHref}>Voltar à relação paginada</Link>.
        </p>
      ) : null}

      <div className="mt-5 -mx-5 sm:-mx-8 print:mx-0">
        <Table aria-label="Relação de processos na data-base">
          <TableHeader>
            <TableRow>
              <TableHead>Processo</TableHead>
              <TableHead>Tribunal / vara</TableHead>
              <TableHead>Fase</TableHead>
              <TableHead>Classificação</TableHead>
              <NumHead>%</NumHead>
              <NumHead>Valor da causa</NumHead>
              <NumHead>Valor liquidado</NumHead>
              <NumHead>Garantias</NumHead>
              <NumHead>Provisão</NumHead>
              <TableHead>Ressalvas</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableEmpty colSpan={10} message="Nenhum processo na data-base com estes filtros." />
            ) : (
              rows.map((r) => (
                <TableRow key={r.processId}>
                  <TableCell className="min-w-56 align-top">
                    {r.deletedAfterClose ? (
                      <>
                        <span className="font-medium tabular-nums text-slate-900">{r.number}</span>
                        <Badge tone="neutral" className="ml-1 align-middle">
                          Excluído após o fechamento
                        </Badge>
                      </>
                    ) : (
                      <Link href={`/processos/${r.processId}`} className={tableLinkClasses}>
                        {r.number}
                      </Link>
                    )}
                    <span className="block max-w-72 truncate text-xs text-muted-foreground" title={r.title}>
                      {r.title}
                    </span>
                  </TableCell>
                  <TableCell className="min-w-40 align-top text-sm">
                    {r.court ?? <EmptyValue>Não informado</EmptyValue>}
                    {r.courtDivision ? <span className="block text-xs text-muted-foreground">{r.courtDivision}</span> : null}
                    {r.instance ? (
                      <span className="block text-xs text-muted-foreground">{PROCESS_INSTANCE_LABELS[r.instance]}</span>
                    ) : null}
                  </TableCell>
                  <TableCell className="align-top whitespace-nowrap text-sm">{processPhaseLabel(r.phase) ?? <EmptyValue>Não informado</EmptyValue>}</TableCell>
                  <TableCell className="align-top whitespace-nowrap">{CLASSIFICATION_LABELS[r.classification ?? "unclassified"]}</TableCell>
                  <NumCell className="align-top">
                    {r.percentageBp === null ? <EmptyValue>Não se aplica</EmptyValue> : formatBp(r.percentageBp)}
                  </NumCell>
                  <MoneyValueCell cents={r.claimCents} nullLabel="Não informado" className="align-top" />
                  <MoneyValueCell cents={r.liquidatedCents} nullLabel="Não apurado" className="align-top" />
                  <NumCell className="align-top">
                    {r.guaranteesCents ? formatMoneyCents(r.guaranteesCents) : <EmptyValue>Sem garantias</EmptyValue>}
                  </NumCell>
                  <MoneyValueCell
                    cents={r.provisionCents}
                    nullLabel="Não calculada"
                    estimate={r.provisionIsEstimate}
                    className="align-top"
                  />
                  <TableCell className="min-w-56 align-top text-xs text-slate-700">
                    {r.caveats.length === 0 ? (
                      <EmptyValue>Sem ressalvas</EmptyValue>
                    ) : (
                      <ul className="list-disc space-y-0.5 pl-4">
                        {r.caveats.map((c) => (
                          <li key={c}>{c}</li>
                        ))}
                      </ul>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      {paginated ? (
        <div className="mt-3 print:hidden">
          <Pagination page={current} pageSize={AUDIT_LETTER_PAGE_SIZE} total={report.rows.length} basePath="/relatorios" searchParams={sp} />
        </div>
      ) : null}

      <section className="print-avoid-break mt-6" aria-label="Ressalvas gerais">
        <h3 className="text-sm font-semibold text-slate-900">Ressalvas gerais</h3>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-slate-800">
          {report.generalCaveats.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ol>
      </section>

      <section className="print-avoid-break mt-10 grid gap-10 sm:grid-cols-2" aria-label="Assinaturas">
        <SignatureLine title="Advogado(a) responsável" lines={["Nome:", "OAB nº:"]} />
        <SignatureLine title="Local e data" lines={["", ""]} />
      </section>
      <p className="mt-6 text-xs text-muted-foreground">
        Campos de assinatura em branco para preenchimento manual. O sistema não assina nem emite parecer em nome do advogado.
      </p>
    </article>
  );
}

function SummaryItem({ label, value, hint, unknown = false }: { label: string; value: string; hint?: string; unknown?: boolean }) {
  return (
    <div className="rounded-md border border-border bg-surface-muted px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={unknown ? "font-medium text-muted-foreground" : "font-semibold text-slate-900 tabular-nums"}>{value}</dd>
      {hint ? <dd className="text-xs text-muted-foreground">{hint}</dd> : null}
    </div>
  );
}

function SignatureLine({ title, lines }: { title: string; lines: string[] }) {
  return (
    <div className="text-sm text-slate-800">
      <div className="h-10 border-b border-slate-500" aria-hidden="true" />
      <p className="mt-1 font-medium">{title}</p>
      {lines.map((l, i) => (
        <p key={`${title}-${i}`} className="mt-3 flex gap-2">
          <span>{l}</span>
          <span className="flex-1 border-b border-dotted border-slate-400" aria-hidden="true" />
        </p>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Movimentação
// ---------------------------------------------------------------------------

export const MOVEMENT_PAGE_SIZE = 100;

/** Badge tone of each movement kind (an index swap keeps value and base date: neutral). */
const MOVEMENT_EVENT_TONES: Record<MovementEventKind, "neutral" | "info" | "primary" | "warning"> = {
  added: "info",
  closed: "neutral",
  value_change: "primary",
  index_change: "neutral",
  phase_change: "warning",
  status_change: "warning",
};

export function MovementReportView({ report, page, sp }: { report: MovementReport; page: number; sp: SearchParams }) {
  const s = report.summary;
  const start = (page - 1) * MOVEMENT_PAGE_SIZE;
  const visible = report.events.slice(start, start + MOVEMENT_PAGE_SIZE);
  const indexChanges = s.indexChanges ?? report.events.filter((e) => e.kind === "index_change").length;
  return (
    <div className="grid grid-cols-1 gap-6">
      <section aria-label="Resumo da movimentação" className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Entradas na carteira" value={formatNumber(s.added)} tone="info" hint="Processos cadastrados no período" />
        <StatCard label="Encerramentos" value={formatNumber(s.closed)} tone="neutral" hint="Pela data de encerramento" />
        <StatCard
          label="Alterações de valor oficial"
          value={formatNumber(s.valueChanges)}
          tone="primary"
          hint={
            indexChanges > 0
              ? `Trocas de índice: ${formatNumber(indexChanges)} (sem mudança de valor)`
              : "Valores oficializados no período"
          }
        />
        <StatCard label="Mudanças de fase" value={formatNumber(s.phaseChanges)} tone="warning" hint={`${pluralize(s.statusChanges, "mudança", "mudanças")} de situação`} />
      </section>

      {s.closedByReason.length > 0 ? (
        <SectionCard title="Encerramentos por motivo">
          <Table aria-label="Encerramentos por motivo">
            <TableHeader>
              <TableRow>
                <TableHead>Motivo</TableHead>
                <NumHead>Processos</NumHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {s.closedByReason.map((c) => (
                <TableRow key={c.reason}>
                  <TableCell>{c.label}</TableCell>
                  <CountCell value={c.count} />
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </SectionCard>
      ) : null}

      {report.pendingProposedValuations > 0 ? (
        <Callout tone="info" title="Valores aguardando conferência">
          {pluralize(report.pendingProposedValuations, "valor proposto", "valores propostos")} no período ainda não{" "}
          {report.pendingProposedValuations === 1 ? "foi oficializado" : "foram oficializados"} e não{" "}
          {report.pendingProposedValuations === 1 ? "aparece" : "aparecem"} como alteração.{" "}
          <Link href="/contingencias/revisao">Abrir a fila de conferência</Link>.
        </Callout>
      ) : null}
      {report.truncated ? (
        <Callout tone="warning" title="Lista limitada">
          O período tem mais de 10.000 movimentações; reduza o período para ver todas.
        </Callout>
      ) : null}

      <SectionCard
        title="Movimentações"
        description={`${pluralize(report.events.length, "movimentação", "movimentações")} de ${formatDate(report.from)} a ${formatDate(report.to)}.`}
      >
        <Table aria-label="Movimentações do período">
          <TableHeader>
            <TableRow>
              <TableHead>Data</TableHead>
              <TableHead>Movimentação</TableHead>
              <TableHead>Processo</TableHead>
              <TableHead>Detalhe</TableHead>
              <NumHead>Valor anterior</NumHead>
              <NumHead>Valor novo</NumHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.length === 0 ? (
              <TableEmpty colSpan={6} message="Nenhuma movimentação no período." description="Ajuste o período ou os filtros." />
            ) : (
              visible.map((e, i) => (
                <TableRow key={`${e.kind}-${e.processId}-${e.date}-${start + i}`}>
                  <TableCell className="whitespace-nowrap tabular-nums">{formatDate(e.date)}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    <Badge tone={MOVEMENT_EVENT_TONES[e.kind]}>{MOVEMENT_EVENT_LABELS[e.kind]}</Badge>
                  </TableCell>
                  <TableCell className="min-w-56">
                    <Link href={`/processos/${e.processId}`} className={tableLinkClasses}>
                      {e.number}
                    </Link>
                    <span className="block max-w-72 truncate text-xs text-muted-foreground" title={e.title}>
                      {e.title}
                    </span>
                  </TableCell>
                  <TableCell className="min-w-56 text-sm">
                    {e.detail}
                    {e.valuationKind && e.isEstimate ? (
                      <span className="ml-1 inline-block align-middle">
                        <EstimateBadge />
                      </span>
                    ) : null}
                  </TableCell>
                  <NumCell>
                    {e.kind === "value_change" ? (
                      e.previousCents === null ? <EmptyValue>Sem valor anterior</EmptyValue> : formatMoneyCents(e.previousCents)
                    ) : (
                      <EmptyValue>Não se aplica</EmptyValue>
                    )}
                  </NumCell>
                  <NumCell>{e.newCents === null ? <EmptyValue>Não se aplica</EmptyValue> : formatMoneyCents(e.newCents)}</NumCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </SectionCard>
      <div className="print:hidden">
        <Pagination page={page} pageSize={MOVEMENT_PAGE_SIZE} total={report.events.length} basePath="/relatorios" searchParams={sp} />
      </div>
      {report.events.length > MOVEMENT_PAGE_SIZE ? (
        <p className="text-xs text-muted-foreground">
          A impressão inclui apenas a página exibida; a exportação CSV/XLSX traz todas as movimentações do período.
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Somente valores oficiais (conferidos por pessoa identificada) aparecem como alteração de valor; valores propostos
        ficam na fila de conferência.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Responsáveis
// ---------------------------------------------------------------------------

export function ResponsiblesReportView({ report }: { report: ResponsiblesReport }) {
  const extra = [{ header: "Sem classificação", cell: (r: ResponsibleRow) => formatNumber(r.unclassified) }];
  return (
    <div className="grid grid-cols-1 gap-6">
      {report.hasEstimates ? <EstimatesCallout /> : null}
      <SectionCard title="Por advogado responsável" description="Responsável cadastrado em cada processo da carteira ativa.">
        <BucketTable label="Carteira por advogado responsável" groupHeader="Advogado" rows={report.lawyers} totals={report.totals} extra={extra} />
      </SectionCard>
      <SectionCard title="Por escritório externo" description="Escritório que patrocina o processo; “condução interna” quando não há escritório.">
        <BucketTable label="Carteira por escritório externo" groupHeader="Escritório" rows={report.lawFirms} totals={report.totals} extra={extra} />
      </SectionCard>
    </div>
  );
}

export { EstimatesCallout };
