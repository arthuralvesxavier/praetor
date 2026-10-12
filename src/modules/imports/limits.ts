/** Upload limit of the portfolio spreadsheet (client-safe constants). */
export const MAX_IMPORT_MB = 15;
export const MAX_IMPORT_BYTES = MAX_IMPORT_MB * 1024 * 1024;

/**
 * Limits of the .xlsx content (checked before the workbook is unzipped and parsed),
 * so a small compressed file cannot exhaust the server memory.
 */
export const MAX_IMPORT_UNCOMPRESSED_MB = 200;
export const MAX_IMPORT_UNCOMPRESSED_BYTES = MAX_IMPORT_UNCOMPRESSED_MB * 1024 * 1024;
/** Entries of the ZIP archive (a normal .xlsx has a few dozen). */
export const MAX_IMPORT_ZIP_ENTRIES = 10_000;
/** Spreadsheet lines kept per import (data + TOTAL lines of every sheet read). */
export const MAX_IMPORT_ROWS = 50_000;
