import {
  caseBriefSchema,
  type BriefAmount,
  type BriefCitation,
  type BriefClaim,
  type BriefDeadline,
  type BriefEvidence,
  type BriefField,
  type BriefNextStep,
  type BriefRisk,
  type BriefTextItem,
  type BriefTimelineEvent,
  type CaseBrief,
  type Provenance,
  SIMULATED_RECORD_AMOUNT_LABELS,
  SIMULATED_RECORD_GAP_TEXTS,
} from "@/domain/case-brief";
import { cnjDigits, isValidCnj, laborCourtFromCnj, normalizeCnj } from "@/domain/cnj";
import {
  DOCUMENT_CATEGORY_LABELS,
  LEGAL_AREA_LABELS,
  PROCESS_INSTANCE_LABELS,
  PROCESS_PHASE_LABELS,
  type DocumentCategory,
} from "@/domain/enums";
import { formatDate, formatMoneyCents } from "@/lib/format";
import { INJECTION_PHRASES, fold } from "../demo";
import {
  pageForOffset,
  type CaseBriefDocumentSource,
  type CaseBriefProvider,
  type CaseBriefRecord,
  type CaseBriefRequest,
  type CaseBriefResponse,
} from "./provider";

/**
 * SIMULATED preliminary case analysis. NO artificial intelligence: deterministic
 * text rules over the process record ("REG") and the extracted text of the
 * process documents ("D1", "D2"...). Every item carries its provenance:
 *
 *   record       — copied from the record (cites REG);
 *   extracted    — read literally from a document (cites ref + page + excerpt);
 *   illustrative — example produced by the simulation (theses, checklists...);
 *   missing      — information looked for and not found.
 *
 * Hard rules: no case law, no legal citations, no court movements; dates are
 * only copied from the text ("prazo de N dias" stays without a date — the
 * lawyer counts it); document text is untrusted: lines that look like
 * instructions to an AI are ignored and flagged (promptInjectionSuspected).
 */

export const CASE_BRIEF_SIMULATION_VERSION = "case-brief-simulation-2026-10-v1";

const MAX_ITEMS = 12;
const EXCERPT_MAX = 220;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function money(cents: number | null | undefined): string {
  return formatMoneyCents(cents, "não informado").replace(/ /g, " ");
}

