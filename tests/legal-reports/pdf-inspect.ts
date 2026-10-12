import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFStream } from "pdf-lib";
import { extractText, getDocumentProxy } from "unpdf";

/** Helpers dos testes de PDF: texto por página (pdf.js/unpdf) e fontes declaradas no arquivo. */

export async function pageTexts(bytes: Uint8Array): Promise<string[]> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: false });
  return (text as string[]).map((t) => t.replace(/\s+/g, " "));
}

export type FontInfo = { name: string; subtype: string; embedded: boolean };

/** Lê os dicionários de fonte: nome, subtipo e se o programa da fonte está embutido (FontFile/2/3). */
export async function fontDictionaries(bytes: Uint8Array): Promise<FontInfo[]> {
  const doc = await PDFDocument.load(bytes);
  const out: FontInfo[] = [];
  const lookupDict = (v: unknown): PDFDict | undefined => {
    const resolved = doc.context.lookup(v as never);
    return resolved instanceof PDFDict ? resolved : undefined;
  };
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    const dict = obj instanceof PDFDict ? obj : obj instanceof PDFStream || obj instanceof PDFRawStream ? obj.dict : null;
    if (!dict || dict.get(PDFName.of("Type")) !== PDFName.of("Font")) continue;
    const subtype = String(dict.get(PDFName.of("Subtype")) ?? "");
    if (subtype === "/CIDFontType2" || subtype === "/CIDFontType0") continue; // descendentes contados pelo Type0
    const name = String(dict.get(PDFName.of("BaseFont")) ?? "");
    let descriptor = lookupDict(dict.get(PDFName.of("FontDescriptor")));
    if (!descriptor) {
      const descendants = doc.context.lookup(dict.get(PDFName.of("DescendantFonts")) as never);
      const first = descendants instanceof PDFArray ? descendants.get(0) : undefined;
      const cid = lookupDict(first);
      descriptor = cid ? lookupDict(cid.get(PDFName.of("FontDescriptor"))) : undefined;
    }
    const embedded =
      !!descriptor &&
      ["FontFile", "FontFile2", "FontFile3"].some((k) => descriptor!.get(PDFName.of(k)) !== undefined);
    out.push({ name, subtype, embedded });
  }
  return out;
}
