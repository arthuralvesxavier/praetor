import { eq } from "drizzle-orm";
import { z } from "zod";
import type { JobType } from "@/domain/enums";
import { getDb } from "@/server/db/client";
import { documentVersions } from "@/server/db/schema";
import { logger } from "@/server/lib/logger";
import { onDocumentVersionTextReady, runAnalysisJob } from "@/modules/analyses/service";
import { onDocumentTextReadyForBriefs, runCaseBriefJob } from "@/modules/briefs/service";
import { processIntakeJob } from "@/modules/intake/service";
import type { JobRow } from "./queue";
import { runRoutine } from "./routines";

/**
 * Job handler registry. Handlers must be idempotent: a job can run more than
 * once (retries, recovered stuck jobs). A handler throws to signal failure;
 * the worker decides retry vs. dead with `isRetryableError`.
 */
export type JobHandler = (job: JobRow) => Promise<void>;

/** Permanent failure caused by a malformed payload (never retried). */
export class InvalidJobPayloadError extends Error {
  readonly retryable = false;
  constructor(type: string) {
    super(`invalid_payload:${type}`);
    this.name = "InvalidJobPayloadError";
  }
}

const analysisPayload = z.object({ analysisId: z.uuid(), notes: z.array(z.string()).optional() });
const extractPayload = z.object({ versionId: z.uuid() });
const routinePayload = z.object({ routineId: z.uuid() });
const intakePayload = z.object({ intakeId: z.uuid() });
const briefPayload = z.object({ briefId: z.uuid() });

export const JOB_HANDLERS: Record<JobType, JobHandler> = {
  "analysis.run": async (job) => {
    const p = analysisPayload.safeParse(job.payload);
    if (!p.success) throw new InvalidJobPayloadError(job.type);
    await runAnalysisJob(p.data.analysisId, {
      attempt: job.attempts,
      maxAttempts: job.maxAttempts,
      notes: p.data.notes,
    });
  },

  "document.extract_text": async (job) => {
    const p = extractPayload.safeParse(job.payload);
    if (!p.success) throw new InvalidJobPayloadError(job.type);
    const { extractDocumentVersionText } = await import("@/modules/documents/service");
    await extractDocumentVersionText(p.data.versionId);

    const [version] = await getDb()
      .select({ id: documentVersions.id, documentId: documentVersions.documentId, organizationId: documentVersions.organizationId })
      .from(documentVersions)
      .where(eq(documentVersions.id, p.data.versionId));
    if (!version) {
      logger.warn("extract_text_version_missing", { jobId: job.id, versionId: p.data.versionId });
      return;
    }
    if (job.organizationId && job.organizationId !== version.organizationId) {
      logger.error("extract_text_org_mismatch", { jobId: job.id, versionId: version.id });
      throw new InvalidJobPayloadError(job.type);
    }
    const ready = { organizationId: version.organizationId, documentId: version.documentId, versionId: version.id };
    await onDocumentVersionTextReady(ready);
    await onDocumentTextReadyForBriefs(ready);
  },

  "routine.run": async (job) => {
    const p = routinePayload.safeParse(job.payload);
    if (!p.success) throw new InvalidJobPayloadError(job.type);
    await runRoutine(p.data.routineId);
  },

  "intake.process": async (job) => {
    const p = intakePayload.safeParse(job.payload);
    if (!p.success) throw new InvalidJobPayloadError(job.type);
    await processIntakeJob(p.data.intakeId, { attempt: job.attempts, maxAttempts: job.maxAttempts });
  },

  "case_brief.generate": async (job) => {
    const p = briefPayload.safeParse(job.payload);
    if (!p.success) throw new InvalidJobPayloadError(job.type);
    await runCaseBriefJob(p.data.briefId, { attempt: job.attempts, maxAttempts: job.maxAttempts });
  },
};
