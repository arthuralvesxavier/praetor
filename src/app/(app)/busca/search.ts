/**
 * Global search (/busca): composes the module services, each of which applies
 * its own permission check and row visibility (`*Where(ctx)`). Sections the
 * user cannot read are returned as `null` (not queried). No `next/*` imports —
 * unit-tested in tests/shell/global-search.test.ts.
 */
import type {
  ContractStatus,
  DocumentCategory,
  OccurrenceCategory,
  OccurrenceStatus,
  ProcessStatus,
  RiskLevel,
} from "@/domain/enums";
import { listContracts } from "@/modules/contracts/service";
import { listDocuments } from "@/modules/documents/service";
import { listOccurrences } from "@/modules/occurrences/service";
import { searchProcesses } from "@/modules/processes/service";
import type { AuthContext } from "@/server/auth/context";
import { can } from "@/server/auth/permissions";

export const SEARCH_MIN_LENGTH = 2;
export const SEARCH_MAX_LENGTH = 120;
export const PROCESS_LIMIT = 20;
export const DOCUMENT_LIMIT = 10;
export const CONTRACT_LIMIT = 5;
export const OCCURRENCE_LIMIT = 5;

export type ProcessHit = { id: string; number: string; title: string; court: string; status: ProcessStatus };
export type DocumentHit = {
  id: string;
  title: string;
  category: DocumentCategory;
  fileName: string | null;
  /** Labels of the linked records the user can see (invisible links are omitted). */
  linkedTo: string[];
  updatedAt: Date;
};
export type ContractHit = {
  id: string;
  title: string;
  counterparty: string;
  status: ContractStatus;
  endDate: string | null;
};
export type OccurrenceHit = {
  id: string;
  title: string;
  category: OccurrenceCategory;
  status: OccurrenceStatus;
  riskLevel: RiskLevel;
};

/** `null` = the user has no permission for that section (it is not shown). */
export type GlobalSearchResult = {
  query: string;
  tooShort: boolean;
  processes: { items: ProcessHit[]; limited: boolean } | null;
  documents: { items: DocumentHit[]; total: number } | null;
  contracts: { items: ContractHit[]; total: number } | null;
  occurrences: { items: OccurrenceHit[]; total: number } | null;
};

/** Trims, collapses whitespace and caps the length of the typed query. */
export function normalizeSearchQuery(raw: string | null | undefined): string {
  return (raw ?? "").replace(/\s+/g, " ").trim().slice(0, SEARCH_MAX_LENGTH);
}

export function countSearchHits(result: GlobalSearchResult): number {
  return (
    (result.processes?.items.length ?? 0) +
    (result.documents?.total ?? 0) +
    (result.contracts?.total ?? 0) +
    (result.occurrences?.total ?? 0)
  );
}

export async function runGlobalSearch(ctx: AuthContext, rawQuery: string): Promise<GlobalSearchResult> {
  const query = normalizeSearchQuery(rawQuery);
  const allowed = {
    processes: can(ctx, "process:read"),
    documents: can(ctx, "document:read"),
    contracts: can(ctx, "contract:read"),
    occurrences: can(ctx, "occurrence:read"),
  };

  if (query.length < SEARCH_MIN_LENGTH) {
    return {
      query,
      tooShort: true,
      processes: allowed.processes ? { items: [], limited: false } : null,
      documents: allowed.documents ? { items: [], total: 0 } : null,
      contracts: allowed.contracts ? { items: [], total: 0 } : null,
      occurrences: allowed.occurrences ? { items: [], total: 0 } : null,
    };
  }

  const [processes, documents, contracts, occurrences] = await Promise.all([
    allowed.processes
      ? searchProcesses(ctx, query, PROCESS_LIMIT).then((rows) => ({
          items: rows.map((r) => ({ id: r.id, number: r.number, title: r.title, court: r.court, status: r.status })),
          limited: rows.length >= PROCESS_LIMIT,
        }))
      : null,
    allowed.documents
      ? listDocuments(ctx, { q: query, page: 1, pageSize: DOCUMENT_LIMIT }).then((r) => ({
          total: r.total,
          items: r.items.map((d) => ({
            id: d.id,
            title: d.title,
            category: d.category,
            fileName: d.fileName,
            linkedTo: d.links.map((l) => l.label).filter((l): l is string => Boolean(l)),
            updatedAt: d.updatedAt,
          })),
        }))
      : null,
    allowed.contracts
      ? listContracts(ctx, { q: query, page: 1, pageSize: CONTRACT_LIMIT }).then((r) => ({
          total: r.total,
          items: r.items.map((c) => ({
            id: c.id,
            title: c.title,
            counterparty: c.counterparty,
            status: c.status,
            endDate: c.endDate,
          })),
        }))
      : null,
    allowed.occurrences
      ? listOccurrences(ctx, { q: query, page: 1, pageSize: OCCURRENCE_LIMIT }).then((r) => ({
          total: r.total,
          items: r.items.map((o) => ({
            id: o.id,
            title: o.title,
            category: o.category,
            status: o.status,
            riskLevel: o.riskLevel,
          })),
        }))
      : null,
  ]);

  return { query, tooShort: false, processes, documents, contracts, occurrences };
}
