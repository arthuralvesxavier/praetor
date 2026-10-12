/**
 * Fictitious demonstration documents (PDF) coherent with a spreadsheet case.
 *
 * Every page carries "DOCUMENTO FICTÍCIO, GERADO PARA DEMONSTRAÇÃO" in the
 * header and in the footer. The pack is deterministic for a given CNJ number
 * and variant (same bytes every time), so seeds and tests are reproducible.
 *
 * Content rules: plain narrative only: no case law, no súmulas, no article
 * numbers, no real lawyer/OAB data, no court movements. Dates and values are
 * fictitious and derived deterministically from the case data (the hearing
 * date in the notification is fictitious document content, not a computed
 * procedural deadline).
 *
 * Variants (see DEMO_VARIANTS): complete pack; pack with deliberate
 * inconsistencies (dispensa before admissão, valor da causa different from the
 * record, divergent CNJ and admission date across documents); health-hazard
 * claims without technical reports; pack with information gaps.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { parseCnj } from "@/domain/cnj";
import type { DocumentCategory } from "@/domain/enums";

export type DemoCaseInfo = {
  number: string;
  court: string;
  courtDivision: string | null;
  city: string | null;
  state: string | null;
  plaintiff: string;
  defendant: string;
  processClass: string | null;
  claimAmountCents: number | null;
  filedAt: string | null;
};

export type DemoDocument = {
  title: string;
  category: DocumentCategory;
  description: string;
  fileName: string;
  mimeType: "application/pdf";
  bytes: Uint8Array;
};

export const DEMO_DOCUMENT_BANNER = "DOCUMENTO FICTÍCIO, GERADO PARA DEMONSTRAÇÃO";

export const DEMO_VARIANTS = [
  { id: 0, label: "Pacote completo (com planilha de cálculos)" },
  { id: 1, label: "Pacote com inconsistências deliberadas (datas, valor da causa e número do processo)" },
  { id: 2, label: "Insalubridade e horas extras, sem laudos nem cálculos" },
  { id: 3, label: "Pacote com lacunas (função e salário não informados)" },
] as const;
export const DEMO_VARIANT_COUNT = DEMO_VARIANTS.length;

// ---------------------------------------------------------------------------
// Deterministic helpers
// ---------------------------------------------------------------------------

/** FNV-1a 32-bit hash. */
export function hashString(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 PRNG: deterministic sequence for a seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function intBetween(next: () => number, min: number, max: number): number {
  return min + Math.floor(next() * (max - min + 1));
}

function pick<T>(next: () => number, list: readonly T[]): T {
  return list[Math.floor(next() * list.length) % list.length];
}

function isoToUtc(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function utcToIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(iso: string, days: number): string {
  const d = isoToUtc(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return utcToIso(d);
}

/** Moves Saturdays/Sundays to the next Monday (fictitious hearing dates fall on weekdays). */
function weekday(iso: string): string {
  const day = isoToUtc(iso).getUTCDay();
  if (day === 6) return addDays(iso, 2);
  if (day === 0) return addDays(iso, 1);
  return iso;
}

export function brDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

/** "R$ 12.345,67" with plain spaces (no NBSP: the PDF font is WinAnsi). */
export function brl(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const reais = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const centavos = String(abs % 100).padStart(2, "0");
  return `${negative ? "-" : ""}R$ ${reais},${centavos}`;
}

// WinAnsi (Windows-1252) characters above 0x7F that are not in Latin-1's 0xA0-0xFF block.
// En dash and em dash are written as escapes, so the source holds no dash as text.
const WIN_ANSI_EXTRA = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•\u2013\u2014˜™š›œžŸ");

/** Keeps only characters the standard Helvetica font can encode (WinAnsi). */
export function toWinAnsi(text: string): string {
  let out = "";
  for (const ch of text.normalize("NFC").replace(/[   ]/g, " ").replace(/[‐‑−]/g, "-")) {
    const code = ch.codePointAt(0) ?? 0;
    if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || WIN_ANSI_EXTRA.has(ch)) {
      out += ch;
      continue;
    }
    if (ch === "\t") {
      out += " ";
      continue;
    }
    const stripped = ch.normalize("NFD").replace(/\p{M}/gu, "");
    out += /^[\x20-\x7e]+$/.test(stripped) ? stripped : "?";
  }
  return out;
}

// ---------------------------------------------------------------------------
// Case facts (fictitious, deterministic)
// ---------------------------------------------------------------------------

type ClaimKind = "overtime" | "break" | "health_hazard" | "severance" | "fgts" | "moral_damages" | "late_payment_fine";

type ClaimSpec = {
  kind: ClaimKind;
  /** Lettered item text. */
  item: string;
  /** Short label (calculation sheet). */
  short: string;
  heading: string;
  reasoning: string;
  fact: string;
  weight: number;
};

const CLAIMS: Record<ClaimKind, Omit<ClaimSpec, "kind" | "fact"> & { fact: (f: CaseFacts) => string }> = {
  overtime: {
    short: "Horas extras e reflexos",
    item: "horas extras excedentes da jornada contratual, com reflexos em férias com um terço, décimo terceiro salário, aviso prévio e FGTS",
    heading: "Da jornada de trabalho e das horas extras",
    reasoning:
      "O reclamante entende que as horas trabalhadas além da jornada contratual devem ser remuneradas como extraordinárias, " +
      "com reflexos nas demais parcelas do contrato, uma vez que não houve compensação nem pagamento correspondente. " +
      "Afirma que os registros de ponto não retratam a jornada efetivamente cumprida.",
    fact: (f) =>
      `Durante todo o contrato, cumpriu jornada ${f.schedule}, sem receber corretamente pelas horas excedentes. ` +
      "Afirma que os controles de ponto não refletiam a jornada efetivamente cumprida.",
    weight: 34,
  },
  break: {
    short: "Intervalo para refeição e descanso",
    item: "pagamento do intervalo para refeição e descanso não usufruído integralmente, com reflexos",
    heading: "Do intervalo para refeição e descanso",
    reasoning:
      "Sustenta que a supressão parcial do intervalo para refeição e descanso deve ser remunerada, pois o tempo de pausa " +
      "não era integralmente usufruído por exigência do serviço.",
    fact: () => "Alega que usufruía de apenas 30 minutos de intervalo para refeição e descanso.",
    weight: 12,
  },
  health_hazard: {
    short: "Adicional de insalubridade e reflexos",
    item: "adicional de insalubridade durante todo o contrato, com reflexos",
    heading: "Do adicional de insalubridade",
    reasoning:
      "Sustenta que a exposição habitual a agentes nocivos, sem neutralização por equipamentos de proteção adequados, " +
      "justifica o pagamento do adicional, cujo grau deverá ser apurado por perícia técnica.",
    fact: () =>
      "Sustenta que trabalhava exposto a ruído intenso e a produtos químicos de limpeza industrial, sem o fornecimento " +
      "regular de equipamentos de proteção individual.",
    weight: 26,
  },
  severance: {
    short: "Verbas rescisórias",
    item: "verbas rescisórias não quitadas (saldo de salário, aviso prévio indenizado, férias proporcionais com um terço e décimo terceiro proporcional)",
    heading: "Das verbas rescisórias",
    reasoning:
      "Defende que, rompido o contrato por iniciativa do empregador e sem justa causa, são devidas as parcelas rescisórias " +
      "que não foram pagas ou foram pagas a menor, conforme demonstrativo a ser conferido.",
    fact: () => "Afirma que as verbas rescisórias não foram pagas integralmente por ocasião do desligamento.",
    weight: 22,
  },
  fgts: {
    short: "FGTS e indenização de 40%",
    item: "depósitos do FGTS não realizados durante o contrato, acrescidos da indenização compensatória de 40%",
    heading: "Do FGTS",
    reasoning:
      "Sustenta que os depósitos faltantes do FGTS devem ser recolhidos, acrescidos da indenização compensatória incidente " +
      "na dispensa sem justa causa, conforme extrato a ser apresentado pela reclamada.",
    fact: () => "Informa que os depósitos do FGTS não foram realizados em todos os meses do contrato.",
    weight: 14,
  },
  moral_damages: {
    short: "Danos morais",
    item: "indenização por danos morais",
    heading: "Do dano moral",
    reasoning:
      "Entende que a conduta descrita, consistente em cobranças excessivas e exposição perante colegas, atingiu sua honra " +
      "e dignidade, o que justificaria reparação em valor a ser arbitrado pelo juízo.",
    fact: () => "Relata ter sido submetido a cobranças excessivas de metas, com exposição perante os colegas de trabalho.",
    weight: 18,
  },
  late_payment_fine: {
    short: "Multa pelo atraso na quitação",
    item: "multa pelo atraso no pagamento das verbas rescisórias",
    heading: "Da multa pelo atraso na quitação",
    reasoning:
      "Afirma que o atraso na quitação das parcelas rescisórias gera o direito à multa correspondente, a ser apurada " +
      "com base no último salário.",
    fact: () => "Afirma que o acerto rescisório não foi feito na data combinada no desligamento.",
    weight: 6,
  },
};

const VARIANT_CLAIMS: Record<number, ClaimKind[]> = {
  0: ["overtime", "severance", "fgts", "moral_damages"],
  1: ["overtime", "break", "severance", "fgts"],
  2: ["health_hazard", "overtime", "moral_damages"],
  3: ["severance", "fgts", "late_payment_fine"],
};

const ROLES = [
  "Auxiliar de produção",
  "Operador de empilhadeira",
  "Assistente administrativo",
  "Motorista de entregas",
  "Vendedor interno",
  "Técnico de manutenção",
  "Auxiliar de logística",
];
const SCHEDULES = [
  "das 7h às 18h, de segunda a sábado",
  "das 6h às 17h30, de segunda a sexta-feira, e em sábados alternados",
  "das 8h às 20h, de segunda a sexta-feira",
  "das 14h às 23h30, de segunda a sábado",
];
const LAWYERS = ["Mariana Teixeira Lopes", "Carlos Henrique Duarte", "Patrícia Moura Siqueira", "Rodrigo Almeida Prado"];

type CaseFacts = {
  variant: number;
  number: string;
  calcNumber: string;
  court: string;
  courtDivision: string | null;
  city: string;
  state: string;
  place: string;
  plaintiff: string;
  defendant: string;
  processClass: string | null;
  filedAt: string;
  admission: string;
  /** Admission date written in the plaintiff's documents (differs in the inconsistent variant). */
  ctpsAdmission: string;
  dismissal: string;
  role: string | null;
  salaryCents: number | null;
  schedule: string;
  recordClaimCents: number;
  petitionClaimCents: number;
  claims: { kind: ClaimKind; spec: (typeof CLAIMS)[ClaimKind]; amountCents: number }[];
  hearingDate: string;
  hearingTime: string;
  noticeIssuedAt: string;
  powerOfAttorneyDate: string;
  calcBaseDate: string;
  lawyer: string;
  includeCalculation: boolean;
  includePayslips: boolean;
};

function normalizeVariant(variant: number | undefined, number: string): number {
  if (variant === undefined || !Number.isFinite(variant)) return hashString(number.replace(/\D/g, "")) % DEMO_VARIANT_COUNT;
  return ((Math.trunc(variant) % DEMO_VARIANT_COUNT) + DEMO_VARIANT_COUNT) % DEMO_VARIANT_COUNT;
}

/** Splits `total` among weights; the last share absorbs rounding so the sum is exact. */
function splitAmount(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  const shares = weights.map((w) => Math.floor((total * w) / sum));
  shares[shares.length - 1] += total - shares.reduce((a, b) => a + b, 0);
  return shares;
}

/** CNJ with a different sequential digit (deliberate inconsistency of variant 1). */
function alteredCnj(number: string): string {
  const digits = number.replace(/\D/g, "");
  if (digits.length !== 20) return `${number}-A`;
  const last = (Number(digits[6]) + 1) % 10;
  const changed = `${digits.slice(0, 6)}${last}${digits.slice(7)}`;
  return `${changed.slice(0, 7)}-${changed.slice(7, 9)}.${changed.slice(9, 13)}.${changed.slice(13, 14)}.${changed.slice(14, 16)}.${changed.slice(16, 20)}`;
}

function buildFacts(info: DemoCaseInfo, variant: number): CaseFacts {
  const next = rng(hashString(`${info.number}|${variant}`));
  const cnjYear = parseCnj(info.number)?.year ?? 2024;
  const filedAt =
    info.filedAt && /^\d{4}-\d{2}-\d{2}$/.test(info.filedAt)
      ? info.filedAt
      : `${cnjYear}-${String(intBetween(next, 1, 11)).padStart(2, "0")}-${String(intBetween(next, 1, 27)).padStart(2, "0")}`;

  const dismissal = addDays(filedAt, -intBetween(next, 40, 320));
  let admission = addDays(dismissal, -intBetween(next, 420, 2400));
  let ctpsAdmission = admission;
  let dismissalWritten = dismissal;
  if (variant === 1) {
    // Deliberate inconsistency: dispensa written before admissão, and a different admission date in the CTPS copy.
    admission = addDays(dismissal, intBetween(next, 60, 200));
    ctpsAdmission = addDays(admission, -intBetween(next, 300, 700));
    dismissalWritten = dismissal;
  }

  const city = (info.city ?? "").trim() || "Palmas";
  const state = (info.state ?? "").trim().toUpperCase().slice(0, 2) || "TO";
  const salaryCents = intBetween(next, 180, 450) * 1000;
  const recordClaimCents =
    info.claimAmountCents !== null && info.claimAmountCents > 0 ? Math.round(info.claimAmountCents) : intBetween(next, 200, 1500) * 10_000;
  const petitionClaimCents = variant === 1 ? Math.round((recordClaimCents * 1.12) / 100) * 100 : recordClaimCents;
  const kinds = VARIANT_CLAIMS[variant];
  const amounts = splitAmount(
    petitionClaimCents,
    kinds.map((k) => CLAIMS[k].weight),
  );
  const hearingDate = weekday(addDays(filedAt, intBetween(next, 35, 75)));
  const hearingTime = pick(next, ["08:30", "09:10", "10:00", "11:20", "13:30", "14:15", "15:40"]);

  return {
    variant,
    number: info.number,
    calcNumber: variant === 1 ? alteredCnj(info.number) : info.number,
    court: info.court.trim() || "Justiça do Trabalho",
    courtDivision: info.courtDivision?.trim() || null,
    city,
    state,
    place: `${city}/${state}`,
    plaintiff: info.plaintiff.trim() || "Reclamante não identificado",
    defendant: info.defendant.trim() || "Reclamada não identificada",
    processClass: info.processClass?.trim() || null,
    filedAt,
    admission,
    ctpsAdmission,
    dismissal: dismissalWritten,
    role: variant === 3 ? null : pick(next, ROLES),
    salaryCents: variant === 3 ? null : salaryCents,
    schedule: pick(next, SCHEDULES),
    recordClaimCents,
    petitionClaimCents,
    claims: kinds.map((kind, i) => ({ kind, spec: CLAIMS[kind], amountCents: amounts[i] })),
    hearingDate,
    hearingTime,
    noticeIssuedAt: addDays(filedAt, intBetween(next, 2, 6)),
    powerOfAttorneyDate: addDays(filedAt, -intBetween(next, 5, 25)),
    calcBaseDate: addDays(filedAt, -intBetween(next, 3, 12)),
    lawyer: pick(next, LAWYERS),
    includeCalculation: variant === 0 || variant === 1,
    includePayslips: variant !== 3,
  };
}

// ---------------------------------------------------------------------------
// Minimal layout engine (A4, Helvetica, word wrap, automatic page breaks)
// ---------------------------------------------------------------------------

type Block =
  | { kind: "title"; text: string }
  | { kind: "heading"; text: string }
  | { kind: "subheading"; text: string }
  | { kind: "para"; text: string }
  | { kind: "line"; text: string }
  | { kind: "item"; text: string }
  | { kind: "gap" }
  | { kind: "pagebreak" };

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN_X = 64;
const TOP_Y = PAGE_HEIGHT - 86;
const BOTTOM_Y = 74;
const BODY_SIZE = 10.5;
const LINE_HEIGHT = 15;
const TEXT_COLOR = rgb(0.1, 0.12, 0.16);
const BANNER_COLOR = rgb(0.55, 0.12, 0.12);

function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    // Very long words (e.g. numbers) are split by characters.
    let rest = word;
    while (font.widthOfTextAtSize(rest, size) > maxWidth && rest.length > 1) {
      let cut = rest.length - 1;
      while (cut > 1 && font.widthOfTextAtSize(rest.slice(0, cut), size) > maxWidth) cut -= 1;
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    current = rest;
  }
  if (current) lines.push(current);
  return lines;
}

async function renderPdf(title: string, blocks: Block[]): Promise<{ bytes: Uint8Array; pageCount: number }> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  const fixedDate = new Date(Date.UTC(2026, 0, 1, 12, 0, 0));
  pdf.setTitle(toWinAnsi(`${title} (documento fictício)`));
  pdf.setAuthor("Praetor, dados de demonstração");
  pdf.setSubject(toWinAnsi(DEMO_DOCUMENT_BANNER));
  pdf.setCreator("Praetor");
  pdf.setProducer("Praetor (pdf-lib)");
  pdf.setCreationDate(fixedDate);
  pdf.setModificationDate(fixedDate);

  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const maxWidth = PAGE_WIDTH - 2 * MARGIN_X;
  const banner = toWinAnsi(DEMO_DOCUMENT_BANNER);

  let page: PDFPage | null = null;
  let y = TOP_Y;
  const pages: PDFPage[] = [];

  const newPage = () => {
    page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    pages.push(page);
    const w = bold.widthOfTextAtSize(banner, 9);
    page.drawText(banner, { x: (PAGE_WIDTH - w) / 2, y: PAGE_HEIGHT - 44, size: 9, font: bold, color: BANNER_COLOR });
    y = TOP_Y;
  };
  const ensure = (height: number) => {
    if (!page || y - height < BOTTOM_Y) newPage();
  };
  const drawLines = (lines: string[], font: PDFFont, size: number, indent = 0, center = false) => {
    for (const line of lines) {
      ensure(LINE_HEIGHT);
      const x = center ? (PAGE_WIDTH - font.widthOfTextAtSize(line, size)) / 2 : MARGIN_X + indent;
      page!.drawText(line, { x, y, size, font, color: TEXT_COLOR });
      y -= LINE_HEIGHT;
    }
  };

  newPage();
  for (const block of blocks) {
    switch (block.kind) {
      case "pagebreak":
        newPage();
        break;
      case "gap":
        y -= LINE_HEIGHT / 2;
        break;
      case "title":
        ensure(LINE_HEIGHT * 3);
        drawLines(wrap(toWinAnsi(block.text), bold, 13, maxWidth), bold, 13, 0, true);
        y -= LINE_HEIGHT / 2;
        break;
      case "heading":
        ensure(LINE_HEIGHT * 3);
        y -= LINE_HEIGHT / 2;
        drawLines(wrap(toWinAnsi(block.text), bold, 11.5, maxWidth), bold, 11.5);
        y -= 3;
        break;
      case "subheading":
        ensure(LINE_HEIGHT * 2.5);
        drawLines(wrap(toWinAnsi(block.text), bold, BODY_SIZE, maxWidth), bold, BODY_SIZE);
        break;
      case "para":
        drawLines(wrap(toWinAnsi(block.text), regular, BODY_SIZE, maxWidth), regular, BODY_SIZE);
        y -= 5;
        break;
      case "line":
        drawLines(wrap(toWinAnsi(block.text), regular, BODY_SIZE, maxWidth), regular, BODY_SIZE);
        break;
      case "item":
        drawLines(wrap(toWinAnsi(block.text), regular, BODY_SIZE, maxWidth - 14), regular, BODY_SIZE, 14);
        y -= 3;
        break;
    }
  }

  pages.forEach((p, i) => {
    const footer = toWinAnsi(`${DEMO_DOCUMENT_BANNER} · Página ${i + 1} de ${pages.length}`);
    const w = regular.widthOfTextAtSize(footer, 8);
    p.drawText(footer, { x: (PAGE_WIDTH - w) / 2, y: 40, size: 8, font: regular, color: BANNER_COLOR });
  });

  const bytes = await pdf.save({ useObjectStreams: false });
  return { bytes, pageCount: pages.length };
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

function addressee(f: CaseFacts): string {
  const division = f.courtDivision ? f.courtDivision.toUpperCase() : `VARA DO TRABALHO DE ${f.city.toUpperCase()}`;
  return `EXCELENTÍSSIMO(A) SENHOR(A) JUIZ(A) DA ${division}`;
}

function petitionBlocks(f: CaseFacts): Block[] {
  const blocks: Block[] = [];
  blocks.push({ kind: "title", text: addressee(f) });
  blocks.push({ kind: "gap" });
  blocks.push({ kind: "title", text: "RECLAMAÇÃO TRABALHISTA" });
  blocks.push({ kind: "line", text: `RECLAMANTE: ${f.plaintiff}` });
  blocks.push({ kind: "line", text: `RECLAMADA: ${f.defendant}` });
  if (f.processClass) blocks.push({ kind: "line", text: `Rito/classe indicado: ${f.processClass}` });
  blocks.push({ kind: "gap" });
  blocks.push({
    kind: "para",
    text:
      `${f.plaintiff}, brasileiro(a), portador(a) de CTPS com dados fictícios, residente em ${f.place}, por seu advogado ` +
      `que esta subscreve (procuração anexa), vem propor RECLAMAÇÃO TRABALHISTA em face de ${f.defendant}, pessoa ` +
      `jurídica de direito privado com sede em ${f.place}, pelos fatos e fundamentos a seguir expostos.`,
  });

  blocks.push({ kind: "heading", text: "DO CONTRATO DE TRABALHO" });
  blocks.push({ kind: "line", text: `Data de admissão: ${brDate(f.admission)}` });
  blocks.push({ kind: "line", text: `Data de dispensa: ${brDate(f.dismissal)} (dispensa sem justa causa)` });
  if (f.role) blocks.push({ kind: "line", text: `Função: ${f.role}` });
  if (f.salaryCents !== null) blocks.push({ kind: "line", text: `Último salário: ${brl(f.salaryCents)}` });
  if (f.claims.some((c) => c.kind === "overtime")) blocks.push({ kind: "line", text: `Jornada alegada: ${f.schedule}` });
  if (!f.role || f.salaryCents === null) {
    blocks.push({
      kind: "para",
      text: "Os demais dados do contrato (função exercida e remuneração) constam dos documentos que serão juntados oportunamente.",
    });
  }

  blocks.push({ kind: "pagebreak" });
  blocks.push({ kind: "heading", text: "DOS FATOS" });
  const admissionSentence =
    f.role && f.salaryCents !== null
      ? `O reclamante foi admitido pela reclamada em ${brDate(f.admission)}, para exercer a função de ${f.role.toLowerCase()}, mediante salário mensal de ${brl(f.salaryCents)}.`
      : `O reclamante foi admitido pela reclamada em ${brDate(f.admission)}.`;
  blocks.push({ kind: "para", text: admissionSentence });
  blocks.push({ kind: "para", text: `Foi dispensado sem justa causa em ${brDate(f.dismissal)}, sem receber corretamente os valores devidos.` });
  for (const c of f.claims) blocks.push({ kind: "para", text: c.spec.fact(f) });
  blocks.push({
    kind: "para",
    text: "Diante desses fatos, e não tendo havido solução amigável, o reclamante busca a tutela jurisdicional para receber o que entende devido.",
  });

  blocks.push({ kind: "pagebreak" });
  blocks.push({ kind: "heading", text: "DOS FUNDAMENTOS" });
  f.claims.forEach((c, i) => {
    blocks.push({ kind: "subheading", text: `${i + 1}. ${c.spec.heading}` });
    blocks.push({ kind: "para", text: c.spec.reasoning });
  });
  blocks.push({
    kind: "para",
    text: "Os fundamentos acima são apresentados de forma resumida e serão desenvolvidos ao longo da instrução processual.",
  });

  blocks.push({ kind: "pagebreak" });
  blocks.push({ kind: "heading", text: "DOS PEDIDOS" });
  blocks.push({ kind: "para", text: "Diante do exposto, requer a condenação da reclamada ao pagamento das seguintes parcelas:" });
  f.claims.forEach((c, i) => {
    blocks.push({ kind: "item", text: `${String.fromCharCode(97 + i)}) ${c.spec.item}: ${brl(c.amountCents)}` });
  });
  blocks.push({ kind: "heading", text: "VALOR DA CAUSA" });
  blocks.push({ kind: "para", text: `Dá-se à causa o valor de ${brl(f.petitionClaimCents)}.` });
  blocks.push({ kind: "heading", text: "REQUERIMENTOS" });
  blocks.push({
    kind: "para",
    text:
      "Requer a notificação da reclamada para comparecer à audiência e apresentar defesa; a produção de todas as provas " +
      "admitidas, especialmente depoimento pessoal, oitiva de testemunhas, perícia e juntada de documentos; e a concessão " +
      "da justiça gratuita.",
  });
  if (f.claims.some((c) => c.kind === "overtime" || c.kind === "break")) {
    blocks.push({
      kind: "para",
      text: "Requer, ainda, que a reclamada seja intimada a apresentar os cartões de ponto e os recibos de pagamento de todo o período contratual.",
    });
  }
  blocks.push({ kind: "para", text: "Nestes termos, pede deferimento." });
  blocks.push({ kind: "line", text: `${f.place}, ${brDate(f.filedAt)}.` });
  blocks.push({ kind: "gap" });
  blocks.push({ kind: "line", text: `${f.lawyer}, advogado(a) do reclamante, OAB/${f.state} nº 00.000 (número fictício)` });
  return blocks;
}

function powerOfAttorneyBlocks(f: CaseFacts): Block[] {
  return [
    { kind: "title", text: "PROCURAÇÃO AD JUDICIA ET EXTRA" },
    { kind: "gap" },
    { kind: "para", text: `OUTORGANTE: ${f.plaintiff}, com qualificação fictícia, residente em ${f.place}.` },
    {
      kind: "para",
      text: `OUTORGADO(A): ${f.lawyer}, advogado(a), OAB/${f.state} nº 00.000 (número fictício), com escritório em ${f.place}.`,
    },
    {
      kind: "para",
      text:
        `PODERES: para o foro em geral, especialmente para propor reclamação trabalhista em face de ${f.defendant}, ` +
        "podendo transigir, desistir, receber e dar quitação, firmar compromissos e substabelecer, com ou sem reserva de poderes.",
    },
    { kind: "gap" },
    { kind: "line", text: `${f.place}, ${brDate(f.powerOfAttorneyDate)}.` },
    { kind: "gap" },
    { kind: "line", text: "Assinatura do outorgante (fictícia)" },
  ];
}

function plaintiffDocumentsBlocks(f: CaseFacts): Block[] {
  const blocks: Block[] = [
    { kind: "title", text: "DOCUMENTOS DO RECLAMANTE" },
    { kind: "title", text: "RESUMO DA CTPS" },
    { kind: "line", text: `Empregado: ${f.plaintiff}` },
    { kind: "line", text: `Empregador: ${f.defendant}` },
    { kind: "line", text: `Data de admissão: ${brDate(f.ctpsAdmission)}` },
    { kind: "line", text: `Data de saída: ${brDate(f.dismissal)}` },
    { kind: "line", text: `Cargo/Função: ${f.role ?? "ilegível na cópia apresentada"}` },
    {
      kind: "line",
      text: `Remuneração inicial: ${f.salaryCents !== null ? brl(Math.round(f.salaryCents * 0.85)) : "ilegível na cópia apresentada"}`,
    },
    { kind: "gap" },
    { kind: "para", text: "Observação: cópia simples da carteira de trabalho apresentada pelo reclamante, sem autenticação." },
  ];
  if (f.includePayslips && f.salaryCents !== null) {
    blocks.push({ kind: "pagebreak" });
    blocks.push({ kind: "title", text: "RESUMO DE HOLERITES (AMOSTRA)" });
    const end = isoToUtc(f.dismissal);
    for (let i = 6; i >= 1; i -= 1) {
      const d = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - i, 1));
      const comp = `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
      const net = Math.round(f.salaryCents * 0.89);
      blocks.push({
        kind: "line",
        text: `${comp}: salário base ${brl(f.salaryCents)}; horas extras pagas ${brl(0)}; líquido ${brl(net)}`,
      });
    }
    blocks.push({ kind: "gap" });
    blocks.push({
      kind: "para",
      text: "O reclamante declara não possuir cópia dos cartões de ponto, que permaneceram em poder da reclamada.",
    });
  }
  return blocks;
}

function noticeBlocks(f: CaseFacts): Block[] {
  return [
    { kind: "title", text: f.court.toUpperCase() },
    ...(f.courtDivision ? [{ kind: "title" as const, text: f.courtDivision.toUpperCase() }] : []),
    { kind: "title", text: "NOTIFICAÇÃO DE AUDIÊNCIA INICIAL" },
    { kind: "line", text: `Processo: ${f.number}` },
    { kind: "line", text: `Reclamante: ${f.plaintiff}` },
    { kind: "line", text: `Reclamada: ${f.defendant}` },
    { kind: "gap" },
    {
      kind: "para",
      text:
        "Fica a reclamada notificada da reclamação trabalhista em epígrafe, cuja cópia segue anexa, e para comparecer à " +
        `audiência inicial designada para ${brDate(f.hearingDate)}, às ${f.hearingTime}, por videoconferência, conforme ` +
        "instruções de acesso disponibilizadas pela secretaria.",
    },
    {
      kind: "para",
      text:
        "A reclamada deverá comparecer acompanhada de preposto munido de carta de preposição e de advogado, podendo " +
        "apresentar defesa e documentos na forma determinada pelo juízo.",
    },
    {
      kind: "para",
      text:
        "Eventual manifestação sobre os documentos juntados pelo reclamante deverá ser apresentada no prazo de 5 (cinco) " +
        "dias contados da audiência.",
    },
    { kind: "gap" },
    { kind: "line", text: `Notificação expedida em ${brDate(f.noticeIssuedAt)}.` },
    { kind: "line", text: "Secretaria da Vara (assinatura fictícia)" },
  ];
}

function calculationBlocks(f: CaseFacts): Block[] {
  const next = rng(hashString(`calc|${f.number}|${f.variant}`));
  const rows = f.claims.map((c) => ({
    label: c.spec.short,
    cents: Math.round((c.amountCents * intBetween(next, 88, 104)) / 100),
  }));
  const subtotal = rows.reduce((a, r) => a + r.cents, 0);
  const update = Math.round(subtotal * 0.047);
  const blocks: Block[] = [
    { kind: "title", text: "PLANILHA DE CÁLCULOS" },
    { kind: "title", text: "ESTIMATIVA APRESENTADA PELO RECLAMANTE" },
    { kind: "line", text: `Processo: ${f.calcNumber}` },
    { kind: "line", text: `Reclamante: ${f.plaintiff}` },
    { kind: "line", text: `Reclamada: ${f.defendant}` },
    { kind: "line", text: `Data-base dos cálculos: ${brDate(f.calcBaseDate)}` },
    { kind: "gap" },
  ];
  for (const r of rows) blocks.push({ kind: "line", text: `${r.label}: ${brl(r.cents)}` });
  blocks.push({ kind: "gap" });
  blocks.push({ kind: "line", text: `Subtotal das parcelas: ${brl(subtotal)}` });
  blocks.push({ kind: "line", text: `Atualização monetária e juros (estimativa): ${brl(update)}` });
  blocks.push({ kind: "line", text: `TOTAL DEVIDO: ${brl(subtotal + update)}` });
  blocks.push({ kind: "gap" });
  blocks.push({
    kind: "para",
    text: "Cálculos estimativos elaborados pela parte reclamante, sujeitos a conferência e à liquidação na fase própria.",
  });
  return blocks;
}

function fileSlug(number: string): string {
  return number.replace(/\D/g, "") || "processo";
}

/** Builds the demo document pack for a case. Deterministic per CNJ number and `variant`. */
export async function buildDemoCaseDocuments(info: DemoCaseInfo, opts: { variant?: number } = {}): Promise<DemoDocument[]> {
  const variant = normalizeVariant(opts.variant, info.number);
  const f = buildFacts(info, variant);
  const slug = fileSlug(info.number);
  const out: DemoDocument[] = [];

  const add = async (
    title: string,
    category: DocumentCategory,
    fileBase: string,
    blocks: Block[],
    describe: (pages: number) => string,
  ) => {
    const { bytes, pageCount } = await renderPdf(title, blocks);
    out.push({
      title,
      category,
      description: `${describe(pageCount)} Documento fictício gerado para demonstração (${pageCount} ${pageCount === 1 ? "página" : "páginas"}).`,
      fileName: `${fileBase}-${slug}.pdf`,
      mimeType: "application/pdf",
      bytes,
    });
  };

  await add("Petição inicial", "initial_petition", "peticao-inicial", petitionBlocks(f), () =>
    "Petição inicial da reclamação trabalhista, com contrato de trabalho, fatos, fundamentos, pedidos e valor da causa.",
  );
  await add("Procuração do reclamante", "power_of_attorney", "procuracao-reclamante", powerOfAttorneyBlocks(f), () =>
    "Procuração outorgada pelo reclamante ao seu advogado.",
  );
  await add("Documentos do reclamante (CTPS e holerites)", "evidence", "documentos-reclamante", plaintiffDocumentsBlocks(f), () =>
    f.includePayslips ? "Resumo da CTPS e amostra de holerites apresentados pelo reclamante." : "Resumo da CTPS apresentado pelo reclamante.",
  );
  await add("Notificação de audiência inicial", "correspondence", "notificacao-audiencia", noticeBlocks(f), () =>
    "Notificação da reclamada para a audiência inicial.",
  );
  if (f.includeCalculation) {
    await add("Planilha de cálculos do reclamante", "calculation", "planilha-calculos", calculationBlocks(f), () =>
      "Planilha de cálculos estimativos apresentada pelo reclamante, com total devido e data-base.",
    );
  }
  return out;
}

/** Facts used to build a pack (exposed for tests and for the seed's documentation). */
export function describeDemoCase(info: DemoCaseInfo, opts: { variant?: number } = {}) {
  const variant = normalizeVariant(opts.variant, info.number);
  const f = buildFacts(info, variant);
  return {
    variant,
    variantLabel: DEMO_VARIANTS[variant].label,
    filedAt: f.filedAt,
    admission: f.admission,
    dismissal: f.dismissal,
    hearingDate: f.hearingDate,
    petitionClaimCents: f.petitionClaimCents,
    recordClaimCents: f.recordClaimCents,
    claimAmounts: f.claims.map((c) => c.amountCents),
    includesCalculation: f.includeCalculation,
  };
}
