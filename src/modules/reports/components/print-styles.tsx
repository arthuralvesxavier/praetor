/**
 * Print stylesheet for report pages (RF-17 "salvar em PDF"). Only the element
 * marked `.report-print` (and the elements that contain it) are printed, so
 * the app shell (sidebar, header, banners) never reaches the paper —
 * independently of how the shell is built. Landscape A4: report tables are wide.
 */
const CSS = `
@media print {
  @page { size: A4 landscape; margin: 12mm; }
  html, body { background: #fff !important; }
  body *:not(:has(.report-print)):not(.report-print):not(.report-print *) { display: none !important; }
  body *:has(.report-print) { display: block !important; position: static !important; padding: 0 !important; margin: 0 !important; max-width: none !important; width: auto !important; min-height: 0 !important; overflow: visible !important; border: 0 !important; box-shadow: none !important; background: #fff !important; }
  .report-print { font-size: 9pt; color: #0f172a; }
  .report-print * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .report-print .overflow-x-auto { overflow: visible !important; }
  .report-print table { width: 100%; font-size: 8pt; }
  .report-print th, .report-print td { padding-top: 2px !important; padding-bottom: 2px !important; }
  .report-print tr, .report-print .print-avoid-break { break-inside: avoid; page-break-inside: avoid; }
  .report-print thead { display: table-header-group; }
  .report-print a { color: inherit !important; text-decoration: none !important; }
}
`;

export function ReportPrintStyles() {
  return <style>{CSS}</style>;
}
