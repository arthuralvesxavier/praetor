import { PDFDocument, degrees, setCharacterSpacing, type PDFFont, type PDFPage, type RGB } from "pdf-lib";
import { drawWordmark } from "./brand";
import { embedFonts, type Fonts } from "./fonts";
import { fitLine, sanitizePdfText, textWidth, wrapText } from "./text";
import { COLORS, CONTENT_WIDTH, PAGE, SEAL_KINDS, SEAL_STYLES, type SealKind } from "./theme";

/**
 * Motor de layout de PDF (servidor; pdf-lib + fontes embutidas).
 *
 * Modelo de fluxo: cada bloco vira um "flowable" que sabe medir a própria
 * altura, dividir-se para caber no espaço restante e desenhar-se. O paginador
 * preenche páginas A4 respeitando:
 *  - títulos presos ao bloco seguinte (sem título órfão no fim da página);
 *  - parágrafos quebrados por linha, sem hifenização, com no mínimo 2 linhas
 *    de cada lado de uma quebra de página;
 *  - tabelas com o cabeçalho repetido em toda página e linhas nunca partidas
 *    no meio de uma célula (só quando uma linha sozinha não cabe numa página);
 *  - legenda dos selos de origem antes do primeiro bloco com selo.
 * Depois (segunda passada, já com o total de páginas) desenha cabeçalho,
 * rodapé "Página X de Y" e a marca d'água.
 */

export type ParagraphStyle = "body" | "small" | "muted" | "lead" | "serif" | "title" | "subtitle" | "kicker";

export type PdfTableColumn = { header: string; weight?: number; align?: "left" | "right" | "center" };

export type PdfBlock =
  | { type: "heading"; text: string; number?: string; level?: 1 | 2 }
  | { type: "paragraph"; text: string; style?: ParagraphStyle; spaceBefore?: number }
  | {
      type: "item";
      seal: SealKind;
      /** Numeração do item (ex.: "2.3"), exibida sob o selo. */
      number?: string;
      text: string;
      /** Trecho literal citado (fonte serifada, entre aspas). */
      quote?: string | null;
      /** Linhas de nota em corpo pequeno (fonte, data, confiança…). */
      notes?: string[];
    }
  | {
      type: "table";
      caption?: string;
      seal?: SealKind;
      columns: PdfTableColumn[];
      rows: string[][];
      totals?: string[] | null;
      note?: string | null;
      emptyText?: string;
      /**
       * Selo de origem POR LINHA (tabela de itens, ex.: linha do tempo): desenhado na
       * coluna `sealColumn` (padrão 0), cujo texto é ignorado. Null = linha sem selo.
       */
      rowSeals?: (SealKind | null)[] | null;
      sealColumn?: number;
    }
  | { type: "keyValues"; pairs: { label: string; value: string }[]; columns?: 1 | 2 }
  | { type: "callout"; tone: "info" | "warning" | "stamp"; title?: string; lines: string[] }
  | { type: "rule"; width?: number; thickness?: number; color?: "gold" | "rule"; spaceBefore?: number; spaceAfter?: number }
  | { type: "spacer"; height: number }
  | { type: "pageBreak" };

export type PdfDocumentSpec = {
  info: { title: string; subject?: string; keywords?: string[]; createdAt: Date; language?: string };
  /** Faixa do cabeçalho (à direita do wordmark), ex.: "CONFIDENCIAL · USO INTERNO". */
  headerStripe: string;
  /** Rodapé: "Página X de Y · <reference> · <baseDateLabel>" + a frase `statement`. */
  footer: { reference: string; baseDateLabel: string; statement: string };
  /** Marca d'água diagonal em todas as páginas (null = sem marca). */
  watermark: string | null;
  blocks: PdfBlock[];
  /** Legenda inserida antes do primeiro bloco com selo (uma vez). */
  sealLegend?: { title: string; labels: Record<SealKind, string>; descriptions: Record<SealKind, string> };
};

export type RenderedPdf = { bytes: Uint8Array; pageCount: number };

// ---------------------------------------------------------------------------
// Estilos
// ---------------------------------------------------------------------------

type TextStyle = {
  font: PDFFont;
  size: number;
  lineHeight: number;
  color: RGB;
  /**
   * Espaçamento entre letras (pt). Mantido abaixo de ~0,09 do corpo: acima
   * disso os leitores de PDF extraem "C O N F I D E N C I A L" (busca e cópia quebram).
   */
  spacing?: number;
  upper?: boolean;
  /** Texto literal de documento (citação): reproduzido como na fonte, sem trocar travessões. */
  literal?: boolean;
};

function buildStyles(f: Fonts) {
  return {
    body: { font: f.sans, size: 9.2, lineHeight: 13.6, color: COLORS.body },
    small: { font: f.sans, size: 8, lineHeight: 11.4, color: COLORS.secondary },
    muted: { font: f.sans, size: 7.3, lineHeight: 10.2, color: COLORS.muted },
    lead: { font: f.serif, size: 13.5, lineHeight: 17.5, color: COLORS.body },
    serif: { font: f.serif, size: 11.5, lineHeight: 15, color: COLORS.body },
    title: { font: f.serifSemiBold, size: 30, lineHeight: 33, color: COLORS.navy },
    subtitle: { font: f.serif, size: 15.5, lineHeight: 19.5, color: COLORS.secondary },
    kicker: { font: f.sansSemiBold, size: 7.3, lineHeight: 11, color: COLORS.goldText, spacing: 0.65, upper: true },
    h1: { font: f.serifSemiBold, size: 17, lineHeight: 21, color: COLORS.navy },
    h1Number: { font: f.serifSemiBold, size: 17, lineHeight: 21, color: COLORS.goldText },
    h2: { font: f.sansSemiBold, size: 7.8, lineHeight: 11.5, color: COLORS.navy, spacing: 0.68, upper: true },
    quote: { font: f.serif, size: 11.4, lineHeight: 14.4, color: COLORS.ink, literal: true },
    note: { font: f.sans, size: 7.3, lineHeight: 10.2, color: COLORS.muted },
    itemNumber: { font: f.sansMedium, size: 6.8, lineHeight: 9, color: COLORS.subtle },
    label: { font: f.sansSemiBold, size: 6.3, lineHeight: 9, color: COLORS.muted, spacing: 0.56, upper: true },
    value: { font: f.serif, size: 12.5, lineHeight: 15.5, color: COLORS.navy },
    th: { font: f.sansSemiBold, size: 7.1, lineHeight: 9.4, color: COLORS.white },
    td: { font: f.sans, size: 7.5, lineHeight: 10, color: COLORS.body },
    tdTotal: { font: f.sansSemiBold, size: 7.5, lineHeight: 10, color: COLORS.navy },
    caption: { font: f.sansSemiBold, size: 8.4, lineHeight: 12, color: COLORS.navy },
    seal: { font: f.sansSemiBold, size: 6, lineHeight: 8, color: COLORS.navy, spacing: 0.4, upper: true },
    calloutTitle: { font: f.sansSemiBold, size: 8.3, lineHeight: 12, color: COLORS.navy },
    calloutText: { font: f.sans, size: 8.3, lineHeight: 12, color: COLORS.body },
    stampTitle: { font: f.sansBold, size: 8, lineHeight: 12, color: COLORS.goldText, spacing: 0.72, upper: true },
    stampText: { font: f.serif, size: 12, lineHeight: 15.5, color: COLORS.navy },
    chromeStripe: { font: f.sansSemiBold, size: 6.1, lineHeight: 8, color: COLORS.white, spacing: 0.55 },
    footer: { font: f.sans, size: 7.2, lineHeight: 9, color: COLORS.secondary },
    footerStatement: { font: f.sans, size: 6.8, lineHeight: 9, color: COLORS.muted },
    watermark: { font: f.sansBold, size: 50, lineHeight: 50, color: COLORS.navy },
  } satisfies Record<string, TextStyle>;
}

