import Link from "next/link";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Pagination } from "@/components/ui/pagination";
import { StatCard } from "@/components/ui/stat-card";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow, tableLinkClasses } from "@/components/ui/table";
import { formatBp } from "@/domain/contingency";
import { PROCESS_INSTANCE_LABELS, PROCESS_PHASE_LABELS } from "@/domain/enums";
import { formatDate, formatDateTime, formatMoneyCents, formatMonthYear, formatNumber, pluralize } from "@/lib/format";
import type { SearchParams } from "@/lib/search-params";
import {
  CLASSIFICATION_LABELS,
  MOVEMENT_EVENT_LABELS,
  PROVISION_MOVEMENT_LABELS,
  type AuditLetterReport,
  type ExposureReport,
  type ExposureRow,
  type MovementReport,
  type PortfolioReport,
  type ProvisionReport,
  type ResponsibleRow,
  type ResponsiblesReport,
} from "../types";
import { BucketTable } from "./bucket-table";
import {
  CountCell,
  DeltaCount,
  DeltaMoney,
  EstimateBadge,
  EstimateMoneyCell,
  MoneyGroupCell,
  MoneyValueCell,
  NumCell,
  NumHead,
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

function EstimatesCallout() {
  return (
    <Callout tone="warning" title="Há valores estimados (RN-07)">
      Exposições e provisões calculadas sobre o valor da causa — quando não há valor liquidado — aparecem nas colunas
      “estimada” e não devem ser lidas como valor apurado.
    </Callout>
  );
}

// ---------------------------------------------------------------------------
// Carteira
// ---------------------------------------------------------------------------

export function PortfolioReportView({ report }: { report: PortfolioReport }) {
  return (
    <div className="grid gap-6">
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

function ExposureTable({ label, header, rows, totals, compare }: { label: string; header: string; rows: ExposureRow[]; totals: ExposureRow; compare: boolean }) {
  const line = (r: ExposureRow, isTotal = false) => (
    <TableRow key={r.key} className={isTotal ? "bg-slate-50 font-semibold" : undefined}>
      <TableCell className="min-w-44 max-w-72">{r.label}</TableCell>
      <CountCell value={r.processCount} />
      {compare ? <NumCell>{r.previous ? <DeltaCount delta={r.processCount - r.previous.processCount} /> : "—"}</NumCell> : null}
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
        unknown={r.bucket.exposureUnknown}
        unknownLabel="Não calculável"
        unknownSingular="não calculável"
        unknownPlural="não calculáveis"
      />
      {compare ? (
        <NumCell>
          {r.previous ? (
            <>
              <span className="block text-xs text-muted-foreground">antes {formatMoneyCents(r.previous.exposureCents)}</span>
              <DeltaMoney delta={r.bucket.exposureCents - r.previous.exposureCents} />
            </>
          ) : (
            "—"
          )}
        </NumCell>
      ) : null}
      <EstimateMoneyCell cents={r.bucket.exposureEstimateCents} />
      {compare ? (
        <NumCell>
          {r.previous ? (
            <>
              <span className="block text-xs text-muted-foreground">antes {formatMoneyCents(r.previous.exposureEstimateCents)}</span>
              <DeltaMoney delta={r.bucket.exposureEstimateCents - r.previous.exposureEstimateCents} />
            </>
          ) : (
            "—"
          )}
        </NumCell>
      ) : null}
    </TableRow>
  );
  return (
    <Table aria-label={label}>
      <TableHeader>
        <TableRow>
          <TableHead>{header}</TableHead>
          <NumHead>Processos</NumHead>
          {compare ? <NumHead>Var. processos</NumHead> : null}
          <NumHead>Valor da causa</NumHead>
          <NumHead>Valor liquidado</NumHead>
          <NumHead>Exposição oficial</NumHead>
          {compare ? <NumHead>Var. exposição oficial</NumHead> : null}
          <NumHead>
            Exposição estimada <span className="font-normal">(RN-07)</span>
          </NumHead>
          {compare ? <NumHead>Var. exposição estimada</NumHead> : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 ? (
          <TableEmpty colSpan={compare ? 9 : 6} message="Nenhum processo com estes filtros." />
        ) : (
          rows.map((r) => line(r))
        )}
        {rows.length > 0 ? line(totals, true) : null}
      </TableBody>
    </Table>
  );
}

export function ExposureReportView({ report }: { report: ExposureReport }) {
  const compare = report.comparison !== null;
  return (
    <div className="grid gap-6">
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

export function ProvisionReportView({ report }: { report: ProvisionReport }) {
  const snap = report.snapshot;
  if (!snap) return null;
  const hasPrev = report.previous !== null;
  return (
    <div className="grid gap-6">
      <Callout tone="info" title={`Competência ${monthLabel(snap.period)} — fechada`}>
        Data-base {formatDate(snap.referenceDate)}
        {snap.closedAt ? `, fechada em ${formatDateTime(snap.closedAt)}` : ""}
        {snap.closedByName ? ` por ${snap.closedByName}` : ""}. Valores lidos do fechamento (imutável, RN-10), com os
        percentuais da época: provável {snap.params.riskPercentages.probable}%, possível {snap.params.riskPercentages.possible}%,
        remota {snap.params.riskPercentages.remote}% (versão {snap.params.rulesVersion} das regras).
      </Callout>
      {report.hasEstimates ? (
        <Callout tone="warning" title="Ressalva — provisões estimadas (RN-07)">
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
              <NumHead>
                Provisão estimada <span className="font-normal">(RN-07)</span>
              </NumHead>
              {hasPrev ? <NumHead>Provisão em {monthLabel(report.previous!.period)}</NumHead> : null}
              {hasPrev ? <NumHead>Variação</NumHead> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {[...report.byClassification, report.totals].map((c, i, all) => {
              const isTotal = i === all.length - 1;
              const prevTotal = c.previous ? c.previous.provisionCents + c.previous.provisionEstimateCents : 0;
              const curTotal = c.current.provisionCents + c.current.provisionEstimateCents;
              return (
                <TableRow key={isTotal ? "total" : c.key} className={isTotal ? "bg-slate-50 font-semibold" : undefined}>
                  <TableCell>{isTotal ? c.label : CLASSIFICATION_LABELS[c.key]}</TableCell>
                  <NumCell>{c.percentageBp === null ? "—" : formatBp(c.percentageBp)}</NumCell>
                  <CountCell value={c.processCount} />
                  <NumCell>{formatMoneyCents(c.current.provisionCents)}</NumCell>
                  <EstimateMoneyCell cents={c.current.provisionEstimateCents} />
                  {hasPrev ? (
                    <NumCell>
                      {c.previous ? (
                        <>
                          {formatMoneyCents(c.previous.provisionCents)}
                          {c.previous.provisionEstimateCents > 0 ? (
                            <span className="block text-xs text-amber-900">
                              + {formatMoneyCents(c.previous.provisionEstimateCents)} estimada
                            </span>
                          ) : null}
                        </>
                      ) : (
                        "—"
                      )}
                    </NumCell>
                  ) : null}
                  {hasPrev ? (
                    <NumCell>
                      <DeltaMoney delta={curTotal - prevTotal} />
                    </NumCell>
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
                <NumCell>—</NumCell>
                <NumCell>{formatMoneyCents(report.movement.opening.provisionCents)}</NumCell>
                <EstimateMoneyCell cents={report.movement.opening.provisionEstimateCents} />
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
                <NumCell>—</NumCell>
                <NumCell>{formatMoneyCents(report.movement.closing.provisionCents)}</NumCell>
                <EstimateMoneyCell cents={report.movement.closing.provisionEstimateCents} />
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

export function AuditLetterView({ report }: { report: AuditLetterReport }) {
  const t = report.totals;
  return (
    <article className="rounded-lg border border-border bg-white p-5 shadow-xs sm:p-8 print:border-0 print:p-0 print:shadow-none" aria-label="Carta de auditoria">
      <header className="border-b border-slate-300 pb-4">
        <p className="text-xs font-semibold tracking-wide text-slate-500 uppercase">{report.organizationName}</p>
        <h2 className="mt-1 text-xl font-semibold text-slate-900">Carta de auditoria — relação de processos judiciais</h2>
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
            value={formatMoneyCents(t.claimCents)}
            hint={t.claimUnknown > 0 ? `+ ${pluralize(t.claimUnknown, "sem valor informado", "sem valor informado")}` : undefined}
          />
          <SummaryItem
            label="Valor liquidado"
            value={t.processCount > 0 && t.liquidatedUnknown >= t.processCount ? "Não apurado" : formatMoneyCents(t.liquidatedCents)}
            hint={t.liquidatedUnknown > 0 ? `${pluralize(t.liquidatedUnknown, "não apurado", "não apurados")}` : undefined}
          />
          <SummaryItem
            label="Provisão"
            value={formatMoneyCents(t.provisionCents)}
            hint={t.provisionEstimateCents > 0 ? `+ ${formatMoneyCents(t.provisionEstimateCents)} estimada (RN-07)` : undefined}
          />
        </dl>
        <p className="mt-2 text-xs text-muted-foreground">
          Por classificação: provável {t.byClassification.probable} · possível {t.byClassification.possible} · remota{" "}
          {t.byClassification.remote} · sem classificação {t.byClassification.unclassified}. Valor da causa e valor liquidado
          não são somados (RN-02).
        </p>
      </section>

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
            {report.rows.length === 0 ? (
              <TableEmpty colSpan={10} message="Nenhum processo na data-base com estes filtros." />
            ) : (
              report.rows.map((r) => (
                <TableRow key={r.processId}>
                  <TableCell className="min-w-56 align-top">
                    <Link href={`/processos/${r.processId}`} className={tableLinkClasses}>
                      {r.number}
                    </Link>
                    <span className="block max-w-72 truncate text-xs text-muted-foreground" title={r.title}>
                      {r.title}
                    </span>
                  </TableCell>
                  <TableCell className="min-w-40 align-top text-sm">
                    {r.court ?? "—"}
                    {r.courtDivision ? <span className="block text-xs text-muted-foreground">{r.courtDivision}</span> : null}
                    {r.instance ? (
                      <span className="block text-xs text-muted-foreground">{PROCESS_INSTANCE_LABELS[r.instance]}</span>
                    ) : null}
                  </TableCell>
                  <TableCell className="align-top whitespace-nowrap text-sm">{r.phase ? PROCESS_PHASE_LABELS[r.phase] : "—"}</TableCell>
                  <TableCell className="align-top whitespace-nowrap">{CLASSIFICATION_LABELS[r.classification ?? "unclassified"]}</TableCell>
                  <NumCell className="align-top">{r.percentageBp === null ? "—" : formatBp(r.percentageBp)}</NumCell>
                  <MoneyValueCell cents={r.claimCents} nullLabel="Não informado" className="align-top" />
                  <MoneyValueCell cents={r.liquidatedCents} nullLabel="Não apurado" className="align-top" />
                  <NumCell className="align-top">{r.guaranteesCents ? formatMoneyCents(r.guaranteesCents) : "—"}</NumCell>
                  <MoneyValueCell
                    cents={r.provisionCents}
                    nullLabel="Não calculada"
                    estimate={r.provisionIsEstimate}
                    className="align-top"
                  />
                  <TableCell className="min-w-56 align-top text-xs text-slate-700">
                    {r.caveats.length === 0 ? (
                      <span className="text-muted-foreground">—</span>
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

function SummaryItem({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border border-border bg-surface-muted px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-semibold text-slate-900 tabular-nums">{value}</dd>
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

export function MovementReportView({ report, page, sp }: { report: MovementReport; page: number; sp: SearchParams }) {
  const s = report.summary;
  const start = (page - 1) * MOVEMENT_PAGE_SIZE;
  const visible = report.events.slice(start, start + MOVEMENT_PAGE_SIZE);
  return (
    <div className="grid gap-6">
      <section aria-label="Resumo da movimentação" className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Entradas na carteira" value={formatNumber(s.added)} tone="info" hint="Processos cadastrados no período" />
        <StatCard label="Encerramentos" value={formatNumber(s.closed)} tone="neutral" hint="Pela data de encerramento" />
        <StatCard label="Alterações de valor oficial" value={formatNumber(s.valueChanges)} tone="primary" hint="Valores oficializados no período" />
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
          {report.pendingProposedValuations === 1 ? "aparece" : "aparecem"} como alteração (RN-11).{" "}
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
                    <Badge tone={e.kind === "closed" ? "neutral" : e.kind === "added" ? "info" : e.kind === "value_change" ? "primary" : "warning"}>
                      {MOVEMENT_EVENT_LABELS[e.kind]}
                    </Badge>
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
                      e.previousCents === null ? <span className="text-muted-foreground">Sem valor anterior</span> : formatMoneyCents(e.previousCents)
                    ) : (
                      "—"
                    )}
                  </NumCell>
                  <NumCell>{e.newCents === null ? "—" : formatMoneyCents(e.newCents)}</NumCell>
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
    <div className="grid gap-6">
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
