/**
 * Parser puro da planilha da carteira (RF-02). Sem I/O: recebe as abas já
 * lidas (`RawSheet[]`, ver `./xlsx.ts`) e devolve linhas normalizadas com as
 * inconsistências encontradas. Tudo aqui é determinístico e testado em
 * `tests/imports/parser.test.ts`.
 *
 * Regras documentadas (requisitos RN-01, RN-03, RN-08, RN-09):
 *
 * Abas
 *   - "Dashboard"/painel/resumo e registros narrativos ("Atualização Geral …")
 *     são ignorados (com nota). A data no nome da aba de atualização vira apenas
 *     uma SUGESTÃO de data-base dos valores — o usuário confirma ou altera.
 *   - "Consolidado …" = base consolidada; "1º/2º/3º Grau", "TST" = abas por instância.
 *   - O cabeçalho é localizado pelas primeiras 30 linhas (sinônimos de coluna);
 *     sem coluna de número do processo a aba é ignorada.
 *
 * Linhas
 *   - Linhas em branco são puladas. Linhas "TOTAL" são ignoradas (informativo) e
 *     a leitura CONTINUA depois delas; as linhas abaixo de um TOTAL recebem um
 *     aviso informativo para conferência.
 *
 * Número CNJ (`@/domain/cnj`)
 *   - Sem 20 dígitos = linha com erro (não importada).
 *   - Dígito verificador que não confere = alerta "conferir". O número NUNCA é corrigido.
 *
 * Tribunal: "TRT 10", "TRT-10", "TRT da 10ª Região" → "TRT10"; "TST". Vazio →
 *   derivado do número CNJ (segmento 5) quando possível, com aviso.
 *
 * Instância: da célula ("1º Grau", "2º Grau", "3º Grau (TST)", "TST") ou, na falta
 *   dela, da aba. Divergência célula × aba gera alerta (vale a célula).
 *
 * Cidade/UF: "Palmas - TO", "Palmas/TO", "Brasília/DF" → cidade + UF. Cidade sem
 *   UF recebe a UF somente quando a MESMA cidade aparece com UF em outra linha do
 *   arquivo (derivação a partir dos dados, informada). Valores que não são
 *   municípios ("Cejusc Digital", "Secretaria de Cálculos Judiciais", "Vara do
 *   Trabalho do Gama - DF") → cidade vazia + alerta (a UF explícita é mantida).
 *
 * Valores: números ou texto "R$ 1.234,56" → centavos. Vazio = não informado
 *   (null) e 0 continua 0 (RN-03).
 *
 * Fase (`parsePhase`), aplicada nesta ordem:
 *   1. Contém "VERIFICAR", "conferir" ou "Saiu do acervo" → marcado para
 *      verificação, com nota, e NENHUM encerramento automático.
 *   2. "PAGO", "satisfação", "quitação" → encerrado (pago/extinto).
 *      "ARQUIVADO def." / "arquivado definitivamente" → encerrado (arquivado).
 *      "Arquivado"/"Arquivados" sem "definitivo" ou "extinto" sem pagamento →
 *      verificação, sem encerramento. A data do texto vira a data de encerramento.
 *   3. "baixou"/"baixado"/"retornou ao 1º grau" → a instância DAQUELA linha foi
 *      baixada (não é a instância atual).
 *   4. Fase e instância são eixos distintos (P0.5). A FASE vem só dos termos
 *      Conhecimento / Liquidação / Execução (ou Cumprimento): primeiro o termo
 *      inicial, depois o termo em qualquer posição. Encerramento não é fase.
 *   5. Termos recursais (recurso, recursal, agravo, ROT/ROR, AIRO → 2º grau;
 *      TST, recurso de revista, RR, AIRR → 3º grau) indicam a INSTÂNCIA, nunca a
 *      fase. Sem efeito quando a linha foi baixada (o recurso já voltou) ou pede
 *      verificação. Menções que negam o recurso ou falam só do prazo ("sem
 *      recurso", "não houve recurso", "recurso não interposto", "prazo recursal",
 *      "prazo para recurso") não contam. A instância indicada preenche a
 *      instância da linha quando a célula e a aba não a informam, com alerta
 *      (`instance_from_phase`) e o processo marcado para verificação.
 *   6. Texto sem termo de fase, recursal ou de encerramento → não reconhecido (alerta).
 *
 * Linhas gravadas antes da P0.5 (`import_rows.normalized` de lotes analisados e
 *   ainda não confirmados) podem ter a fase do modelo anterior ("appeal",
 *   "closed"...): `normalizeStoredPhase` refaz a leitura a partir do texto da
 *   célula, com as regras acima, antes do plano.
 *
 * Partes: "(e outros)" é retirado do nome e vira nota. A parte cujo nome
 *   corresponde ao da empresa selecionada (sem diferenciar maiúsculas, espaços,
 *   pontuação ou acentos) é marcada como cliente. "Ministério Público do
 *   Trabalho"/"MPT" recebe o papel Ministério Público.
 *
 * Área: trabalhista quando o segmento do número CNJ é 5 (derivado do número).
 */
import { isProcessPhase, type ClosureReason, type IssueLevel, type LegalArea, type PartyRole, type ProcessInstance, type ProcessPhase } from "@/domain/enums";
import { isValidCnj, laborCourtFromCnj, normalizeCnj, parseCnj } from "@/domain/cnj";
import { parseMoneyToCents } from "@/lib/format";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RawCell = string | number | boolean | Date | null | undefined;
export type RawSheet = { name: string; rows: RawCell[][] };

export type CanonicalField =
  | "instance"
  | "court"
  | "number"
  | "plaintiff"
  | "defendant"
  | "city"
  | "courtDivision"
  | "processClass"
  | "phase"
  | "claimAmount"
  | "liquidatedAmount";

