import { describe, expect, it } from "vitest";
import { MAX_IMPORT_UNCOMPRESSED_BYTES, MAX_IMPORT_ZIP_ENTRIES } from "@/modules/imports/limits";
import { inspectZipDirectory, readWorkbook, UnreadableWorkbookError } from "@/modules/imports/xlsx";
import { demoBytes } from "../../imports/helpers";
import { craftZip, MB } from "./zip-helpers";

function reasonOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    expect(err).toBeInstanceOf(UnreadableWorkbookError);
    return (err as UnreadableWorkbookError).reason;
  }
}

describe("decompressed-size guard of the .xlsx import (zip bomb)", () => {
  it("keeps the limits in the client-safe constants", () => {
    expect(MAX_IMPORT_UNCOMPRESSED_BYTES).toBe(200 * MB);
    expect(MAX_IMPORT_ZIP_ENTRIES).toBeGreaterThanOrEqual(1000);
  });

  it("accepts the demo spreadsheet and reports its declared size without unzipping", async () => {
    const summary = inspectZipDirectory(await demoBytes());
    expect(summary.entries).toBeGreaterThan(5);
    expect(summary.uncompressedBytes).toBeGreaterThan(1 * MB);
    expect(summary.uncompressedBytes).toBeLessThan(MAX_IMPORT_UNCOMPRESSED_BYTES);
  });

  it("rejects an archive whose entries declare more than the limit in total", () => {
    const bomb = craftZip([
      { name: "xl/worksheets/sheet1.xml", uncompressedSize: 150 * MB },
      { name: "xl/worksheets/sheet2.xml", uncompressedSize: 120 * MB },
    ]);
    expect(bomb.byteLength).toBeLessThan(500); // tiny file, huge declared content
    expect(reasonOf(() => inspectZipDirectory(bomb))).toBe("too_large");
    // Just under the limit is fine.
    const ok = craftZip([{ name: "xl/worksheets/sheet1.xml", uncompressedSize: 199 * MB }]);
    expect(inspectZipDirectory(ok)).toEqual({ entries: 1, uncompressedBytes: 199 * MB });
  });

  it("treats ZIP64 markers and too many entries as too large", () => {
    expect(reasonOf(() => inspectZipDirectory(craftZip([{ name: "a.xml", uncompressedSize: 0xffffffff }])))).toBe("too_large");
    expect(reasonOf(() => inspectZipDirectory(craftZip([{ name: "a.xml", uncompressedSize: 1 }], { entriesInEocd: 0xffff })))).toBe("too_large");
    const many = craftZip(Array.from({ length: 4 }, (_, i) => ({ name: `f${i}.xml`, uncompressedSize: 10 })));
    expect(reasonOf(() => inspectZipDirectory(many, { maxEntries: 3 }))).toBe("too_large");
    expect(inspectZipDirectory(many, { maxEntries: 4 }).entries).toBe(4);
  });

  it("rejects a malformed central directory as invalid", () => {
    const zip = craftZip([{ name: "a.xml", uncompressedSize: 10 }]);
    // Directory claims more entries than it has.
    expect(reasonOf(() => inspectZipDirectory(craftZip([{ name: "a.xml", uncompressedSize: 10 }], { entriesInEocd: 2 })))).toBe("invalid");
    // No end-of-central-directory record.
    expect(reasonOf(() => inspectZipDirectory(zip.slice(0, zip.byteLength - 22)))).toBe("invalid");
    expect(reasonOf(() => inspectZipDirectory(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4])))).toBe("invalid");
  });

  it("readWorkbook refuses the bomb before handing it to the unzip library", async () => {
    const bomb = craftZip([{ name: "xl/worksheets/sheet1.xml", uncompressedSize: 250 * MB }]);
    const err = await readWorkbook(bomb).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UnreadableWorkbookError);
    expect((err as UnreadableWorkbookError).reason).toBe("too_large");
    // Invalid files keep the "invalid" reason.
    const invalid = await readWorkbook(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4])).then(
      () => null,
      (e: unknown) => e,
    );
    expect((invalid as UnreadableWorkbookError).reason).toBe("invalid");
  });
});
