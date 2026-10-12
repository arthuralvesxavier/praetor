import { readFile } from "node:fs/promises";
import path from "node:path";
import * as fontkitModule from "@pdf-lib/fontkit";
import type { PDFDocument, PDFFont } from "pdf-lib";

type Fontkit = Parameters<PDFDocument["registerFontkit"]>[0];
// The package ships an ES build with only a default export but typings with named exports.
const realFontkit: Fontkit =
  (fontkitModule as unknown as { default?: Fontkit }).default ?? (fontkitModule as unknown as Fontkit);

type LayoutFn = (text: string, features?: unknown, ...rest: unknown[]) => unknown;
const LAYOUT_CACHE_LIMIT = 20_000;

/**
 * fontkit com cache de composição: dentro de UM documento, o resultado de
 * `layout` (texto + recursos OpenType) é memorizado, então medir e desenhar o
 * mesmo texto (cabeçalhos de tabela, "Não apurado", rodapé) não refaz a
 * composição OpenType, que domina o tempo de geração.
 *
 * O objeto da fonte NÃO é compartilhado entre documentos: o fontkit guarda um
 * objeto por glifo com os code points da primeira criação; o subconjunto de um
 * documento cria glifos componentes (ex.: o "A" de "Ã") sem code points, e um
 * documento seguinte que reusasse a fonte perderia esses caracteres no mapa
 * ToUnicode (texto não pesquisável). Cada documento analisa a fonte de novo.
 */
const fontkit: Fontkit = {
  create(buffer: Uint8Array, postscriptName?: string) {
    const font = realFontkit.create(buffer, postscriptName);
    const target = font as unknown as { layout: LayoutFn };
    const original: LayoutFn = target.layout.bind(font);
    const memo = new Map<string, unknown>();
    target.layout = (text, features, ...rest) => {
      if (rest.length) return original(text, features, ...rest);
      const key = `${features ? JSON.stringify(features) : ""}|${text}`;
      let run = memo.get(key);
      if (run === undefined) {
        run = original(text, features);
        if (memo.size >= LAYOUT_CACHE_LIMIT) memo.clear();
        memo.set(key, run);
      }
      return run;
    };
    return font;
  },
} as Fontkit;

/**
 * Fontes EMBUTIDAS nos PDFs (nunca as 14 fontes padrão do PDF):
 *
 * - Inter 4.1 (estáticas Regular/Medium/SemiBold/Bold), do release oficial
 *   https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip
 *   (`extras/ttf/`). Licença SIL OFL 1.1: `fonts/inter/OFL.txt`.
 * - Cormorant Garamond 4.000 (estáticas Regular/SemiBold/Bold), de
 *   github.com/google/fonts `ofl/cormorantgaramond` no commit 6a386aad (o
 *   diretório atual só tem a fonte variável). Licença SIL OFL 1.1:
 *   `fonts/cormorant-garamond/OFL.txt`.
 *
 * As duas licenças permitem embutir as fontes em documentos (OS/2 fsType = 0,
 * instalável, subconjunto permitido). Os PDFs levam só o subconjunto de glifos
 * usados.
 */
export const FONT_FILES = {
  sans: "inter/Inter-Regular.ttf",
  sansMedium: "inter/Inter-Medium.ttf",
  sansSemiBold: "inter/Inter-SemiBold.ttf",
  sansBold: "inter/Inter-Bold.ttf",
  serif: "cormorant-garamond/CormorantGaramond-Regular.ttf",
  serifSemiBold: "cormorant-garamond/CormorantGaramond-SemiBold.ttf",
  serifBold: "cormorant-garamond/CormorantGaramond-Bold.ttf",
} as const;

export type FontRole = keyof typeof FONT_FILES;
export type Fonts = Record<FontRole, PDFFont>;

/** Diretório das fontes (o servidor e o worker rodam a partir da raiz do projeto). */
export function fontsDirectory(): string {
  return path.join(process.cwd(), "src", "server", "pdf", "fonts");
}

const cache = new Map<FontRole, Promise<Uint8Array>>();

function loadFontBytes(role: FontRole): Promise<Uint8Array> {
  let pending = cache.get(role);
  if (!pending) {
    pending = readFile(path.join(fontsDirectory(), FONT_FILES[role])).then((b) => new Uint8Array(b));
    // A failed read must not stay cached (e.g. transient I/O error).
    pending.catch(() => cache.delete(role));
    cache.set(role, pending);
  }
  return pending;
}

/** Registra o fontkit e embute (em subconjunto) todas as fontes do tema. */
export async function embedFonts(pdf: PDFDocument): Promise<Fonts> {
  pdf.registerFontkit(fontkit);
  const roles = Object.keys(FONT_FILES) as FontRole[];
  const bytes = await Promise.all(roles.map((r) => loadFontBytes(r)));
  const fonts = {} as Fonts;
  for (let i = 0; i < roles.length; i += 1) {
    // Cormorant usa algarismos de estilo antigo por padrão; números (referência, datas, CNJ) pedem algarismos alinhados.
    const features = roles[i].startsWith("serif") ? { lnum: true } : undefined;
    fonts[roles[i]] = await pdf.embedFont(bytes[i], { subset: true, features });
  }
  return fonts;
}
