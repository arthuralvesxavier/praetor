import { sql } from "drizzle-orm";
import { bigint, boolean, index, integer, jsonb, pgTable, primaryKey, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type {
  AiMode,
  AnalysisReviewStatus,
  AnalysisStatus,
  AnalysisSubjectType,
  AnalysisTrigger,
  AnalysisType,
  JobStatus,
  JobType,
  RoutineType,
} from "@/domain/enums";
import type { AnalysisResult } from "@/domain/analysis";
import { createdAt, id, ts, updatedAt } from "./_columns";
import { organizations, users } from "./core";

/**
 * One AI analysis request and its result.
 *
 * Lifecycle: queued -> running -> succeeded | failed (retried up to
 * `maxAttempts` by the job queue) | cancelled.
 *
 * Deduplication: `inputHash` = hash(type, subject, question, prompt version,
 * content hashes of every source). While an analysis with the same hash is
 * queued/running (unique index below) or succeeded and not stale, a new
 * request returns the existing one instead of calling the provider again.
 *
 * Staleness: when any source changes (new document version, relevant record
 * update) the analysis is flagged `isStale` with a reason; it is never
 * silently rewritten.
 */
export const aiAnalyses = pgTable(
  "ai_analyses",
  {
    id: id(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    type: text("type").$type<AnalysisType>().notNull(),
    subjectType: text("subject_type").$type<AnalysisSubjectType>().notNull(),
    /** Null only for organization-wide Q&A. */
    subjectId: uuid("subject_id"),
    /** User question for `question_answer` analyses. */
    question: text("question"),
    status: text("status").$type<AnalysisStatus>().notNull().default("queued"),
    trigger: text("trigger").$type<AnalysisTrigger>().notNull().default("manual"),
    mode: text("mode").$type<AiMode>().notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    inputHash: text("input_hash").notNull(),
    result: jsonb("result").$type<AnalysisResult>(),
    /** Sanitized error message (never raw provider payloads or document text). */
    errorMessage: text("error_message"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    /** Estimated cost in millionths of USD. */
    costMicroUsd: bigint("cost_micro_usd", { mode: "number" }),
    /** True when the source text exceeded `maxInputChars` and was cut. Shown as a limitation. */
    inputTruncated: boolean("input_truncated").notNull().default(false),
    reviewStatus: text("review_status").$type<AnalysisReviewStatus>().notNull().default("pending_review"),
    reviewedById: uuid("reviewed_by_id").references(() => users.id),
    reviewedAt: ts("reviewed_at"),
    reviewNote: text("review_note"),
    isStale: boolean("is_stale").notNull().default(false),
    staleReason: text("stale_reason"),
    staleSince: ts("stale_since"),
    requestedById: uuid("requested_by_id").references(() => users.id),
    createdAt: createdAt(),
    startedAt: ts("started_at"),
    completedAt: ts("completed_at"),
  },
  (t) => [
    uniqueIndex("ai_analyses_inflight_uq")
      .on(t.organizationId, t.inputHash)
      .where(sql`${t.status} in ('queued', 'running')`),
    index("ai_analyses_subject_idx").on(t.organizationId, t.subjectType, t.subjectId, t.createdAt),
    index("ai_analyses_hash_idx").on(t.organizationId, t.inputHash),
  ],
);

/**
 * Snapshot of every source an analysis used. `contentHash` is the hash of the
 * exact content sent to the provider; comparing it with the current content
 * hash is how staleness is detected.
 */
export const aiAnalysisSources = pgTable(
  "ai_analysis_sources",
  {
    id: id(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    analysisId: uuid("analysis_id").notNull().references(() => aiAnalyses.id, { onDelete: "cascade" }),
    /** Stable reference used in the result's citations, e.g. "S1". */
    ref: text("ref").notNull(),
    /** `document_version`, `legal_process`, `occurrence`, `contract`, `process_event`... */
    sourceType: text("source_type").notNull(),
    /** Id of the entity whose change should mark the analysis stale (document id for versions). */
    entityId: uuid("entity_id").notNull(),
    /** Document version id when sourceType = document_version. */
    versionId: uuid("version_id"),
    versionNumber: integer("version_number"),
    label: text("label").notNull(),
    contentHash: text("content_hash").notNull(),
    charCount: integer("char_count").notNull().default(0),
    truncated: boolean("truncated").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    index("ai_sources_analysis_idx").on(t.analysisId),
    index("ai_sources_entity_idx").on(t.organizationId, t.entityId),
  ],
);

/** Monthly AI consumption per organization, used for budget enforcement. */
export const aiUsage = pgTable(
  "ai_usage",
  {
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    /** `YYYY-MM` (UTC). */
    period: text("period").notNull(),
    requests: integer("requests").notNull().default(0),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    costMicroUsd: bigint("cost_micro_usd", { mode: "number" }).notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.period] })],
);

// ---------------------------------------------------------------------------
// Background jobs (Postgres-backed queue, claimed with FOR UPDATE SKIP LOCKED)
// ---------------------------------------------------------------------------

export const jobs = pgTable(
  "jobs",
  {
    id: id(),
    organizationId: uuid("organization_id").references(() => organizations.id),
    type: text("type").$type<JobType>().notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").$type<JobStatus>().notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    runAt: ts("run_at").notNull().defaultNow(),
    lockedAt: ts("locked_at"),
    lockedBy: text("locked_by"),
    lastError: text("last_error"),
    /** Prevents enqueuing the same work twice while it is pending. */
    dedupeKey: text("dedupe_key"),
    createdAt: createdAt(),
    completedAt: ts("completed_at"),
  },
  (t) => [
    index("jobs_claim_idx").on(t.status, t.runAt),
    uniqueIndex("jobs_pending_dedupe_uq")
      .on(t.dedupeKey)
      .where(sql`${t.dedupeKey} is not null and ${t.status} in ('queued', 'running')`),
  ],
);

/** Configurable scheduled routines per organization (interval based). */
export const scheduledRoutines = pgTable(
  "scheduled_routines",
  {
    id: id(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    type: text("type").$type<RoutineType>().notNull(),
    enabled: boolean("enabled").notNull().default(true),
    intervalMinutes: integer("interval_minutes").notNull(),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    lastRunAt: ts("last_run_at"),
    nextRunAt: ts("next_run_at").notNull().defaultNow(),
    lastStatus: text("last_status"),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("scheduled_routines_org_type_uq").on(t.organizationId, t.type)],
);
