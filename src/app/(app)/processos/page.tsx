import { ChevronDown, FileDown, FileSpreadsheet, Gavel, Plus, Scale, SearchCheck, Wallet } from "lucide-react";
import type { Metadata } from "next";
import { buttonVariants, ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { FilterBar, FilterInput, FilterSelect } from "@/components/ui/filter-bar";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { StatCard } from "@/components/ui/stat-card";
import { LinkTabs } from "@/components/ui/tabs";
import {
  LEGAL_AREA_LABELS,
  PROCESS_INSTANCE_LABELS,
  PROCESS_PHASE_LABELS,
  PROCESS_STATUS_LABELS,
  RISK_LEVEL_LABELS,
} from "@/domain/enums";
import { formatMoneyCents, formatNumber, pluralize } from "@/lib/format";
import { optionsFromLabels } from "@/lib/options";
import { buildHref, hasAnyParam, param } from "@/lib/search-params";
import { listUnitOptions, listUserOptions } from "@/modules/admin/service";
import { listCompanyOptions, listLawFirmOptions } from "@/modules/organization/service";
import { PortfolioTable } from "@/modules/processes/components/portfolio-table";
import {
  LIQUIDATED_FILTER_LABELS,
  LIQUIDATED_FILTER_PARAMS,
  PORTFOLIO_VIEW_DESCRIPTIONS,
  PORTFOLIO_VIEW_LABELS,
  PORTFOLIO_VIEW_PARAMS,
  PROCESS_LIST_PARAM_KEYS,
  PROCESS_SORT_LABELS,
  PROCESS_SORT_PARAMS,
  processFiltersFromSearchParams,
  SECONDARY_FILTER_KEYS,
} from "@/modules/processes/filters";
import { PORTFOLIO_VIEWS, PROCESS_SORTS } from "@/modules/processes/schemas";
import { STATE_OPTIONS } from "@/modules/processes/states";
import { getProcessFilterOptions, listProcesses, summarizeProcesses } from "@/modules/processes/service";
import { can } from "@/server/auth/permissions";
import { requirePageContext } from "@/server/auth/session";

export const metadata: Metadata = { title: "Carteira de processos" };

const toOptions = (values: string[]) => values.map((v) => ({ value: v, label: v }));

export default async function ProcessesPage(props: PageProps<"/processos">) {
  const ctx = await requirePageContext("process:read");
  const sp = await props.searchParams;
  const filters = processFiltersFromSearchParams(sp);
  const filtered = hasAnyParam(sp, [...PROCESS_LIST_PARAM_KEYS]);
  const secondaryActive = hasAnyParam(sp, [...SECONDARY_FILTER_KEYS]);

  const [result, summary, filterOptions, unitOptions, userOptions, companyOptions, lawFirmOptions] = await Promise.all([
    listProcesses(ctx, filters),
    summarizeProcesses(ctx, filters),
    getProcessFilterOptions(ctx),
    listUnitOptions(ctx),
    listUserOptions(ctx),
    listCompanyOptions(ctx),
    listLawFirmOptions(ctx),
  ]);
  const canWrite = can(ctx, "process:write");
  const view = filters.portfolio;
  const exportHref = (format: "csv" | "xlsx") =>
    buildHref("/api/processes/export", sp, { formato: format, pagina: null });
  const sortOptions = PROCESS_SORTS.filter((s) => s !== "updated_desc").map((s) => ({
    value: PROCESS_SORT_PARAMS[s],
    label: PROCESS_SORT_LABELS[s],
  }));
  const uf = filters.state;
  const stateOptions = STATE_OPTIONS.filter(
    (o) => filterOptions.states.includes(o.value) || o.value === uf,
  );

  return (
    <>
      <PageHeader
        title="Carteira de processos"
        description="Passivo judicial acompanhado pelo jurídico: um registro por número CNJ, com as instâncias vinculadas."
        actions={
          <>
            <a href={exportHref("csv")} className={buttonVariants({ variant: "outline" })}>
              <FileDown aria-hidden="true" />
              Exportar CSV
            </a>
            <a href={exportHref("xlsx")} className={buttonVariants({ variant: "outline" })}>
              <FileSpreadsheet aria-hidden="true" />
              Exportar Excel
            </a>
            {canWrite ? (
              <ButtonLink href="/processos/novo">
                <Plus aria-hidden="true" />
                Novo processo
              </ButtonLink>
            ) : null}
          </>
        }
      />

      <LinkTabs
        label="Recorte da carteira"
        active={view}
        className="mb-4"
        tabs={PORTFOLIO_VIEWS.map((v) => ({
          key: v,
          label: PORTFOLIO_VIEW_LABELS[v],
          href: buildHref("/processos", sp, { carteira: PORTFOLIO_VIEW_PARAMS[v], pagina: null }),
          count: v === view ? summary.count : undefined,
        }))}
      />
      <p className="mb-4 text-sm text-muted-foreground">{PORTFOLIO_VIEW_DESCRIPTIONS[view]}</p>

      <section aria-label="Totais do recorte filtrado" className="mb-2 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Processos (CNJ únicos)"
          value={formatNumber(summary.count)}
          hint="Instâncias do mesmo CNJ contam uma vez."
          icon={<Gavel />}
        />
        <StatCard
          label="Valor da causa (soma)"
          value={formatMoneyCents(summary.claimCents)}
          hint={
            summary.claimUnknown > 0
              ? `${pluralize(summary.claimUnknown, "processo sem valor informado", "processos sem valor informado")}`
              : "Todos com valor informado."
          }
          icon={<Scale />}
          tone="info"
        />
        <StatCard
          label="Valor liquidado / apurado (soma)"
          value={formatMoneyCents(summary.liquidatedCents)}
          hint={
            summary.liquidatedUnknown > 0
              ? `${pluralize(summary.liquidatedUnknown, "não apurado", "não apurados")} — não entram como zero`
              : "Todos com valor apurado."
          }
          icon={<Wallet />}
          tone="primary"
        />
        <StatCard
          label="Marcados para verificação"
          value={formatNumber(summary.needsVerification)}
          hint="Dados a conferir (ex.: saída do acervo, divergências)."
          icon={<SearchCheck />}
          tone={summary.needsVerification > 0 ? "warning" : "neutral"}
          href={filters.needsVerification ? undefined : buildHref("/processos", sp, { verificar: "1", pagina: null })}
        />
      </section>
      <p className="mb-6 text-xs text-muted-foreground">
        Somas do recorte filtrado. Valor da causa e valor liquidado são grandezas diferentes e nunca são somados entre si.
      </p>

      <FilterBar
        basePath="/processos"
        defaultQuery={param(sp, "q")}
        searchPlaceholder="CNJ, parte, título, cidade ou classe"
        hiddenFields={{ carteira: param(sp, "carteira") }}
        showClear={filtered || hasAnyParam(sp, ["ordem"])}
      >
        <FilterSelect name="tribunal" label="Tribunal" options={toOptions(filterOptions.courts)} defaultValue={filters.court} />
        <FilterSelect
          name="instancia"
          label="Instância"
          options={optionsFromLabels(PROCESS_INSTANCE_LABELS)}
          defaultValue={filters.instance}
          placeholder="Todas"
        />
        <FilterSelect
          name="phase"
          label="Fase"
          options={optionsFromLabels(PROCESS_PHASE_LABELS)}
          defaultValue={filters.phase}
          placeholder="Todas"
        />
        <FilterSelect
          name="empresa"
          label="Empresa"
          options={companyOptions.map((c) => ({ value: c.id, label: c.name }))}
          defaultValue={filters.companyId}
          placeholder="Todas"
        />
        <FilterSelect
          name="ordem"
          label="Ordenar por"
          options={sortOptions}
          defaultValue={filters.sort === "updated_desc" ? "" : PROCESS_SORT_PARAMS[filters.sort]}
          placeholder={PROCESS_SORT_LABELS.updated_desc}
        />
        <details open={secondaryActive} className="group w-full sm:basis-full">
          <summary className="inline-flex cursor-pointer items-center gap-1 rounded-sm text-sm font-medium text-primary-700 select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
            <ChevronDown aria-hidden="true" className="size-4 transition-transform group-open:rotate-180" />
            Mais filtros
          </summary>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <FilterSelect name="cidade" label="Cidade" options={toOptions(filterOptions.cities)} defaultValue={filters.city} placeholder="Todas" className="sm:w-auto" />
            <FilterSelect name="uf" label="UF" options={stateOptions} defaultValue={uf} placeholder="Todas" className="sm:w-auto" />
            <FilterSelect name="classe" label="Classe" options={toOptions(filterOptions.classes)} defaultValue={filters.processClass} placeholder="Todas" className="sm:w-auto" />
            <FilterSelect
              name="escritorio"
              label="Escritório externo"
              options={lawFirmOptions.map((f) => ({ value: f.id, label: f.name }))}
              defaultValue={filters.lawFirmId}
              className="sm:w-auto"
            />
            <FilterSelect name="status" label="Situação" options={optionsFromLabels(PROCESS_STATUS_LABELS)} defaultValue={filters.status} placeholder="Todas" className="sm:w-auto" />
            <FilterSelect name="area" label="Área" options={optionsFromLabels(LEGAL_AREA_LABELS)} defaultValue={filters.area} placeholder="Todas" className="sm:w-auto" />
            <FilterSelect name="risco" label="Risco (interno)" options={optionsFromLabels(RISK_LEVEL_LABELS)} defaultValue={filters.riskLevel} className="sm:w-auto" />
            <FilterSelect
              name="unidade"
              label="Unidade"
              options={unitOptions.map((u) => ({ value: u.id, label: u.name }))}
              defaultValue={filters.unitId}
              placeholder="Todas"
              className="sm:w-auto"
            />
            <FilterSelect
              name="responsavel"
              label="Responsável"
              options={userOptions.map((u) => ({ value: u.id, label: u.name }))}
              defaultValue={filters.responsibleId}
              className="sm:w-auto"
            />
            <FilterInput
              name="valor_min"
              label="Valor da causa mín. (R$)"
              inputMode="numeric"
              placeholder="Ex.: 50000"
              defaultValue={param(sp, "valor_min")}
              className="sm:w-auto"
            />
            <FilterInput
              name="valor_max"
              label="Valor da causa máx. (R$)"
              inputMode="numeric"
              placeholder="Ex.: 500000"
              defaultValue={param(sp, "valor_max")}
              className="sm:w-auto"
            />
            <FilterSelect
              name="liquidado"
              label="Valor liquidado"
              options={(["with", "without"] as const).map((k) => ({
                value: LIQUIDATED_FILTER_PARAMS[k],
                label: LIQUIDATED_FILTER_LABELS[k],
              }))}
              defaultValue={filters.liquidated ? LIQUIDATED_FILTER_PARAMS[filters.liquidated] : ""}
              className="sm:w-auto"
            />
            <FilterSelect
              name="verificar"
              label="Verificação"
              options={[{ value: "1", label: "Somente a verificar" }]}
              defaultValue={filters.needsVerification ? "1" : ""}
              className="sm:w-auto"
            />
          </div>
        </details>
      </FilterBar>

      {result.total === 0 && !filtered && view === "active" ? (
        <EmptyState
          icon={<Gavel />}
          title="Nenhum processo na carteira ativa"
          description={
            canWrite
              ? "Cadastre um processo ou importe a planilha da carteira para acompanhar valores, prazos e documentos."
              : "Ainda não há processos ativos visíveis para o seu perfil."
          }
          action={
            canWrite ? (
              <ButtonLink href="/processos/novo">
                <Plus aria-hidden="true" />
                Novo processo
              </ButtonLink>
            ) : null
          }
        />
      ) : (
        <>
          <p className="mb-2 text-sm text-muted-foreground" aria-live="polite">
            {pluralize(result.total, "processo encontrado", "processos encontrados")}
            {filters.sort !== "updated_desc" ? ` · ordenados por ${PROCESS_SORT_LABELS[filters.sort].toLowerCase()}` : ""}
          </p>
          <Card className="py-0">
            <PortfolioTable
              items={result.items}
              emptyDescription={
                view === "active"
                  ? "Revise os filtros ou consulte também os processos fora da carteira ativa."
                  : "Revise os filtros ou limpe a busca."
              }
            />
          </Card>
          <Pagination
            page={result.page}
            pageSize={result.pageSize}
            total={result.total}
            basePath="/processos"
            searchParams={sp}
          />
        </>
      )}
    </>
  );
}
