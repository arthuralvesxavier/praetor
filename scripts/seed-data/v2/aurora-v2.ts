import type {
  ApiKeyScope,
  ClaimCategory,
  HearingKind,
  HearingMode,
  LossProbability,
  ProbabilityBand,
  ProcessInstance,
} from "@/domain/enums";
import type { UnitKey, UserKey } from "../aurora";

/**
 * Fictional data added to the demo organization "Grupo Aurora Exemplo S.A."
 * by `npm run db:seed:v2` (scripts/seed-v2.ts). Every person, company, law
 * firm, unit, opinion and address here is invented. The portfolio itself comes
 * from the client's FICTITIOUS demo spreadsheet (DADOS_FICTICIOS), imported
 * through the imports module.
 *
 * Offsets are days from the day the seed runs (negative = past). Monthly
 * closes use the two months before the current one.
 */

/** The fictitious demo spreadsheet (scripts/seed-data/files). */
export const DEMO_SPREADSHEET = {
  fileName: "Passivo_TESTE_Consolidado_DADOS_FICTICIOS.xlsx",
  /** Data-base of the values ("Atualização Geral (29-07-2026)" sheet of the file). */
  baseDate: "2026-07-29",
} as const;

/**
 * Exact party name used in the spreadsheet ("EMPRESA MODELO TESTE LTDA (e
 * outros)"): the import marks that party as the client only when the company
 * has this exact name.
 */
export const V2_COMPANY_NAME = "EMPRESA MODELO TESTE LTDA";

export const V2_LAW_FIRM = {
  name: "Escritório Parceiro Exemplo Advogados (fictício)",
  contactName: "Marcelo Antunes (contato fictício)",
  contactEmail: "contato@escritorio-parceiro.invalid",
} as const;

export type V2UnitKey = "centroNorte" | "nordeste";

export const V2_UNITS: { key: V2UnitKey; name: string; code: string }[] = [
  { key: "centroNorte", name: "Regional Centro-Norte (fictícia)", code: "RCN" },
  { key: "nordeste", name: "Regional Nordeste (fictícia)", code: "RNE" },
];

export type V2UserKey = "contabilidade" | "auditoria" | "escritorio" | "advogadaPalmas" | "advogadoBrasilia";

/** DEMO_ACCOUNTS e-mail → seed key, unit, law firm and job title (v2 accounts of the Aurora organization). */
export const AURORA_V2_USERS: Record<string, { key: V2UserKey; unit: V2UnitKey | null; lawFirm: boolean; jobTitle: string }> = {
  "contabilidade@demo.praetor.local": { key: "contabilidade", unit: null, lawFirm: false, jobTitle: "Analista de controladoria" },
  "auditoria@demo.praetor.local": { key: "auditoria", unit: null, lawFirm: false, jobTitle: "Auditora interna" },
  "escritorio@demo.praetor.local": { key: "escritorio", unit: null, lawFirm: true, jobTitle: "Sócio do escritório parceiro" },
  "advogada.palmas@demo.praetor.local": { key: "advogadaPalmas", unit: "centroNorte", lawFirm: false, jobTitle: "Advogada trabalhista" },
  "advogado.brasilia@demo.praetor.local": { key: "advogadoBrasilia", unit: "centroNorte", lawFirm: false, jobTitle: "Advogado trabalhista" },
};

/** v2 lawyers that join the existing "Contencioso Trabalhista" team. */
export const V2_TEAM = { name: "Contencioso Trabalhista", members: ["advogadaPalmas", "advogadoBrasilia"] as V2UserKey[] };

export type DemoUserKey = UserKey | V2UserKey;

export type RuleSeed = {
  name: string;
  /** Names used by earlier versions of this seed (looked up so a rule is never created twice). */
  legacyNames?: string[];
  description: string;
  priority: number;
  courts?: string[];
  instances?: ProcessInstance[];
  method: "fixed" | "round_robin" | "least_loaded";
  users: DemoUserKey[];
  /** Sets the external law firm on the assigned processes. */
  lawFirm?: boolean;
  /** Unit set on processes that have none. */
  unit?: V2UnitKey | UnitKey;
};

/**
 * Rule name as written by earlier versions of this seed ("<a> <dash> <b>"),
 * kept only to find rules that already exist; new text never uses the dash.
 */
function legacy(a: string, b: string): string {
  return `${a} ${String.fromCharCode(0x2014)} ${b}`;
}