type Styles = ReturnType<typeof buildStyles>;

function prepare(text: string, style: TextStyle): string {
  const clean = sanitizePdfText(text, { keepDashes: style.literal });
  return style.upper ? clean.toLocaleUpperCase("pt-BR") : clean;
}

function wrap(text: string, style: TextStyle, width: number): string[] {
  return wrapText(prepare(text, style), style.font, style.size, width, style.spacing ?? 0, { keepDashes: style.literal });
}

function widthOf(text: string, style: TextStyle): number {
  return textWidth(style.font, style.size, prepare(text, style), style.spacing ?? 0);
}

/** Distância do topo da linha até a linha de base (glifo centralizado na entrelinha). */
function baselineOffset(style: TextStyle): number {
  const full = style.font.heightAtSize(style.size);
  const ascent = style.font.heightAtSize(style.size, { descender: false });
  return (style.lineHeight - full) / 2 + ascent;
}

/** Altura das maiúsculas (aprox.), para centralizar texto em selos e faixas. */
function capHeight(style: TextStyle): number {
  return style.size * 0.727;
}

function drawTextRun(
  page: PDFPage,
  text: string,
  style: TextStyle,
  x: number,
  baseline: number,
  opts: { color?: RGB; opacity?: number; rotate?: number } = {},
): void {
  const value = prepare(text, style);
  if (!value) return;
  const spacing = style.spacing ?? 0;
  if (spacing) page.pushOperators(setCharacterSpacing(spacing));
  page.drawText(value, {
    x,
    y: baseline,
    size: style.size,
    font: style.font,
    color: opts.color ?? style.color,
    opacity: opts.opacity,
    rotate: opts.rotate !== undefined ? degrees(opts.rotate) : undefined,
  });
  if (spacing) page.pushOperators(setCharacterSpacing(0));
}

function drawLineAt(page: PDFPage, text: string, style: TextStyle, x: number, top: number, align: "left" | "right" | "center" = "left", width = 0) {
  let dx = 0;
  if (align !== "left" && width > 0) {
    const w = widthOf(text, style);
    dx = align === "right" ? width - w : (width - w) / 2;
  }
  drawTextRun(page, text, style, x + dx, top - baselineOffset(style));
}

function roundedRectPath(w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  return [
    `M${rr} 0`,
    `H${w - rr}`,
    `Q${w} 0 ${w} ${rr}`,
    `V${h - rr}`,
    `Q${w} ${h} ${w - rr} ${h}`,
    `H${rr}`,
    `Q0 ${h} 0 ${h - rr}`,
    `V${rr}`,
    `Q0 0 ${rr} 0`,
    "Z",
  ].join("");
}

/** Retângulo arredondado com o canto superior esquerdo em (x, top). */
function drawRoundedRect(
  page: PDFPage,
  x: number,
  top: number,
  w: number,
  h: number,
  r: number,
  opts: { fill?: RGB; border?: RGB; borderWidth?: number },
) {
  page.drawSvgPath(roundedRectPath(w, h, r), {
    x,
    y: top,
    color: opts.fill,
    borderColor: opts.border,
    borderWidth: opts.border ? (opts.borderWidth ?? 0.6) : 0,
  });
}

// ---------------------------------------------------------------------------
// Selos de origem
// ---------------------------------------------------------------------------

const SEAL_HEIGHT = 10.6;
const SEAL_PAD_X = 4.4;
const SEAL_COLUMN = 66;
const SEAL_GAP = 9;
/** Itens até esta altura (pt) nunca são divididos entre páginas. */
const ITEM_KEEP_TOGETHER = 200;
/**
 * Tabela que não cabe no espaço restante é dividida (cabeçalho repetido) quando cabem nele o cabeçalho e ao menos
 * 3 linhas de dados; senão vai inteira para a página seguinte. Assim uma tabela curta não deixa uma área grande em
 * branco só para ficar junta.
 */
const TABLE_MIN_ROWS = 3;
/** Tabelas com ao menos este número de linhas de dados deixam 2 linhas para a página seguinte; as menores, ao menos 1 (ou só a nota). */
const TABLE_TWO_AFTER_FROM = 5;
/** Título da continuação só com a nota de uma tabela sem legenda (com legenda: "<legenda> (continuação)"). */
export const NOTE_ONLY_CONTINUATION_CAPTION = "Nota da tabela da página anterior (continuação)";

function sealWidth(label: string, s: Styles): number {
  return widthOf(label, s.seal) + 2 * SEAL_PAD_X;
}

