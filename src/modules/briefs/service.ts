/**
 * Análise preliminar (case brief). STUB from the foundation step — the
 * signatures below are cross-module contracts (docs/dev/MODULE_CONTRACTS.md);
 * the briefs package replaces the bodies.
 */
import type { AiMode, CaseBriefStatus } from "@/domain/enums";
import type { AuthContext } from "@/server/auth/context";

export type CaseBriefSummary = {
  id: string;
  processId: string;
  version: number;
  status: CaseBriefStatus;
  mode: AiMode;
  headline: string | null;
  generatedAt: Date | null;
  approvedAt: Date | null;
  approvedByName: string | null;
  isStale: boolean;
};

/**
 * Creates a new brief version for the process and generates it. `inline: true`
 * generates synchronously (used by the intake pipeline, which already runs in a
 * job); otherwise a `case_brief.generate` job is enqueued. Requires
 * `brief:review` or `intake:manage` (system context allowed).
 */
export async function requestCaseBrief(
  _ctx: AuthContext,
  _processId: string,
  _opts: { intakeId?: string | null; inline?: boolean } = {},
): Promise<{ briefId: string; status: CaseBriefStatus }> {
  throw new Error("not_implemented: requestCaseBrief");
}

/** Job handler body for `case_brief.generate`. Idempotent. */
export async function runCaseBriefJob(_briefId: string, _opts: { attempt: number; maxAttempts: number }): Promise<void> {
  throw new Error("not_implemented: runCaseBriefJob");
}

/** Latest brief of a process visible to ctx (null when none / not visible). Requires `brief:read`. */
export async function getLatestCaseBriefSummary(_ctx: AuthContext, _processId: string): Promise<CaseBriefSummary | null> {
  return null;
}

/** Short digest used to compose the "análise disponível" e-mail (no document text beyond short items). */
export type CaseBriefEmailDigest = {
  briefId: string;
  version: number;
  headline: string;
  urgencies: string[];
  possibleDeadlines: { description: string; date: string | null }[];
  gapsCount: number;
  missingDocumentsCount: number;
  isDemo: boolean;
};

export async function getCaseBriefEmailDigest(_ctx: AuthContext, _briefId: string): Promise<CaseBriefEmailDigest> {
  throw new Error("not_implemented: getCaseBriefEmailDigest");
}

/** Called by the extraction job when a document version's text is ready: marks briefs that used the document stale. */
export async function onDocumentTextReadyForBriefs(_input: {
  organizationId: string;
  documentId: string;
  versionId: string;
}): Promise<void> {
  // no-op until implemented
}
