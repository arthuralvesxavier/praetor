/** Brazilian federative units (UF) for the process forms. Client-safe. */
export const BRAZILIAN_STATES = [
  ["AC", "Acre"],
  ["AL", "Alagoas"],
  ["AP", "Amapá"],
  ["AM", "Amazonas"],
  ["BA", "Bahia"],
  ["CE", "Ceará"],
  ["DF", "Distrito Federal"],
  ["ES", "Espírito Santo"],
  ["GO", "Goiás"],
  ["MA", "Maranhão"],
  ["MT", "Mato Grosso"],
  ["MS", "Mato Grosso do Sul"],
  ["MG", "Minas Gerais"],
  ["PA", "Pará"],
  ["PB", "Paraíba"],
  ["PR", "Paraná"],
  ["PE", "Pernambuco"],
  ["PI", "Piauí"],
  ["RJ", "Rio de Janeiro"],
  ["RN", "Rio Grande do Norte"],
  ["RS", "Rio Grande do Sul"],
  ["RO", "Rondônia"],
  ["RR", "Roraima"],
  ["SC", "Santa Catarina"],
  ["SP", "São Paulo"],
  ["SE", "Sergipe"],
  ["TO", "Tocantins"],
] as const;

export const STATE_OPTIONS = BRAZILIAN_STATES.map(([value, name]) => ({ value, label: `${value} (${name})` }));

/** "Palmas" + "TO" -> "Palmas/TO"; missing parts are omitted. */
export function cityWithState(city: string | null | undefined, state: string | null | undefined): string | null {
  if (city && state) return `${city}/${state}`;
  return city || state || null;
}
