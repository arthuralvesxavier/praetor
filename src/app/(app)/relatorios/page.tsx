import { FileSpreadsheet, FileText, Landmark } from "lucide-react";
import type { Metadata } from "next";
import { buttonVariants, ButtonLink } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { EmptyState } from "@/components/ui/empty-state";
import { FilterBar, FilterInput, FilterSelect } from "@/components/ui/filter-bar";
import { PageHeader } from "@/components/ui/page-header";
import { LinkTabs } from "@/components/ui/tabs";
import { SNAPSHOT_STATUS_LABELS } from "@/domain/enums";
import { formatDateTime, formatMonthYear, todayISO } from "@/lib/format";
import { buildHref, flagParam, hasAnyParam, pageParam, param } from "@/lib/search-params";
import { cn } from "@/lib/utils";
import { can } from "@/server/auth/permissions";
import { requirePageContext } from "@/server/auth/session";
import { AppError } from "@/server/lib/errors";
import { ReportPrintStyles } from "@/modules/reports/components/print-styles";
import { PrintButton } from "@/modules/reports/components/print-button";
import {
  AuditLetterView,
  ExposureReportView,
  MovementReportView,
  PortfolioReportView,
  ProvisionReportView,
  ResponsiblesReportView,
} from "@/modules/reports/components/report-views";
import { CSV_CONTENT_HINTS, READING_RULES } from "@/modules/reports/export-builders";
import { exportHref, isReportType, reportFiltersFromParams } from "@/modules/reports/schemas";
import { getReport, listReportFilterOptions } from "@/modules/reports/service";
import {
  REPORT_TAB_LABELS,
  REPORT_TYPE_DESCRIPTIONS,
  REPORT_TYPE_LABELS,
  REPORT_TYPES,
  type ReportData,
  type ReportFilterOptions,
  type ReportType,
} from "@/modules/reports/types";

export const metadata: Metadata = { title: "Relatórios" };

const BASE_PATH = "/relatorios";

function periodOptions(snapshots: ReportFilterOptions["snapshots"], closedOnly: boolean) {
  return snapshots
    .filter((s) => !closedOnly || s.status === "closed")
    .map((s) => ({
      value: s.period,
      label: `${formatMonthYear(`${s.period}-01`)}${closedOnly ? "" : ` (${SNAPSHOT_STATUS_LABELS[s.status].toLowerCase()})`}`,
    }));
}

function isEmptyReport(r: ReportData): boolean {
  switch (r.type) {
    case "carteira":
    case "exposicao":
    case "responsaveis":
      return r.totals.processCount === 0 && (r.type !== "exposicao" || !r.dimensions.some((d) => d.rows.length > 0));
    case "provisao":
      return r.snapshot === null;
    case "auditoria":
      return false;
    case "movimentacao":
      return false;
  }
}