function drawSeal(page: PDFPage, kind: SealKind, label: string, x: number, top: number, s: Styles): number {
  const style = SEAL_STYLES[kind];
  const w = sealWidth(label, s);
  drawRoundedRect(page, x, top, w, SEAL_HEIGHT, 2.6, { fill: style.bg, border: style.border, borderWidth: 0.6 });
  const baseline = top - SEAL_HEIGHT + (SEAL_HEIGHT - capHeight(s.seal)) / 2;
  drawTextRun(page, label, s.seal, x + SEAL_PAD_X, baseline, { color: style.fg });
  return w;
}

// ---------------------------------------------------------------------------
// Flowables
// ---------------------------------------------------------------------------

interface Flow {
  readonly kind: string;
  readonly spaceBefore: number;
  readonly spaceAfter: number;
  readonly keepWithNext: boolean;
  readonly hasSeal: boolean;
  height(): number;
  /** Altura mínima do primeiro pedaço (para manter um título junto do bloco seguinte). */
  minHead(): number;
  /** Divide para o primeiro pedaço caber em `avail`; null quando não há divisão válida. */
  split(avail: number): [Flow, Flow] | null;
  draw(page: PDFPage, x: number, top: number): void;
}

type Line = { text: string; style: TextStyle; indent: number; gapBefore: number; role: "text" | "quote" | "note" };

function linesHeight(lines: Line[]): number {
  return lines.reduce((h, l, i) => h + l.style.lineHeight + (i === 0 ? 0 : l.gapBefore), 0);
}

/** Índice de corte (n linhas no primeiro pedaço) respeitando 2 linhas de cada lado. */
function lineCut(lines: Line[], avail: number, minEach = 2): number | null {
  let h = 0;
  let n = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const lh = lines[i].style.lineHeight + (i === 0 ? 0 : lines[i].gapBefore);
    if (h + lh > avail) break;
    h += lh;
    n += 1;
  }
  const total = lines.length;
  // Blocos curtos não se dividem (evita linha órfã/viúva): vão inteiros para a página seguinte.
  if (total < 2 * minEach || n >= total) return null;
  if (total - n < minEach) n = total - minEach;
  if (n < minEach) return null;
  return n;
}

class ParagraphFlow implements Flow {
  readonly kind = "paragraph";
  readonly keepWithNext = false;
  readonly hasSeal = false;
  constructor(
    private readonly lines: Line[],
    readonly spaceBefore: number,
    readonly spaceAfter: number,
    private readonly align: "left" | "center" = "left",
  ) {}
  height() {
    return linesHeight(this.lines);
  }
  minHead() {
    return linesHeight(this.lines.slice(0, Math.min(2, this.lines.length)));
  }
  split(avail: number): [Flow, Flow] | null {
    const n = lineCut(this.lines, avail);
    if (n === null) return null;
    return [
      new ParagraphFlow(this.lines.slice(0, n), this.spaceBefore, 0, this.align),
      new ParagraphFlow(this.lines.slice(n).map((l, i) => (i === 0 ? { ...l, gapBefore: 0 } : l)), 0, this.spaceAfter, this.align),
    ];
  }
  draw(page: PDFPage, x: number, top: number) {
    let y = top;
    this.lines.forEach((l, i) => {
      if (i > 0) y -= l.gapBefore;
      drawLineAt(page, l.text, l.style, x + l.indent, y, this.align, CONTENT_WIDTH - l.indent);
      y -= l.style.lineHeight;
    });
  }
}

class HeadingFlow implements Flow {
  readonly kind = "heading";
  readonly keepWithNext = true;
  readonly hasSeal = false;
  readonly spaceBefore: number;
  readonly spaceAfter: number;
  private readonly lines: string[];
  private readonly numberWidth: number;
  constructor(
    private readonly text: string,
    private readonly number: string | undefined,
    private readonly level: 1 | 2,
    private readonly s: Styles,
  ) {
    const style = level === 1 ? s.h1 : s.h2;
    this.numberWidth = number ? widthOf(`${number}`, level === 1 ? s.h1Number : s.h2) + (level === 1 ? 9 : 6) : 0;
    this.lines = wrap(text, style, CONTENT_WIDTH - this.numberWidth);
    this.spaceBefore = level === 1 ? 20 : 12;
    this.spaceAfter = level === 1 ? 9 : 5;
  }
  height() {
    const style = this.level === 1 ? this.s.h1 : this.s.h2;
    return this.lines.length * style.lineHeight + (this.level === 1 ? 6 : 0);
  }
  minHead() {
    return this.height();
  }
  split(): null {
    return null;
  }
  draw(page: PDFPage, x: number, top: number) {
    const style = this.level === 1 ? this.s.h1 : this.s.h2;
    if (this.number) drawLineAt(page, this.number, this.level === 1 ? this.s.h1Number : style, x, top);
    let y = top;
    for (const line of this.lines) {
      drawLineAt(page, line, style, x + this.numberWidth, y);
      y -= style.lineHeight;
    }
    if (this.level === 1) {
      page.drawLine({
        start: { x, y: y - 3.5 },
        end: { x: x + CONTENT_WIDTH, y: y - 3.5 },
        thickness: 0.6,
        color: COLORS.ruleStrong,
      });
    }
  }
}

