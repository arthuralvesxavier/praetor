import { ChevronDown } from "lucide-react";
import { FilterBar, FilterInput, FilterSelect } from "@/components/ui/filter-bar";
import {
  LEGAL_AREA_LABELS,
  PROCESS_INSTANCE_LABELS,
  PROCESS_PHASE_LABELS,
  PROCESS_STATUS_LABELS,
  RISK_LEVEL_LABELS,
} from "@/domain/enums";
import { optionsFromLabels, type Option } from "@/lib/options";
import { param, type SearchParams } from "@/lib/search-params";
import {
  LIQUIDATED_FILTER_LABELS,
  LIQUIDATED_FILTER_PARAMS,
  MISSING_FIELD_LABELS,
  MISSING_FIELD_PARAMS,
  PROCESS_SORT_LABELS,
  PROCESS_SORT_PARAMS,
  type ProcessListParams,
} from "../filters";
import { PROCESS_MISSING_FIELDS, PROCESS_SORTS, type ProcessMissingField, type ProcessSort } from "../schemas";
import { BRAZILIAN_STATES } from "../states";

/**
 * Sort labels of the portfolio screen. "Valor apurado" is the term of the column
 * and of the totals strip (PROCESS_SORT_LABELS, shared, still says "liquidado").
 */
export const PORTFOLIO_SORT_LABELS: Record<ProcessSort, string> = {
  ...PROCESS_SORT_LABELS,
  liquidated_desc: "Maior valor apurado",
  liquidated_asc: "Menor valor apurado",
};

export type PortfolioFilterOptions = {
  courts: string[];
  cities: string[];
  classes: string[];
  states: string[];
  users: Option[];
  companies: Option[];
  /** Empty for external counsel (internal structure is not listed to a third party). */
  units: Option[];
  /** Empty for external counsel. */
  lawFirms: Option[];
};

export type PortfolioFiltersProps = {
  sp: SearchParams;
  filters: ProcessListParams;
  options: PortfolioFilterOptions;
  /**
   * False for external counsel: no "Unidade" / "Escritório externo" selects and no "Sem unidade"
   * option (unless it is in the URL). A unit or firm that arrived in the URL is kept in a hidden
   * field (the page shows it in a callout with a link that removes it).
   */
  showInternalStructure: boolean;
  /** "Empresa" filter: only when the organization has more than one active company (or the filter is in the URL). */
  showCompany: boolean;
  /** Open "Mais filtros": one of its filters is active (a sort alone keeps it collapsed). */
  advancedOpen: boolean;
  showClear: boolean;
};

const toOptions = (values: string[]): Option[] => values.map((v) => ({ value: v, label: v }));

/**
 * Keeps a value that arrived in the URL selectable when it is not in the option
 * list (an inactive record, a long list), so the next "Filtrar" does not drop it.
 */
function withCurrent(options: Option[], current: string | undefined, label: string = current ?? ""): Option[] {
  return current && !options.some((o) => o.value === current) ? [...options, { value: current, label }] : options;
}

/**
 * GET filter form of `/processos` (works without JavaScript). Main row: search,
 * tribunal, instância and fase; everything else in "Mais filtros", collapsed
 * unless one of those filters is active.
 */
