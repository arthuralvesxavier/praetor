import type { PDFFont } from "pdf-lib";

/**
 * Texto seguro para o PDF: sem travessão nem meia-risca (regra do produto:
 * travessão entre espaços vira ", " e um traço isolado vira "-"), sem hífen discricionário,
 * caracteres de controle ou espaços de largura zero. Quebras de linha são
 * preservadas. `keepDashes`: trecho LITERAL de documento (citação), reproduzido
 * como está na fonte, travessões inclusive.
 */
export function sanitizePdfText(value: string | null | undefined, opts: { keepDashes?: boolean } = {}): string {
  if (!value) return "";
  const clean = value
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u00ad\u200b-\u200d\u2060\ufeff]/g, "");
  if (opts.keepDashes) return clean;
  return clean
    .replace(/[ \u00a0]+[\u2012-\u2015][ \u00a0]+/g, ", ")
    .replace(/[\u2012-\u2015]/g, "-");
}

/** Largura do texto com espaçamento entre letras (Tc aplicado a cada caractere). */
export function textWidth(font: PDFFont, size: number, text: string, letterSpacing = 0): number {
  if (!text) return 0;
  return font.widthOfTextAtSize(text, size) + letterSpacing * [...text].length;
}

/**
 * Quebra em linhas que cabem em `maxWidth`, sem hifenizar: quebra nos espaços;
 * uma palavra maior que a linha é cortada entre caracteres (sem inserir hífen).
 * `\n` força quebra. Nunca devolve lista vazia para texto não vazio.
 */
export function wrapText(
  text: string,
  font: PDFFont,
  size: number,
  maxWidth: number,
  letterSpacing = 0,
  opts: { keepDashes?: boolean } = {},
): string[] {
  // Largura por palavra (cacheada); linha = soma das palavras + espaços. Ignorar o kerning entre
  // palavras muda menos de 0,1 pt por linha e evita medir a linha inteira a cada palavra.
  const widths = new Map<string, number>();
  const width = (s: string) => {
    let w = widths.get(s);
    if (w === undefined) {
      w = textWidth(font, size, s, letterSpacing);
      widths.set(s, w);
    }
    return w;
  };
  const space = width(" ");
  const lines: string[] = [];
  for (const paragraph of sanitizePdfText(text, opts).split("\n")) {
    const words = paragraph.split(/ +/).filter((w, i, arr) => w !== "" || arr.length === 1);
    if (words.length === 0 || (words.length === 1 && words[0] === "")) {
      lines.push("");
      continue;
    }
    let current = "";
    let currentWidth = 0;
    for (const word of words) {
      const ww = width(word);
      if (current && currentWidth + space + ww <= maxWidth) {
        current = `${current} ${word}`;
        currentWidth += space + ww;
        continue;
      }
      if (current) lines.push(current);
      if (ww <= maxWidth) {
        current = word;
        currentWidth = ww;
        continue;
      }
      // Palavra maior que a linha (ex.: hash, URL): corta entre caracteres, sem hífen.
      let chunk = "";
      for (const ch of [...word]) {
        if (chunk && textWidth(font, size, chunk + ch, letterSpacing) > maxWidth) {
          lines.push(chunk);
          chunk = ch;
        } else chunk += ch;
      }
      current = chunk;
      currentWidth = textWidth(font, size, chunk, letterSpacing);
    }
    lines.push(current);
  }
  return lines;
}

/** Corta uma linha única com reticências para caber em `maxWidth`. */
export function fitLine(text: string, font: PDFFont, size: number, maxWidth: number, letterSpacing = 0): string {
  const clean = sanitizePdfText(text).replace(/\n/g, " ");
  if (textWidth(font, size, clean, letterSpacing) <= maxWidth) return clean;
  const chars = [...clean];
  while (chars.length > 1 && textWidth(font, size, `${chars.join("")}…`, letterSpacing) > maxWidth) chars.pop();
  return `${chars.join("").trimEnd()}…`;
}