class ItemFlow implements Flow {
  readonly kind = "item";
  readonly keepWithNext = false;
  readonly spaceAfter = 0;
  readonly hasSeal: boolean;
  constructor(
    private readonly seal: { kind: SealKind; label: string } | null,
    private readonly number: string | undefined,
    private readonly lines: Line[],
    private readonly s: Styles,
    readonly spaceBefore: number,
  ) {
    this.hasSeal = !!seal;
  }
  private headHeight() {
    return this.seal ? SEAL_HEIGHT + (this.number ? 2 + this.s.itemNumber.lineHeight : 0) + 1 : 0;
  }
  height() {
    return Math.max(linesHeight(this.lines), this.headHeight());
  }
  minHead() {
    return this.height() <= 120 ? this.height() : linesHeight(this.lines.slice(0, 2));
  }
  split(avail: number): [Flow, Flow] | null {
    // Itens curtos nunca se dividem (selo, texto, trecho e notas ficam juntos): vão inteiros para a próxima página.
    if (this.height() <= ITEM_KEEP_TOGETHER || avail < this.headHeight()) return null;
    const n = lineCut(this.lines, avail);
    if (n === null) return null;
    const rest = this.lines.slice(n).map((l, i) => (i === 0 ? { ...l, gapBefore: 0 } : l));
    return [
      new ItemFlow(this.seal, this.number, this.lines.slice(0, n), this.s, this.spaceBefore),
      new ItemFlow(null, undefined, rest, this.s, 0),
    ];
  }
  draw(page: PDFPage, x: number, top: number) {
    if (this.seal) {
      drawSeal(page, this.seal.kind, this.seal.label, x, top - 1.2, this.s);
      if (this.number) drawLineAt(page, this.number, this.s.itemNumber, x + 0.5, top - 1.2 - SEAL_HEIGHT - 2);
    }
    const bodyX = x + SEAL_COLUMN + SEAL_GAP;
    let y = top;
    let quoteTop: number | null = null;
    let quoteBottom = 0;
    this.lines.forEach((l, i) => {
      if (i > 0) y -= l.gapBefore;
      if (l.role === "quote") {
        if (quoteTop === null) quoteTop = y;
        quoteBottom = y - l.style.lineHeight;
      }
      drawLineAt(page, l.text, l.style, bodyX + l.indent, y);
      y -= l.style.lineHeight;
    });
    if (quoteTop !== null) {
      page.drawRectangle({ x: bodyX, y: quoteBottom + 1.5, width: 1.6, height: quoteTop - quoteBottom - 3, color: COLORS.gold });
    }
  }
}

type TableRow = {
  cells: string[][];
  height: number;
  total: boolean;
  index: number;
  /** Selo de origem da linha (tabela de itens), desenhado na coluna `sealColumn`. */
  seal?: { kind: SealKind; label: string } | null;
};

const CELL_PAD_X = 4.6;
const CELL_PAD_Y = 3.4;
const HEAD_PAD_Y = 4.4;

class TableFlow implements Flow {
  readonly kind = "table";
  readonly keepWithNext = false;
  readonly hasSeal: boolean;
  readonly spaceAfter = 0;
  private readonly captionLines: string[];
  private readonly headerCells: string[][];
  private readonly headerHeight: number;
  private readonly noteLines: string[];
  constructor(
    private readonly spec: {
      caption?: string;
      seal?: { kind: SealKind; label: string } | null;
      columns: PdfTableColumn[];
      widths: number[];
      rows: TableRow[];
      note?: string | null;
      continued: boolean;
      sealColumn?: number;
    },
    private readonly s: Styles,
    readonly spaceBefore: number,
  ) {
    this.hasSeal = !!spec.seal || spec.rows.some((r) => !!r.seal);
    const sealW = spec.seal ? sealWidth(spec.seal.label, s) + 7 : 0;
    // Continuação só com a nota: sempre com um título que a liga à tabela (sem legenda, o genérico).
    const noteOnly = spec.continued && spec.rows.length === 0;
    const caption = spec.caption
      ? `${spec.caption}${spec.continued ? " (continuação)" : ""}`
      : noteOnly
        ? NOTE_ONLY_CONTINUATION_CAPTION
        : "";
    this.captionLines = caption ? wrap(caption, s.caption, CONTENT_WIDTH - sealW) : [];
    this.headerCells = spec.columns.map((c, i) => wrap(c.header, s.th, spec.widths[i] - 2 * CELL_PAD_X));
    this.headerHeight = Math.max(...this.headerCells.map((l) => l.length)) * s.th.lineHeight + 2 * HEAD_PAD_Y;
    this.noteLines = spec.note ? wrap(spec.note, s.note, CONTENT_WIDTH) : [];
  }
  private captionHeight() {
    return this.captionLines.length ? Math.max(this.captionLines.length * this.s.caption.lineHeight, SEAL_HEIGHT) + 5 : 0;
  }
  private noteHeight() {
    return this.noteLines.length ? 4 + this.noteLines.length * this.s.note.lineHeight : 0;
  }
  /** Continuação só com a nota (todas as linhas couberam na página anterior): sem cabeçalho de colunas. */
  private noteOnly() {
    return this.spec.continued && this.spec.rows.length === 0;
  }
  private head() {
    return this.captionHeight() + (this.noteOnly() ? 0 : this.headerHeight);
  }
  height() {
    return this.head() + this.spec.rows.reduce((h, r) => h + r.height, 0) + this.noteHeight();
  }
  /**
   * Divisão com `k` linhas no primeiro pedaço: ao menos 3 linhas de dados nesta página; na seguinte, ao menos
   * 2 linhas de dados (tabelas com 5 ou mais) ou 1 (as menores; a linha de totais nunca vai sozinha), ou só a
   * nota, quando todas as linhas couberam.
   */
  private validCut(k: number): boolean {
    const rows = this.spec.rows;
    if (k <= 0 || k > rows.length) return false;
    const before = rows.slice(0, k).filter((r) => !r.total).length;
    if (before < TABLE_MIN_ROWS) return false;
    if (k === rows.length) return this.noteLines.length > 0;
    const after = rows.slice(k).filter((r) => !r.total).length;
    return after >= (before + after >= TABLE_TWO_AFTER_FROM ? 2 : 1);
  }
  minHead() {
    // Primeiro pedaço da menor divisão válida (o título preso à tabela vai junto com ele); sem divisão válida,
    // a tabela inteira (título e tabela vão juntos para a página seguinte).
    const rows = this.spec.rows;
    for (let k = 1; k <= rows.length; k += 1) {
      if (this.validCut(k)) return this.head() + rows.slice(0, k).reduce((h, r) => h + r.height, 0);
    }
    return Math.min(this.height(), PAGE.contentTop - PAGE.contentBottom);
  }
  split(avail: number): [Flow, Flow] | null {
    const rows = this.spec.rows;
    let used = this.head();
    let fit = 0;
    while (fit < rows.length && used + rows[fit].height <= avail) {
      used += rows[fit].height;
      fit += 1;
    }
    // A maior divisão válida entre as linhas que cabem. Se todas cabem e só a nota não, prefere levar linhas
    // junto com a nota; sem como (tabela curta), a nota vai sozinha, com o título "(continuação)".
    let k = fit === rows.length ? rows.length - 1 : fit;
    while (k > 0 && !this.validCut(k)) k -= 1;
    if (k <= 0 && fit === rows.length && this.validCut(rows.length)) k = rows.length;
    if (k <= 0) {
      const fullPage = PAGE.contentTop - PAGE.contentBottom;
      if (rows.length > 0 && this.head() + rows[0].height > fullPage) {
        // Linha mais alta que uma página inteira (inevitável): divide a linha pelas linhas de texto.
        return this.splitTallRow(avail);
      }
      return null;
    }
    const base = { ...this.spec };
    return [
      new TableFlow({ ...base, rows: rows.slice(0, k), note: null }, this.s, this.spaceBefore),
      new TableFlow({ ...base, rows: rows.slice(k), continued: true }, this.s, 0),
    ];
  }
  private splitTallRow(avail: number): [Flow, Flow] | null {
    const [row, ...others] = this.spec.rows;
    const lh = this.s.td.lineHeight;
    const fit = Math.floor((avail - this.head() - 2 * CELL_PAD_Y) / lh);
    if (fit < 1) return null;
    const first: TableRow = { ...row, cells: row.cells.map((c) => c.slice(0, fit)) };
    const second: TableRow = { ...row, cells: row.cells.map((c) => c.slice(fit)) };
    first.height = Math.max(1, ...first.cells.map((c) => c.length)) * lh + 2 * CELL_PAD_Y;
    second.height = Math.max(1, ...second.cells.map((c) => c.length)) * lh + 2 * CELL_PAD_Y;
    const base = { ...this.spec };
    return [
      new TableFlow({ ...base, rows: [first], note: null }, this.s, this.spaceBefore),
      new TableFlow({ ...base, rows: [second, ...others], continued: true }, this.s, 0),
    ];
  }
  draw(page: PDFPage, x: number, top: number) {
    const s = this.s;
    let y = top;
    if (this.captionLines.length) {
      let cx = x;
      if (this.spec.seal) cx += drawSeal(page, this.spec.seal.kind, this.spec.seal.label, x, y - 0.6, s) + 7;
      this.captionLines.forEach((line, i) => drawLineAt(page, line, s.caption, cx, y - i * s.caption.lineHeight));
      y -= this.captionHeight();
    }
    // Cabeçalho (repetido em cada página com linhas).
    if (!this.noteOnly()) {
      page.drawRectangle({ x, y: y - this.headerHeight, width: CONTENT_WIDTH, height: this.headerHeight, color: COLORS.navy });
      let cx = x;
      this.spec.columns.forEach((col, i) => {
        const w = this.spec.widths[i];
        this.headerCells[i].forEach((line, j) =>
          drawLineAt(page, line, s.th, cx + CELL_PAD_X, y - HEAD_PAD_Y - j * s.th.lineHeight, col.align ?? "left", w - 2 * CELL_PAD_X),
        );
        cx += w;
      });
      y -= this.headerHeight;
    }
    for (const row of this.spec.rows) {
      if (row.total) {
        page.drawRectangle({ x, y: y - row.height, width: CONTENT_WIDTH, height: row.height, color: COLORS.goldWash });
        page.drawLine({ start: { x, y }, end: { x: x + CONTENT_WIDTH, y }, thickness: 0.8, color: COLORS.navy });
      } else if (row.index % 2 === 1) {
        page.drawRectangle({ x, y: y - row.height, width: CONTENT_WIDTH, height: row.height, color: COLORS.zebra });
      }
      const style = row.total ? s.tdTotal : s.td;
      let rx = x;
      this.spec.columns.forEach((col, i) => {
        const w = this.spec.widths[i];
        if (row.seal && i === (this.spec.sealColumn ?? 0)) {
          drawSeal(page, row.seal.kind, row.seal.label, rx + CELL_PAD_X, y - CELL_PAD_Y + 0.4, s);
        } else {
          (row.cells[i] ?? []).forEach((line, j) =>
            drawLineAt(page, line, style, rx + CELL_PAD_X, y - CELL_PAD_Y - j * style.lineHeight, col.align ?? "left", w - 2 * CELL_PAD_X),
          );
        }
        rx += w;
      });
      y -= row.height;
      page.drawLine({ start: { x, y }, end: { x: x + CONTENT_WIDTH, y }, thickness: 0.4, color: COLORS.rule });
    }
    if (this.noteLines.length) {
      y -= 4;
      this.noteLines.forEach((line) => {
        drawLineAt(page, line, s.note, x, y);
        y -= s.note.lineHeight;
      });
    }
  }
}