export const CANONICAL_FIELDS: readonly CanonicalField[] = [
  "instance",
  "court",
  "number",
  "plaintiff",
  "defendant",
  "city",
  "courtDivision",
  "processClass",
  "phase",
  "claimAmount",
  "liquidatedAmount",
];

/** Same shape as `ImportIssue` in the schema (kept here so this module stays client-safe and I/O free). */
export type ParsedIssue = { level: IssueLevel; code: string; field: string | null; message: string };

export type SheetRole = "consolidated" | "instance" | "ignored";

export type ParsedSheet = {
  name: string;
  role: SheetRole;
  instance: ProcessInstance | null;
  /** 1-based header row, null when not found. */
  headerRow: number | null;
  /** Non-blank rows below the header (data + TOTAL rows). */
  rowCount: number;
  note: string | null;
  /** canonical field -> header text as found in the file. */
  mapping: Partial<Record<CanonicalField, string>>;
};

export type PhaseParse = {
  /** Conhecimento / liquidação / execução, só pelos termos de fase (nunca por termos recursais). */
  phase: ProcessPhase | null;
  /** Instância indicada pelos termos recursais do texto (2º / 3º grau); null sem termo recursal ou quando a linha foi baixada. */
  instance: ProcessInstance | null;
  closed: boolean;
  closureReason: ClosureReason | null;
  /** "YYYY-MM-DD" found in the text of a closed phase. */
  closedAt: string | null;
  /** The instance of this row was left ("baixou à origem"). */
  returned: boolean;
  /** The text says the records were sent to the superior instance ("remetidos ao TST", "RR interposto"). */
  forwarded: boolean;
  needsVerification: boolean;
  verificationNote: string | null;
  /** Raw text from the cell (kept for conferência). */
  detail: string | null;
  recognized: boolean;
};

export type PartyParse = {
  name: string;
  role: PartyRole;
  /** "(e outros)" was removed from the name. */
  hasOthers: boolean;
  isClient: boolean;
};

export type NormalizedRow = {
  /** Normalized CNJ (NNNNNNN-DD.AAAA.J.TR.OOOO) or null when it could not be normalized. */
  cnj: string | null;
  cnjRaw: string | null;
  cnjValid: boolean;
  instance: ProcessInstance | null;
  /**
   * The instance came from the appeal terms of the Fase text (no Instância cell, no instance sheet):
   * the plan marks the process for verification. Absent in rows stored before P0.5 (= false).
   */
  instanceFromPhase?: boolean;
  court: string | null;
  courtDivision: string | null;
  processClass: string | null;
  city: string | null;
  state: string | null;
  phase: PhaseParse;
  claimAmountCents: number | null;
  liquidatedAmountCents: number | null;
  /** The sheet has a "valor liquidado" column (an empty cell then means "não apurado"). */
  hasLiquidatedColumn: boolean;
  /** Canonical fields present in the sheet header (a missing column is not compared across sheets). */
  presentFields: CanonicalField[];
  plaintiff: PartyParse | null;
  defendant: PartyParse | null;
  area: LegalArea;
  /** The row comes after a TOTAL row of the same sheet. */
  afterTotal: boolean;
};

export type ParsedRow = {
  sheet: string;
  sheetRole: "consolidated" | "instance";
  sheetInstance: ProcessInstance | null;
  /** 1-based row number as shown by spreadsheet software. */
  rowNumber: number;
  kind: "data" | "total";
  /** Cell values keyed by header text. */
  raw: Record<string, string | number | boolean | null>;
  /** Null for TOTAL rows. */
  data: NormalizedRow | null;
  issues: ParsedIssue[];
  /** Row cannot be imported (error-level issue). */
  error: boolean;
};

export type BaseDateHint = { date: string; source: string };

export type ParsedWorkbook = {
  sheets: ParsedSheet[];
  rows: ParsedRow[];
  baseDateHint: BaseDateHint | null;
  /** Rows where a party matched the selected company. */
  clientMatches: number;
};

export type ParseOptions = {
  /** Name of the selected company (client). Null disables client detection. */
  clientName: string | null;
};

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/** Lower case, no accents, ordinal marks removed, punctuation collapsed to single spaces. */
export function normalizeKey(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/r\$/g, " ")
    .replace(/[º°ª]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Trimmed text with collapsed whitespace; empty -> null. */
export function cleanText(value: RawCell): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const t = value.replace(/\s+/g, " ").trim();
    return t === "" ? null : t;
  }
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value === "boolean") return value ? "VERDADEIRO" : "FALSO";
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  return String(value);
}

function rawValue(value: RawCell): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  if (typeof value === "string") return value === "" ? null : value;
  return value;
}

function isBlankRow(row: RawCell[]): boolean {
  return row.every((c) => cleanText(c) === null);
}