export default async function RelatoriosPage(props: PageProps<"/relatorios">) {
  const ctx = await requirePageContext("report:read");
  const sp = await props.searchParams;
  const tipoParam = param(sp, "tipo");
  const type: ReportType = isReportType(tipoParam) ? tipoParam : "carteira";
  const filters = reportFiltersFromParams(sp);

  const options = await listReportFilterOptions(ctx);
  let report: ReportData | null = null;
  let error: string | null = null;
  try {
    report = await getReport(ctx, type, filters);
  } catch (err) {
    if (err instanceof AppError && (err.code === "validation" || err.code === "not_found")) error = err.message;
    else throw err;
  }

  const tabHref = (key: ReportType) =>
    buildHref(BASE_PATH, {}, { tipo: key, empresa: filters.companyId, unidade: filters.unitId });
  const filtered = hasAnyParam(sp, ["empresa", "unidade", "competencia", "de", "ate"]);
  const usesPeriod = type === "exposicao" || type === "provisao" || type === "auditoria";
  const today = todayISO();

  return (
    <div className="space-y-6">
      <ReportPrintStyles />
      <div className="space-y-4 print:hidden">
        <PageHeader
          title="Relatórios"
          description="Relatórios da carteira de processos por empresa e unidade, com exportação em CSV e XLSX e versão para impressão (PDF)."
          breadcrumbs={[{ label: "Painel executivo", href: "/dashboard" }, { label: "Relatórios" }]}
          className="mb-0"
        />
        <LinkTabs
          label="Tipos de relatório"
          active={type}
          tabs={REPORT_TYPES.map((t) => ({ key: t, label: REPORT_TAB_LABELS[t], href: tabHref(t) }))}
        />
        <div>
          <h2 className="text-lg font-semibold text-slate-900">{REPORT_TYPE_LABELS[type]}</h2>
          <p className="mt-1 max-w-4xl text-sm text-muted-foreground">{REPORT_TYPE_DESCRIPTIONS[type]}</p>
        </div>

        <FilterBar basePath={BASE_PATH} search={false} hiddenFields={{ tipo: type }} showClear={filtered} className="mb-0">
          <FilterSelect
            name="empresa"
            label="Empresa"
            options={options.companies.map((c) => ({ value: c.id, label: c.name }))}
            defaultValue={filters.companyId}
            placeholder="Todas"
          />
          <FilterSelect
            name="unidade"
            label="Unidade"
            options={options.units.map((u) => ({ value: u.id, label: u.name }))}
            defaultValue={filters.unitId}
            placeholder="Todas"
          />
          {usesPeriod ? (
            <FilterSelect
              name="competencia"
              label={type === "exposicao" ? "Comparar com" : "Competência"}
              options={periodOptions(options.snapshots, type !== "exposicao")}
              defaultValue={filters.period}
              placeholder={
                type === "exposicao" ? "Mês anterior (padrão)" : type === "provisao" ? "Última fechada" : "Posição atual (hoje)"
              }
              className="sm:w-56"
            />
          ) : null}
          {type === "movimentacao" ? (
            <>
              <FilterInput type="date" name="de" label="De" defaultValue={filters.from ?? `${today.slice(0, 7)}-01`} max={today} />
              <FilterInput type="date" name="ate" label="Até" defaultValue={filters.to ?? today} />
            </>
          ) : null}
        </FilterBar>

        {report && !error ? (
          <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3 shadow-xs sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted-foreground">
              Exportar este relatório com os filtros atuais. O CSV traz {CSV_CONTENT_HINTS[type]}.
            </p>
            <div className="flex flex-wrap gap-2">
              <a href={exportHref(type, "csv", filters)} className={cn(buttonVariants({ variant: "outline" }))}>
                <FileText aria-hidden="true" />
                Exportar CSV
              </a>
              <a href={exportHref(type, "xlsx", filters)} className={cn(buttonVariants({ variant: "outline" }))}>
                <FileSpreadsheet aria-hidden="true" />
                Exportar XLSX
              </a>
              <PrintButton />
            </div>
          </div>
        ) : null}
      </div>

      {error ? (
        <Callout tone="danger" title="Não foi possível montar o relatório" role="alert">
          {error}
        </Callout>
      ) : null}

      {report ? (
        <section className="report-print space-y-6" aria-label={REPORT_TYPE_LABELS[type]}>
          {report.type !== "auditoria" ? <ReportMeta report={report} /> : null}
          {isEmptyReport(report) ? (
            report.type === "provisao" ? (
              <EmptyState
                icon={<Landmark />}
                title={filters.period ? "Competência não fechada" : "Nenhuma competência fechada"}
                description={
                  filters.period
                    ? `${formatMonthYear(`${filters.period}-01`)} ainda não foi fechada. O relatório de provisão lê somente competências fechadas (imutáveis).`
                    : "O relatório de provisão lê somente competências fechadas (imutáveis). Feche uma competência na tela de provisão mensal."
                }
                action={
                  can(ctx, "contingency:read") ? (
                    <ButtonLink href="/contingencias/provisao" variant="outline">
                      Abrir provisão mensal
                    </ButtonLink>
                  ) : null
                }
              />
            ) : (
              <EmptyState
                icon={<FileText />}
                title="Nenhum processo na carteira com estes filtros"
                description={
                  report.scope.orgWide
                    ? "Ajuste a empresa ou a unidade selecionada."
                    : "O relatório considera somente os processos visíveis para o seu perfil."
                }
              />
            )
          ) : (
            <ReportBody report={report} page={pageParam(sp)} sp={sp} />
          )}
          {report.type !== "auditoria" ? (
            <footer className="border-t border-border pt-3 text-xs text-muted-foreground">
              <p className="font-medium text-slate-700">Como ler</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {READING_RULES.map((r) => (
                  <li key={r}>{r}</li>
                ))}
                <li>Gerado a partir dos registros do sistema; não constitui parecer jurídico.</li>
              </ul>
            </footer>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function ReportMeta({ report }: { report: ReportData }) {
  return (
    <div className="rounded-lg border border-border bg-surface-muted px-4 py-3 text-sm">
      <p className="hidden text-base font-semibold text-slate-900 print:block">
        {report.organizationName}: {REPORT_TYPE_LABELS[report.type]}
      </p>
      <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-[auto_1fr]">
        <dt className="font-medium text-slate-600">Escopo</dt>
        <dd className="text-slate-900">{report.scope.label}</dd>
        <dt className="font-medium text-slate-600">Filtros</dt>
        <dd className="text-slate-900">{report.filterSummary}</dd>
        <dt className="font-medium text-slate-600">Emitido em</dt>
        <dd className="text-slate-900">{formatDateTime(report.generatedAt)}</dd>
      </dl>
    </div>
  );
}

function ReportBody({ report, page, sp }: { report: ReportData; page: number; sp: Awaited<PageProps<"/relatorios">["searchParams"]> }) {
  switch (report.type) {
    case "carteira":
      return <PortfolioReportView report={report} />;
    case "exposicao":
      return <ExposureReportView report={report} />;
    case "provisao":
      return <ProvisionReportView report={report} />;
    case "auditoria":
      return <AuditLetterView report={report} page={page} sp={sp} printAll={flagParam(sp, "impressao")} />;
    case "movimentacao":
      return <MovementReportView report={report} page={page} sp={sp} />;
    case "responsaveis":
      return <ResponsiblesReportView report={report} />;
  }
}