class KeyValueFlow implements Flow {
  readonly kind = "keyValues";
  readonly keepWithNext = false;
  readonly hasSeal = false;
  readonly spaceAfter = 0;
  constructor(
    private readonly rows: { cells: { label: string[]; value: string[] }[]; height: number }[],
    private readonly colWidth: number,
    private readonly gap: number,
    private readonly s: Styles,
    readonly spaceBefore: number,
  ) {}
  height() {
    return this.rows.reduce((h, r) => h + r.height, 0);
  }
  minHead() {
    return this.rows[0]?.height ?? 0;
  }
  split(avail: number): [Flow, Flow] | null {
    let used = 0;
    let k = 0;
    while (k < this.rows.length && used + this.rows[k].height <= avail) {
      used += this.rows[k].height;
      k += 1;
    }
    if (k === 0 || k >= this.rows.length) return null;
    return [
      new KeyValueFlow(this.rows.slice(0, k), this.colWidth, this.gap, this.s, this.spaceBefore),
      new KeyValueFlow(this.rows.slice(k), this.colWidth, this.gap, this.s, 0),
    ];
  }
  draw(page: PDFPage, x: number, top: number) {
    let y = top;
    for (const row of this.rows) {
      row.cells.forEach((cell, i) => {
        const cx = x + i * (this.colWidth + this.gap);
        page.drawLine({ start: { x: cx, y }, end: { x: cx + this.colWidth, y }, thickness: 0.5, color: COLORS.ruleStrong });
        let cy = y - 5;
        for (const l of cell.label) {
          drawLineAt(page, l, this.s.label, cx, cy);
          cy -= this.s.label.lineHeight;
        }
        cy -= 1;
        for (const v of cell.value) {
          drawLineAt(page, v, this.s.value, cx, cy);
          cy -= this.s.value.lineHeight;
        }
      });
      y -= row.height;
    }
  }
}

