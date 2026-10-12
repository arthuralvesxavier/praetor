/**
 * Tabs of the process detail (`/processos/[id]?aba=...`, P0.6): six tabs, the keys
 * of the previous fourteen-tab layout still open the tab that now holds their
 * content (old links in e-mails, alerts and other modules keep working), and
 * the in-page anchors of each section. Pure and client-safe.
 */

export const PROCESS_TAB_KEYS = [
  "resumo",
  "partes-e-andamento",
  "valores-e-acordos",
  "prazos-e-audiencias",
  "documentos-e-analises",
  "historico",
] as const;
export type ProcessTabKey = (typeof PROCESS_TAB_KEYS)[number];

export const DEFAULT_PROCESS_TAB: ProcessTabKey = "resumo";

export const PROCESS_TAB_LABELS: Record<ProcessTabKey, string> = {
  resumo: "Resumo",
  "partes-e-andamento": "Partes e andamento",
  "valores-e-acordos": "Valores e acordos",
  "prazos-e-audiencias": "Prazos e audiências",
  "documentos-e-analises": "Documentos e análises",
  historico: "Histórico",
};

/** In-page anchors (element ids) of the sections inside the tabs. */
export const PROCESS_SECTION_IDS = {
  parties: "partes",
  instances: "instancias",
  timeline: "andamento",
  values: "valores",
  /** Same value as RISK_SECTION_ID (`./decision-band`), the risk card of the values section. */
  risk: "classificacao-risco",
  claims: "pedidos",
  settlements: "acordos",
  scenarios: "cenarios",
  deadlines: "prazos",
  hearings: "audiencias",
  documents: "documentos",
  sensitiveDownloads: "downloads-sensiveis",
  brief: "analise-preliminar",
  legalReport: "relatorio-do-processo",
  analyses: "analises-ia",
  comments: "comentarios",
  emails: "emails",
  history: "historico-alteracoes",
} as const;
export type ProcessSectionId = (typeof PROCESS_SECTION_IDS)[keyof typeof PROCESS_SECTION_IDS];

/**
 * Keys of the fourteen-tab layout (until P0.6) → the tab that holds the content now
 * and, when the content is not at the top of that tab, the section anchor to scroll to.
 */
export const LEGACY_PROCESS_TABS: Record<string, { tab: ProcessTabKey; section: ProcessSectionId | null }> = {
  "visao-geral": { tab: "resumo", section: null },
  partes: { tab: "partes-e-andamento", section: PROCESS_SECTION_IDS.parties },
  instancias: { tab: "partes-e-andamento", section: PROCESS_SECTION_IDS.instances },
  movimentacoes: { tab: "partes-e-andamento", section: PROCESS_SECTION_IDS.timeline },
  valores: { tab: "valores-e-acordos", section: null },
  acordos: { tab: "valores-e-acordos", section: PROCESS_SECTION_IDS.settlements },
  audiencias: { tab: "prazos-e-audiencias", section: PROCESS_SECTION_IDS.hearings },
  "analise-preliminar": { tab: "documentos-e-analises", section: PROCESS_SECTION_IDS.brief },
  documentos: { tab: "documentos-e-analises", section: null },
  prazos: { tab: "prazos-e-audiencias", section: null },
  emails: { tab: "historico", section: PROCESS_SECTION_IDS.emails },
  ia: { tab: "documentos-e-analises", section: PROCESS_SECTION_IDS.analyses },
  comentarios: { tab: "historico", section: null },
  historico: { tab: "historico", section: null },
};

export type ResolvedProcessTab = {
  tab: ProcessTabKey;
  /** Section to bring into view (legacy key whose content is not at the top of the new tab). */
  section: ProcessSectionId | null;
  /** True when `aba` was a key of the previous layout. */
  legacy: boolean;
};

/**
 * `aba` value → tab to open. New keys win; old keys are mapped; anything else
 * (absent, unknown, repeated) opens the default tab.
 */
export function resolveProcessTab(aba: string | string[] | null | undefined): ResolvedProcessTab {
  const value = Array.isArray(aba) ? aba[0] : aba;
  if (value && (PROCESS_TAB_KEYS as readonly string[]).includes(value)) {
    return { tab: value as ProcessTabKey, section: null, legacy: false };
  }
  if (value && Object.prototype.hasOwnProperty.call(LEGACY_PROCESS_TABS, value)) {
    const target = LEGACY_PROCESS_TABS[value];
    return { tab: target.tab, section: target.section, legacy: true };
  }
  return { tab: DEFAULT_PROCESS_TAB, section: null, legacy: false };
}

/** Link to a tab (and optionally a section) of the process page. */
export function processTabUrl(processId: string, tab: ProcessTabKey, section?: ProcessSectionId | null): string {
  const query = tab === DEFAULT_PROCESS_TAB ? "" : `?aba=${tab}`;
  return `/processos/${processId}${query}${section ? `#${section}` : ""}`;
}

/** `?valor_causa=` value after a valor da causa change was sent to the review queue. */
export const CLAIM_PROPOSED_PARAM_VALUE = "em_conferencia";

type HeaderParty = { name: string; role: string; isClient: boolean };

/**
 * Subtitle of the process header: "Autor × Empresa". The author is the first plaintiff
 * ("e outros" when there are more); the company is the group company of the record, else
 * the defendant marked as client, else the first defendant.
 */
export function processHeaderSubtitle(p: { parties: readonly HeaderParty[]; companyName: string | null }): string {
  const plaintiffs = p.parties.filter((x) => x.role === "plaintiff");
  const defendants = p.parties.filter((x) => x.role === "defendant");
  const author = plaintiffs[0]
    ? plaintiffs.length > 1
      ? `${plaintiffs[0].name} e outros`
      : plaintiffs[0].name
    : "Autor não informado";
  const company = p.companyName ?? defendants.find((x) => x.isClient)?.name ?? defendants[0]?.name ?? "Empresa não informada";
  return `${author} × ${company}`;
}