export function PortfolioFilters({ sp, filters, options, showInternalStructure, showCompany, advancedOpen, showClear }: PortfolioFiltersProps) {
  const uf = filters.state;
  const stateOptions: Option[] = BRAZILIAN_STATES.filter(([value]) => options.states.includes(value) || value === uf).map(
    ([value, name]) => ({ value, label: `${value} (${name})` }),
  );
  // Phase is required on every process and the unit is internal structure: list them only when they arrive in the URL.
  const hiddenGap = (k: ProcessMissingField) =>
    (k === "phase" || (k === "unit" && !showInternalStructure)) && filters.missingField !== k;
  const missingFieldOptions = PROCESS_MISSING_FIELDS.filter((k) => !hiddenGap(k)).map((k) => ({
    value: MISSING_FIELD_PARAMS[k],
    label: MISSING_FIELD_LABELS[k],
  }));
  const sortOptions = PROCESS_SORTS.filter((s) => s !== "updated_desc").map((s) => ({
    value: PROCESS_SORT_PARAMS[s],
    label: PORTFOLIO_SORT_LABELS[s],
  }));

  return (
    <FilterBar
      basePath="/processos"
      defaultQuery={param(sp, "q")}
      searchPlaceholder="CNJ, parte, cidade ou classe"
      hiddenFields={{ carteira: param(sp, "carteira") }}
      showClear={showClear}
    >
      {!showInternalStructure && filters.unitId ? <input type="hidden" name="unidade" value={filters.unitId} /> : null}
      {!showInternalStructure && filters.lawFirmId ? <input type="hidden" name="escritorio" value={filters.lawFirmId} /> : null}
      <div className="grid grid-cols-2 gap-3 sm:contents">
        <FilterSelect
          name="tribunal"
          label="Tribunal"
          options={withCurrent(toOptions(options.courts), filters.court)}
          defaultValue={filters.court}
          className="sm:w-36"
        />
        <FilterSelect
          name="instancia"
          label="Instância"
          options={optionsFromLabels(PROCESS_INSTANCE_LABELS)}
          defaultValue={filters.instance}
          placeholder="Todas"
          className="sm:w-36"
        />
        <FilterSelect
          name="phase"
          label="Fase"
          options={optionsFromLabels(PROCESS_PHASE_LABELS)}
          defaultValue={filters.phase}
          placeholder="Todas"
          className="sm:w-36"
        />
        {showCompany ? (
          <FilterSelect
            name="empresa"
            label="Empresa"
            options={withCurrent(options.companies, filters.companyId, "Empresa selecionada")}
            defaultValue={filters.companyId}
            placeholder="Todas"
            className="sm:w-44"
          />
        ) : null}
      </div>
      {/* Closed: a link-like toggle next to "Filtrar"; open: a full row, with the buttons below its fields. */}
      <details open={advancedOpen} className="group w-full sm:w-auto sm:open:basis-full">
        <summary className="inline-flex h-9 cursor-pointer items-center gap-1 rounded-sm text-sm font-medium whitespace-nowrap text-primary-700 select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
          <ChevronDown aria-hidden="true" className="size-4 transition-transform group-open:rotate-180" />
          Mais filtros
        </summary>
        <div className="mt-1 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <FilterSelect
            name="ordem"
            label="Ordenar por"
            options={sortOptions}
            defaultValue={filters.sort === "updated_desc" ? "" : PROCESS_SORT_PARAMS[filters.sort]}
            placeholder={PORTFOLIO_SORT_LABELS.updated_desc}
            className="sm:w-auto"
          />
          <FilterSelect name="status" label="Situação" options={optionsFromLabels(PROCESS_STATUS_LABELS)} defaultValue={filters.status} placeholder="Todas" className="sm:w-auto" />
          <FilterSelect name="area" label="Área" options={optionsFromLabels(LEGAL_AREA_LABELS)} defaultValue={filters.area} placeholder="Todas" className="sm:w-auto" />
          <FilterSelect name="risco" label="Risco (interno)" options={optionsFromLabels(RISK_LEVEL_LABELS)} defaultValue={filters.riskLevel} className="sm:w-auto" />
          <FilterSelect
            name="cidade"
            label="Cidade"
            options={withCurrent(toOptions(options.cities), filters.city)}
            defaultValue={filters.city}
            placeholder="Todas"
            className="sm:w-auto"
          />
          <FilterSelect name="uf" label="UF" options={stateOptions} defaultValue={uf} placeholder="Todas" className="sm:w-auto" />
          <FilterSelect
            name="classe"
            label="Classe"
            options={withCurrent(toOptions(options.classes), filters.processClass)}
            defaultValue={filters.processClass}
            placeholder="Todas"
            className="sm:w-auto"
          />
          <FilterSelect
            name="responsavel"
            label="Responsável"
            options={withCurrent(options.users, filters.responsibleId, "Responsável selecionado")}
            defaultValue={filters.responsibleId}
            className="sm:w-auto"
          />
          {showInternalStructure ? (
            <>
              <FilterSelect
                name="unidade"
                label="Unidade"
                options={withCurrent(options.units, filters.unitId, "Unidade selecionada")}
                defaultValue={filters.unitId}
                placeholder="Todas"
                className="sm:w-auto"
              />
              <FilterSelect
                name="escritorio"
                label="Escritório externo"
                options={withCurrent(options.lawFirms, filters.lawFirmId, "Escritório selecionado")}
                defaultValue={filters.lawFirmId}
                className="sm:w-auto"
              />
            </>
          ) : null}
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
            label="Valor apurado"
            options={(["with", "without"] as const).map((k) => ({
              value: LIQUIDATED_FILTER_PARAMS[k],
              label: LIQUIDATED_FILTER_LABELS[k],
            }))}
            defaultValue={filters.liquidated ? LIQUIDATED_FILTER_PARAMS[filters.liquidated] : ""}
            className="sm:w-auto"
          />
          <FilterSelect
            name="pendencia"
            label="Pendência de cadastro"
            options={missingFieldOptions}
            defaultValue={filters.missingField ? MISSING_FIELD_PARAMS[filters.missingField] : ""}
            className="sm:w-auto"
          />
          <FilterSelect
            name="verificar"
            label="Conferência"
            options={[{ value: "1", label: "Somente pendentes de conferência" }]}
            defaultValue={filters.needsVerification ? "1" : ""}
            className="sm:w-auto"
          />
        </div>
      </details>
    </FilterBar>
  );
}