function clip(text: string, max = EXCERPT_MAX): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function toIso(day: number, month: number, year: number): string | null {
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function daysBetween(fromIso: string, toIsoDate: string): number {
  const [a, b] = [fromIso, toIsoDate].map((iso) => {
    const [y, m, d] = iso.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  });
  return Math.round((b - a) / 86_400_000);
}

function parseMoney(raw: string): number | null {
  const digits = raw.replace(/\./g, "").replace(",", ".");
  const value = Number(digits);
  return Number.isFinite(value) ? Math.round(value * 100) : null;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function recordCitation(): BriefCitation {
  return { ref: "REG", page: null, excerpt: null };
}

function normalizeName(name: string): string {
  return fold(name)
    .replace(/\(.*?\)/g, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\b(ltda|s a|sa|me|epp|eireli|e outros|outros)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sameName(a: string, b: string): boolean {
  const x = normalizeName(a);
  const y = normalizeName(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

// ---------------------------------------------------------------------------
// Document preparation
// ---------------------------------------------------------------------------

type DocKind = "petition" | "defense" | "calculation" | "power_of_attorney" | "notice" | "plaintiff_evidence" | "other";

type Doc = {
  src: CaseBriefDocumentSource;
  kind: DocKind;
  /** Original text with banner and suspicious lines blanked with spaces (same length, offsets preserved). */
  clean: string;
  /** fold(clean): lower-case without accents, same length. */
  folded: string;
  /** Usable lines with their offsets. */
  lines: { text: string; start: number; end: number }[];
  pageCount: number;
};

const BANNER_RE = /documento ficticio.{0,6}gerado para demonstracao/;

function detectKind(src: CaseBriefDocumentSource, folded: string): DocKind {
  const title = fold(src.title);
  const byCategory: Partial<Record<DocumentCategory, DocKind>> = {
    initial_petition: "petition",
    defense: "defense",
    calculation: "calculation",
    power_of_attorney: "power_of_attorney",
  };
  if (byCategory[src.category]) return byCategory[src.category]!;
  if (/peticao inicial|reclamacao trabalhista/.test(title)) return "petition";
  if (/contestacao|defesa/.test(title)) return "defense";
  if (/calculo/.test(title)) return "calculation";
  if (/procuracao|substabelecimento/.test(title)) return "power_of_attorney";
  if (/notificacao|intimacao|citacao/.test(title)) return "notice";
  if (/ctps|holerite|documentos do (reclamante|autor)/.test(title)) return "plaintiff_evidence";
  if (/\bdos pedidos\b/.test(folded) && /\b(reclamante|autor)\b/.test(folded)) return "petition";
  if (/audiencia/.test(folded) && /notific|intima/.test(folded)) return "notice";
  if (src.category === "evidence") return "plaintiff_evidence";
  return "other";
}

function prepareDocuments(sources: CaseBriefDocumentSource[]): { docs: Doc[]; injection: boolean } {
  let injection = false;
  const docs = sources.map((src) => {
    const text = src.text ?? "";
    let clean = "";
    const lines: Doc["lines"] = [];
    let offset = 0;
    for (const rawLine of text.split("\n")) {
      const start = offset;
      const end = start + rawLine.length;
      offset = end + 1;
      const f = fold(rawLine);
      const banner = BANNER_RE.test(f);
      const suspicious = INJECTION_PHRASES.some((p) => f.includes(p));
      if (suspicious) injection = true;
      if (banner || suspicious) {
        clean += " ".repeat(rawLine.length);
      } else {
        clean += rawLine;
        if (rawLine.trim()) lines.push({ text: rawLine.trim(), start: start + (rawLine.length - rawLine.trimStart().length), end });
      }
      if (offset <= text.length) clean += "\n";
    }
    clean = clean.slice(0, text.length);
    const folded = fold(clean);
    const pageCount = Math.max(1, src.pageCount ?? src.pageOffsets?.length ?? 1);
    return { src, kind: detectKind(src, folded), clean, folded, lines, pageCount };
  });
  return { docs, injection };
}

/** Citation to a position of a document (page falls back to 1 for non-paged formats). */
function cite(doc: Doc, offset: number, excerpt: string): BriefCitation {
  const page = pageForOffset(doc.src.pageOffsets, offset) ?? 1;
  return { ref: doc.src.ref, page: Math.min(page, doc.pageCount), excerpt: clip(excerpt) };
}

function lineAt(doc: Doc, offset: number): { text: string; start: number; end: number } | null {
  return doc.lines.find((l) => l.start <= offset && offset <= l.end) ?? null;
}

/** Sentences of a text range with their start offsets (dots inside numbers do not split). */
function sentencesIn(doc: Doc, from: number, to: number): { text: string; start: number }[] {
  const out: { text: string; start: number }[] = [];
  let start = from;
  for (let i = from; i < to; i += 1) {
    const ch = doc.clean[i];
    const nextCh = doc.clean[i + 1] ?? " ";
    if ((ch === "." || ch === "!" || ch === "?" || ch === ";") && /\s/.test(nextCh)) {
      const raw = doc.clean.slice(start, i + 1);
      const lead = raw.length - raw.trimStart().length;
      const text = raw.replace(/\s+/g, " ").trim();
      if (text.length > 3) out.push({ text, start: start + lead });
      start = i + 1;
    }
  }
  const rest = doc.clean.slice(start, to);
  const text = rest.replace(/\s+/g, " ").trim();
  if (text.length > 3) out.push({ text, start: start + (rest.length - rest.trimStart().length) });
  return out;
}

const SECTION_HEADINGS: { key: string; re: RegExp }[] = [
  { key: "contract", re: /^(do )?contrato de trabalho$/ },
  { key: "facts", re: /^(dos fatos|dos fatos e fundamentos|da sintese dos fatos|sintese dos fatos)$/ },
  { key: "grounds", re: /^(dos fundamentos|do direito|dos fundamentos juridicos|do merito)$/ },
  { key: "claims", re: /^(dos pedidos|do pedido|pedidos)$/ },
  { key: "claimValue", re: /^(do )?valor da causa$/ },
  { key: "requests", re: /^(dos )?requerimentos( finais)?$/ },
];

type Section = { key: string; start: number; end: number };

function sectionsOf(doc: Doc): Section[] {
  const found: { key: string; headingEnd: number; headingStart: number }[] = [];
  for (const line of doc.lines) {
    const f = fold(line.text).replace(/[:.\s]+$/, "").replace(/\s+/g, " ").trim();
    const h = SECTION_HEADINGS.find((s) => s.re.test(f));
    if (h) found.push({ key: h.key, headingStart: line.start, headingEnd: line.end });
  }
  return found.map((h, i) => ({
    key: h.key,
    start: h.headingEnd,
    end: i + 1 < found.length ? found[i + 1].headingStart : doc.clean.length,
  }));
}

// ---------------------------------------------------------------------------
// Extraction primitives
// ---------------------------------------------------------------------------

type DateHit = { doc: Doc; iso: string; offset: number; line: string; label: string | null };

const DATE_LABELS: { label: string; re: RegExp }[] = [
  { label: "Audiência", re: /audiencia/ },
  { label: "Data-base dos cálculos", re: /data-base|data base/ },
  { label: "Admissão", re: /admiss|admitid/ },
  { label: "Dispensa / saída", re: /dispens|demiss|desligad|data de saida|rescisao do contrato/ },
  { label: "Notificação expedida", re: /expedid|notificacao/ },
  { label: "Ajuizamento", re: /ajuiz|distribuid|protocolad/ },
];

function findDates(doc: Doc): DateHit[] {
  const hits: DateHit[] = [];
  for (const m of doc.clean.matchAll(/\b(\d{2})\/(\d{2})\/(\d{4})\b/g)) {
    const iso = toIso(Number(m[1]), Number(m[2]), Number(m[3]));
    if (!iso) continue;
    const offset = m.index ?? 0;
    const line = lineAt(doc, offset);
    if (!line) continue;
    const f = fold(line.text);
    // Context before the date on the same line decides the label (a line may hold two dates).
    const before = fold(doc.clean.slice(Math.max(line.start, offset - 90), offset));
    let label = DATE_LABELS.find((d) => d.re.test(before))?.label ?? DATE_LABELS.find((d) => d.re.test(f))?.label ?? null;
    if (!label && /^[^\d]{2,60}, \d{2}\/\d{2}\/\d{4}\.?$/.test(line.text)) {
      label = doc.kind === "petition" ? "Data da petição inicial" : doc.kind === "power_of_attorney" ? "Data da procuração" : null;
    }
    if (label === "Audiência" && /audiencia (inicial|de conciliacao|de instrucao|una)/.test(f)) {
      label = /inicial/.test(f) ? "Audiência inicial" : /conciliacao/.test(f) ? "Audiência de conciliação" : /instrucao/.test(f) ? "Audiência de instrução" : "Audiência una";
    }
    hits.push({ doc, iso, offset, line: line.text, label });
  }
  return hits;
}

type AmountHit = { doc: Doc; cents: number; offset: number; excerpt: string };

function findFirstAmount(doc: Doc, re: RegExp): AmountHit | null {
  const m = re.exec(doc.folded);
  if (!m || m.index === undefined) return null;
  const valueMatch = /r\$\s*([\d.]+,\d{2})/.exec(m[0]);
  if (!valueMatch) return null;
  const cents = parseMoney(valueMatch[1]);
  if (cents === null) return null;
  const line = lineAt(doc, m.index);
  return { doc, cents, offset: m.index, excerpt: doc.clean.slice(m.index, m.index + m[0].length) || line?.text || "" };
}

type ClaimHit = { doc: Doc; letter: string; description: string; cents: number | null; offset: number; raw: string };

function findClaims(doc: Doc, section: Section): ClaimHit[] {
  const items: { letter: string; start: number; textStart: number }[] = [];
  for (const line of doc.lines) {
    if (line.start < section.start || line.start >= section.end) continue;
    const m = /^([a-z])\)\s+/.exec(line.text);
    if (m) items.push({ letter: m[1], start: line.start, textStart: line.start + m[0].length });
  }
  return items.map((item, i) => {
    const end = i + 1 < items.length ? items[i + 1].start : section.end;
    // Stop at the next paragraph (blank line) or heading.
    let raw = doc.clean.slice(item.textStart, end);
    const blank = raw.search(/\n\s*\n/);
    if (blank >= 0) raw = raw.slice(0, blank);
    raw = raw.replace(/\s+/g, " ").trim();
    // "a) <pedido>: R$ 1.000,00" (demo pack) or "<pedido> - R$ ..." / with a dash (other documents).
    const amount = /\s*[:—–-]\s*R\$\s*([\d.]+,\d{2})\s*[.;]?\s*$/.exec(raw);
    const cents = amount ? parseMoney(amount[1]) : null;
    const description = (amount ? raw.slice(0, amount.index) : raw).replace(/[;.]\s*$/, "").trim();
    return { doc, letter: item.letter, description, cents, offset: item.start, raw };
  });
}

type ClaimType = "overtime" | "break" | "health_hazard" | "severance" | "fgts" | "moral_damages" | "fine";

const CLAIM_TYPES: { type: ClaimType; re: RegExp; label: string }[] = [
  { type: "overtime", re: /horas? extra|sobrejornada/, label: "horas extras" },
  { type: "break", re: /intervalo/, label: "intervalo para refeição e descanso" },
  { type: "health_hazard", re: /insalubr|periculos/, label: "adicional de insalubridade/periculosidade" },
  { type: "severance", re: /verbas rescis|parcelas rescis|aviso previo/, label: "verbas rescisórias" },
  { type: "fgts", re: /fgts/, label: "FGTS" },
  { type: "moral_damages", re: /dano(s)? mora/, label: "danos morais" },
  { type: "fine", re: /multa/, label: "multa" },
];

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

function item(text: string, provenance: Provenance, citations: BriefCitation[] = [], note: string | null = null): BriefTextItem {
  return { text, provenance, citations, note };
}

function field(
  key: string,
  label: string,
  value: string | null,
  provenance: Provenance,
  citations: BriefCitation[],
  note: string | null = null,
): BriefField {
  return { key, label, value, provenance, citations, note };
}

function partyNames(record: CaseBriefRecord, role: "plaintiff" | "defendant"): string[] {
  return record.parties.filter((p) => p.role === role).map((p) => p.name.trim()).filter(Boolean);
}

function firstLineValue(doc: Doc, labelRe: RegExp): { value: string; offset: number; line: string } | null {
  for (const line of doc.lines) {
    const m = labelRe.exec(line.text);
    if (m) return { value: line.text.slice(m[0].length).trim().replace(/[.;]$/, ""), offset: line.start, line: line.text };
  }
  return null;
}

export function buildSimulatedCaseBrief(req: CaseBriefRequest): CaseBrief {
  const { record, today } = req;
  const { docs, injection } = prepareDocuments(req.documents);
  const isLabor = record.area === "labor";
  const petitions = docs.filter((d) => d.kind === "petition");
  const defenses = docs.filter((d) => d.kind === "defense");
  const reg = [recordCitation()];

  const identification: BriefField[] = [];
  const contradictions: BriefTextItem[] = [];
  const gaps: BriefTextItem[] = [];
  const limitations: string[] = [];

  // ----- Identification (record) --------------------------------------------
  const plaintiffs = partyNames(record, "plaintiff");
  const defendants = partyNames(record, "defendant");
  const numberNote = isValidCnj(record.number) ? null : "O dígito verificador do número CNJ não confere: conferir o número nos autos.";
  identification.push(field("process_number", "Número do processo", record.number, "record", reg, numberNote));
  if (!isValidCnj(record.number) && normalizeCnj(record.number)) {
    gaps.push(item(SIMULATED_RECORD_GAP_TEXTS.process_number, "missing", reg, "Conferir o número nos autos."));
  }

  const docPlaintiff = docs.flatMap((d) => {
    const hit = firstLineValue(d, /^(reclamante|autora?|requerente|empregado)\s*:\s*/i);
    return hit && hit.value ? [{ doc: d, ...hit }] : [];
  });
  const docDefendant = docs.flatMap((d) => {
    const hit = firstLineValue(d, /^(reclamad[ao]|r[ée]u?|requerid[ao]|empregador)\s*:\s*/i);
    return hit && hit.value ? [{ doc: d, ...hit }] : [];
  });

  const partyField = (key: string, label: string, names: string[], hits: typeof docPlaintiff) => {
    if (names.length) {
      identification.push(field(key, label, names.join("; "), "record", reg));
      for (const h of hits) {
        if (!names.some((n) => sameName(n, h.value))) {
          contradictions.push(
            item(
              `${label} em “${h.doc.src.title}” (${h.value}) não corresponde ao cadastro (${names.join("; ")}).`,
              "extracted",
              [cite(h.doc, h.offset, h.line), recordCitation()],
              "Conferir a grafia e se a parte está cadastrada.",
            ),
          );
        }
      }
    } else if (hits.length) {
      const h = hits[0];
      identification.push(
        field(key, label, h.value, "extracted", [cite(h.doc, h.offset, h.line)], "Parte não cadastrada no processo: cadastrar após conferir."),
      );
    } else {
      identification.push(field(key, label, null, "missing", [], "Não informado no cadastro nem nos documentos."));
    }
  };
  partyField("plaintiffs", "Autor(es)", plaintiffs, docPlaintiff);
  partyField("defendants", "Réu(s)", defendants, docDefendant);

  identification.push(
    record.companyName
      ? field("company", "Empresa do grupo", record.companyName, "record", reg)
      : field("company", "Empresa do grupo", null, "missing", reg, "Empresa do grupo não identificada no cadastro."),
  );
  identification.push(field("court", "Tribunal", record.court, "record", reg));
  const courtFromNumber = laborCourtFromCnj(record.number);
  if (courtFromNumber) {
    const normalizedCourt = record.court.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!normalizedCourt.includes(courtFromNumber.replace(/[^A-Z0-9]/g, ""))) {
      contradictions.push(
        item(
          `O número do processo indica ${courtFromNumber}, mas o tribunal cadastrado é “${record.court}”.`,
          "record",
          reg,
          "Conferir o tribunal e o número no cadastro.",
        ),
      );
    }
  }
  identification.push(
    record.courtDivision
      ? field("court_division", "Vara / órgão julgador", record.courtDivision, "record", reg)
      : field("court_division", "Vara / órgão julgador", null, "missing", reg),
  );
  const cityValue = record.city ? `${record.city}${record.state ? `/${record.state}` : ""}` : null;
  identification.push(
    cityValue ? field("city", "Cidade/UF", cityValue, "record", reg) : field("city", "Cidade/UF", null, "missing", reg),
  );
  identification.push(field("legal_area", "Área", LEGAL_AREA_LABELS[record.area], "record", reg));
  identification.push(
    record.instance
      ? field("instance", "Instância", PROCESS_INSTANCE_LABELS[record.instance], "record", reg)
      : field("instance", "Instância", null, "missing", reg),
  );
  identification.push(
    record.processClass
      ? field("process_class", "Classe", record.processClass, "record", reg)
      : field("process_class", "Classe", null, "missing", reg),
  );
  identification.push(
    field(
      "phase",
      "Fase",
      `${PROCESS_PHASE_LABELS[record.phase]}${record.phaseDetail ? ` (${record.phaseDetail})` : ""}`,
      "record",
      reg,
    ),
  );
  identification.push(
    record.filedAt
      ? field("filed_at", "Data de ajuizamento", formatDate(record.filedAt), "record", reg)
      : field("filed_at", "Data de ajuizamento", null, "missing", reg, "Não informada no cadastro."),
  );
  identification.push(
    record.claimAmountCents !== null
      ? field("claim_amount", "Valor da causa (cadastro)", money(record.claimAmountCents), "record", reg, "Exposição declarada; não somar ao liquidado.")
      : field("claim_amount", "Valor da causa (cadastro)", null, "missing", reg, "Não informado no cadastro."),
  );
  identification.push(
    record.liquidatedAmountCents !== null
      ? field("liquidated_amount", "Valor liquidado (cadastro)", money(record.liquidatedAmountCents), "record", reg)
      : field("liquidated_amount", "Valor liquidado (cadastro)", "Não apurado", "missing", reg, "Não apurado: ausência de valor não significa zero."),
  );
  identification.push(
    record.responsibleName
      ? field("responsible", "Responsável", record.responsibleName, "record", reg)
      : field("responsible", "Responsável", null, "missing", reg, "Processo sem responsável definido."),
  );
  if (!record.responsibleName) gaps.push(item(SIMULATED_RECORD_GAP_TEXTS.responsible, "missing", reg));
  if (!record.companyName) gaps.push(item(SIMULATED_RECORD_GAP_TEXTS.company, "missing", reg));
  if (!record.filedAt) gaps.push(item(SIMULATED_RECORD_GAP_TEXTS.filed_at, "missing", reg));
  if (record.claimAmountCents === null) gaps.push(item(SIMULATED_RECORD_GAP_TEXTS.claim_amount, "missing", reg));
  if (record.liquidatedAmountCents === null) {
    gaps.push(item(SIMULATED_RECORD_GAP_TEXTS.liquidated_amount, "missing", reg, "Registrar quando houver cálculo homologado ou apuração."));
  }

  // CNJ numbers quoted in documents.
  for (const d of docs) {
    for (const m of d.clean.matchAll(/\b\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}\b/g)) {
      if (cnjDigits(m[0]) === cnjDigits(record.number)) continue;
      const line = lineAt(d, m.index ?? 0);
      contradictions.push(
        item(
          `Número do processo em “${d.src.title}” (${m[0]}) difere do cadastro (${record.number}).`,
          "extracted",
          [cite(d, m.index ?? 0, line?.text ?? m[0]), recordCitation()],
          "Pode ser erro de digitação no documento ou documento de outro processo.",
        ),
      );
      break;
    }
  }

  // ----- Employment data, timeline -----------------------------------------
  const dateHits = docs.flatMap(findDates);
  const timeline: BriefTimelineEvent[] = [];
  const seenEvents = new Set<string>();
  for (const h of dateHits) {
    if (!h.label) continue;
    const key = `${h.iso}|${h.label}|${h.doc.src.ref}`;
    if (seenEvents.has(key)) continue;
    seenEvents.add(key);
    timeline.push({
      date: h.iso,
      description: `${h.label} (segundo “${h.doc.src.title}”)`,
      provenance: "extracted",
      citations: [cite(h.doc, h.offset, h.line)],
      note: null,
    });
  }
  if (record.filedAt) {
    timeline.push({ date: record.filedAt, description: "Ajuizamento (cadastro)", provenance: "record", citations: reg, note: null });
  }
  for (const e of record.events.slice(0, 20)) {
    timeline.push({ date: e.date, description: `${e.title} (movimentação cadastrada)`, provenance: "record", citations: reg, note: null });
  }
  timeline.sort((a, b) => (a.date ?? "9999").localeCompare(b.date ?? "9999"));

  const admissions = dateHits.filter((h) => h.label === "Admissão");
  const dismissals = dateHits.filter((h) => h.label === "Dispensa / saída");
  const firstPerDoc = (hits: DateHit[]) => {
    const map = new Map<string, DateHit>();
    for (const h of hits) if (!map.has(h.doc.src.ref)) map.set(h.doc.src.ref, h);
    return [...map.values()];
  };
  const admissionByDoc = firstPerDoc(admissions);
  const dismissalByDoc = firstPerDoc(dismissals);
  for (const a of admissionByDoc) {
    const dis = dismissalByDoc.find((d) => d.doc.src.ref === a.doc.src.ref);
    if (dis && dis.iso < a.iso) {
      contradictions.push(
        item(
          `Em “${a.doc.src.title}”, a data de dispensa (${formatDate(dis.iso)}) é anterior à data de admissão (${formatDate(a.iso)}).`,
          "extracted",
          [cite(a.doc, a.offset, a.line), cite(dis.doc, dis.offset, dis.line)],
          "Conferir as datas do contrato nos documentos originais.",
        ),
      );
    }
  }
  const distinctAdmissions = [...new Map(admissionByDoc.map((a) => [a.iso, a])).values()];
  if (distinctAdmissions.length > 1) {
    const [x, y] = distinctAdmissions;
    contradictions.push(
      item(
        `Data de admissão diverge entre documentos: ${formatDate(x.iso)} em “${x.doc.src.title}” e ${formatDate(y.iso)} em “${y.doc.src.title}”.`,
        "extracted",
        [cite(x.doc, x.offset, x.line), cite(y.doc, y.offset, y.line)],
        "Conferir a CTPS e o registro de empregado.",
      ),
    );
  }

  const roleHit = docs.flatMap((d) => {
    const h = firstLineValue(d, /^(fun[çc][ãa]o|cargo\/fun[çc][ãa]o|cargo)\s*:\s*/i);
    return h && h.value && !/ilegivel|nao informad/.test(fold(h.value)) ? [{ doc: d, ...h }] : [];
  })[0];
  const salaryHit = docs.flatMap((d) => {
    const h = firstLineValue(d, /^([úu]ltimo sal[áa]rio|sal[áa]rio|remunera[çc][ãa]o( inicial)?)\s*:\s*/i);
    return h && /R\$\s*[\d.]+,\d{2}/.test(h.value) ? [{ doc: d, ...h }] : [];
  })[0];
  if (isLabor || admissions.length || roleHit) {
    if (admissionByDoc[0]) {
      identification.push(
        field("employment_admission", "Data de admissão", formatDate(admissionByDoc[0].iso), "extracted", [
          cite(admissionByDoc[0].doc, admissionByDoc[0].offset, admissionByDoc[0].line),
        ]),
      );
    } else gaps.push(item("Data de admissão não localizada nos documentos.", "missing"));
    if (dismissalByDoc[0]) {
      identification.push(
        field("employment_dismissal", "Data de dispensa / saída", formatDate(dismissalByDoc[0].iso), "extracted", [
          cite(dismissalByDoc[0].doc, dismissalByDoc[0].offset, dismissalByDoc[0].line),
        ]),
      );
    } else gaps.push(item("Data de dispensa (fim do contrato) não localizada nos documentos.", "missing"));
    if (roleHit) {
      identification.push(field("employment_role", "Função", roleHit.value, "extracted", [cite(roleHit.doc, roleHit.offset, roleHit.line)]));
    } else gaps.push(item("Função do reclamante não informada nos documentos.", "missing"));
    if (salaryHit) {
      identification.push(
        field("employment_salary", "Salário informado", salaryHit.value, "extracted", [cite(salaryHit.doc, salaryHit.offset, salaryHit.line)]),
      );
    } else gaps.push(item("Salário do reclamante não informado nos documentos.", "missing"));
  }

  // ----- Facts, grounds, claims --------------------------------------------
  const factsSummary: BriefTextItem[] = [];
  const plaintiffArguments: BriefTextItem[] = [];
  let claimHits: ClaimHit[] = [];
  for (const p of petitions) {
    const sections = sectionsOf(p);
    const facts = sections.find((s) => s.key === "facts");
    if (facts) {
      for (const s of sentencesIn(p, facts.start, facts.end).slice(0, MAX_ITEMS)) {
        factsSummary.push(item(s.text, "extracted", [cite(p, s.start, s.text)]));
      }
    }
    const grounds = sections.find((s) => s.key === "grounds");
    if (grounds) {
      const headings = p.lines.filter((l) => l.start >= grounds.start && l.start < grounds.end && /^\d{1,2}[.)]\s+\S/.test(l.text));
      if (headings.length) {
        for (const h of headings.slice(0, MAX_ITEMS)) {
          const after = sentencesIn(p, h.end, Math.min(grounds.end, h.end + 600))[0];
          const title = h.text.replace(/^\d{1,2}[.)]\s+/, "");
          plaintiffArguments.push(
            item(after ? `${title}: ${after.text}` : title, "extracted", [cite(p, h.start, after ? `${h.text} ${after.text}` : h.text)]),
          );
        }
      } else {
        for (const s of sentencesIn(p, grounds.start, grounds.end).slice(0, 5)) {
          plaintiffArguments.push(item(s.text, "extracted", [cite(p, s.start, s.text)]));
        }
      }
    }
    const claimsSection = sections.find((s) => s.key === "claims");
    if (claimsSection) claimHits = claimHits.concat(findClaims(p, claimsSection));
  }
  if (!petitions.length) {
    gaps.push(item("Petição inicial não localizada entre os documentos com texto: fatos, fundamentos e pedidos não foram lidos.", "missing"));
  } else {
    if (!factsSummary.length) gaps.push(item("Seção “Dos fatos” não localizada na petição inicial.", "missing"));
    if (!claimHits.length) gaps.push(item("Pedidos não localizados na petição inicial (lista “a)”, “b)”...).", "missing"));
  }

  const claims: BriefClaim[] = claimHits.slice(0, 30).map((c) => ({
    description: c.description,
    amountCents: c.cents,
    provenance: "extracted",
    citations: [cite(c.doc, c.offset, `${c.letter}) ${c.raw}`)],
    note: c.cents === null ? "Valor do pedido não indicado no texto." : null,
  }));

  // Claim types come from each claim's main subject (the "com reflexos em..." tail is ignored);
  // without a list of claims, the facts of the petition are used.
  const subjectOf = (description: string) => fold(description).split(/,?\s+com reflexos/)[0];
  const typeSource = claimHits.length
    ? claimHits.map((c) => subjectOf(c.description)).join(" | ")
    : petitions
        .map((p) => {
          const facts = sectionsOf(p).find((s) => s.key === "facts");
          return facts ? p.folded.slice(facts.start, facts.end) : "";
        })
        .join(" ");
  const claimTypes = new Set<ClaimType>(CLAIM_TYPES.filter((t) => t.re.test(typeSource)).map((t) => t.type));
  const claimCitationFor = (type: ClaimType): BriefCitation[] => {
    const def = CLAIM_TYPES.find((t) => t.type === type)!;
    const hit = claimHits.find((c) => def.re.test(subjectOf(c.description)));
    return hit ? [cite(hit.doc, hit.offset, `${hit.letter}) ${hit.raw}`)] : [];
  };

  // ----- Amounts --------------------------------------------------------------
  const amounts: BriefAmount[] = [];
  const petitionValue = petitions
    .map((p) => findFirstAmount(p, /(?:da-se a causa o valor de|valor da causa\s*:?)\s*r\$\s*[\d.]+,\d{2}/))
    .find((h): h is AmountHit => h !== null);
  if (petitionValue) {
    amounts.push({
      label: "Valor da causa segundo a petição inicial",
      amountCents: petitionValue.cents,
      provenance: "extracted",
      citations: [cite(petitionValue.doc, petitionValue.offset, petitionValue.excerpt)],
      note: null,
    });
  }
  amounts.push(
    record.claimAmountCents !== null
      ? { label: SIMULATED_RECORD_AMOUNT_LABELS.claim_amount, amountCents: record.claimAmountCents, provenance: "record", citations: reg, note: "Exposição declarada; nunca somada ao valor liquidado." }
      : { label: SIMULATED_RECORD_AMOUNT_LABELS.claim_amount, amountCents: null, provenance: "missing", citations: reg, note: "Não informado no cadastro." },
  );
  const claimsWithAmount = claimHits.filter((c) => c.cents !== null);
  const claimsTotal = claimsWithAmount.reduce((sum, c) => sum + (c.cents ?? 0), 0);
  if (claimsWithAmount.length) {
    const first = claimsWithAmount[0];
    amounts.push({
      label: "Soma dos valores dos pedidos da inicial",
      amountCents: claimsTotal,
      provenance: "extracted",
      citations: [cite(first.doc, first.offset, `${first.letter}) ${first.raw}`)],
      note: `Soma feita pela simulação a partir de ${plural(claimsWithAmount.length, "pedido com valor", "pedidos com valor")}; conferir.`,
    });
  }
  let calcTotal: AmountHit | null = null;
  let calcBaseDate: { iso: string; doc: Doc; offset: number; line: string } | null = null;
  for (const d of docs) {
    const hit = findFirstAmount(d, /total devido\s*:?\s*r\$\s*[\d.]+,\d{2}/);
    if (!hit) continue;
    calcTotal = hit;
    const base = dateHits.find((h) => h.doc === d && h.label === "Data-base dos cálculos");
    if (base) calcBaseDate = { iso: base.iso, doc: d, offset: base.offset, line: base.line };
    break;
  }
  if (calcTotal) {
    amounts.push({
      label: "Total devido segundo a planilha de cálculos",
      amountCents: calcTotal.cents,
      provenance: "extracted",
      citations: [cite(calcTotal.doc, calcTotal.offset, calcTotal.excerpt)],
      note: `${calcBaseDate ? `Data-base: ${formatDate(calcBaseDate.iso)}. ` : ""}Estimativa apresentada por uma das partes; não é valor liquidado.`,
    });
  }
  amounts.push(
    record.liquidatedAmountCents !== null
      ? { label: SIMULATED_RECORD_AMOUNT_LABELS.liquidated_amount, amountCents: record.liquidatedAmountCents, provenance: "record", citations: reg, note: "Mostrado ao lado do valor da causa, nunca somado a ele." }
      : { label: SIMULATED_RECORD_AMOUNT_LABELS.liquidated_amount, amountCents: null, provenance: "missing", citations: reg, note: "Não apurado (ausência de valor não é zero)." },
  );

  if (petitionValue && record.claimAmountCents !== null && Math.abs(petitionValue.cents - record.claimAmountCents) >= 100) {
    contradictions.push(
      item(
        `Valor da causa na petição inicial (${money(petitionValue.cents)}) difere do valor cadastrado (${money(record.claimAmountCents)}).`,
        "extracted",
        [cite(petitionValue.doc, petitionValue.offset, petitionValue.excerpt), recordCitation()],
        "Registrar a divergência; o valor do cadastro não é alterado automaticamente.",
      ),
    );
  }
  if (petitionValue && claimsWithAmount.length && Math.abs(petitionValue.cents - claimsTotal) >= 100) {
    contradictions.push(
      item(
        `A soma dos pedidos (${money(claimsTotal)}) difere do valor da causa indicado na petição (${money(petitionValue.cents)}).`,
        "extracted",
        [cite(petitionValue.doc, petitionValue.offset, petitionValue.excerpt)],
        null,
      ),
    );
  }
  if (!petitionValue && petitions.length) gaps.push(item("Valor da causa não localizado na petição inicial.", "missing"));

  // ----- Evidence -------------------------------------------------------------
  const evidence: BriefEvidence[] = [];
  const holderOf = (kind: DocKind): BriefEvidence["holder"] =>
    kind === "defense" ? "defendant" : kind === "notice" ? "court" : kind === "other" ? "unknown" : "plaintiff";
  for (const d of docs) {
    const first = d.lines[0];
    evidence.push({
      description: `${d.src.title} (${DOCUMENT_CATEGORY_LABELS[d.src.category]}${d.src.pageCount ? `, ${plural(d.src.pageCount, "página", "páginas")}` : ""})`,
      holder: holderOf(d.kind),
      provenance: "extracted",
      citations: first ? [cite(d, first.start, first.text)] : [{ ref: d.src.ref, page: 1, excerpt: clip(d.src.title) }],
      note: null,
    });
  }
  const mentions: { re: RegExp; description: string; holder: BriefEvidence["holder"] }[] = [
    { re: /cartoes de ponto|controles de ponto|registros de ponto/, description: "Cartões / controles de ponto mencionados (documentos da empresa)", holder: "defendant" },
    { re: /oitiva de testemunhas|prova testemunhal|testemunhas/, description: "Prova testemunhal requerida", holder: "unknown" },
    { re: /pericia|pericial/, description: "Perícia requerida ou mencionada", holder: "court" },
    { re: /recibos de pagamento|holerites/, description: "Recibos de pagamento / holerites mencionados", holder: "plaintiff" },
  ];
  for (const m of mentions) {
    for (const d of docs) {
      const hit = m.re.exec(d.folded);
      if (!hit || hit.index === undefined) continue;
      const line = lineAt(d, hit.index);
      evidence.push({
        description: m.description,
        holder: m.holder,
        provenance: "extracted",
        citations: [cite(d, hit.index, line?.text ?? hit[0])],
        note: null,
      });
      break;
    }
  }

  // ----- Defense --------------------------------------------------------------
  const defendantArguments: BriefTextItem[] = [];
  if (defenses.length) {
    for (const d of defenses) {
      const heads = d.lines.filter((l) => /^(\d{1,2}[.)]\s+\S|[A-ZÀ-Ú][A-ZÀ-Ú ,]{6,}$)/.test(l.text)).slice(0, 8);
      for (const h of heads) defendantArguments.push(item(h.text, "extracted", [cite(d, h.start, h.text)]));
      if (!heads.length) {
        for (const s of sentencesIn(d, 0, d.clean.length).slice(0, 4)) defendantArguments.push(item(s.text, "extracted", [cite(d, s.start, s.text)]));
      }
    }
  } else {
    defendantArguments.push(
      item("Contestação não localizada entre os documentos do processo: não há argumentos da defesa para resumir.", "missing"),
    );
    const checklist: Partial<Record<ClaimType, string>> = {
      overtime: "Ponto a verificar com a empresa: existência de controles de jornada assinados e de eventual acordo de compensação de horas.",
      break: "Ponto a verificar: registros de intervalo e escalas de trabalho do período.",
      health_hazard: "Ponto a verificar: laudos ambientais e fichas de entrega de EPI com certificado de aprovação.",
      severance: "Ponto a verificar: termo de rescisão assinado e comprovante de pagamento das verbas rescisórias.",
      fgts: "Ponto a verificar: extratos de depósitos do FGTS de todo o contrato.",
      moral_damages: "Ponto a verificar: apuração interna, testemunhas e políticas de metas aplicadas no período.",
      fine: "Ponto a verificar: data efetiva do pagamento das verbas rescisórias.",
    };
    for (const t of CLAIM_TYPES) {
      if (claimTypes.has(t.type) && checklist[t.type]) {
        defendantArguments.push(
          item(checklist[t.type]!, "illustrative", claimCitationFor(t.type), "Checklist ilustrativo da simulação. Não é argumento apresentado nos autos."),
        );
      }
    }
  }

  // ----- Missing documents ----------------------------------------------------
  const titles = docs.map((d) => ({ title: fold(d.src.title), category: d.src.category, kind: d.kind }));
  const has = (pred: (t: (typeof titles)[number]) => boolean) => titles.some(pred);
  const missingDocuments: BriefTextItem[] = [];
  const missingNames: string[] = [];
  const requireDoc = (name: string, present: boolean, reason: string, citations: BriefCitation[] = []) => {
    if (!present) {
      missingNames.push(name);
      missingDocuments.push(item(`${name}: não localizado entre os documentos do processo.`, "missing", citations, reason));
    }
  };
  if (claimTypes.has("overtime") || claimTypes.has("break")) {
    requireDoc(
      "Cartões de ponto / controles de jornada",
      has((t) => /cartoes? de ponto|controle.{0,10}jornada|espelho de ponto/.test(t.title)),
      "Necessário para o pedido de horas extras / intervalo.",
      claimCitationFor(claimTypes.has("overtime") ? "overtime" : "break"),
    );
  }
  if (claimTypes.has("health_hazard")) {
    requireDoc(
      "Laudo técnico de insalubridade, PPRA/PGR e PCMSO",
      has((t) => /laudo|ppra|pgr|pcmso|ltcat/.test(t.title)),
      "Necessário para o pedido de adicional de insalubridade.",
      claimCitationFor("health_hazard"),
    );
  }
  if (claimTypes.has("severance") || claimTypes.has("fine")) {
    requireDoc(
      "Termo de rescisão (TRCT) e comprovante de pagamento das verbas rescisórias",
      has((t) => /trct|termo de rescisao|comprovante.{0,20}rescis/.test(t.title)),
      "Necessário para o pedido de verbas rescisórias.",
      claimCitationFor(claimTypes.has("severance") ? "severance" : "fine"),
    );
  }
  if (claimTypes.has("fgts")) {
    requireDoc("Extratos do FGTS", has((t) => /fgts/.test(t.title)), "Necessário para o pedido de FGTS.", claimCitationFor("fgts"));
  }
  if (isLabor || petitions.length) {
    requireDoc("Contestação", defenses.length > 0 || has((t) => t.category === "defense" || /contestacao/.test(t.title)), "Peça de defesa da empresa.");
    requireDoc(
      "Procuração da empresa (reclamada)",
      has((t) => t.category === "power_of_attorney" && !/reclamante|autor/.test(t.title)),
      "A procuração encontrada, se houver, é do autor.",
    );
    if (isLabor) requireDoc("Carta de preposição", has((t) => /preposi/.test(t.title)), "Necessária para a audiência.");
  }

  // ----- Hearings, deadlines, urgencies ---------------------------------------
  const hearingHits = dateHits.filter((h) => h.label?.startsWith("Audiência"));
  const urgencies: BriefTextItem[] = [];
  const possibleDeadlines: BriefDeadline[] = [];
  const seenHearing = new Set<string>();
  for (const h of hearingHits) {
    if (seenHearing.has(h.iso)) continue;
    seenHearing.add(h.iso);
    const c = cite(h.doc, h.offset, h.line);
    const days = daysBetween(today, h.iso);
    const kind = h.label ?? "Audiência";
    possibleDeadlines.push({
      description: `${kind}: data escrita no documento`,
      date: h.iso,
      basis: `Data copiada literalmente de “${h.doc.src.title}” (p. ${c.page}): “${clip(h.line, 160)}”. Conferir nos autos antes de registrar.`,
      provenance: "extracted",
      citations: [c],
      note: null,
    });
    if (days >= 0 && days <= 60) {
      urgencies.push(
        item(
          `${kind} em ${formatDate(h.iso)} (${days === 0 ? "hoje" : `em ${plural(days, "dia", "dias")}`}): preparar preposto, carta de preposição e defesa.`,
          "extracted",
          [c],
        ),
      );
    } else if (days < 0 && days >= -30) {
      urgencies.push(
        item(
          `${kind} indicada para ${formatDate(h.iso)} já passou segundo o documento: verificar a ata e os desdobramentos.`,
          "extracted",
          [c],
        ),
      );
    }
  }
  for (const d of docs) {
    for (const m of d.folded.matchAll(/prazo de (\d{1,3})(?:\s*\([^)]{1,30}\))?\s*dias?(?: uteis| corridos)?/g)) {
      const line = lineAt(d, m.index ?? 0);
      const literal = d.clean.slice(m.index ?? 0, (m.index ?? 0) + m[0].length);
      possibleDeadlines.push({
        description: `Prazo de ${m[1]} dias mencionado em “${d.src.title}”`,
        date: null,
        basis:
          `O documento menciona “${clip(literal, 80)}” sem data final. O sistema não conta prazos: ` +
          "o advogado deve verificar o termo inicial, contar e conferir o prazo manualmente.",
        provenance: "extracted",
        citations: [cite(d, m.index ?? 0, line?.text ?? literal)],
        note: "Sem data: não pode virar prazo sem contagem humana.",
      });
    }
    // Literal dates next to "prazo"/"até"/"vencimento" (other than hearings).
    for (const h of dateHits.filter((x) => x.doc === d && !x.label?.startsWith("Audiência"))) {
      const before = fold(d.clean.slice(Math.max(0, h.offset - 40), h.offset));
      if (!/\b(prazo|ate|vencimento|vence)\b/.test(before)) continue;
      const c = cite(d, h.offset, h.line);
      possibleDeadlines.push({
        description: `Data limite mencionada em “${d.src.title}”`,
        date: h.iso,
        basis: `Data copiada literalmente (p. ${c.page}): “${clip(h.line, 160)}”. Conferir antes de registrar.`,
        provenance: "extracted",
        citations: [c],
        note: null,
      });
    }
  }

  // ----- Theses (always illustrative) -------------------------------------------
  const theses: BriefTextItem[] = [];
  const thesisNote = "Ilustrativo (simulação): hipótese a verificar, sem jurisprudência nem fundamento legal citado.";
  const thesisText: Partial<Record<ClaimType, string>> = {
    overtime: "Hipótese a verificar: se houver controles de jornada válidos, eles podem demonstrar a jornada efetivamente cumprida e eventual pagamento ou compensação das horas extras.",
    break: "Hipótese a verificar: registros de intervalo podem indicar se a pausa era usufruída integralmente.",
    health_hazard: "Hipótese a verificar: laudos ambientais e comprovantes de entrega de EPI podem indicar se a exposição era neutralizada.",
    severance: "Hipótese a verificar: o termo de rescisão e o comprovante bancário podem demonstrar a quitação das verbas rescisórias.",
    fgts: "Hipótese a verificar: os extratos podem confirmar se os depósitos foram regulares em todo o contrato.",
    moral_damages: "Hipótese a verificar: avaliar se os fatos narrados têm prova além do relato da inicial.",
    fine: "Hipótese a verificar: a data efetiva do pagamento rescisório indica se houve atraso.",
  };
  for (const t of CLAIM_TYPES) {
    if (claimTypes.has(t.type) && thesisText[t.type]) theses.push(item(thesisText[t.type]!, "illustrative", claimCitationFor(t.type), thesisNote));
  }
  if (contradictions.length) {
    theses.push(
      item(
        "Hipótese a verificar: as divergências de datas, valores ou número do processo apontadas podem ser relevantes para a defesa, após conferência nos autos.",
        "illustrative",
        [],
        thesisNote,
      ),
    );
  }

  // ----- Risks ---------------------------------------------------------------
  const risks: BriefRisk[] = [];
  if (record.phase === "enforcement") {
    risks.push({
      description: "Processo em fase de execução: possibilidade de bloqueio de valores; conferir garantias e saldo devedor.",
      level: "high",
      provenance: "record",
      citations: reg,
      note: "Calculado a partir do cadastro (fase).",
    });
    if (record.liquidatedAmountCents === null) {
      risks.push({
        description: "Execução sem valor liquidado no cadastro (não apurado): exposição concreta desconhecida.",
        level: "high",
        provenance: "record",
        citations: reg,
        note: "Calculado a partir do cadastro.",
      });
    }
  } else if (record.phase === "liquidation") {
    risks.push({ description: "Processo em liquidação: valores em apuração.", level: "medium", provenance: "record", citations: reg, note: "Calculado a partir do cadastro (fase)." });
  }
  // Phase and instance are distinct axes (P0.5): "em recurso" comes from the INSTANCE (2º/3º grau), never from the phase.
  if (record.instance === "second" || record.instance === "superior") {
    risks.push({
      description: `Processo em grau de recurso (${PROCESS_INSTANCE_LABELS[record.instance]}): o resultado pode alterar os valores envolvidos.`,
      level: "medium",
      provenance: "record",
      citations: reg,
      note: "Calculado a partir do cadastro (instância).",
    });
  }
  if (record.claimAmountCents !== null && record.claimAmountCents >= 10_000_000) {
    risks.push({
      description: `Valor da causa elevado (${money(record.claimAmountCents)}): é a exposição declarada pelo autor, não uma estimativa de perda.`,
      level: record.claimAmountCents >= 50_000_000 ? "high" : "medium",
      provenance: "record",
      citations: reg,
      note: "Calculado a partir do cadastro (valor da causa).",
    });
  }
  if (record.liquidatedAmountCents !== null && record.liquidatedAmountCents > 0) {
    risks.push({
      description: `Há valor liquidado no cadastro (${money(record.liquidatedAmountCents)}), apresentado ao lado do valor da causa e nunca somado a ele.`,
      level: record.phase === "enforcement" ? "high" : "medium",
      provenance: "record",
      citations: reg,
      note: "Calculado a partir do cadastro (valor liquidado).",
    });
  }
  const upcomingHearing = possibleDeadlines.find((d) => d.date && d.description.startsWith("Audiência") && daysBetween(today, d.date) >= 0);
  if (!defenses.length && upcomingHearing) {
    risks.push({
      description: "Audiência designada e nenhuma contestação entre os documentos: a defesa precisa ser preparada antes da data.",
      level: "high",
      provenance: "illustrative",
      citations: upcomingHearing.citations,
      note: "Sugestão ilustrativa baseada nos documentos; confirmar a situação nos autos.",
    });
  }
  if ((claimTypes.has("overtime") || claimTypes.has("break")) && missingDocuments.some((m) => m.text.startsWith("Cartões de ponto"))) {
    risks.push({
      description: "Sem controles de jornada entre os documentos, a defesa do pedido de horas extras pode ficar mais difícil.",
      level: "medium",
      provenance: "illustrative",
      citations: claimCitationFor("overtime"),
      note: "Sugestão ilustrativa.",
    });
  }
  if (contradictions.length) {
    risks.push({
      description: "Há divergências entre documentos e cadastro: conferir antes de qualquer provisão ou acordo.",
      level: "medium",
      provenance: "illustrative",
      citations: [],
      note: "Sugestão ilustrativa.",
    });
  }

  // ----- Next steps ---------------------------------------------------------
  const nextSteps: BriefNextStep[] = [];
  for (const d of possibleDeadlines.filter((x) => x.date && x.description.startsWith("Audiência"))) {
    const days = daysBetween(today, d.date!);
    if (days < 0) continue;
    nextSteps.push({
      description: `Conferir a notificação e registrar a audiência de ${formatDate(d.date)} na agenda de audiências.`,
      priority: days <= 15 ? "urgent" : "high",
      provenance: "extracted",
      citations: d.citations,
      note: null,
    });
  }
  if (!defenses.length && (isLabor || petitions.length)) {
    nextSteps.push({
      description: "Designar quem vai elaborar a contestação e reunir as provas da empresa.",
      priority: "high",
      provenance: "illustrative",
      citations: [],
      note: "Sugestão ilustrativa da simulação.",
    });
  }
  if (missingDocuments.length) {
    nextSteps.push({
      description: `Solicitar à área responsável os documentos faltantes: ${missingNames.slice(0, 6).join("; ")}.`,
      priority: "high",
      provenance: "illustrative",
      citations: [],
      note: "Sugestão ilustrativa da simulação.",
    });
  }
  if (contradictions.length) {
    nextSteps.push({
      description: "Conferir nos autos as divergências apontadas (datas, valores e número do processo).",
      priority: "medium",
      provenance: "illustrative",
      citations: [],
      note: "Sugestão ilustrativa da simulação.",
    });
  }
  if (petitionValue || calcTotal) {
    nextSteps.push({
      description: "Enviar os valores extraídos para conferência na fila de valores (contingências).",
      priority: "medium",
      provenance: "illustrative",
      citations: [],
      note: "Sugestão ilustrativa da simulação.",
    });
  }
  if (gaps.some((g) => g.citations.some((c) => c.ref === "REG"))) {
    nextSteps.push({
      description: "Completar os dados que faltam no cadastro do processo (ver “Lacunas de informação”).",
      priority: "low",
      provenance: "illustrative",
      citations: [],
      note: "Sugestão ilustrativa da simulação.",
    });
  }

  // ----- Limitations, headline ------------------------------------------------
  limitations.push(
    "Simulação por regras determinísticas, sem inteligência artificial: identifica apenas padrões de texto (seções, datas, valores e listas de pedidos) e pode omitir informações relevantes.",
  );
  limitations.push(
    docs.length
      ? `Foram lidos ${plural(docs.length, "documento com texto extraído", "documentos com texto extraído")}; documentos sem texto (imagens, PDFs digitalizados) não foram considerados.`
      : "Nenhum documento com texto extraído estava disponível: a análise usou apenas o cadastro do processo.",
  );
  limitations.push("Datas e valores foram copiados literalmente dos documentos; nenhum prazo foi contado pelo sistema.");
  for (const d of docs) {
    if (!d.src.pageOffsets?.length) limitations.push(`“${d.src.title}” não tem informação de páginas: as citações indicam a página 1.`);
  }
  if (injection) {
    limitations.push(
      "Foram encontrados trechos com aparência de instruções dirigidas a sistemas automatizados; eles foram ignorados e não influenciaram o resultado.",
    );
  }

  const plaintiffLabel = plaintiffs[0] ?? docPlaintiff[0]?.value ?? "Autor não identificado";
  const defendantLabel = defendants[0] ?? docDefendant[0]?.value ?? "réu não identificado";
  const headlineParts = [
    `${plaintiffLabel} x ${defendantLabel} (${LEGAL_AREA_LABELS[record.area].toLowerCase()}, ${PROCESS_PHASE_LABELS[record.phase].toLowerCase()}${record.instance ? `, ${PROCESS_INSTANCE_LABELS[record.instance]}` : ""}).`,
    claims.length
      ? `${plural(claims.length, "pedido identificado", "pedidos identificados")} na petição inicial${claimsWithAmount.length ? `, somando ${money(claimsTotal)}` : ""}.`
      : "Pedidos não identificados nos documentos.",
    `Valor da causa no cadastro: ${record.claimAmountCents !== null ? money(record.claimAmountCents) : "não informado"}; valor liquidado: ${
      record.liquidatedAmountCents !== null ? money(record.liquidatedAmountCents) : "não apurado"
    }.`,
    `${plural(contradictions.length, "contradição", "contradições")}, ${plural(missingDocuments.length, "documento faltante", "documentos faltantes")} e ${plural(urgencies.length, "urgência", "urgências")} apontados.`,
  ];

  const brief: CaseBrief = {
    headline: headlineParts.join(" "),
    identification,
    factsSummary: factsSummary.slice(0, MAX_ITEMS),
    timeline: timeline.slice(0, 40),
    claims,
    amounts,
    evidence: evidence.slice(0, 20),
    plaintiffArguments: plaintiffArguments.slice(0, MAX_ITEMS),
    defendantArguments: defendantArguments.slice(0, MAX_ITEMS),
    contradictions: contradictions.slice(0, 20),
    missingDocuments,
    theses,
    risks,
    urgencies,
    nextSteps,
    possibleDeadlines: possibleDeadlines.slice(0, 20),
    gaps,
    limitations,
    promptInjectionSuspected: injection,
  };
  // The contract is validated here as well as in the service.
  return caseBriefSchema.parse(brief);
}

export class SimulatedCaseBriefProvider implements CaseBriefProvider {
  readonly name = "simulated-case-brief";
  readonly model = "regras-deterministicas-v1";
  readonly mode = "demo" as const;
  readonly promptVersion = CASE_BRIEF_SIMULATION_VERSION;

  async generate(req: CaseBriefRequest): Promise<CaseBriefResponse> {
    return { brief: buildSimulatedCaseBrief(req), usage: { inputTokens: 0, outputTokens: 0 } };
  }
}
