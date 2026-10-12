/**
 * Reads every sheet of an .xlsx file from bytes. Uses the "universal" build of
 * read-excel-file (pure JavaScript, no worker threads), so it runs the same way
 * in route handlers, the seed script and tests.
 */
import readXlsxFile from "read-excel-file/universal";
import { MAX_IMPORT_UNCOMPRESSED_BYTES, MAX_IMPORT_ZIP_ENTRIES } from "./limits";
import type { RawCell, RawSheet } from "./parser";

/** .xlsx files are ZIP archives: local file header "PK\x03\x04". */
export function hasZipSignature(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/**
 * The file cannot be imported. `reason` = "invalid" (not a readable .xlsx) or
 * "too_large" (the unzipped content exceeds `MAX_IMPORT_UNCOMPRESSED_BYTES`,
 * has too many entries or uses ZIP64).
 */
export class UnreadableWorkbookError extends Error {
  readonly reason: "invalid" | "too_large";
  constructor(reason: "invalid" | "too_large" = "invalid") {
    super(reason === "too_large" ? "workbook_too_large" : "unreadable_workbook");
    this.name = "UnreadableWorkbookError";
    this.reason = reason;
  }
}

export type ZipDirectorySummary = { entries: number; uncompressedBytes: number };

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const EOCD_SIZE = 22;
const CENTRAL_HEADER_SIZE = 46;
const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;

/**
 * Reads the ZIP central directory WITHOUT decompressing anything and checks the
 * declared sizes against the import limits. The unzip library used by the
 * reader (fflate, through read-excel-file) sizes each output buffer from these
 * same central-directory fields, so their sum bounds the memory of the unzip.
 * Throws `UnreadableWorkbookError("too_large")` above the limits (or for ZIP64,
 * which a spreadsheet of the allowed size never needs) and
 * `UnreadableWorkbookError("invalid")` for a malformed directory.
 */
export function inspectZipDirectory(
  bytes: Uint8Array,
  limits: { maxUncompressedBytes?: number; maxEntries?: number } = {},
): ZipDirectorySummary {
  const maxBytes = limits.maxUncompressedBytes ?? MAX_IMPORT_UNCOMPRESSED_BYTES;
  const maxEntries = limits.maxEntries ?? MAX_IMPORT_ZIP_ENTRIES;
  if (bytes.byteLength < EOCD_SIZE) throw new UnreadableWorkbookError();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // End of central directory: last record with the signature (same search as the unzip library).
  let eocd = -1;
  const lowest = Math.max(0, bytes.byteLength - EOCD_SIZE - U16_MAX);
  for (let i = bytes.byteLength - EOCD_SIZE; i >= lowest; i--) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new UnreadableWorkbookError();

  const entriesOnDisk = view.getUint16(eocd + 8, true);
  const entriesTotal = view.getUint16(eocd + 10, true);
  const directorySize = view.getUint32(eocd + 12, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  const zip64 =
    entriesOnDisk === U16_MAX ||
    entriesTotal === U16_MAX ||
    directorySize === U32_MAX ||
    directoryOffset === U32_MAX ||
    (eocd >= 20 && view.getUint32(eocd - 20, true) === ZIP64_LOCATOR_SIGNATURE);
  if (zip64) throw new UnreadableWorkbookError("too_large");
  const entries = Math.max(entriesOnDisk, entriesTotal);
  if (entries > maxEntries) throw new UnreadableWorkbookError("too_large");
  const end = directoryOffset + directorySize;
  if (end > eocd) throw new UnreadableWorkbookError();

  let pos = directoryOffset;
  let uncompressedBytes = 0;
  for (let n = 0; n < entries; n++) {
    if (pos + CENTRAL_HEADER_SIZE > end || view.getUint32(pos, true) !== CENTRAL_HEADER_SIGNATURE) {
      throw new UnreadableWorkbookError();
    }
    const compressedSize = view.getUint32(pos + 20, true);
    const uncompressedSize = view.getUint32(pos + 24, true);
    const localHeaderOffset = view.getUint32(pos + 42, true);
    if (compressedSize === U32_MAX || uncompressedSize === U32_MAX || localHeaderOffset === U32_MAX) {
      throw new UnreadableWorkbookError("too_large"); // ZIP64 entry
    }
    uncompressedBytes += uncompressedSize;
    if (uncompressedBytes > maxBytes) throw new UnreadableWorkbookError("too_large");
    pos += CENTRAL_HEADER_SIZE + view.getUint16(pos + 28, true) + view.getUint16(pos + 30, true) + view.getUint16(pos + 32, true);
  }
  return { entries, uncompressedBytes };
}

/**
 * All sheets with their cell values. Throws `UnreadableWorkbookError` for files
 * that are not valid .xlsx (`reason: "invalid"`) or whose unzipped content is
 * above the import limits (`reason: "too_large"`, checked before unzipping).
 */
export async function readWorkbook(bytes: Uint8Array): Promise<RawSheet[]> {
  if (!hasZipSignature(bytes)) throw new UnreadableWorkbookError();
  inspectZipDirectory(bytes);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  try {
    const sheets = await readXlsxFile(buffer);
    return sheets.map((s) => ({ name: s.sheet, rows: s.data as unknown as RawCell[][] }));
  } catch {
    throw new UnreadableWorkbookError();
  }
}