/**
 * Distribution rules (lowest priority number first). Processes that match no
 * rule (e.g. TRT9) go to the built-in fallback: least loaded lawyer.
 */
export const V2_RULES: RuleSeed[] = [
  {
    name: "Instância superior (TST): escritório parceiro",
    legacyNames: [legacy("Instância superior (TST)", "escritório parceiro")],
    description: "Processos em trâmite no TST ficam com o escritório externo parceiro (regra de demonstração).",
    priority: 10,
    instances: ["superior"],
    method: "fixed",
    users: ["escritorio"],
    lawFirm: true,
  },
  {
    name: "TRT10: Distrito Federal e Tocantins (rodízio)",
    legacyNames: [legacy("TRT10", "Distrito Federal e Tocantins (rodízio)")],
    description: "Rodízio entre os advogados da Regional Centro-Norte (fictícia).",
    priority: 20,
    courts: ["TRT10"],
    method: "round_robin",
    users: ["advogadaPalmas", "advogadoBrasilia"],
    unit: "centroNorte",
  },
  {
    name: "TRT18 e TRT23: Goiás e Mato Grosso (menor carga)",
    legacyNames: [legacy("TRT18 e TRT23", "Goiás e Mato Grosso (menor carga)")],
    description: "Menor carga entre os advogados da Regional Centro-Norte (fictícia).",
    priority: 30,
    courts: ["TRT18", "TRT23"],
    method: "least_loaded",
    users: ["advogadaPalmas", "advogadoBrasilia"],
    unit: "centroNorte",
  },
  {
    name: "TRT5: Bahia",
    legacyNames: [legacy("TRT5", "Bahia")],
    description: "Processos da Bahia ficam com o advogado do Nordeste (regra de demonstração).",
    priority: 40,
    courts: ["TRT5"],
    method: "fixed",
    users: ["advogadoRecife"],
    unit: "nordeste",
  },
  {
    name: "TRT2 e TRT15: São Paulo",
    legacyNames: [legacy("TRT2 e TRT15", "São Paulo")],
    description: "Processos de São Paulo ficam com a Matriz.",
    priority: 50,
    courts: ["TRT2", "TRT15"],
    method: "fixed",
    users: ["advogada"],
    unit: "sp",
  },
];

/** Every text written by the v2 seed carries this marker. */
export const FICTITIOUS = "(dados fictícios)";

/** Short fictitious opinions (pareceres) for manual risk classifications. */
export const RISK_OPINIONS: Record<LossProbability, string[]> = {
  remote: [
    "Pedidos sem respaldo documental e prova testemunhal favorável à empresa; baixa chance de condenação. (parecer fictício)",
    "Prescrição parcial reconhecida e controles de jornada íntegros juntados com a defesa. (parecer fictício)",
  ],
  possible: [
    "Fase de conhecimento sem sentença; pedidos de horas extras dependem da prova oral. (parecer fictício)",
    "Laudo pericial ainda não produzido; risco equilibrado entre as teses das partes. (parecer fictício)",
    "Sentença parcialmente desfavorável com recurso pendente; reversão possível em parte dos pedidos. (parecer fictício)",
  ],
  probable: [
    "Sentença desfavorável mantida em segundo grau; discussão restrita aos cálculos. (parecer fictício)",
    "Condenação confirmada e cálculos em fase de homologação; desembolso esperado. (parecer fictício)",
  ],
};

export const RISK_RECLASSIFICATION_OPINION =
  "Reclassificado após sentença desfavorável na fase de conhecimento; recurso com chance reduzida de êxito. (parecer fictício)";

export const RULE_APPROVAL_NOTE = "Conferido com os cálculos e a fase registrada no cadastro. (parecer fictício)";

export type HearingSeed = { days: number; time: string; kind: HearingKind; mode: HearingMode };

/** Upcoming hearings (next 1–20 days) of first-instance processes in the knowledge phase. */
export const V2_HEARINGS: HearingSeed[] = [
  { days: 1, time: "09:30", kind: "instruction", mode: "in_person" },
  { days: 3, time: "14:00", kind: "conciliation", mode: "virtual" },
  { days: 6, time: "10:00", kind: "initial", mode: "virtual" },
  { days: 9, time: "13:30", kind: "unified", mode: "in_person" },
  { days: 14, time: "15:00", kind: "instruction", mode: "hybrid" },
  { days: 20, time: "09:00", kind: "conciliation", mode: "virtual" },
];

