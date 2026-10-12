import type { PDFPage, RGB } from "pdf-lib";
import { GLYPHS, LETTERS, LETTERS_TRANSFORM } from "@/components/brand/wordmark-paths";
import { COLORS } from "./theme";

/**
 * Wordmark PRAETOR em vetor no PDF, com os MESMOS caminhos da marca
 * (`src/components/brand/wordmark-paths.ts` para as letras; arco e quadrado
 * copiados de `src/components/brand/logo.tsx`, conferidos por teste).
 */
export const BRAND_ARCH_PATH = "M4 28V14A10 10 0 0 1 14 4H18A10 10 0 0 1 28 14V18H22V16A6 6 0 0 0 10 16V28Z";
export const BRAND_SQUARE_PATH = "M22 22H28V28H22Z";

/** viewBox do wordmark horizontal: "24 24 882.72 120". */
const VIEW = { x: 24, y: 24, width: 882.72, height: 120 } as const;

type Affine = { sx: number; sy: number; tx: number; ty: number };

function parseLettersTransform(transform: string): { tx: number; ty: number; sx: number; sy: number } {
  const nums = (re: RegExp) => {
    const m = re.exec(transform);
    if (!m) throw new Error("LETTERS_TRANSFORM em formato inesperado.");
    return [Number(m[1]), Number(m[2])];
  };
  const translates = [...transform.matchAll(/translate\(\s*([-\d.]+)[\s,]+([-\d.]+)\s*\)/g)].map((m) => [
    Number(m[1]),
    Number(m[2]),
  ]);
  const [sx, sy] = nums(/scale\(\s*([-\d.]+)[\s,]+([-\d.]+)\s*\)/);
  if (translates.length === 0) throw new Error("LETTERS_TRANSFORM sem translate.");
  const tx = translates.reduce((a, t) => a + t[0], 0);
  const ty = translates.reduce((a, t) => a + t[1], 0);
  return { tx, ty, sx, sy };
}

/**
 * Aplica uma transformação afim alinhada aos eixos a um caminho SVG com
 * comandos ABSOLUTOS (M, L, H, V, Q, T, C, S, Z), como os glifos do wordmark.
 */
export function transformSvgPath(d: string, t: Affine): string {
  const tokens = d.match(/[A-Za-z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? [];
  const out: string[] = [];
  let cmd = "";
  let i = 0;
  const num = () => Number(tokens[i++]);
  const fx = (x: number) => +(t.sx * x + t.tx).toFixed(4);
  const fy = (y: number) => +(t.sy * y + t.ty).toFixed(4);
  while (i < tokens.length) {
    const tok = tokens[i];
    if (/^[A-Za-z]$/.test(tok)) {
      cmd = tok;
      i += 1;
      if (cmd === "Z" || cmd === "z") {
        out.push("Z");
        continue;
      }
      if (cmd !== cmd.toUpperCase() || cmd === "A") throw new Error(`Comando SVG não suportado: ${cmd}`);
    }
    switch (cmd) {
      case "M":
      case "L":
      case "T": {
        const x = num();
        const y = num();
        out.push(`${cmd}${fx(x)} ${fy(y)}`);
        if (cmd === "M") cmd = "L"; // pares seguintes de um M são L
        break;
      }
      case "H":
        out.push(`H${fx(num())}`);
        break;
      case "V":
        out.push(`V${fy(num())}`);
        break;
      case "Q":
      case "S": {
        const x1 = num();
        const y1 = num();
        const x = num();
        const y = num();
        out.push(`${cmd}${fx(x1)} ${fy(y1)} ${fx(x)} ${fy(y)}`);
        break;
      }
      case "C": {
        const v = [num(), num(), num(), num(), num(), num()];
        out.push(`C${fx(v[0])} ${fy(v[1])} ${fx(v[2])} ${fy(v[3])} ${fx(v[4])} ${fy(v[5])}`);
        break;
      }
      default:
        throw new Error(`Caminho SVG inválido perto de "${tok}".`);
    }
  }
  return out.join("");
}

let letterPaths: string[] | null = null;

/** Letras do wordmark já no sistema de coordenadas do viewBox (y para baixo). */
function wordmarkLetterPaths(): string[] {
  if (!letterPaths) {
    const base = parseLettersTransform(LETTERS_TRANSFORM);
    letterPaths = LETTERS.map((l) =>
      transformSvgPath(GLYPHS[l.glyph], {
        sx: base.sx,
        sy: base.sy,
        tx: base.tx + base.sx * l.x,
        ty: base.ty,
      }),
    );
  }
  return letterPaths;
}

/** Proporção largura/altura do wordmark. */
export const WORDMARK_ASPECT = VIEW.width / VIEW.height;

/**
 * Desenha o wordmark com o canto superior esquerdo em (x, top), em pontos do
 * PDF (y para cima). Devolve a largura desenhada.
 */
export function drawWordmark(
  page: PDFPage,
  opts: { x: number; top: number; height: number; letters?: RGB; arch?: RGB; square?: RGB },
): number {
  const s = opts.height / VIEW.height;
  const letters = opts.letters ?? COLORS.navy;
  const arch = opts.arch ?? COLORS.navy;
  const square = opts.square ?? COLORS.gold;
  // Símbolo: translate(4 4) scale(5) no grid de 32.
  const symbolX = opts.x + (4 - VIEW.x) * s;
  const symbolY = opts.top - (4 - VIEW.y) * s;
  page.drawSvgPath(BRAND_ARCH_PATH, { x: symbolX, y: symbolY, scale: 5 * s, color: arch });
  page.drawSvgPath(BRAND_SQUARE_PATH, { x: symbolX, y: symbolY, scale: 5 * s, color: square });
  for (const d of wordmarkLetterPaths()) {
    page.drawSvgPath(d, { x: opts.x - VIEW.x * s, y: opts.top + VIEW.y * s, scale: s, color: letters });
  }
  return VIEW.width * s;
}
