import { FileDown, FileSpreadsheet, Gavel, Plus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { buttonVariants, ButtonLink } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { LinkTabs } from "@/components/ui/tabs";
import { pluralize } from "@/lib/format";
import { buildHref, hasAnyParam } from "@/lib/search-params";
import { listUnitOptions, listUserOptions } from "@/modules/admin/service";
import { listCompanyOptions, listLawFirmOptions } from "@/modules/organization/service";
import { PORTFOLIO_SORT_LABELS, PortfolioFilters } from "@/modules/processes/components/portfolio-filters";
import { PortfolioSummary } from "@/modules/processes/components/portfolio-summary";
import { PortfolioTable } from "@/modules/processes/components/portfolio-table";
import {
  MISSING_FIELD_LABELS,
  PORTFOLIO_VIEW_DESCRIPTIONS,
  PORTFOLIO_VIEW_LABELS,
  PORTFOLIO_VIEW_PARAMS,
  PROCESS_LIST_PARAM_KEYS,
  PROCESS_SORT_PARAMS,
  processFiltersFromSearchParams,
  SECONDARY_FILTER_KEYS,
} from "@/modules/processes/filters";
import { PORTFOLIO_VIEWS, type ProcessSort } from "@/modules/processes/schemas";
import { getProcessFilterOptions, listProcesses, summarizeProcesses } from "@/modules/processes/service";
import { isExternalCounsel } from "@/server/auth/access";
import { can } from "@/server/auth/permissions";
import { requirePageContext } from "@/server/auth/session";

export const metadata: Metadata = { title: "Carteira de processos" };

/** Filters about the internal structure (units, the firms the organization works with): no select for external counsel. */
const INTERNAL_STRUCTURE_KEYS: readonly string[] = ["unidade", "escritorio"];

type NamedOption = { id: string; name: string };
const noOptions = (): Promise<NamedOption[]> => Promise.resolve([]);

/**
 * "unidade São Paulo e escritório X": the internal-structure scope that arrived in
 * the URL of an external counsel (a dashboard drill-down), or null.
 */
function structureScopeText(
  filters: { unitId?: string; lawFirmId?: string },
  units: NamedOption[],
  lawFirms: NamedOption[],
): string | null {
  const parts: string[] = [];
  if (filters.unitId) parts.push(`unidade ${units.find((u) => u.id === filters.unitId)?.name ?? "selecionada"}`);
  if (filters.lawFirmId) parts.push(`escritório ${lawFirms.find((l) => l.id === filters.lawFirmId)?.name ?? "selecionado"}`);
  return parts.length > 0 ? parts.join(" e ") : null;
}

export default async function ProcessesPage(props: PageProps<"/processos">) {
  const ctx = await requirePageContext("process:read");
  const sp = await props.searchParams;
  const external = isExternalCounsel(ctx);
  // One set of filters for the list, the totals and the export link. External counsel has no
  // "Unidade" / "Escritório externo" select and no list of the internal structure; a unit or firm
  // that arrives in the URL (a dashboard drill-down) is still applied, so the list matches the
  // number clicked, and it is shown in a callout with a link that removes it: never applied unseen.
  const filters = processFiltersFromSearchParams(sp);
  const filtered = hasAnyParam(sp, PROCESS_LIST_PARAM_KEYS);
  const advancedOpen = hasAnyParam(
    sp,
    SECONDARY_FILTER_KEYS.filter((k) => !(external && INTERNAL_STRUCTURE_KEYS.includes(k))),
  );

  const [result, summary, filterOptions, userOptions, companyOptions, unitOptions, lawFirmOptions] = await Promise.all([
    listProcesses(ctx, filters),
    summarizeProcesses(ctx, filters),
    getProcessFilterOptions(ctx),
    listUserOptions(ctx),
    listCompanyOptions(ctx),
    // External counsel: only to name the unit or firm of the scope above (never rendered as a list).
    !external || filters.unitId ? listUnitOptions(ctx) : noOptions(),
    !external || filters.lawFirmId ? listLawFirmOptions(ctx) : noOptions(),
  ]);
  const canWrite = can(ctx, "process:write");
  const view = filters.portfolio;
  // One active company: it goes in the subtitle; more than one: a line under the autor and a filter.
  const multiCompany = companyOptions.length > 1;
  const singleCompany = companyOptions.length === 1 ? companyOptions[0].name : null;
  const structureScope = external ? structureScopeText(filters, unitOptions, lawFirmOptions) : null;

  const exportHref = (format: "csv" | "xlsx") =>
    buildHref("/api/processes/export", sp, { formato: format, pagina: null });
  const sortHref = (s: ProcessSort) =>
    buildHref("/processos", sp, { ordem: s === "updated_desc" ? null : PROCESS_SORT_PARAMS[s], pagina: null });

  return (
    <>
      <PageHeader
        title="Carteira de processos"
        description={
          singleCompany ? (
            <>
              Passivo judicial de <span className="font-medium text-slate-700">{singleCompany}</span> acompanhado pelo
              jurídico: um registro por número CNJ, com as instâncias vinculadas.
            </>
          ) : (
            "Passivo judicial acompanhado pelo jurídico: um registro por número CNJ, com as instâncias vinculadas."
          )
        }
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

      {structureScope ? (
        <Callout tone="info" title={`Recorte por ${structureScope}`} className="mb-4">
          Este recorte veio do link que você abriu (por exemplo, um gráfico do painel executivo) e vale para a lista, os totais e a
          exportação.{" "}
          <Link href={buildHref("/processos", sp, { unidade: null, escritorio: null, pagina: null })}>Remover o recorte</Link>
        </Callout>
      ) : null}

      {filters.missingField ? (
        <Callout tone="warning" title={`Pendência de cadastro: ${MISSING_FIELD_LABELS[filters.missingField].toLowerCase()}`} className="mb-4">
          Estes processos ficam fora do gráfico correspondente no painel executivo.{" "}
          {canWrite
            ? "Abra cada um, complete o campo e salve: o processo sai desta lista e entra no gráfico automaticamente."
            : "Peça ao responsável pelo processo que complete o campo: o processo sai desta lista e entra no gráfico automaticamente."}{" "}
          <Link href={buildHref("/processos", sp, { pendencia: null, pagina: null })}>Ver todos os processos do recorte</Link>
        </Callout>
      ) : null}

      <PortfolioSummary
        summary={summary}
        verificationHref={filters.needsVerification ? undefined : buildHref("/processos", sp, { verificar: "1", pagina: null })}
      />

      <PortfolioFilters
        sp={sp}
        filters={filters}
        options={{
          ...filterOptions,
          users: userOptions.map((u) => ({ value: u.id, label: u.name })),
          companies: companyOptions.map((c) => ({ value: c.id, label: c.name })),
          units: external ? [] : unitOptions.map((u) => ({ value: u.id, label: u.name })),
          lawFirms: external ? [] : lawFirmOptions.map((f) => ({ value: f.id, label: f.name })),
        }}
        showInternalStructure={!external}
        showCompany={multiCompany || Boolean(filters.companyId)}
        advancedOpen={advancedOpen}
        showClear={filtered || hasAnyParam(sp, ["ordem"])}
      />

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
            {filters.sort !== "updated_desc" ? `, ordenados por ${PORTFOLIO_SORT_LABELS[filters.sort].toLowerCase()}` : ""}.{" "}
            {PORTFOLIO_VIEW_DESCRIPTIONS[view]}
          </p>
          <Card className="gap-0 py-0">
            <PortfolioTable
              items={result.items}
              showCompany={multiCompany}
              sort={{ current: filters.sort, href: sortHref }}
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
