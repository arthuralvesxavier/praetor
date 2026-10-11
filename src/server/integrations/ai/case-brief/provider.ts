import type { CaseBrief } from "@/domain/case-brief";
import type { AiMode, DocumentCategory, LegalArea, PartyRole, ProcessInstance, ProcessPhase } from "@/domain/enums";
import type { AiUsage } from "../provider";

/**
 * Provider interface for the PRELIMINARY CASE ANALYSIS (análise preliminar).
 * Separate from the generic analyses provider (../provider.ts) because the
 * output contract is different (src/domain/case-brief.ts).
 *
 * Implementations:
 *  - SimulatedCaseBriefProvider (this version, default and only active one):
 *    deterministic rules over the record and the extracted document text; no
 *    AI, no network. Every item is labeled with its provenance.
 *  - A live adapter may exist but is not enabled in this version.
 *
 * Document texts are UNTRUSTED data: a live provider must only embed them in
 * delimited source blocks and ignore instructions found inside them.
 */

/** Structured process data (from the record / imported spreadsheet) — cited as "REG". */
export type CaseBriefRecord = {
  number: string;
  title: string;
  court: string;
  courtDivision: string | null;
  city: string | null;
  state: string | null;
  area: LegalArea;
  phase: ProcessPhase;
  phaseDetail: string | null;
  instance: ProcessInstance | null;
  processClass: string | null;
  claimAmountCents: number | null;
  liquidatedAmountCents: number | null;
  filedAt: string | null;
  companyName: string | null;
  responsibleName: string | null;
  parties: { name: string; role: PartyRole; isClient: boolean }[];
  instances: { instance: ProcessInstance; court: string; courtDivision: string | null; phaseDetail: string | null }[];
  events: { date: string; title: string }[];
  /** Where the record data came from, e.g. "Planilha Passivo_TESTE… (dados fictícios)". */
  recordSourceLabel: string;
};

export type CaseBriefDocumentSource = {
  /** "D1", "D2"... */
  ref: string;
  documentId: string;
  versionId: string;
  title: string;
  category: DocumentCategory;
  fileName: string;
  /** Extracted text (UNTRUSTED). */
  text: string;
  /** Offset where each page starts in `text` (index 0 = page 1); null when unknown. */
  pageOffsets: number[] | null;
  pageCount: number | null;
};

export type CaseBriefRequest = {
  record: CaseBriefRecord;
  documents: CaseBriefDocumentSource[];
  /** Today's date (YYYY-MM-DD) for relative statements; never used to compute legal deadlines. */
  today: string;
};

export type CaseBriefResponse = { brief: CaseBrief; usage: AiUsage };

export interface CaseBriefProvider {
  name: string;
  model: string;
  mode: AiMode;
  /** Bumped whenever the rules/prompt change (stored with each brief). */
  promptVersion: string;
  generate(req: CaseBriefRequest): Promise<CaseBriefResponse>;
}

/** 1-based page for a character offset, using `pageOffsets`. Null when offsets are unknown. */
export function pageForOffset(pageOffsets: number[] | null, offset: number): number | null {
  if (!pageOffsets || pageOffsets.length === 0 || offset < 0) return null;
  let page = 1;
  for (let i = 0; i < pageOffsets.length; i += 1) {
    if (pageOffsets[i] <= offset) page = i + 1;
    else break;
  }
  return page;
}
