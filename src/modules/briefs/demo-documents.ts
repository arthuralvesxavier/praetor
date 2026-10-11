/**
 * Fictitious demonstration documents (PDF) coherent with a spreadsheet case.
 * Every page is marked "DOCUMENTO FICTÍCIO — GERADO PARA DEMONSTRAÇÃO".
 * STUB from the foundation step — the briefs package implements it (it owns
 * both these documents and the simulated extractor that reads them).
 */
import type { DocumentCategory } from "@/domain/enums";

export type DemoCaseInfo = {
  number: string;
  court: string;
  courtDivision: string | null;
  city: string | null;
  state: string | null;
  plaintiff: string;
  defendant: string;
  processClass: string | null;
  claimAmountCents: number | null;
  filedAt: string | null;
};

export type DemoDocument = {
  title: string;
  category: DocumentCategory;
  description: string;
  fileName: string;
  mimeType: "application/pdf";
  bytes: Uint8Array;
};

/** Builds the demo document pack (e.g. petição inicial, procuração, documentos do autor) for a case. Deterministic per `variant`. */
export async function buildDemoCaseDocuments(_info: DemoCaseInfo, _opts: { variant?: number } = {}): Promise<DemoDocument[]> {
  throw new Error("not_implemented: buildDemoCaseDocuments");
}