class CalloutFlow implements Flow {
  readonly kind = "callout";
  readonly keepWithNext = false;
  readonly hasSeal = false;
  readonly spaceAfter = 0;
  private readonly titleLines: string[];
  private readonly bodyLines: string[];
  private static readonly PAD_X = 11;
  private static readonly PAD_Y = 8;
  constructor(
    private readonly tone: "info" | "warning" | "stamp",
    title: string | undefined,
    lines: string[],
    private readonly s: Styles,
    readonly spaceBefore: number,
  ) {
    const inner = CONTENT_WIDTH - 2 * CalloutFlow.PAD_X - 3;
    this.titleLines = title ? wrap(title, this.titleStyle(), inner) : [];
    this.bodyLines = lines.flatMap((l) => wrap(l, this.textStyle(), inner));
  }
  private titleStyle() {
    return this.tone === "stamp" ? this.s.stampTitle : this.s.calloutTitle;
  }
  private textStyle() {
    return this.tone === "stamp" ? this.s.stampText : this.s.calloutText;
  }
  height() {
    return (
      2 * CalloutFlow.PAD_Y +
      this.titleLines.length * this.titleStyle().lineHeight +
      (this.titleLines.length && this.bodyLines.length ? 2 : 0) +
      this.bodyLines.length * this.textStyle().lineHeight
    );
  }
  minHead() {
    return this.height();
  }
  split(): null {
    return null;
  }
  draw(page: PDFPage, x: number, top: number) {
    const h = this.height();
    const palette =
      this.tone === "warning"
        ? { bg: COLORS.warnBg, bar: COLORS.warnBar, border: undefined }
        : this.tone === "stamp"
          ? { bg: COLORS.white, bar: COLORS.gold, border: COLORS.gold }
          : { bg: COLORS.infoBg, bar: COLORS.infoBar, border: undefined };
    page.drawRectangle({
      x,
      y: top - h,
      width: CONTENT_WIDTH,
      height: h,
      color: palette.bg,
      borderColor: palette.border,
      borderWidth: palette.border ? 0.8 : 0,
    });
    page.drawRectangle({ x, y: top - h, width: 3, height: h, color: palette.bar });
    let y = top - CalloutFlow.PAD_Y;
    const tx = x + CalloutFlow.PAD_X + 3;
    for (const line of this.titleLines) {
      drawLineAt(page, line, this.titleStyle(), tx, y);
      y -= this.titleStyle().lineHeight;
    }
    if (this.titleLines.length && this.bodyLines.length) y -= 2;
    for (const line of this.bodyLines) {
      drawLineAt(page, line, this.textStyle(), tx, y);
      y -= this.textStyle().lineHeight;
    }
  }
}

class RuleFlow implements Flow {
  readonly kind = "rule";
  readonly keepWithNext = false;
  readonly hasSeal = false;
  constructor(
    private readonly width: number,
    private readonly thickness: number,
    private readonly color: RGB,
    readonly spaceBefore: number,
    readonly spaceAfter: number,
  ) {}
  height() {
    return this.thickness;
  }
  minHead() {
    return this.thickness;
  }
  split(): null {
    return null;
  }
  draw(page: PDFPage, x: number, top: number) {
    page.drawRectangle({ x, y: top - this.thickness, width: this.width, height: this.thickness, color: this.color });
  }
}

class SpacerFlow implements Flow {
  readonly kind = "spacer";
  readonly keepWithNext = false;
  readonly hasSeal = false;
  readonly spaceBefore = 0;
  readonly spaceAfter = 0;
  constructor(private readonly h: number) {}
  height() {
    return this.h;
  }
  minHead() {
    return 0;
  }
  split(): [Flow, Flow] {
    // Um espaço no fim da página simplesmente termina ali.
    return [new SpacerFlow(0), new SpacerFlow(0)];
  }
  draw() {}
}

class PageBreakFlow implements Flow {
  readonly kind = "pageBreak";
  readonly keepWithNext = false;
  readonly hasSeal = false;
  readonly spaceBefore = 0;
  readonly spaceAfter = 0;
  height() {
    return 0;
  }
  minHead() {
    return 0;
  }
  split(): null {
    return null;
  }
  draw() {}
}

class LegendFlow implements Flow {
  readonly kind = "legend";
  readonly keepWithNext = true;
  readonly hasSeal = false;
  readonly spaceBefore = 10;
  readonly spaceAfter = 4;
  private readonly rows: { kind: SealKind; label: string; lines: string[] }[];
  private static readonly PAD = 9;
  constructor(
    private readonly title: string,
    labels: Record<SealKind, string>,
    descriptions: Record<SealKind, string>,
    private readonly s: Styles,
  ) {
    const textW = CONTENT_WIDTH - 2 * LegendFlow.PAD - SEAL_COLUMN - SEAL_GAP;
    this.rows = SEAL_KINDS.map((kind) => ({ kind, label: labels[kind], lines: wrap(descriptions[kind], s.small, textW) }));
  }
  private rowHeight(r: { lines: string[] }) {
    return Math.max(SEAL_HEIGHT + 3, r.lines.length * this.s.small.lineHeight) + 2;
  }
  height() {
    return 2 * LegendFlow.PAD + this.s.label.lineHeight + 4 + this.rows.reduce((h, r) => h + this.rowHeight(r), 0);
  }
  minHead() {
    return this.height();
  }
  split(): null {
    return null;
  }
  draw(page: PDFPage, x: number, top: number) {
    const h = this.height();
    drawRoundedRect(page, x, top, CONTENT_WIDTH, h, 4, { fill: COLORS.panel, border: COLORS.rule, borderWidth: 0.6 });
    let y = top - LegendFlow.PAD;
    drawLineAt(page, this.title, this.s.label, x + LegendFlow.PAD, y);
    y -= this.s.label.lineHeight + 4;
    for (const r of this.rows) {
      drawSeal(page, r.kind, r.label, x + LegendFlow.PAD, y - 1, this.s);
      r.lines.forEach((line, i) =>
        drawLineAt(page, line, this.s.small, x + LegendFlow.PAD + SEAL_COLUMN + SEAL_GAP, y - i * this.s.small.lineHeight),
      );
      y -= this.rowHeight(r);
    }
  }
}

// ---------------------------------------------------------------------------
// Blocos → flowables
// ---------------------------------------------------------------------------

function paragraphLines(text: string, style: TextStyle, width: number, role: Line["role"] = "text", indent = 0): Line[] {
  return wrap(text, style, width - indent).map((t) => ({ text: t, style, indent, gapBefore: 0, role }));
}

