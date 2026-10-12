/**
 * URL params of the portfolio list (`/processos`) and of the export route
 * (`/api/processes/export`), mapped to the service filters. Client-safe.
 *
 * Params (MODULE_CONTRACTS "v2 — New routes and URL params"):
 *   q, status, area, phase, risco, unidade, responsavel, tribunal, instancia,
 *   cidade, uf, empresa, escritorio, classe, valor_min, valor_max (reais),
 *   liquidado=com|sem, verificar=1, carteira=ativa|encerrada|todas (default ativa), ordem, pagina
 */
import {
  LEGAL_AREAS,
  PROCESS_INSTANCES,
  PROCESS_PHASES,
  PROCESS_STATUSES,
  RISK_LEVELS,
  type ProcessInstance,
} from "@/domain/enums";
import { enumParam, flagParam, idParam, pageParam, param, type SearchParams } from "@/lib/search-params";
import type { LiquidatedFilter, PortfolioView, ProcessFilters, ProcessSort } from "./schemas";

export const PORTFOLIO_VIEW_PARAMS: Record<PortfolioView, string> = {
  active: "ativa",
  closed: "encerrada",
  all: "todas",
};

export const PORTFOLIO_VIEW_LABELS: Record<PortfolioView, string> = {
  active: "Carteira ativa",
  closed: "Fora da carteira ativa",
  all: "Todos",
};

export const PORTFOLIO_VIEW_DESCRIPTIONS: Record<PortfolioView, string> = {
  active: "Processos ativos ou suspensos.",
  closed: "Encerrados ou arquivados (inclusive saída do acervo / perda do patrocínio). O histórico é preservado.",
  all: "Todos os processos visíveis para o seu perfil.",
};

export const LIQUIDATED_FILTER_PARAMS: Record<LiquidatedFilter, string> = { with: "com", without: "sem" };
export const LIQUIDATED_FILTER_LABELS: Record<LiquidatedFilter, string> = {
  with: "Com valor apurado",
  without: "Não apurado",
};

export const PROCESS_SORT_PARAMS: Record<ProcessSort, string> = {
  updated_desc: "recentes",
  number_asc: "numero",
  claim_desc: "causa_maior",
  claim_asc: "causa_menor",
  liquidated_desc: "liquidado_maior",
  liquidated_asc: "liquidado_menor",
  filed_desc: "ajuizamento_recente",
  filed_asc: "ajuizamento_antigo",
  last_movement_desc: "movimentacao_recente",
};

export const PROCESS_SORT_LABELS: Record<ProcessSort, string> = {
  updated_desc: "Atualizados recentemente",
  number_asc: "Número (CNJ)",
  claim_desc: "Maior valor da causa",
  claim_asc: "Menor valor da causa",
  liquidated_desc: "Maior valor liquidado",
  liquidated_asc: "Menor valor liquidado",
  filed_desc: "Ajuizamento mais recente",
  filed_asc: "Ajuizamento mais antigo",
  last_movement_desc: "Última movimentação",
};

/** Instance labels as written in the client spreadsheet (sheet names / "Instância" column). */
export const INSTANCE_SHEET_LABELS: Record<ProcessInstance, string> = {
  first: "1º Grau",
  second: "2º Grau",
  superior: "3º Grau",
};

/** Every list param (to show "Limpar" and to keep filters in links). */
export const PROCESS_LIST_PARAM_KEYS = [
  "q",
  "status",
  "area",
  "phase",
  "risco",
  "unidade",
  "responsavel",
  "tribunal",
  "instancia",
  "cidade",
  "uf",
  "empresa",
  "escritorio",
  "classe",
  "valor_min",
  "valor_max",
  "liquidado",
  "verificar",
] as const;

/** Params shown inside "Mais filtros" (the details block opens when any of them is set). */
export const SECONDARY_FILTER_KEYS = [
  "cidade",
  "uf",
  "classe",
  "escritorio",
  "status",
  "area",
  "risco",
  "unidade",
  "responsavel",
  "valor_min",
  "valor_max",
  "liquidado",
  "verificar",
] as const;

function reverse<K extends string>(map: Record<K, string>, value: string | undefined): K | undefined {
  if (value === undefined) return undefined;
  return (Object.keys(map) as K[]).find((k) => map[k] === value);
}

/** Integer reais ("150000", "150.000", "150000,00") -> cents; anything else -> undefined. */
export function reaisParamToCents(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const cleaned = value.replace(/\./g, "").replace(/,00$/, "");
  if (!/^\d{1,13}$/.test(cleaned)) return undefined;
  return Number.parseInt(cleaned, 10) * 100;
}

function text(sp: SearchParams, key: string, max: number): string | undefined {
  const v = param(sp, key);
  return v ? v.slice(0, max) : undefined;
}

export type ProcessListParams = ProcessFilters & {
  portfolio: PortfolioView;
  sort: ProcessSort;
  page: number;
};

/**
 * Parses the URL into service filters. Invalid values are dropped (never an
 * error). When `status` is given without `carteira`, the view widens to
 * "todas" so that `?status=closed` (dashboard deep links) still finds records.
 */
export function processFiltersFromSearchParams(sp: SearchParams): ProcessListParams {
  const status = enumParam(sp, "status", PROCESS_STATUSES);
  const uf = param(sp, "uf");
  const portfolio = reverse(PORTFOLIO_VIEW_PARAMS, param(sp, "carteira")) ?? (status ? "all" : "active");
  return {
    q: text(sp, "q", 200),
    status,
    area: enumParam(sp, "area", LEGAL_AREAS),
    phase: enumParam(sp, "phase", PROCESS_PHASES),
    riskLevel: enumParam(sp, "risco", RISK_LEVELS),
    unitId: idParam(sp, "unidade"),
    responsibleId: idParam(sp, "responsavel"),
    court: text(sp, "tribunal", 120),
    instance: enumParam(sp, "instancia", PROCESS_INSTANCES),
    city: text(sp, "cidade", 120),
    state: uf && /^[A-Za-z]{2}$/.test(uf) ? uf.toUpperCase() : undefined,
    companyId: idParam(sp, "empresa"),
    lawFirmId: idParam(sp, "escritorio"),
    processClass: text(sp, "classe", 40),
    claimMinCents: reaisParamToCents(param(sp, "valor_min")),
    claimMaxCents: reaisParamToCents(param(sp, "valor_max")),
    liquidated: reverse(LIQUIDATED_FILTER_PARAMS, param(sp, "liquidado")),
    needsVerification: flagParam(sp, "verificar") ? true : undefined,
    portfolio,
    sort: reverse(PROCESS_SORT_PARAMS, param(sp, "ordem")) ?? "updated_desc",
    page: pageParam(sp),
  };
}
