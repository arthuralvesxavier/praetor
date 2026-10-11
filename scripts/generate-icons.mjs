/**
 * Generates raster icons from the brand SVG (src/app/icon.svg):
 *   - src/app/favicon.ico  (16, 32 and 48 px PNGs inside an ICO container)
 *   - src/app/apple-icon.png (180 px)
 * Run after changing the logo: `node scripts/generate-icons.mjs`.
 * Browsers request /favicon.ico on their own and cache it aggressively, so it
 * must exist and match the current logo.
 */
import { readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";

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
await writeFile("src/app/apple-icon.png", await render(180));
console.log("Ícones gerados: src/app/favicon.ico, src/app/apple-icon.png");
