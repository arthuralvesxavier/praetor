/**
 * Pure mapping rules from DataJud data to Praetor records (unit-tested).
 *
 * Safety rules (product owner):
 * - movements are mapped by their NAME/code as informed; nothing is inferred
 *   beyond the explicit rules below;
 * - the only automatic phase changes are forward and unambiguous
 *   ("Liquidação iniciada" -> liquidation, execution start -> enforcement);
 *   a "Remessa ... em grau de recurso" moves the INSTANCE (phase and instance
 *   are distinct axes: there is no "appeal" phase);
 * - baixa / arquivamento / extinção / trânsito em julgado NEVER close a
 *   process: they only raise an alert and mark it for verification;
 * - a hearing movement says the hearing was designated, not when: the alert
 *   asks a person to register the date from the summons.
 */
import type { ProcessEventType, ProcessInstance, ProcessPhase } from "@/domain/enums";
import type { CourtMovement, CourtMovementComplement } from "@/server/integrations/courts/types";

export const DATAJUD_SOURCE_LABEL = "DataJud (CNJ)";
export const DATAJUD_ACTOR = "Sistema · DataJud";

/** Lower case, no accents, single spaces. */
export function normalizeText(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Stable id of a movement in the source: `code|dateTime|grau` (same code and time twice = one event). */
export function movementExternalId(m: Pick<CourtMovement, "code" | "dateTime">, grau: string): string {
  return `${m.code ?? "s/c"}|${m.dateTime}|${grau.toUpperCase()}`;
}

/** Calendar date of a movement, as informed (no time zone shift). */
export function movementDate(m: Pick<CourtMovement, "dateTime">): string {
  return m.dateTime.slice(0, 10);
}

export function instanceForGrau(grau: string): ProcessInstance | null {
  switch (grau.toUpperCase()) {
    case "G1":
      return "first";
    case "G2":
      return "second";
    case "SUP":
      return "superior";
    default:
      return null;
  }
}

export const INSTANCE_RANK: Record<ProcessInstance, number> = { first: 1, second: 2, superior: 3 };

const COMPLEMENT_LABELS: Record<string, string> = {
  situacao_da_audiencia: "Situação da audiência",
  dirigida_por: "Dirigida por",
  tipo_de_peticao: "Tipo de petição",
  tipo_de_conclusao: "Tipo de conclusão",
  motivo_da_remessa: "Motivo da remessa",
  tipo_de_distribuicao_redistribuicao: "Tipo de distribuição",
  tipo_de_documento: "Tipo de documento",
};

function complementLabel(description: string): string {
  const known = COMPLEMENT_LABELS[description];
  if (known) return known;
  const text = description.replace(/_/g, " ").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "Complemento";
}

/** "Situação da audiência: designada; Dirigida por: Juiz(a)" (null when there is nothing to say). */
export function describeComplements(complements: CourtMovementComplement[]): string | null {
  const parts = complements
    .filter((c) => c.name)
    .map((c) => `${complementLabel(c.description)}: ${c.name}`);
  return parts.length ? parts.join("; ") : null;
}

function complementNamed(m: Pick<CourtMovement, "complements">, description: string): string | null {
  const c = m.complements.find((x) => x.description === description);
  return c ? normalizeText(c.name) : null;
}

/** "designada" | "realizada" | "cancelada" | ... when the movement carries a hearing situation. */
export function hearingSituation(m: Pick<CourtMovement, "complements">): string | null {
  return complementNamed(m, "situacao_da_audiencia");
}

const DECISION_PREFIXES = [
  "procedencia",
  "improcedencia",
  "homologacao",
  "acolhimento",
  "nao acolhimento",
  "rejeicao",
  "provimento",
  "nao-provimento",
  "nao provimento",
  "extincao",
  "julgamento",
];

export function eventTypeFor(m: Pick<CourtMovement, "code" | "name" | "complements">): ProcessEventType {
  const name = normalizeText(m.name);
  if (m.code === 26 || name.startsWith("distribuicao") || name.startsWith("redistribuicao")) return "filing";
  if (hearingSituation(m) !== null || m.code === 12747 || m.code === 12749 || name.includes("audiencia")) return "hearing";
  if (m.code === 85 || name.startsWith("peticao")) return "petition";
  if (m.code === 92 || m.code === 1061 || name.startsWith("publicacao") || name.startsWith("disponibilizacao")) {
    return "publication";
  }
  if (m.code === 221 || DECISION_PREFIXES.some((p) => name.startsWith(p))) return "decision";
  return "other";
}

/** Unambiguous phase changes by movement name (forward only; see `PHASE_RANK`). */
const PHASE_BY_NAME: Readonly<Record<string, ProcessPhase>> = {
  "liquidacao iniciada": "liquidation",
  "execucao iniciada": "enforcement",
  "iniciada a execucao": "enforcement",
  "inicio da execucao": "enforcement",
  "cumprimento de sentenca iniciado": "enforcement",
  "inicio do cumprimento de sentenca": "enforcement",
};

export function phaseTargetFor(m: Pick<CourtMovement, "name">): ProcessPhase | null {
  return PHASE_BY_NAME[normalizeText(m.name)] ?? null;
}

/**
 * Order used for the forward-only rule (conhecimento → liquidação → execução).
 * Phase and instance are distinct axes (P0.5): a remessa em grau de recurso
 * moves the instance, never the phase. A stored value outside the three phases
 * (legacy data) is never changed automatically.
 */
export const PHASE_RANK: Readonly<Record<ProcessPhase, number>> = {
  knowledge: 1,
  liquidation: 2,
  enforcement: 3,
};

/** Whether moving from `current` to `target` is an allowed automatic (forward) change. */
export function isForwardPhaseChange(current: string, target: ProcessPhase): boolean {
  const from = (PHASE_RANK as Readonly<Record<string, number>>)[current];
  const to = PHASE_RANK[target];
  if (from === undefined || to === undefined) return false;
  return to > from;
}

/** "Remessa" with motivo "em grau de recurso": the case went up one level. */
export function isRemessaEmGrauDeRecurso(m: Pick<CourtMovement, "name" | "complements">): boolean {
  if (!normalizeText(m.name).startsWith("remessa")) return false;
  return m.complements.some((c) => normalizeText(c.name).includes("em grau de recurso"));
}

export type RelevantKind = "transito" | "baixa" | "arquivamento" | "extincao";

export const RELEVANT_KIND_LABELS: Record<RelevantKind, string> = {
  transito: "Trânsito em julgado",
  baixa: "Baixa definitiva",
  arquivamento: "Arquivamento",
  extincao: "Extinção",
};

/** Movements that may mean the case is ending: alert + verification, never an automatic closure. */
export function relevantKind(m: Pick<CourtMovement, "name">): RelevantKind | null {
  const name = normalizeText(m.name);
  if (name.startsWith("transito em julgado")) return "transito";
  if (name.startsWith("baixa definitiva")) return "baixa";
  if (/(^|[^a-z])(arquivamento|arquivado|arquivados)([^a-z]|$)/.test(name)) return "arquivamento";
  if (name.startsWith("extincao")) return "extincao";
  return null;
}

/** Relevant kinds that end the case in a grau (a trânsito em julgado is usually followed by liquidation). */
export const CLOSURE_KINDS: ReadonlySet<RelevantKind> = new Set<RelevantKind>(["baixa", "arquivamento", "extincao"]);

const REOPENING_PREFIXES = [
  "desarquivamento",
  "desarquivado",
  "reativacao",
  "processo reativado",
  "recebimento",
  "recebidos os autos",
  "distribuicao",
  "redistribuicao",
  "remessa",
];

/**
 * Movements that show the case going on after a baixa/arquivamento/extinção:
 * unarchiving, reactivation, records received back, (re)distribution, remessa,
 * a phase change (liquidation, enforcement) or a hearing designated. Routine
 * movements (petição, conclusão, publicação, expedição) do not count.
 */
export function reopensCase(m: Pick<CourtMovement, "name" | "complements">): boolean {
  const name = normalizeText(m.name);
  if (REOPENING_PREFIXES.some((p) => name.startsWith(p))) return true;
  if (phaseTargetFor(m) !== null) return true;
  return hearingSituation(m) === "designada";
}

const UFS = new Set([
  "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG", "PA", "PB",
  "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC", "SE", "SP", "TO",
]);

/**
 * City and UF from an órgão julgador name, ONLY when it clearly ends with
 * "de <Cidade> - <UF>" right after the court type:
 *   "21ª Vara do Trabalho de Brasília - DF"      -> Brasília / DF
 *   "1ª Vara do Trabalho do Rio de Janeiro - RJ" -> Rio de Janeiro / RJ
 *   "2ª Vara Cível de Campinas - SP"             -> Campinas / SP
 * Anything else (turmas, gabinetes, CEJUSC, "Vara de Família de ...") -> null.
 */
export function parseCityState(divisionName: string | null | undefined): { city: string; state: string } | null {
  const name = (divisionName ?? "").replace(/\s+/g, " ").trim();
  const m =
    /^(?:\d+[ªºa]?\s+)?Vara do Trabalho (?:de|do|da|dos|das) (.+?) - ([A-Z]{2})$/u.exec(name) ??
    /^(?:\d+[ªºa]?\s+)?Vara (?:Cível|Civel|Criminal|Única|Unica|Federal|Mista) (?:de|do|da|dos|das) (.+?) - ([A-Z]{2})$/u.exec(name);
  if (!m) return null;
  const city = m[1].trim();
  const state = m[2];
  if (!UFS.has(state)) return null;
  if (city.length < 2 || city.length > 60 || /\d|-|\bvara\b/i.test(city)) return null;
  return { city, state };
}

/** Accent/case-insensitive comparison used to detect divergences. */
export function sameText(a: string | null | undefined, b: string | null | undefined): boolean {
  return normalizeText(a) === normalizeText(b);
}

/** "TRT-10", "trt10", "TRT 10" -> "TRT10". */
export function courtKey(value: string | null | undefined): string {
  return normalizeText(value).replace(/[^a-z0-9]/g, "").toUpperCase();
}

// ---------------------------------------------------------------------------
// Divergence detection (record vs. tribunal): tolerant to spelling, never to content
// ---------------------------------------------------------------------------

/** Lower case, no accents, no punctuation, no ordinal marks ("21ª" -> "21"). */
function plainWords(value: string | null | undefined): string[] {
  return normalizeText(value)
    .replace(/[ªº°]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map((w) => w.replace(/^(\d+)[ao]$/, "$1"));
}

const WORD_ABBREVIATIONS: Readonly<Record<string, string[]>> = {
  vt: ["vara", "trabalho"],
  jt: ["justica", "trabalho"],
  trib: ["tribunal"],
};
const STOP_WORDS = new Set(["de", "do", "da", "dos", "das", "e", "em", "a", "o"]);

function descriptiveTokens(value: string | null | undefined): string[] {
  return plainWords(value)
    .flatMap((w) => WORD_ABBREVIATIONS[w] ?? [w])
    .filter((w) => !STOP_WORDS.has(w));
}

/**
 * Whether two descriptive names (órgão julgador, classe) say the same thing:
 * equal after normalization, or one is the other with fewer words
 * ("21ª VT de Brasília" vs "21ª Vara do Trabalho de Brasília - DF").
 * Different numbers or words are a divergence ("2ª Vara" vs "21ª Vara").
 */
export function sameDescriptive(a: string | null | undefined, b: string | null | undefined): boolean {
  const ta = descriptiveTokens(a);
  const tb = descriptiveTokens(b);
  if (ta.length === 0 || tb.length === 0) return true; // nothing to compare
  if (ta.join(" ") === tb.join(" ")) return true;
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  if (short.length < 2) return false;
  const pool = new Set(long);
  return short.every((w) => pool.has(w));
}

/** Official acronyms of labor classes (PJe) as written in spreadsheets. */
const CLASS_ACRONYMS: Readonly<Record<string, string>> = {
  atord: "Ação Trabalhista - Rito Ordinário",
  atsum: "Ação Trabalhista - Rito Sumaríssimo",
  rot: "Recurso Ordinário Trabalhista",
  rorsum: "Recurso Ordinário - Rito Sumaríssimo",
  airr: "Agravo de Instrumento em Recurso de Revista",
  airo: "Agravo de Instrumento em Recurso Ordinário",
  rr: "Recurso de Revista",
  ap: "Agravo de Petição",
  cumsen: "Cumprimento de Sentença",
};

/** Same as `sameDescriptive`, also accepting the class acronym ("ATOrd" = "Ação Trabalhista - Rito Ordinário"). */
export function sameProcessClass(a: string | null | undefined, b: string | null | undefined): boolean {
  const expand = (v: string | null | undefined) => CLASS_ACRONYMS[plainWords(v).join("")] ?? v;
  return sameDescriptive(expand(a), expand(b));
}

/**
 * Court acronym in a comparable form ("TRT da 10ª Região", "TRT-10", "trt10"
 * -> "TRT10"; "TJ-SP" -> "TJSP"). Null when the text is not an acronym we can
 * read (then no divergence is claimed).
 */
export function canonicalCourt(value: string | null | undefined): string | null {
  const text = plainWords(value).join(" ");
  const regional = /^(trt|trf|tre)\s*(?:da\s+)?(\d{1,2})(?:\s+regiao)?$/.exec(text);
  if (regional) return `${regional[1].toUpperCase()}${Number(regional[2])}`;
  const compact = text.replace(/\s+/g, "");
  if (/^(tst|stj|stf|tse|stm|tjdft|tjm[a-z]{2}|tj[a-z]{2})$/.test(compact)) return compact.toUpperCase();
  return null;
}

/** Courts differ only when both are readable acronyms and they are not the same. */
export function courtsDiffer(a: string | null | undefined, b: string | null | undefined): boolean {
  const ca = canonicalCourt(a);
  const cb = canonicalCourt(b);
  return ca !== null && cb !== null && ca !== cb;
}

// ---------------------------------------------------------------------------
// Verification note (shared with people: their text is never cut)
// ---------------------------------------------------------------------------

/** Prefix of every line the DataJud collection writes in the verification note. */
export const DATAJUD_NOTE_PREFIX = "[DataJud]";

/**
 * Appends DataJud lines to the verification note within `max` characters.
 * When it does not fit, the OLDEST DataJud lines go first; text written by a
 * person (any line without the prefix) is never removed or cut. If the
 * person's text alone leaves too little room, only the newest line is
 * shortened (or left out; the process stays marked for verification).
 */
export function mergeVerificationNote(current: string | null | undefined, additions: string[], max: number): string {
  const lines = [...(current ? current.split("\n") : []), ...additions];
  const isAuto = (line: string) => line.startsWith(DATAJUD_NOTE_PREFIX);
  const size = () => lines.join("\n").length;
  while (size() > max) {
    const i = lines.findIndex((line, idx) => isAuto(line) && idx < lines.length - 1);
    if (i < 0) break;
    lines.splice(i, 1);
  }
  if (size() <= max || additions.length === 0 || !isAuto(lines[lines.length - 1] ?? "")) return lines.join("\n");
  const newest = lines.pop() as string;
  const head = lines.join("\n");
  const room = max - head.length - (head ? 1 : 0);
  return room >= 40 ? [head, `${newest.slice(0, room - 1)}…`].filter(Boolean).join("\n") : head;
}
