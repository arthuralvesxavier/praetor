/**
 * pt-BR labels and tones of the import screens (client-safe). Issue codes are
 * produced by `./parser.ts` and `./plan.ts`.
 */
import type { ImportBatchStatus, ImportRowAction, IssueLevel } from "@/domain/enums";
import type { Tone } from "@/lib/tones";

export const SHEET_ROLE_LABELS: Record<"consolidated" | "instance" | "ignored", string> = {
  consolidated: "Base consolidada (oficial)",
  instance: "Aba por instância (conferência)",
  ignored: "Ignorada",
};

export const SHEET_ROLE_TONES: Record<"consolidated" | "instance" | "ignored", Tone> = {
  consolidated: "primary",
  instance: "info",
  ignored: "neutral",
};

export const IMPORT_BATCH_STATUS_TONES: Record<ImportBatchStatus, Tone> = {
  analyzed: "warning",
  committed: "success",
  rolled_back: "neutral",
  failed: "danger",
};

export const IMPORT_ROW_ACTION_TONES: Record<ImportRowAction, Tone> = {
  create: "success",
  update: "info",
  unchanged: "neutral",
  merge_instance: "primary",
  skip: "neutral",
  error: "danger",
};

export const ISSUE_LEVEL_TONES: Record<IssueLevel, Tone> = {
  error: "danger",
  warning: "warning",
  info: "info",
};

/** Canonical import fields (`CanonicalField` in ./parser). */
export const IMPORT_FIELD_LABELS: Record<string, string> = {
  instance: "Instância",
  court: "Tribunal",
  number: "Nº do processo (CNJ)",
  plaintiff: "Parte autora",
  defendant: "Parte ré",
  city: "Cidade / UF",
  courtDivision: "Vara / órgão julgador",
  processClass: "Classe processual",
  phase: "Fase",
  claimAmount: "Valor da causa",
  liquidatedAmount: "Valor liquidado / apurado",
};

export const ISSUE_CODE_LABELS: Record<string, string> = {
  total_row: "Linha de total ignorada",
  after_total: "Linha abaixo do TOTAL",
  cnj_missing: "Número não informado",
  cnj_invalid_format: "Número fora do padrão CNJ",
  cnj_invalid_check_digit: "Dígito verificador não confere",
  instance_unrecognized: "Instância não reconhecida",
  instance_sheet_mismatch: "Instância difere da aba",
  instance_assumed: "Instância presumida",
  instance_from_court: "Instância derivada do tribunal",
  instance_from_phase: "Instância derivada dos termos recursais da fase",
  court_derived: "Tribunal derivado do número",
  court_missing: "Tribunal ausente",
  court_cnj_mismatch: "Tribunal difere do número",
  city_non_geographic: "Localidade não é município",
  city_ambiguous: "Mais de uma localidade",
  city_state_inferred: "UF inferida da planilha",
  city_state_conflict: "Cidade com UFs diferentes",
  money_unrecognized: "Valor não reconhecido",
  money_negative: "Valor negativo",
  claim_symbolic: "Valor da causa simbólico",
  phase_unrecognized: "Fase não reconhecida",
  phase_verification: "Fase pede conferência",
  phase_closed: "Encerrado na planilha",
  closed_at_assumed: "Data de encerramento presumida",
  phase_fallback: "Fase presumida",
  phase_fallback_instance_only: "Fase não informada (texto indica só a instância)",
  phase_fallback_closed: "Fase não informada (processo encerrado)",
  party_missing: "Parte não informada",
  party_others: "“e outros” no nome",
  party_public_prosecutor: "Ministério Público",
  client_not_found: "Empresa não encontrada nas partes",
  client_both_sides: "Empresa nos dois polos",
  client_plaintiff_side: "Empresa no polo ativo",
  area_not_derived: "Área não derivada",
  duplicate_in_sheet: "Número repetido na aba",
  value_divergence: "Divergência entre abas",
  conferred: "Conferida com a base",
  only_in_instance_sheet: "Somente na aba da instância",
  current_instance_undetermined: "Instância atual indeterminada",
  forwarded_without_row: "Remessa sem linha da instância",
  instances_contradict: "Instâncias contraditórias",
  instance_values_differ: "Valor difere entre instâncias",
  existing_closed_not_reopened: "Encerrado no sistema",
  existing_value_differs: "Valor difere do oficial",
};

export function issueCodeLabel(code: string): string {
  return ISSUE_CODE_LABELS[code] ?? code;
}

export const DIVERGENCE_FIELD_LABELS: Record<string, string> = {
  claimAmount: "Valor da causa",
  liquidatedAmount: "Valor liquidado",
  phase: "Fase",
  court: "Tribunal",
  courtDivision: "Vara / órgão julgador",
};