function truncateText(value: string | null, max: number): string | null {
  if (value === null) return null;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

const MONEY_FMT = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
/** "R$ 1.234,56" with a regular space (for messages stored in the database). */
export function formatCentsPlain(cents: number | null): string {
  if (cents === null) return "não informado";
  return MONEY_FMT.format(cents / 100).replace(/\s/g, " ");
}

// ---------------------------------------------------------------------------
// Header detection
// ---------------------------------------------------------------------------

/** Header synonyms (already normalized with `normalizeKey`). */
export const HEADER_SYNONYMS: Record<CanonicalField, readonly string[]> = {
  instance: ["instancia", "grau", "instancia grau", "grau de jurisdicao", "instancia atual"],
  court: ["trt tribunal", "tribunal", "trt", "tribunal trt", "orgao tribunal", "tribunal regional"],
  number: [
    "n do processo",
    "no do processo",
    "numero do processo",
    "num do processo",
    "n processo",
    "numero processo",
    "processo",
    "numero cnj",
    "processo cnj",
    "cnj",
  ],
  plaintiff: ["parte autora", "autor", "autora", "autor a", "reclamante", "polo ativo", "requerente", "exequente"],
  defendant: [
    "parte re",
    "parte reu",
    "reu",
    "re",
    "reclamada",
    "reclamado",
    "polo passivo",
    "requerido",
    "requerida",
    "executado",
    "executada",
  ],
  city: ["cidade", "municipio", "comarca", "cidade uf", "municipio uf", "localidade"],
  courtDivision: [
    "vara orgao julgador turma",
    "vara orgao julgador",
    "orgao julgador",
    "vara",
    "turma",
    "orgao",
    "juizo",
  ],
  processClass: ["classe", "classe processual", "classe judicial"],
  phase: ["fase", "fase processual", "fase atual", "situacao", "status"],
  claimAmount: ["valor da causa", "valor causa", "vl causa", "vl da causa", "valor da acao"],
  liquidatedAmount: [
    "valor liquidado apurado 1 grau",
    "valor liquidado apurado",
    "valor liquidado",
    "valor apurado",
    "liquidado",
    "vl liquidado",
  ],
};

/** Canonical field for a header cell, or null. Exact synonym first, then the longest synonym the header starts with. */
export function matchHeader(header: string | null): CanonicalField | null {
  const key = normalizeKey(header);
  if (!key) return null;
  for (const field of CANONICAL_FIELDS) {
    if (HEADER_SYNONYMS[field].includes(key)) return field;
  }
  let best: { field: CanonicalField; length: number } | null = null;
  for (const field of CANONICAL_FIELDS) {
    for (const syn of HEADER_SYNONYMS[field]) {
      if (syn.length >= 3 && key.startsWith(`${syn} `) && (!best || syn.length > best.length)) {
        best = { field, length: syn.length };
      }
    }
  }
  return best?.field ?? null;
}

export type HeaderDetection = {
  headerRow: number;
  /** canonical field -> column index */
  columns: Partial<Record<CanonicalField, number>>;
  mapping: Partial<Record<CanonicalField, string>>;
  headers: (string | null)[];
};

/** Finds the header row among the first 30 rows: needs the number column and at least 3 known columns. */
export function detectHeader(rows: RawCell[][]): HeaderDetection | null {
  const limit = Math.min(rows.length, 30);
  for (let i = 0; i < limit; i++) {
    const headers = rows[i].map((c) => cleanText(c));
    const columns: Partial<Record<CanonicalField, number>> = {};
    const mapping: Partial<Record<CanonicalField, string>> = {};
    headers.forEach((h, idx) => {
      const field = matchHeader(h);
      if (field && columns[field] === undefined && h) {
        columns[field] = idx;
        mapping[field] = h;
      }
    });
    if (columns.number !== undefined && Object.keys(columns).length >= 3) {
      return { headerRow: i + 1, columns, mapping, headers };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Sheet roles
// ---------------------------------------------------------------------------

export type SheetClassification = { role: SheetRole; instance: ProcessInstance | null; note: string | null } | null;

/** Role suggested by the sheet name (null = unknown name). */
export function classifySheetName(name: string): SheetClassification {
  const key = normalizeKey(name);
  if (/\b(dashboard|painel|resumo|grafico|graficos|indicadores|sumario)\b/.test(key)) {
    return {
      role: "ignored",
      instance: null,
      note: "Aba de resumo (painel) ignorada: não contém linhas de processos.",
    };
  }
  if (/\b(atualizacao|atualizacoes|historico|log|observacoes|notas|anotacoes|revisao)\b/.test(key)) {
    return {
      role: "ignored",
      instance: null,
      note: "Registro narrativo de atualização, ignorado para as linhas de processos.",
    };
  }
  if (/\bconsolidad/.test(key)) return { role: "consolidated", instance: null, note: null };
  if (/\b(3|terceiro)\s*(grau|instancia)\b|\btst\b|\bsuperior\b/.test(key)) {
    return { role: "instance", instance: "superior", note: null };
  }
  if (/\b(2|segundo)\s*(grau|instancia)\b/.test(key)) return { role: "instance", instance: "second", note: null };
  if (/\b(1|primeiro)\s*(grau|instancia)\b/.test(key)) return { role: "instance", instance: "first", note: null };
  return null;
}

// ---------------------------------------------------------------------------
// Field normalizers
// ---------------------------------------------------------------------------

/** "1º Grau" -> first, "2º Grau" -> second, "3º Grau (TST)"/"TST" -> superior. */
export function parseInstance(value: string | null): ProcessInstance | null {
  const key = normalizeKey(value);
  if (!key) return null;
  if (/\b(tst|stj|stf)\b|superior|\b3\s*(grau|instancia)\b|terceiro/.test(key)) return "superior";
  if (/\b2\s*(grau|instancia)\b|segundo/.test(key)) return "second";
  if (/\b1\s*(grau|instancia)\b|primeiro/.test(key)) return "first";
  return null;
}

/** "TRT 10" / "TRT-10" / "TRT da 10ª Região" -> "TRT10"; "TST"; other values kept as informed. */
export function normalizeCourt(value: string | null): string | null {
  const text = value?.replace(/\s+/g, " ").trim();
  if (!text) return null;
  const key = normalizeKey(text);
  const trt =
    /^trt\s*(?:da\s*)?(\d{1,2})(?:\s*regiao)?$/.exec(key) ??
    /^tribunal regional do trabalho (?:da )?(\d{1,2})(?: regiao)?$/.exec(key);
  if (trt) return `TRT${Number(trt[1])}`;
  if (key === "tst" || key === "tribunal superior do trabalho") return "TST";
  const trf = /^trf\s*(\d)(?:\s*regiao)?$/.exec(key);
  if (trf) return `TRF${trf[1]}`;
  const tj = /^tj\s*([a-z]{2})$/.exec(key);
  if (tj && UFS.includes(tj[1].toUpperCase())) return `TJ${tj[1].toUpperCase()}`;
  if (["stj", "stf", "tse"].includes(key)) return key.toUpperCase();
  return text.slice(0, 120);
}

export const UFS: readonly string[] = [
  "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG", "PA",
  "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO",
];

const NON_GEOGRAPHIC =
  /\b(vara|varas|cejusc|secretaria|nucleo|juizo|juizado|gabinete|turma|tribunal|forum|posto|centro judiciario|justica 4 0|sentencas|calculos|digital|distribuicao|central|orgao|cartorio)\b/;

export type CityParse = {
  city: string | null;
  state: string | null;
  kind: "city" | "non_geographic" | "ambiguous" | "empty";
  raw: string | null;
};

/** "Palmas - TO", "Palmas/TO", "Palmas (TO)" -> Palmas + TO. Non-city values -> city null. */
export function parseCityCell(value: string | null): CityParse {
  const raw = value?.replace(/\s+/g, " ").trim() || null;
  if (!raw) return { city: null, state: null, kind: "empty", raw: null };
  let city = raw;
  let state: string | null = null;
  const withUf = /^(.*?)\s*(?:[-–—/,]\s*([A-Za-z]{2})|\(\s*([A-Za-z]{2})\s*\))$/.exec(raw);
  const uf = withUf ? (withUf[2] ?? withUf[3]).toUpperCase() : null;
  if (withUf && uf && UFS.includes(uf)) {
    city = withUf[1].trim();
    state = uf;
  }
  if (NON_GEOGRAPHIC.test(normalizeKey(city))) return { city: null, state, kind: "non_geographic", raw };
  if (/[/;]|\s+e\s+/.test(city) && !state) return { city: null, state: null, kind: "ambiguous", raw };
  if (!city) return { city: null, state, kind: state ? "city" : "empty", raw };
  return { city: city.slice(0, 120), state, kind: "city", raw };
}

export type MoneyParse = { cents: number | null; issue: Omit<ParsedIssue, "field"> | null };

const EMPTY_MONEY = /^(|-|n a|na|nao informado|nao apurado|sem valor|nihil|x)$/;

/** Number cell or "R$ 1.234,56" -> integer cents. Empty -> null (not zero, RN-03). */
export function parseMoneyCell(value: RawCell): MoneyParse {
  if (value === null || value === undefined) return { cents: null, issue: null };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return { cents: null, issue: { level: "warning", code: "money_unrecognized", message: "Valor numérico inválido, tratado como não informado." } };
    }
    if (value < 0) {
      return {
        cents: null,
        issue: { level: "warning", code: "money_negative", message: `Valor negativo (${value}), tratado como não informado; conferir.` },
      };
    }
    return { cents: Math.round(value * 100), issue: null };
  }
  if (typeof value === "string") {
    const text = value.replace(/\s+/g, " ").trim();
    const key = normalizeKey(text);
    if (text === "" || /^[-–—]+$/.test(text) || EMPTY_MONEY.test(key)) return { cents: null, issue: null };
    const cents = parseMoneyToCents(text);
    if (cents === null) {
      return {
        cents: null,
        issue: { level: "warning", code: "money_unrecognized", message: `Valor não reconhecido ("${truncateText(text, 40)}"), tratado como não informado.` },
      };
    }
    if (cents < 0) {
      return {
        cents: null,
        issue: { level: "warning", code: "money_negative", message: `Valor negativo ("${truncateText(text, 40)}"), tratado como não informado; conferir.` },
      };
    }
    return { cents, issue: null };
  }
  return {
    cents: null,
    issue: { level: "warning", code: "money_unrecognized", message: "Célula de valor com conteúdo não numérico, tratada como não informada." },
  };
}

/** First valid date in the text ("2026-06-25" or "25/06/2026"), as "YYYY-MM-DD". */
function extractDate(text: string): string | null {
  const found: { index: number; date: string | null }[] = [];
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text);
  if (iso) found.push({ index: iso.index, date: isoDateOrNull(iso[1], iso[2], iso[3]) });
  const br = /\b(\d{2})\/(\d{2})\/(\d{4})\b/.exec(text);
  if (br) found.push({ index: br.index, date: isoDateOrNull(br[3], br[2], br[1]) });
  found.sort((a, b) => a.index - b.index);
  return found.find((f) => f.date !== null)?.date ?? null;
}

function isoDateOrNull(y: string, m: string, d: string): string | null {
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1) return null;
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) return null;
  return `${y.padStart(4, "0")}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

/** Termos recursais: indicam a INSTÂNCIA em que o processo tramita, nunca a fase (P0.5). */
const APPEAL_TERMS = /\b(recurso|recursos|recursal|agravo|airr|rr|rrag|airo|rot|ror|rorsum|tst|revista)\b/;
/** Termos do 3º grau (TST): recurso de revista e o agravo de instrumento em recurso de revista. */
const SUPERIOR_TERMS = /\b(airr|rr|rrag|tst|revista)\b/;
/**
 * Menções que NÃO indicam recurso em andamento (texto já normalizado por `normalizeKey`): recurso
 * negado ("sem recurso", "não houve recurso", "recurso não interposto") ou só o prazo ("prazo
 * recursal", "prazo para recurso"). São retiradas do texto antes de procurar os termos recursais.
 */
const NON_APPEAL_MENTIONS = new RegExp(
  [
    String.raw`\b(sem|nao houve|nao ha|nao foi interposto|nao interpos|ausencia de|inexistencia de)( (a|o|interposicao de|qualquer))? (recursos?|agravos?)\b`,
    String.raw`\b(recursos?|agravos?) nao (interpost[oa]s?|apresentad[oa]s?)\b`,
    String.raw`\bprazos? (recursal|recursais|(para|de) (o |a )?(interposicao de )?(recursos?|recorrer|agravo))\b`,
  ].join("|"),
  "g",
);

/** Composite "Fase" text -> phase, instance (appeal terms), closure, returned/forwarded flags and verification note (rules in the header comment). */
export function parsePhase(value: string | null): PhaseParse {
  const detail = value?.replace(/\s+/g, " ").trim() || null;
  const base: PhaseParse = {
    phase: null,
    instance: null,
    closed: false,
    closureReason: null,
    closedAt: null,
    returned: false,
    forwarded: false,
    needsVerification: false,
    verificationNote: null,
    detail,
    recognized: false,
  };
  if (!detail) return base;
  const key = normalizeKey(detail);
  const leadText = detail.split(/\s[—–-]\s|[(;:]/)[0] ?? detail;
  const lead = normalizeKey(leadText);

  const notes: string[] = [];
  const verify = /\bverificar\b|\bconferir\b|saiu do acervo/.test(key);
  if (verify) notes.push(`Planilha pede conferência: "${truncateText(detail, 200)}"`);

  const paid = /\bpago\b|\bpaga\b|satisfacao|\bquitad[oa]s?\b|\bquitacao\b/.test(key);
  const archivedDefinitive = /\barquivad[oa]s?\s+(def|definitiv)|\barquivamento definitivo\b/.test(key);
  const archivedOther = /\barquivad[oa]s?\b|\barquivamento\b/.test(key);
  const extinct = /\bextint[oa]s?\b/.test(key);

  let closed = false;
  let closureReason: ClosureReason | null = null;
  if (!verify) {
    if (paid) {
      closed = true;
      closureReason = "paid_extinct";
    } else if (archivedDefinitive) {
      closed = true;
      closureReason = "archived";
    } else if (archivedOther) {
      notes.push(`Arquivamento sem indicação de "definitivo"; conferir: "${truncateText(detail, 200)}"`);
    } else if (extinct) {
      notes.push(`Extinção sem indicação de pagamento; conferir o motivo: "${truncateText(detail, 200)}"`);
    }
  }

  const returned = /\bbaix(ou|ado|ada|ados|adas)\b|\bretornou (ao|a) (1|primeiro|origem)|\bdevolvid[oa]s? (a|ao) origem/.test(key);
  const forwarded =
    !returned && /\bremetid[oa]s? ao tst\b|\brumo ao tst\b|\b(rr|recurso de revista) interposto\b/.test(key);

  // Phase: only Conhecimento / Liquidação / Execução terms (lead term first, then anywhere).
  let phase: ProcessPhase | null = null;
  if (/^(execucao|execucoes|cumprimento)\b/.test(lead)) phase = "enforcement";
  else if (/^liquidacao\b/.test(lead)) phase = "liquidation";
  else if (/^conhecimento\b/.test(lead)) phase = "knowledge";
  else if (/\bexecucao\b/.test(key)) phase = "enforcement";
  else if (/\bliquidacao\b/.test(key)) phase = "liquidation";
  else if (/\bconhecimento\b/.test(key)) phase = "knowledge";

  // Instance: appeal terms (never a phase), ignoring "sem recurso" / "prazo recursal". A returned row
  // ("baixou") or a row to verify gives none.
  const appealKey = key.replace(NON_APPEAL_MENTIONS, " ");
  const appeal = APPEAL_TERMS.test(appealKey);
  const instance: ProcessInstance | null =
    appeal && !returned && !verify ? (SUPERIOR_TERMS.test(appealKey) ? "superior" : "second") : null;

  const needsVerification = notes.length > 0;
  return {
    phase,
    instance,
    closed,
    closureReason,
    closedAt: closed ? extractDate(detail) : null,
    returned,
    forwarded,
    needsVerification,
    verificationNote: needsVerification ? notes.join(" · ") : null,
    detail,
    recognized: phase !== null || appeal || closed,
  };
}

/**
 * Phase parse of a row stored in `import_rows.normalized`. Rows analyzed before P0.5 hold a phase
 * of the previous model ("appeal", "closed"...) and no `instance`: the parse is redone from the
 * stored cell text with the current rules (phase, appeal instance, closure). A current parse is
 * returned as is.
 */
export function normalizeStoredPhase(stored: PhaseParse | null | undefined): PhaseParse {
  if (!stored) return parsePhase(null);
  const legacy = stored.instance === undefined || (stored.phase !== null && stored.phase !== undefined && !isProcessPhase(stored.phase));
  return legacy ? parsePhase(stored.detail ?? null) : stored;
}

const OTHERS_SUFFIX = /\s*\(?\s*\b(e|and)\s+outr[oa]s?\b\s*\)?\s*\.?$/i;
const PUBLIC_PROSECUTOR = /^(ministerio publico do trabalho|ministerio publico federal|ministerio publico|mpt|mpf|procuradoria regional do trabalho)\b/;

/** Normalized party name for comparisons (case, accents, punctuation and spaces ignored). */
export function partyKey(name: string | null | undefined): string {
  return normalizeKey(name);
}

/** "EMPRESA X LTDA e outros" -> { name: "EMPRESA X LTDA", hasOthers: true }. */
export function parsePartyCell(value: string | null, side: "plaintiff" | "defendant", clientName: string | null): PartyParse | null {
  const text = value?.replace(/\s+/g, " ").trim();
  if (!text) return null;
  const hasOthers = OTHERS_SUFFIX.test(text);
  const name = (hasOthers ? text.replace(OTHERS_SUFFIX, "") : text).trim().slice(0, 300);
  if (!name) return null;
  const key = partyKey(name);
  const role: PartyRole = PUBLIC_PROSECUTOR.test(key) ? "public_prosecutor" : side;
  const isClient = !!clientName && partyKey(clientName) !== "" && key === partyKey(clientName);
  return { name, role, hasOthers, isClient };
}

/** Labor area when the CNJ segment is 5 (derived from the number, not guessed). */
export function areaFromCnj(cnj: string | null): LegalArea | null {
  const parts = parseCnj(cnj);
  if (!parts) return null;
  return parts.segment === "5" ? "labor" : null;
}

/** Date found in a sheet name such as "Atualização Geral (29-07-2026)". */
export function baseDateFromText(text: string): string | null {
  const br = /\b(\d{2})[-/.](\d{2})[-/.](\d{4})\b/.exec(text);
  if (br) return isoDateOrNull(br[3], br[2], br[1]);
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text);
  if (iso) return isoDateOrNull(iso[1], iso[2], iso[3]);
  return null;
}

// ---------------------------------------------------------------------------
// Workbook
// ---------------------------------------------------------------------------

export const FIELD_LABELS_PT: Record<CanonicalField, string> = {
  instance: "Instância",
  court: "Tribunal",
  number: "Nº do processo",
  plaintiff: "Parte autora",
  defendant: "Parte ré",
  city: "Cidade",
  courtDivision: "Vara / órgão julgador",
  processClass: "Classe",
  phase: "Fase",
  claimAmount: "Valor da causa",
  liquidatedAmount: "Valor liquidado",
};

function isTotalRow(row: RawCell[], numberCol: number | undefined): boolean {
  if (numberCol !== undefined && cleanText(row[numberCol]) !== null) return false;
  const first = row.map((c) => cleanText(c)).find((c) => c !== null);
  const key = normalizeKey(first);
  return /^(total|totais|subtotal|soma)\b/.test(key);
}

/**
 * Parses every sheet. Rows of ignored sheets are not returned. Client-detection
 * uses `options.clientName`; the file-wide city → UF inference runs at the end.
 */
export function parseWorkbook(rawSheets: readonly RawSheet[], options: ParseOptions): ParsedWorkbook {
  const sheets: ParsedSheet[] = [];
  const rows: ParsedRow[] = [];
  let baseDateHint: BaseDateHint | null = null;

  const named = rawSheets.map((s) => ({ sheet: s, byName: classifySheetName(s.name), header: detectHeader(s.rows) }));
  const hasConsolidatedByName = named.some((n) => n.byName?.role === "consolidated" && n.header);
  let unknownPromoted = false;

  for (const { sheet, byName, header } of named) {
    if (!baseDateHint) {
      const date = baseDateFromText(sheet.name);
      if (date) baseDateHint = { date, source: `Aba "${sheet.name}"` };
    }

    let role: SheetRole;
    let instance: ProcessInstance | null = null;
    let note: string | null = null;
    if (byName?.role === "ignored") {
      role = "ignored";
      note = byName.note;
    } else if (!header) {
      role = "ignored";
      note = "Cabeçalho não encontrado (coluna de número do processo ausente): aba ignorada.";
    } else if (byName) {
      role = byName.role;
      instance = byName.instance;
    } else if (!hasConsolidatedByName && !unknownPromoted) {
      role = "consolidated";
      unknownPromoted = true;
      note = "Nome de aba não reconhecido: tratada como base consolidada.";
    } else {
      role = "ignored";
      note = 'Aba não reconhecida e ignorada. Renomeie para "Consolidado" ou "1º Grau"/"2º Grau"/"3º Grau" para incluí-la.';
    }

    if (role === "ignored" || !header) {
      sheets.push({ name: sheet.name, role: "ignored", instance: null, headerRow: header?.headerRow ?? null, rowCount: 0, note, mapping: header?.mapping ?? {} });
      continue;
    }

    const parsedSheet: ParsedSheet = { name: sheet.name, role, instance, headerRow: header.headerRow, rowCount: 0, note, mapping: header.mapping };
    sheets.push(parsedSheet);

    const headerKeys = uniqueHeaderKeys(header.headers);
    let totalRowNumber: number | null = null;
    for (let i = header.headerRow; i < sheet.rows.length; i++) {
      const cells = sheet.rows[i];
      if (!cells || isBlankRow(cells)) continue;
      parsedSheet.rowCount += 1;
      const rowNumber = i + 1;
      const raw: Record<string, string | number | boolean | null> = {};
      headerKeys.forEach((key, idx) => {
        if (key !== null) raw[key] = rawValue(cells[idx]);
      });
      // Extra cells beyond the header (unnamed columns) are kept for traceability.
      for (let idx = headerKeys.length; idx < cells.length; idx++) {
        const v = rawValue(cells[idx]);
        if (v !== null) raw[`Coluna ${idx + 1}`] = v;
      }

      if (isTotalRow(cells, header.columns.number)) {
        totalRowNumber = rowNumber;
        rows.push({
          sheet: sheet.name,
          sheetRole: role,
          sheetInstance: instance,
          rowNumber,
          kind: "total",
          raw,
          data: null,
          issues: [{ level: "info", code: "total_row", field: null, message: "Linha de totalização ignorada (a leitura continua nas linhas seguintes)." }],
          error: false,
        });
        continue;
      }

      rows.push(parseDataRow(cells, header, { sheet: sheet.name, role, instance, rowNumber, raw, totalRowNumber, options }));
    }
  }

  inferStatesFromFile(rows);

  const clientMatches = rows.filter((r) => r.data && (r.data.plaintiff?.isClient || r.data.defendant?.isClient)).length;
  if (options.clientName && clientMatches === 0) {
    // Without a single match the selected company is probably not the one in the file.
    for (const r of rows) {
      if (r.kind === "data" && !r.error) {
        r.issues.push({
          level: "warning",
          code: "client_not_found",
          field: null,
          message: `Nenhuma parte corresponde à empresa selecionada ("${truncateText(options.clientName, 80)}"): o cliente não foi marcado nas partes.`,
        });
      }
    }
  }

  return { sheets, rows, baseDateHint, clientMatches };
}

function uniqueHeaderKeys(headers: (string | null)[]): (string | null)[] {
  const seen = new Map<string, number>();
  return headers.map((h, idx) => {
    const base = h ?? `Coluna ${idx + 1}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base} (${n + 1})`;
  });
}

type RowContext = {
  sheet: string;
  role: "consolidated" | "instance";
  instance: ProcessInstance | null;
  rowNumber: number;
  raw: Record<string, string | number | boolean | null>;
  totalRowNumber: number | null;
  options: ParseOptions;
};

function parseDataRow(cells: RawCell[], header: HeaderDetection, rc: RowContext): ParsedRow {
  const issues: ParsedIssue[] = [];
  const col = header.columns;
  const label = (field: CanonicalField) => header.mapping[field] ?? FIELD_LABELS_PT[field];
  const cell = (field: CanonicalField): RawCell => (col[field] === undefined ? null : cells[col[field] as number]);
  const text = (field: CanonicalField) => cleanText(cell(field));
  let error = false;

  if (rc.totalRowNumber !== null) {
    issues.push({
      level: "info",
      code: "after_total",
      field: null,
      message: `Linha abaixo da linha TOTAL (linha ${rc.totalRowNumber}), lida normalmente; conferir se pertence à carteira.`,
    });
  }

  // Number (CNJ)
  const numberCell = cell("number");
  const cnjRaw = typeof numberCell === "number" ? String(numberCell) : cleanText(numberCell);
  const cnj = normalizeCnj(cnjRaw);
  const cnjValid = isValidCnj(cnj);
  if (!cnjRaw) {
    error = true;
    issues.push({ level: "error", code: "cnj_missing", field: label("number"), message: "Número do processo não informado: linha não importada." });
  } else if (!cnj) {
    error = true;
    issues.push({
      level: "error",
      code: "cnj_invalid_format",
      field: label("number"),
      message: `Número fora do padrão CNJ (20 dígitos): "${truncateText(cnjRaw, 40)}". Linha não importada.`,
    });
  } else if (!cnjValid) {
    issues.push({
      level: "warning",
      code: "cnj_invalid_check_digit",
      field: label("number"),
      message: "Dígito verificador do número CNJ não confere; conferir. O número foi mantido como informado (não é corrigido).",
    });
  }

  // Phase text is read first: its appeal terms may fill a missing instance (P0.5).
  const phase = parsePhase(text("phase"));

  // Instance
  const instanceText = text("instance");
  const fromCell = parseInstance(instanceText);
  let instance: ProcessInstance | null = fromCell ?? rc.instance;
  if (instanceText && !fromCell) {
    issues.push({
      level: "warning",
      code: "instance_unrecognized",
      field: label("instance"),
      message: rc.instance
        ? `Instância não reconhecida ("${truncateText(instanceText, 40)}"): usada a instância da aba.`
        : `Instância não reconhecida ("${truncateText(instanceText, 40)}").`,
    });
  } else if (fromCell && rc.instance && fromCell !== rc.instance) {
    issues.push({
      level: "warning",
      code: "instance_sheet_mismatch",
      field: label("instance"),
      message: `Instância da linha ("${truncateText(instanceText, 40)}") difere da aba "${rc.sheet}": usada a instância da linha.`,
    });
  }

  // Court
  const courtText = text("court");
  let court = normalizeCourt(courtText);
  let instanceFromPhase = false;
  if (!instance) {
    if (phase.instance) {
      // Free text is a presumption: as strict as instance_assumed, plus verification (the plan marks it).
      instance = phase.instance;
      instanceFromPhase = true;
      issues.push({
        level: "warning",
        code: "instance_from_phase",
        field: label("instance"),
        message: `Instância não informada: ${phase.instance === "superior" ? "3º grau" : "2º grau"} conforme os termos recursais da fase; conferir (processo pendente de conferência).`,
      });
    } else if (court === "TST") {
      instance = "superior";
      issues.push({ level: "info", code: "instance_from_court", field: label("instance"), message: "Instância não informada: considerada 3º grau (TST)." });
    } else {
      instance = "first";
      issues.push({ level: "warning", code: "instance_assumed", field: label("instance"), message: "Instância não informada: considerada 1º grau; conferir." });
    }
  }
  if (!court && cnj) {
    const derived = instance === "superior" && parseCnj(cnj)?.segment === "5" ? "TST" : laborCourtFromCnj(cnj);
    if (derived) {
      court = derived;
      issues.push({ level: "info", code: "court_derived", field: label("court"), message: `Tribunal não informado: derivado do número CNJ (${derived}).` });
    }
  }
  if (!court && !error) {
    error = true;
    issues.push({ level: "error", code: "court_missing", field: label("court"), message: "Tribunal não informado e não derivável do número: linha não importada." });
  }
  if (court && cnj && instance !== "superior") {
    const fromNumber = laborCourtFromCnj(cnj);
    if (fromNumber && /^TRT\d+$/.test(court) && fromNumber !== court) {
      issues.push({
        level: "warning",
        code: "court_cnj_mismatch",
        field: label("court"),
        message: `Tribunal informado (${court}) difere do tribunal indicado no número CNJ (${fromNumber}); conferir.`,
      });
    }
  }

  // City / UF
  const cityParse = parseCityCell(text("city"));
  if (cityParse.kind === "non_geographic") {
    issues.push({
      level: "warning",
      code: "city_non_geographic",
      field: label("city"),
      message: `"${truncateText(cityParse.raw, 60)}" não é um município (órgão/unidade judicial): cidade não preenchida${cityParse.state ? `; UF ${cityParse.state} mantida` : ""}.`,
    });
  } else if (cityParse.kind === "ambiguous") {
    issues.push({
      level: "warning",
      code: "city_ambiguous",
      field: label("city"),
      message: `Mais de uma localidade informada ("${truncateText(cityParse.raw, 60)}"): cidade não preenchida; conferir.`,
    });
  }

  // Money
  const claim = parseMoneyCell(cell("claimAmount"));
  if (claim.issue) issues.push({ ...claim.issue, field: label("claimAmount") });
  if (claim.cents !== null && claim.cents > 0 && claim.cents <= 100) {
    issues.push({
      level: "warning",
      code: "claim_symbolic",
      field: label("claimAmount"),
      message: `Valor da causa simbólico (${formatCentsPlain(claim.cents)}); conferir.`,
    });
  }
  const hasLiquidatedColumn = col.liquidatedAmount !== undefined;
  const liquidated = parseMoneyCell(cell("liquidatedAmount"));
  if (liquidated.issue) issues.push({ ...liquidated.issue, field: label("liquidatedAmount") });

  // Phase
  if (phase.detail && !phase.recognized) {
    issues.push({ level: "warning", code: "phase_unrecognized", field: label("phase"), message: `Fase não reconhecida ("${truncateText(phase.detail, 80)}"); conferir.` });
  }
  if (phase.needsVerification) {
    issues.push({
      level: "warning",
      code: "phase_verification",
      field: label("phase"),
      message: `${phase.verificationNote}. Processo pendente de conferência, sem encerramento automático.`,
    });
  }
  if (phase.closed) {
    issues.push({
      level: "info",
      code: "phase_closed",
      field: label("phase"),
      message: `Encerrado conforme a planilha (${phase.closureReason === "paid_extinct" ? "pago/extinto" : "arquivado definitivamente"}${phase.closedAt ? `, ${phase.closedAt.split("-").reverse().join("/")}` : ""}).`,
    });
  }

  // Parties
  const plaintiff = parsePartyCell(text("plaintiff"), "plaintiff", rc.options.clientName);
  const defendant = parsePartyCell(text("defendant"), "defendant", rc.options.clientName);
  for (const [party, field] of [
    [plaintiff, "plaintiff"],
    [defendant, "defendant"],
  ] as const) {
    if (!party) {
      issues.push({
        level: "warning",
        code: "party_missing",
        field: label(field),
        message: field === "plaintiff" ? "Parte autora não informada." : "Parte ré não informada.",
      });
      continue;
    }
    if (party.hasOthers) {
      issues.push({ level: "info", code: "party_others", field: label(field), message: `"e outros" retirado do nome de ${party.name}: há outras partes não identificadas na planilha.` });
    }
    if (party.role === "public_prosecutor") {
      issues.push({ level: "info", code: "party_public_prosecutor", field: label(field), message: `${party.name}: papel registrado como Ministério Público.` });
    }
  }
  if (plaintiff?.isClient && defendant?.isClient) {
    issues.push({ level: "warning", code: "client_both_sides", field: null, message: "A empresa aparece nos dois polos da linha; conferir as partes." });
  } else if (plaintiff?.isClient && rc.role === "instance" && rc.instance !== "first") {
    issues.push({
      level: "info",
      code: "client_plaintiff_side",
      field: label("plaintiff"),
      message: "Empresa na coluna da parte autora nesta instância (provável recorrente): polos mantidos conforme a planilha.",
    });
  }

  // Area
  const derivedArea = areaFromCnj(cnj);
  if (cnj && !derivedArea) {
    issues.push({ level: "info", code: "area_not_derived", field: label("number"), message: "Área não derivável do número (segmento diferente de 5): registrada como \"Outra\"." });
  }

  const data: NormalizedRow = {
    cnj,
    cnjRaw,
    cnjValid,
    instance,
    instanceFromPhase,
    court,
    courtDivision: truncateText(text("courtDivision"), 200),
    processClass: truncateText(text("processClass"), 40),
    city: cityParse.city,
    state: cityParse.state,
    phase: { ...phase, detail: truncateText(phase.detail, 500) },
    claimAmountCents: claim.cents,
    liquidatedAmountCents: hasLiquidatedColumn ? liquidated.cents : null,
    hasLiquidatedColumn,
    presentFields: CANONICAL_FIELDS.filter((f) => col[f] !== undefined),
    plaintiff,
    defendant,
    area: derivedArea ?? "other",
    afterTotal: rc.totalRowNumber !== null,
  };

  return {
    sheet: rc.sheet,
    sheetRole: rc.role,
    sheetInstance: rc.instance,
    rowNumber: rc.rowNumber,
    kind: "data",
    raw: rc.raw,
    data,
    issues,
    error,
  };
}

/** City without UF gets the UF when the same city appears with exactly one UF elsewhere in the file. */
function inferStatesFromFile(rows: ParsedRow[]): void {
  const statesByCity = new Map<string, Set<string>>();
  for (const r of rows) {
    const d = r.data;
    if (!d?.city || !d.state) continue;
    const key = normalizeKey(d.city);
    if (!statesByCity.has(key)) statesByCity.set(key, new Set());
    statesByCity.get(key)!.add(d.state);
  }
  for (const r of rows) {
    const d = r.data;
    if (!d?.city || d.state) continue;
    const states = statesByCity.get(normalizeKey(d.city));
    if (!states) continue;
    if (states.size === 1) {
      const [uf] = [...states];
      d.state = uf;
      r.issues.push({
        level: "info",
        code: "city_state_inferred",
        field: "Cidade",
        message: `UF ${uf} inferida: a cidade ${d.city} aparece com essa UF em outras linhas da planilha.`,
      });
    } else {
      r.issues.push({
        level: "warning",
        code: "city_state_conflict",
        field: "Cidade",
        message: `A cidade ${d.city} aparece com UFs diferentes (${[...states].sort().join(", ")}): UF não preenchida; conferir.`,
      });
    }
  }
}