/** A past hearing registered as held. */
export const V2_PAST_HEARING = {
  days: -6,
  time: "10:30",
  kind: "instruction" as HearingKind,
  mode: "in_person" as HearingMode,
  outcome:
    "Audiência realizada: depoimentos pessoais e de duas testemunhas colhidos; instrução encerrada e razões finais em 10 dias. (registro fictício)",
};

export function hearingLocation(city: string | null, division: string | null): string {
  const where = [division, city].filter(Boolean).join(", ");
  return `Fórum Trabalhista${where ? `, ${where}` : ""}, sala 3 (endereço fictício)`;
}

export function hearingUrl(n: number): string {
  return `https://audiencia.exemplo.invalid/sala-${100 + n}`;
}

export const V2_SETTLEMENT_NOTES = {
  homologated: "Acordo homologado em audiência de conciliação; 6 parcelas mensais. (dados fictícios)",
  negotiating: "Contraproposta da empresa em análise pela parte autora. (dados fictícios)",
  fulfilled: "Acordo quitado em 2 parcelas; comprovantes juntados aos autos. (dados fictícios)",
  breached: "Parcela em atraso; parte autora pediu a execução do acordo. (dados fictícios)",
} as const;

export const GUARANTEE_DESCRIPTIONS = {
  appeal_deposit: "Depósito recursal efetuado na interposição do recurso. (dados fictícios)",
  judicial_deposit: "Depósito judicial para garantia do juízo na execução. (dados fictícios)",
} as const;

export const VALUATION_UPDATE_REASON = "Atualização dos cálculos de liquidação pela contabilidade. (dados fictícios)";
export const EXTINCTION_NOTE = "pagamento integral comprovado nos autos (dados fictícios)";

/** Order of preference for the preventive-intelligence suggestion turned into an occurrence + action plan. */
export const PREVENTIVE_SUGGESTION_PREFERENCE = ["jornada", "rescisao", "passivo-materializado", "saneamento-cadastral"];

/** Number of simulated incoming processes (intake pipeline demo). */
export const SIMULATED_INTAKES = 3;

/**
 * Justification of the demo monthly closes (P1.9): the spreadsheet portfolio is
 * imported without risk classification, so the two previous competências are
 * closed with this justification (recorded with the list of unclassified
 * processes). At least 20 characters, no dash.
 */
export const CLOSE_JUSTIFICATION = "Fechamento de demonstração: processos importados ainda sem classificação de risco.";

// ---------------------------------------------------------------------------
// Pedidos (claims, P1.6): per-claim risk so the derived process risk shows up
// ---------------------------------------------------------------------------

/** Number of imported processes that get fictitious claims with assessments. */
export const CLAIMS_TARGET_PROCESSES = 20;

/** Suffix of every claim written by the seed (also the seed's marker for its own claims). */
export const CLAIM_FICTITIOUS_SUFFIX = "(dados fictícios)";

export type ClaimTemplateItem = {
  description: string;
  category: ClaimCategory;
  /** Share of the valor da causa (rounded to whole reais); null = not quantified (never zero). */
  share: number | null;
  /** Classification the responsible lawyer gives this claim. */
  classification: LossProbability;
};

/**
 * Fictitious labor claims (the demo portfolio is labor). The amounts split the
 * valor da causa of the process; nothing here comes from a real petition.
 * Derived process risk: rescisão = provável, jornada = possível (with a claim
 * whose value the court will set, so the rate is flagged for review),
 * insalubridade = possível, equiparação = remota, acidente = provável.
 */