function toFlows(spec: PdfDocumentSpec, s: Styles): Flow[] {
  const flows: Flow[] = [];
  const sealLabel = (kind: SealKind) => spec.sealLegend?.labels[kind] ?? kind;
  for (const block of spec.blocks) {
    switch (block.type) {
      case "heading":
        flows.push(new HeadingFlow(block.text, block.number, block.level ?? 1, s));
        break;
      case "paragraph": {
        const styleKey = block.style ?? "body";
        const style: TextStyle = s[styleKey];
        const spaceBefore =
          block.spaceBefore ?? (styleKey === "title" ? 6 : styleKey === "subtitle" ? 8 : styleKey === "kicker" ? 0 : 6);
        flows.push(new ParagraphFlow(paragraphLines(block.text, style, CONTENT_WIDTH), spaceBefore, 0));
        break;
      }
      case "item": {
        const width = CONTENT_WIDTH - SEAL_COLUMN - SEAL_GAP;
        const lines: Line[] = paragraphLines(block.text, s.body, width);
        if (block.quote) {
          const quoteLines = paragraphLines(`“${block.quote}”`, s.quote, width, "quote", 8);
          if (quoteLines.length) quoteLines[0] = { ...quoteLines[0], gapBefore: 3 };
          lines.push(...quoteLines);
        }
        (block.notes ?? []).forEach((note, i) => {
          const noteLines = paragraphLines(note, s.note, width, "note");
          if (noteLines.length) noteLines[0] = { ...noteLines[0], gapBefore: i === 0 ? 3 : 0.5 };
          lines.push(...noteLines);
        });
        flows.push(new ItemFlow({ kind: block.seal, label: sealLabel(block.seal) }, block.number, lines, s, 9));
        break;
      }
      case "table": {
        const weights = block.columns.map((c) => c.weight ?? 1);
        const totalWeight = weights.reduce((a, b) => a + b, 0);
        const widths = weights.map((w) => (CONTENT_WIDTH * w) / totalWeight);
        const cellLines = (cells: string[], style: TextStyle) =>
          block.columns.map((_, i) => wrap(cells[i] ?? "", style, widths[i] - 2 * CELL_PAD_X));
        const rows: TableRow[] = [];
        if (block.rows.length === 0) {
          const cells = block.columns.map((_, i) => (i === 0 ? wrap(block.emptyText ?? "Nenhum registro.", s.td, CONTENT_WIDTH) : []));
          rows.push({ cells, height: s.td.lineHeight + 2 * CELL_PAD_Y, total: false, index: 0 });
        }
        const sealColumn = block.sealColumn ?? 0;
        block.rows.forEach((r, index) => {
          const sealKind = block.rowSeals?.[index] ?? null;
          const cells = cellLines(r, s.td);
          if (sealKind) cells[sealColumn] = [];
          const textHeight = Math.max(1, ...cells.map((c) => c.length)) * s.td.lineHeight + 2 * CELL_PAD_Y;
          rows.push({
            cells,
            // A linha com selo tem ao menos a altura do selo.
            height: sealKind ? Math.max(textHeight, SEAL_HEIGHT + 2 * CELL_PAD_Y - 0.4) : textHeight,
            total: false,
            index,
            seal: sealKind ? { kind: sealKind, label: sealLabel(sealKind) } : null,
          });
        });
        if (block.totals) {
          const cells = cellLines(block.totals, s.tdTotal);
          rows.push({
            cells,
            height: Math.max(1, ...cells.map((c) => c.length)) * s.tdTotal.lineHeight + 2 * CELL_PAD_Y,
            total: true,
            index: -1,
          });
        }
        flows.push(
          new TableFlow(
            {
              caption: block.caption,
              seal: block.seal ? { kind: block.seal, label: sealLabel(block.seal) } : null,
              columns: block.columns,
              widths,
              rows,
              note: block.note,
              continued: false,
              sealColumn,
            },
            s,
            12,
          ),
        );
        break;
      }
      case "keyValues": {
        const columns = block.columns ?? 2;
        const gap = 22;
        const colWidth = columns === 2 ? (CONTENT_WIDTH - gap) / 2 : CONTENT_WIDTH;
        const rows: { cells: { label: string[]; value: string[] }[]; height: number }[] = [];
        for (let i = 0; i < block.pairs.length; i += columns) {
          const cells = block.pairs.slice(i, i + columns).map((p) => ({
            label: wrap(p.label, s.label, colWidth),
            value: wrap(p.value.trim() || "Não informado", s.value, colWidth),
          }));
          const h = Math.max(
            ...cells.map((c) => 5 + c.label.length * s.label.lineHeight + 1 + c.value.length * s.value.lineHeight),
          );
          rows.push({ cells, height: h + 9 });
        }
        flows.push(new KeyValueFlow(rows, colWidth, gap, s, 8));
        break;
      }
      case "callout":
        flows.push(new CalloutFlow(block.tone, block.title, block.lines, s, 12));
        break;
      case "rule":
        flows.push(
          new RuleFlow(
            block.width ?? CONTENT_WIDTH,
            block.thickness ?? 0.6,
            block.color === "gold" ? COLORS.gold : COLORS.ruleStrong,
            block.spaceBefore ?? 8,
            block.spaceAfter ?? 8,
          ),
        );
        break;
      case "spacer":
        flows.push(new SpacerFlow(block.height));
        break;
      case "pageBreak":
        flows.push(new PageBreakFlow());
        break;
    }
  }
  if (spec.sealLegend) {
    const first = flows.findIndex((f) => f.hasSeal);
    if (first >= 0) {
      flows.splice(first, 0, new LegendFlow(spec.sealLegend.title, spec.sealLegend.labels, spec.sealLegend.descriptions, s));
    }
  }
  return flows;
}

// ---------------------------------------------------------------------------
// Paginação (1ª passada) e moldura (2ª passada)
// ---------------------------------------------------------------------------

/** Altura necessária para `flows[i]` e a cadeia de blocos presos a ele (keep-with-next). */
function chainNeed(flows: Flow[], i: number): number {
  let need = flows[i].height();
  let j = i;
  while (flows[j]?.keepWithNext && j + 1 < flows.length && flows[j + 1].kind !== "pageBreak") {
    const next = flows[j + 1];
    // O espaço depois do título também conta: sem ele o título cabia sozinho e ficava órfão no pé da página.
    need += flows[j].spaceAfter + next.spaceBefore + (next.keepWithNext ? next.height() : next.minHead());
    j += 1;
  }
  return need;
}

