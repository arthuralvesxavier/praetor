/**
 * Motor de PDF do servidor (relatórios jurídicos). Nunca importar em
 * componentes de cliente: lê as fontes do disco.
 */
export { renderPdf, type PdfBlock, type PdfDocumentSpec, type PdfTableColumn, type ParagraphStyle, type RenderedPdf } from "./engine";
export { sanitizePdfText, wrapText } from "./text";
export { SEAL_KINDS, type SealKind } from "./theme";
export { FONT_FILES, fontsDirectory } from "./fonts";
