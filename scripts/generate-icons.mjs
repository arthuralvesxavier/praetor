/**
 * Generates the brand assets derived from the client's artwork:
 *   - src/app/favicon.ico  (16, 32 and 48 px PNGs inside an ICO container), from src/app/icon.svg
 *   - src/app/apple-icon.png (180 px), from src/app/icon.svg
 *   - src/components/brand/wordmark-paths.ts, the outlined "PRAETOR" letters
 *     copied verbatim from public/brand/praetor-logo.svg (used by LogoWordmark)
 * Run after changing the logo: `node scripts/generate-icons.mjs` (from the repo root).
 * Browsers request /favicon.ico on their own and cache it aggressively, so it
 * must exist and match the current logo.
 */
import { readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";

// ----------------------------------------------------------------- rasters
const svg = await readFile("src/app/icon.svg");
const render = (size) => sharp(svg, { density: 384 }).resize(size, size).png().toBuffer();

const sizes = [16, 32, 48];
const pngs = await Promise.all(sizes.map(render));

// ICO container with embedded PNGs (supported by every current browser).
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(sizes.length, 4);
const entries = [];
let offset = 6 + 16 * sizes.length;
sizes.forEach((size, i) => {
  const e = Buffer.alloc(16);
  e.writeUInt8(size, 0); // width
  e.writeUInt8(size, 1); // height
  e.writeUInt8(0, 2); // palette
  e.writeUInt8(0, 3); // reserved
  e.writeUInt16LE(1, 4); // color planes
  e.writeUInt16LE(32, 6); // bits per pixel
  e.writeUInt32LE(pngs[i].length, 8);
  e.writeUInt32LE(offset, 12);
  offset += pngs[i].length;
  entries.push(e);
});
await writeFile("src/app/favicon.ico", Buffer.concat([header, ...entries, ...pngs]));
// iOS applies its own rounded mask: the touch icon must be a full-bleed square (transparent corners turn black).
const square = Buffer.from(
  svg.toString("utf8").replace(/<rect width="32" height="32" rx="[\d.]+"/, '<rect width="32" height="32" rx="0"'),
);
await writeFile("src/app/apple-icon.png", await sharp(square, { density: 384 }).resize(180, 180).png().toBuffer());

// ------------------------------------------------------- wordmark letters
const logo = await readFile("public/brand/praetor-logo.svg", "utf8");
const letters = "PRAETOR".split("");
const found = [...logo.matchAll(/<path transform="translate\(([-\d.]+) 0\)" d="([^"]+)"\/>/g)].map((m) => ({
  x: Number(m[1]),
  d: m[2],
}));
if (found.length !== letters.length)
  throw new Error(`praetor-logo.svg: esperados 7 glifos, encontrados ${found.length}`);
const group = logo.match(
  /<g transform="translate\(([-\d.]+) ([-\d.]+)\)"><g fill="#[0-9A-Fa-f]{6}" transform="translate\(([-\d.]+) ([-\d.]+)\) scale\(([-\d.]+) ([-\d.]+)\)">/,
);
if (!group) throw new Error("praetor-logo.svg: transformação do grupo de letras não encontrada");
const [, gx, gy, ix, iy, sx, sy] = group;

const glyphs = {};
const sequence = found.map((g, i) => {
  const key = letters[i];
  if (glyphs[key] && glyphs[key] !== g.d) throw new Error(`praetor-logo.svg: glifo ${key} diverge`);
  glyphs[key] = g.d;
  return { glyph: key, x: g.x };
});

const ts = [
  "/**",
  " * Outlined serif letters of the official PRAETOR wordmark, copied verbatim from",
  " * public/brand/praetor-logo.svg by scripts/generate-icons.mjs (do not edit by hand).",
  " *",
  " * Glyphs are in font units (cap height 700, baseline 0, y up); LETTERS_TRANSFORM",
  " * places them in the wordmark's coordinate system, where the symbol occupies",
  " * x/y 24..144 (symbol path scaled 5x and translated by 4).",
  " */",
  `export const LETTERS_TRANSFORM = "translate(${gx} ${gy}) translate(${ix} ${iy}) scale(${sx} ${sy})";`,
  "",
  "export const GLYPHS = {",
  ...Object.entries(glyphs).map(([k, d]) => `  ${k}: "${d}",`),
  "} as const;",
  "",
  "export const LETTERS: readonly { glyph: keyof typeof GLYPHS; x: number }[] = [",
  ...sequence.map((s) => `  { glyph: "${s.glyph}", x: ${s.x} },`),
  "];",
  "",
].join("\n");
await writeFile("src/components/brand/wordmark-paths.ts", ts);

console.log("Gerados: src/app/favicon.ico, src/app/apple-icon.png, src/components/brand/wordmark-paths.ts");