function paginate(pdf: PDFDocument, input: Flow[]): PDFPage[] {
  const pages: PDFPage[] = [];
  const x = PAGE.marginX;
  let page!: PDFPage;
  let cursor = 0;
  let empty = true;
  const newPage = () => {
    page = pdf.addPage([PAGE.width, PAGE.height]);
    pages.push(page);
    cursor = PAGE.contentTop;
    empty = true;
  };
  newPage();
  const queue = [...input];
  let guard = 0;
  while (queue.length) {
    guard += 1;
    if (guard > 200_000) throw new Error("Paginação não convergiu.");
    const f = queue[0];
    if (f.kind === "pageBreak") {
      queue.shift();
      if (!empty) newPage();
      continue;
    }
    const before = empty ? 0 : f.spaceBefore;
    const avail = cursor - PAGE.contentBottom;
    const h = f.height();
    const need = before + chainNeed(queue, 0);
    if (need <= avail) {
      queue.shift();
      f.draw(page, x, cursor - before);
      cursor -= before + h + f.spaceAfter;
      empty = false;
      continue;
    }
    // Título (ou cadeia presa) que caberia sozinho: vai inteiro para a próxima página.
    if (f.keepWithNext && !empty) {
      newPage();
      continue;
    }
    if (!f.keepWithNext) {
      const parts = f.split(avail - before);
      if (parts) {
        queue.shift();
        parts[0].draw(page, x, cursor - before);
        queue.unshift(parts[1]);
        newPage();
        continue;
      }
    }
    if (!empty) {
      newPage();
      continue;
    }
    // Página vazia e o bloco ainda não cabe nem se divide: desenha assim mesmo (conteúdo excepcional).
    queue.shift();
    f.draw(page, x, cursor);
    cursor -= h + f.spaceAfter;
    empty = false;
  }
  // Uma quebra de página final não deixa página em branco.
  if (pages.length > 1 && empty) {
    pdf.removePage(pages.length - 1);
    pages.pop();
  }
  return pages;
}

function drawChrome(page: PDFPage, index: number, total: number, spec: PdfDocumentSpec, s: Styles) {
  const top = PAGE.height - 30;
  const markHeight = 12.5;
  drawWordmark(page, { x: PAGE.marginX, top, height: markHeight });
  // Faixa "CONFIDENCIAL · USO INTERNO" à direita.
  const stripeText = spec.headerStripe;
  const stripeH = 13;
  const stripeW = widthOf(stripeText, s.chromeStripe) + 14;
  const stripeX = PAGE.width - PAGE.marginX - stripeW;
  const stripeTop = top - markHeight / 2 + stripeH / 2;
  page.drawRectangle({ x: stripeX, y: stripeTop - stripeH, width: stripeW, height: stripeH, color: COLORS.navy });
  page.drawRectangle({ x: stripeX, y: stripeTop - stripeH, width: 2.2, height: stripeH, color: COLORS.gold });
  drawTextRun(page, stripeText, s.chromeStripe, stripeX + 7.6, stripeTop - stripeH + (stripeH - capHeight(s.chromeStripe)) / 2);
  page.drawLine({
    start: { x: PAGE.marginX, y: PAGE.height - 52 },
    end: { x: PAGE.width - PAGE.marginX, y: PAGE.height - 52 },
    thickness: 0.8,
    color: COLORS.gold,
  });

  // Rodapé.
  page.drawLine({ start: { x: PAGE.marginX, y: 56 }, end: { x: PAGE.width - PAGE.marginX, y: 56 }, thickness: 0.5, color: COLORS.rule });
  const line1 = [`Página ${index} de ${total}`, spec.footer.reference, spec.footer.baseDateLabel].filter(Boolean).join("  ·  ");
  const l1 = fitLine(line1, s.footer.font, s.footer.size, PAGE.width - 2 * PAGE.marginX);
  drawTextRun(page, l1, s.footer, (PAGE.width - widthOf(l1, s.footer)) / 2, 44);
  const l2 = fitLine(spec.footer.statement, s.footerStatement.font, s.footerStatement.size, PAGE.width - 2 * PAGE.marginX);
  drawTextRun(page, l2, s.footerStatement, (PAGE.width - widthOf(l2, s.footerStatement)) / 2, 33);

  if (spec.watermark) {
    const angle = 36;
    const rad = (angle * Math.PI) / 180;
    const w = widthOf(spec.watermark, s.watermark);
    const ch = capHeight(s.watermark);
    const cx = PAGE.width / 2;
    const cy = PAGE.height / 2;
    const ox = cx - (w / 2) * Math.cos(rad) + (ch / 2) * Math.sin(rad);
    const oy = cy - (w / 2) * Math.sin(rad) - (ch / 2) * Math.cos(rad);
    drawTextRun(page, spec.watermark, s.watermark, ox, oy, { opacity: 0.075, rotate: angle });
  }
}

/** Renderiza o documento: paginação (1ª passada) + moldura com "Página X de Y" e marca d'água (2ª passada). */
export async function renderPdf(spec: PdfDocumentSpec): Promise<RenderedPdf> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  const fonts = await embedFonts(pdf);
  const styles = buildStyles(fonts);
  const pages = paginate(pdf, toFlows(spec, styles));
  pages.forEach((page, i) => drawChrome(page, i + 1, pages.length, spec, styles));

  pdf.setTitle(sanitizePdfText(spec.info.title), { showInWindowTitleBar: true });
  if (spec.info.subject) pdf.setSubject(sanitizePdfText(spec.info.subject));
  if (spec.info.keywords?.length) pdf.setKeywords(spec.info.keywords.map((k) => sanitizePdfText(k)));
  pdf.setAuthor("Praetor");
  pdf.setCreator("Praetor");
  pdf.setProducer("Praetor (motor de relatórios)");
  pdf.setLanguage(spec.info.language ?? "pt-BR");
  pdf.setCreationDate(spec.info.createdAt);
  pdf.setModificationDate(spec.info.createdAt);

  const bytes = await pdf.save();
  return { bytes, pageCount: pages.length };
}
