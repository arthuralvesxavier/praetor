/**
 * Reads every sheet of an .xlsx file from bytes. Uses the "universal" build of
 * read-excel-file (pure JavaScript, no worker threads), so it runs the same way
 * in route handlers, the seed script and tests.
 */
import readXlsxFile from "read-excel-file/universal";
import type { RawCell, RawSheet } from "./parser";

/** .xlsx files are ZIP archives: local file header "PK\x03\x04". */
export function hasZipSignature(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

export class UnreadableWorkbookError extends Error {
  constructor() {
    super("unreadable_workbook");
    this.name = "UnreadableWorkbookError";
  }
}

/** All sheets with their cell values. Throws `UnreadableWorkbookError` for files that are not valid .xlsx. */
export async function readWorkbook(bytes: Uint8Array): Promise<RawSheet[]> {
  if (!hasZipSignature(bytes)) throw new UnreadableWorkbookError();
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  try {
    const sheets = await readXlsxFile(buffer);
    return sheets.map((s) => ({ name: s.sheet, rows: s.data as unknown as RawCell[][] }));
  } catch {
    throw new UnreadableWorkbookError();
  }
}