export const CLAIM_TEMPLATES: { key: string; items: ClaimTemplateItem[] }[] = [
  {
    key: "rescisao",
    items: [
      { description: "Verbas rescisórias (aviso prévio, 13º salário e férias proporcionais)", category: "severance_pay", share: 0.3, classification: "probable" },
      { description: "Depósitos de FGTS em atraso e multa de 40%", category: "fgts", share: 0.15, classification: "probable" },
      { description: "Horas extras e reflexos", category: "overtime", share: 0.35, classification: "possible" },
      { description: "Indenização por dano moral", category: "moral_damages", share: 0.2, classification: "remote" },
    ],
  },
  {
    key: "jornada",
    items: [
      { description: "Horas extras além da oitava diária e reflexos", category: "overtime", share: 0.5, classification: "possible" },
      { description: "Intervalo intrajornada não concedido", category: "overtime", share: 0.25, classification: "possible" },
      { description: "Adicional noturno e reflexos", category: "other", share: 0.25, classification: "remote" },
      { description: "Indenização por dano moral (valor a arbitrar pelo juízo)", category: "moral_damages", share: null, classification: "remote" },
    ],
  },
  {
    key: "insalubridade",
    items: [
      { description: "Adicional de insalubridade e reflexos", category: "health_hazard_pay", share: 0.45, classification: "possible" },
      { description: "Horas extras e reflexos", category: "overtime", share: 0.35, classification: "remote" },
      { description: "Indenização por dano moral", category: "moral_damages", share: 0.2, classification: "remote" },
    ],
  },
  {
    key: "equiparacao",
    items: [
      { description: "Diferenças salariais por equiparação salarial e reflexos", category: "salary_equalization", share: 0.65, classification: "remote" },
      { description: "FGTS sobre as diferenças salariais", category: "fgts", share: 0.1, classification: "remote" },
      { description: "Indenização por dano moral", category: "moral_damages", share: 0.25, classification: "remote" },
    ],
  },
  {
    key: "acidente",
    items: [
      { description: "Indenização por dano material (despesas médicas e lucros cessantes)", category: "material_damages", share: 0.4, classification: "probable" },
      { description: "Indenização por dano moral", category: "moral_damages", share: 0.45, classification: "possible" },
      { description: "Salários do período de estabilidade provisória", category: "other", share: 0.15, classification: "possible" },
    ],
  },
];

/** Description stored for a template item (with the fictitious-data suffix). */
export function claimDescription(item: Pick<ClaimTemplateItem, "description">): string {
  return `${item.description} ${CLAIM_FICTITIOUS_SUFFIX}`;
}

/** Short fictitious opinions (pareceres) for the claim assessments. */
export const CLAIM_OPINIONS: Record<LossProbability, string[]> = {
  remote: [
    "Pedido sem respaldo nos documentos juntados; defesa com prova favorável à empresa. (parecer fictício)",
    "Pedido acessório que acompanha o principal, com baixa chance de êxito da parte autora. (parecer fictício)",
  ],
  possible: [
    "Pedido depende da prova oral; chances equilibradas entre as teses das partes. (parecer fictício)",
    "Perícia ainda não realizada; resultado incerto para este pedido. (parecer fictício)",
  ],
  probable: [
    "Documentos juntados confirmam o fato alegado para este pedido; condenação esperada. (parecer fictício)",
    "Prova documental desfavorável à empresa neste pedido; discussão restrita ao valor. (parecer fictício)",
  ],
};

// ---------------------------------------------------------------------------
// Cenários (process scenarios): system proposals for a few processes
// ---------------------------------------------------------------------------

/** Number of processes (with claims) that get scenario proposals. */
export const SCENARIO_TARGET_PROCESSES = 4;

/** Proposals by the classification derived from the claims (bands use the organization's limits). */
export const SCENARIO_PROPOSALS: Record<LossProbability, { band: ProbabilityBand; description: string }[]> = {
  probable: [
    { band: "high", description: "Condenação nos pedidos avaliados como prováveis, com a discussão concentrada nos cálculos. (cenário de demonstração)" },
    { band: "moderate", description: "Acordo antes da sentença por valor inferior ao estimado para os pedidos prováveis. (cenário de demonstração)" },
  ],
  possible: [
    { band: "moderate", description: "Procedência parcial: condenação em parte dos pedidos que dependem da prova oral. (cenário de demonstração)" },
    { band: "low", description: "Improcedência dos pedidos principais após a instrução. (cenário de demonstração)" },
  ],
  remote: [
    { band: "very_low", description: "Improcedência dos pedidos, sem condenação relevante. (cenário de demonstração)" },
    { band: "low", description: "Procedência parcial limitada a um pedido acessório. (cenário de demonstração)" },
  ],
};

export const SCENARIO_COMMENT =
  "Proposta gerada pelo sistema a partir da classificação derivada dos pedidos; revisar com o advogado responsável. (dados fictícios)";

// ---------------------------------------------------------------------------
// API de entrada: one demo key (shown once in the seed output; only its hash is stored)
// ---------------------------------------------------------------------------

export const DEMO_API_KEY: { name: string; scopes: ApiKeyScope[] } = {
  name: "Chave de demonstração, use só neste computador",
  scopes: ["intake:create", "process:read"],
};
