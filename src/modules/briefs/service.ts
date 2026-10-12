/**
 * Análise preliminar (case brief): geração SIMULADA, revisão, edição e
 * aprovação pelo advogado.
 *
 * Security / data rules:
 * - every read applies `caseBriefWhere(ctx)` (process visible AND every source
 *   document visible); single-record reads return NotFoundError otherwise;
 * - the sources of a brief are the documents of the process visible to the
 *   requester (all of them for system contexts), so the requester can always
 *   open the result;
 * - the brief never changes records by itself: deadlines, tasks and amounts
 *   only come from explicit user actions (deadlines pending validation,
 *   valuations `proposed`);
 * - audit entries and logs carry metadata only — never brief content, document
 *   text or excerpts; deadlines/tasks created from a brief carry document text
 *   only in the gated `sourceExcerpt`, never in their description;
 * - only the latest generated version of a process can be reviewed or applied
 *   (older ones are "superseded"), and the intake of the process follows the
 *   latest version (`case_intakes.brief_id`, moved by `requestCaseBrief`; the
 *   intake pipeline is queued again when that version becomes ready).
 */
import { createHash } from "node:crypto";
import { and, asc, count, desc, eq, exists, gt, inArray, isNotNull, isNull, max, ne, notExists, notInArray, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import {
  CASE_BRIEF_DEMO_NOTICE,
  CASE_BRIEF_DISCLAIMER,
  CASE_BRIEF_SECTIONS,
  caseBriefSchema,
  type BriefCitation,
  type CaseBrief,
  type CaseBriefSectionKey,
  type Provenance,
  type StoredCaseBrief,
} from "@/domain/case-brief";
import { normalizePage, type Page, type Paginated } from "@/domain/entities";
import type { AiMode, CaseBriefStatus, DocumentCategory, Priority, ValuationKind } from "@/domain/enums";
import { todayISO } from "@/lib/format";
import { resolveAlertsByDedupeKeys, upsertAlert } from "@/modules/alerts/service";
import { errorSummary } from "@/modules/documents/log";
import { caseBriefWhere, documentWhere, processWhere } from "@/server/auth/access";
import { systemContext, type AuthContext } from "@/server/auth/context";
import { assertCan, can } from "@/server/auth/permissions";
import { getDb, type DbOrTx } from "@/server/db/client";
import {
  caseBriefRevisions,
  caseBriefSources,
  caseBriefs,
  caseIntakes,
  companies,
  deadlines,
  documentVersions,
  documents,
  legalProcesses,
  processEvents,
  processInstances,
  processParties,
  processValuations,
  tasks,
  users,
  type IntakeStep,
} from "@/server/db/schema";
import {
  getCaseBriefProvider,
  type CaseBriefDocumentSource,
  type CaseBriefRecord,
} from "@/server/integrations/ai/case-brief";
import { AiProviderError } from "@/server/integrations/ai/provider";
import { enqueueJob } from "@/server/jobs/queue";
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";
import { recordAudit } from "@/server/services/audit";
import {
  approveBriefSchema,
  citationPageSchema,
  idSchema,
  itemIndexSchema,
  listBriefsSchema,
  rejectBriefSchema,
  requestBriefSchema,
  revisionMetaSchema,
  sectionKeySchema,
  type EditableSectionKey,
  type ListBriefsFilters,
} from "./schemas";
import type { BriefCitationPage } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

export type CaseBriefListItem = {
  id: string;
  processId: string;
  processNumber: string;
  processTitle: string;
  responsibleName: string | null;
  version: number;
  status: CaseBriefStatus;
  mode: AiMode;
  currentRevision: number;
  isStale: boolean;
  generatedAt: Date | null;
  approvedAt: Date | null;
  createdAt: Date;
  counts: { contradictions: number; missingDocuments: number; urgencies: number } | null;
  /** A newer version of the same process already has content: this one can no longer be reviewed or applied. */
  superseded: boolean;
};

export type CaseBriefSourceItem = {
  ref: string;
  sourceType: "legal_process" | "document_version";
  entityId: string;
  versionId: string | null;
  versionNumber: number | null;
  label: string;
  pageCount: number | null;
  charCount: number;
};

export type CaseBriefRevisionItem = {
  revision: number;
  editedByName: string | null;
  changeNote: string | null;
  createdAt: Date;
};

export type CaseBriefDetail = {
  id: string;
  version: number;
  status: CaseBriefStatus;
  mode: AiMode;
  provider: string;
  model: string;
  promptVersion: string;
  process: { id: string; number: string; title: string; responsibleId: string | null };
  intakeId: string | null;
  content: StoredCaseBrief | null;
  currentRevision: number;
  errorMessage: string | null;
  isStale: boolean;
  staleReason: string | null;
  requestedByName: string | null;
  createdAt: Date;
  generatedAt: Date | null;
  lastEditedByName: string | null;
  lastEditedAt: Date | null;
  approvedByName: string | null;
  approvedAt: Date | null;
  approvalNote: string | null;
  rejectedByName: string | null;
  rejectedAt: Date | null;
  rejectionReason: string | null;
  sources: CaseBriefSourceItem[];
  revisions: CaseBriefRevisionItem[];
  otherVersions: { id: string; version: number; status: CaseBriefStatus; createdAt: Date }[];
  /** A newer version of the same process already has content: this one can no longer be reviewed or applied. */
  superseded: boolean;
  /** Newest generated version visible to the user, when this one is superseded (null if it is not visible). */
  latestVersion: { id: string; version: number } | null;
};

/** Statuses in which the content can be edited, approved or rejected. */
export const REVIEWABLE_STATUSES: readonly CaseBriefStatus[] = ["ready_for_review", "in_review"];
/** Statuses in which suggestions can be turned into deadlines, tasks or proposed values. */
export const APPLICABLE_STATUSES: readonly CaseBriefStatus[] = ["ready_for_review", "in_review", "approved"];

type BriefRow = typeof caseBriefs.$inferSelect;

/** A brief still `generating` after this long is considered lost (its job died) and can be replaced. */
export const STUCK_GENERATION_MS = 30 * 60_000;
const STUCK_MESSAGE = "A geração não foi concluída no tempo esperado e foi encerrada. Gere uma nova versão.";

export function isStuckGenerating(createdAt: Date, now: Date = new Date()): boolean {
  return now.getTime() - createdAt.getTime() > STUCK_GENERATION_MS;
}

const UNEXPECTED_RUN_ERROR = "Falha inesperada ao gerar a análise preliminar. Tente gerar novamente.";
export const SUPERSEDED_MESSAGE = "Existe uma versão mais recente desta análise preliminar. Revise a versão mais recente.";
/** Statuses of a version that has content (generated). */
const GENERATED_STATUSES: readonly CaseBriefStatus[] = ["ready_for_review", "in_review", "approved", "rejected"];
const PROCESS_GONE_MESSAGE = "O processo foi excluído ou não está mais disponível.";
const MAX_CONTENT_BYTES = 600_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseOrThrow<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(
      "Verifique os campos informados.",
      z.flattenError(parsed.error).fieldErrors as Record<string, string[]>,
    );
  }
  return parsed.data;
}

function parseId(id: unknown): string {
  const parsed = idSchema.safeParse(id);
  if (!parsed.success) throw new NotFoundError();
  return parsed.data;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function isUniqueViolation(err: unknown): boolean {
  let e: unknown = err;
  for (let i = 0; i < 5 && e && typeof e === "object"; i++) {
    if ((e as { code?: unknown }).code === "23505") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

function refNumber(ref: string): number {
  return ref === "REG" ? 0 : Number(ref.slice(1)) || 9999;
}

function isValidIsoDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Stable JSON (sorted keys) used to compare brief items. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

async function userNames(organizationId: string, ids: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (!unique.length) return new Map();
  const rows = await getDb()
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(and(eq(users.organizationId, organizationId), inArray(users.id, unique)));
  return new Map(rows.map((r) => [r.id, r.name]));
}

function alertKey(briefId: string): string {
  return `brief_review:${briefId}`;
}

function isDemoMode(mode: AiMode): boolean {
  return mode === "demo";
}

/** Text that labels anything derived from a brief (simulated briefs are always demonstrative). */
function originLabel(b: { version: number; mode: AiMode }): string {
  return isDemoMode(b.mode)
    ? `análise preliminar v${b.version}, SIMULAÇÃO (conteúdo demonstrativo, sem inteligência artificial real)`
    : `análise preliminar v${b.version} (IA)`;
}

async function loadVisibleBrief(ctx: AuthContext, id: string, db: DbOrTx = getDb()): Promise<BriefRow> {
  const [row] = await db
    .select()
    .from(caseBriefs)
    .where(and(eq(caseBriefs.id, parseId(id)), caseBriefWhere(ctx)))
    .limit(1);
  if (!row) throw new NotFoundError("Análise preliminar não encontrada ou sem permissão de acesso.");
  return row;
}

// ---------------------------------------------------------------------------
// Versions: only the latest generated version of a process is reviewed
// ---------------------------------------------------------------------------

type VersionRef = { organizationId: string; processId: string; version: number };

const newerBrief = alias(caseBriefs, "newer_brief");

/** Generated versions (with content) of the same process that are newer than `b`. */
function newerGeneratedVersionsOf(b: VersionRef): SQL {
  return and(
    eq(newerBrief.organizationId, b.organizationId),
    eq(newerBrief.processId, b.processId),
    gt(newerBrief.version, b.version),
    isNotNull(newerBrief.content),
  )!;
}

/** Correlated SQL: the current `case_briefs` row is superseded by a newer generated version. */
function supersededSql(): SQL {
  return exists(
    getDb()
      .select({ one: sql`1` })
      .from(newerBrief)
      .where(
        and(
          eq(newerBrief.organizationId, caseBriefs.organizationId),
          eq(newerBrief.processId, caseBriefs.processId),
          gt(newerBrief.version, caseBriefs.version),
          isNotNull(newerBrief.content),
        ),
      ),
  );
}

/** Guard for review updates: no newer generated version of the process of `b` exists. */
function notSupersededGuard(b: VersionRef): SQL {
  return notExists(getDb().select({ one: sql`1` }).from(newerBrief).where(newerGeneratedVersionsOf(b)));
}

/** A newer version of the same process already has content (whatever its visibility). */
async function isSuperseded(b: VersionRef, db: DbOrTx = getDb()): Promise<boolean> {
  const [newer] = await db.select({ id: newerBrief.id }).from(newerBrief).where(newerGeneratedVersionsOf(b)).limit(1);
  return !!newer;
}

/**
 * A superseded version can no longer be edited, approved, rejected or
 * applied: the process and its intake follow the latest version.
 */
async function assertLatestVersion(b: VersionRef, db: DbOrTx = getDb()): Promise<void> {
  if (await isSuperseded(b, db)) throw new ConflictError(SUPERSEDED_MESSAGE);
}

// ---------------------------------------------------------------------------
// Record (REG) and document sources
// ---------------------------------------------------------------------------

async function loadProcessRow(organizationId: string, processId: string, db: DbOrTx = getDb()) {
  const [p] = await db
    .select()
    .from(legalProcesses)
    .where(
      and(
        eq(legalProcesses.id, processId),
        eq(legalProcesses.organizationId, organizationId),
        isNull(legalProcesses.deletedAt),
      ),
    )
    .limit(1);
  return p ?? null;
}

/** Structured process data sent to the provider as the "REG" source. */
async function buildRecord(organizationId: string, processId: string): Promise<CaseBriefRecord | null> {
  const db = getDb();
  const p = await loadProcessRow(organizationId, processId);
  if (!p) return null;
  const [parties, instances, events, company, responsible] = await Promise.all([
    db
      .select({ name: processParties.name, role: processParties.role, isClient: processParties.isClient })
      .from(processParties)
      .where(and(eq(processParties.processId, p.id), eq(processParties.organizationId, organizationId)))
      .orderBy(asc(processParties.createdAt)),
    db
      .select({
        instance: processInstances.instance,
        court: processInstances.court,
        courtDivision: processInstances.courtDivision,
        phaseDetail: processInstances.phaseDetail,
      })
      .from(processInstances)
      .where(and(eq(processInstances.processId, p.id), eq(processInstances.organizationId, organizationId))),
    db
      .select({ date: processEvents.occurredAt, title: processEvents.title })
      .from(processEvents)
      .where(and(eq(processEvents.processId, p.id), eq(processEvents.organizationId, organizationId)))
      .orderBy(asc(processEvents.occurredAt))
      .limit(50),
    p.companyId
      ? db
          .select({ name: companies.name })
          .from(companies)
          .where(and(eq(companies.id, p.companyId), eq(companies.organizationId, organizationId)))
          .limit(1)
      : Promise.resolve([] as { name: string }[]),
    p.responsibleId
      ? db
          .select({ name: users.name })
          .from(users)
          .where(and(eq(users.id, p.responsibleId), eq(users.organizationId, organizationId)))
          .limit(1)
      : Promise.resolve([] as { name: string }[]),
  ]);
  return {
    number: p.number,
    title: p.title,
    court: p.court,
    courtDivision: p.courtDivision,
    city: p.city,
    state: p.state,
    area: p.area,
    phase: p.phase,
    phaseDetail: p.phaseDetail,
    instance: p.instance,
    processClass: p.processClass,
    claimAmountCents: p.claimAmountCents,
    liquidatedAmountCents: p.liquidatedAmountCents,
    filedAt: p.filedAt,
    companyName: company[0]?.name ?? null,
    responsibleName: responsible[0]?.name ?? null,
    parties,
    instances,
    events,
    recordSourceLabel:
      p.dataOrigin === "imported"
        ? `Planilha importada${p.externalSource ? ` (${p.externalSource})` : ""}`
        : "Cadastro do processo no sistema",
  };
}

/** Current versions of the process documents (visible to ctx) that have, or may soon have, text. */
async function candidateDocuments(ctx: AuthContext, processId: string, db: DbOrTx) {
  return db
    .select({
      documentId: documents.id,
      versionId: documentVersions.id,
      versionNumber: documentVersions.versionNumber,
      title: documents.title,
    })
    .from(documents)
    .innerJoin(
      documentVersions,
      and(eq(documentVersions.id, documents.currentVersionId), eq(documentVersions.documentId, documents.id)),
    )
    .where(
      and(
        eq(documents.processId, processId),
        eq(documents.organizationId, ctx.organizationId),
        documentWhere(ctx),
        inArray(documentVersions.extractionStatus, ["succeeded", "pending"]),
      ),
    )
    .orderBy(asc(documents.createdAt), asc(documents.id));
}

// ---------------------------------------------------------------------------
// Output sanitization (generation) and provenance merge (review)
// ---------------------------------------------------------------------------

type SourceInfo = { pageCount: number; text: string | null };
type AnyItem = { provenance: Provenance; citations: BriefCitation[]; note: string | null };

const ITEM_SECTIONS = CASE_BRIEF_SECTIONS.map((s) => s.key);

function sanitizeCitations(citations: BriefCitation[], sources: Map<string, SourceInfo>): BriefCitation[] {
  const out: BriefCitation[] = [];
  const seen = new Set<string>();
  for (const c of citations) {
    const src = sources.get(c.ref);
    if (!src) continue;
    let next: BriefCitation;
    if (c.ref === "REG") {
      next = { ref: "REG", page: null, excerpt: c.excerpt ? clip(c.excerpt, 300) : null };
    } else {
      if (c.page === null || !Number.isInteger(c.page) || c.page < 1 || c.page > src.pageCount) continue;
      next = { ref: c.ref, page: c.page, excerpt: c.excerpt ? clip(c.excerpt, 300) : null };
    }
    const key = canonical(next);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(next);
  }
  return out;
}

function hasDocumentCitation(item: AnyItem): boolean {
  return item.citations.some((c) => c.ref !== "REG" && c.page !== null && !!c.excerpt);
}

/** "2026-11-23" -> forms in which that date may be written in a document. */
function literalDateForms(iso: string): string[] {
  const [y, m, d] = iso.split("-");
  return [iso, `${d}/${m}/${y}`, `${Number(d)}/${Number(m)}/${y}`, `${d}.${m}.${y}`];
}

/**
 * Validates what a provider returned before storing it: drops the "reviewer"
 * provenance, citations to unknown refs or pages, "extracted" items without a
 * document citation, invalid dates/amounts, and deadline dates that are not
 * literally present in the cited document (deadlines are never computed).
 */
export function sanitizeGeneratedBrief(
  brief: CaseBrief,
  sources: Map<string, SourceInfo>,
): { brief: CaseBrief; dropped: number; clearedDates: number } {
  let dropped = 0;
  let clearedDates = 0;
  const out: CaseBrief = { ...brief };
  for (const key of ITEM_SECTIONS) {
    const items = brief[key] as AnyItem[];
    const kept: AnyItem[] = [];
    for (const original of items) {
      if (original.provenance === "reviewer") {
        dropped += 1;
        continue;
      }
      const item = { ...original, citations: sanitizeCitations(original.citations, sources) } as AnyItem & Record<string, unknown>;
      if (item.provenance === "extracted" && !hasDocumentCitation(item)) {
        dropped += 1;
        continue;
      }
      if ("amountCents" in item && item.amountCents !== null) {
        const v = item.amountCents as number;
        if (!Number.isSafeInteger(v) || v < 0) item.amountCents = null;
      }
      if (key === "timeline" && typeof item.date === "string" && !isValidIsoDate(item.date)) item.date = null;
      if (key === "possibleDeadlines" && typeof item.date === "string") {
        const date = item.date;
        const literal =
          isValidIsoDate(date) &&
          (item.provenance === "record" ||
            (item.provenance === "extracted" &&
              item.citations.some((c) => {
                const text = sources.get(c.ref)?.text ?? "";
                return literalDateForms(date).some((f) => text.includes(f));
              })));
        if (!literal) {
          item.date = null;
          item.basis = `${String(item.basis ?? "")} (Data removida pelo sistema: não aparece literalmente no documento citado; conte e confira o prazo manualmente.)`.trim();
          clearedDates += 1;
        }
      }
      kept.push(item);
    }
    (out as Record<string, unknown>)[key] = kept;
  }
  return { brief: out, dropped, clearedDates };
}

function itemContentKey(item: Record<string, unknown>): string {
  return canonical({ ...item, provenance: undefined });
}

/**
 * Merges a reviewer's version of a section with the current one. Items equal
 * to a current item (ignoring provenance) keep the current item untouched;
 * every new or changed item gets provenance "reviewer" (the client can never
 * claim "extracted"/"record"), and its citations are re-validated.
 */
function mergeSection(current: AnyItem[], next: AnyItem[], sources: Map<string, SourceInfo>): { items: AnyItem[]; changed: boolean } {
  const pool = new Map<string, AnyItem[]>();
  for (const c of current) {
    const key = itemContentKey(c as unknown as Record<string, unknown>);
    pool.set(key, [...(pool.get(key) ?? []), c]);
  }
  const items = next.map((n) => {
    const key = itemContentKey(n as unknown as Record<string, unknown>);
    const match = pool.get(key)?.shift();
    if (match) return match;
    return { ...n, provenance: "reviewer" as const, citations: sanitizeCitations(n.citations, sources) };
  });
  return { items, changed: canonical(items) !== canonical(current) };
}

async function sourceInfoForBrief(briefId: string, organizationId: string, db: DbOrTx = getDb()): Promise<Map<string, SourceInfo>> {
  const rows = await db
    .select({ ref: caseBriefSources.ref, pageCount: caseBriefSources.pageCount })
    .from(caseBriefSources)
    .where(and(eq(caseBriefSources.briefId, briefId), eq(caseBriefSources.organizationId, organizationId)));
  return new Map(rows.map((r) => [r.ref, { pageCount: Math.max(1, r.pageCount ?? 1), text: null }]));
}

// ---------------------------------------------------------------------------
// Request & generation
// ---------------------------------------------------------------------------

/**
 * Creates a new brief version for the process and generates it. `inline: true`
 * generates synchronously (used by the intake pipeline, which already runs in a
 * job); otherwise a `case_brief.generate` job is enqueued. Requires
 * `brief:review`; `intake:manage` alone (analysts) is accepted only with the
 * `intakeId` of an intake of that process (the intake page). System context
 * allowed. When a version is already being generated for the process (and is
 * visible to ctx), that one is returned.
 *
 * Without `intakeId`, an intake of the process that follows an older version
 * (not cancelled, its brief not approved) is moved to the new version in the
 * same transaction (`case_intakes.brief_id`, status "analyzing", e-mail step
 * reopened, step appended): the intake always follows the latest version.
 */
export async function requestCaseBrief(
  ctx: AuthContext,
  processId: string,
  opts: { intakeId?: string | null; inline?: boolean } = {},
): Promise<{ briefId: string; status: CaseBriefStatus }> {
  if (!can(ctx, "brief:review")) {
    // A new version supersedes the lawyer's review: analysts only generate it from the intake page.
    if (!can(ctx, "intake:manage") || !opts.intakeId) throw new ForbiddenError();
  }
  const v = parseOrThrow(requestBriefSchema, { processId, intakeId: opts.intakeId ?? null, inline: opts.inline });
  const db = getDb();

  const [process] = await db
    .select({ id: legalProcesses.id, number: legalProcesses.number })
    .from(legalProcesses)
    .where(and(eq(legalProcesses.id, v.processId), processWhere(ctx)))
    .limit(1);
  if (!process) throw new NotFoundError("Processo não encontrado ou sem permissão de acesso.");

  if (v.intakeId) {
    const [intake] = await db
      .select({ id: caseIntakes.id })
      .from(caseIntakes)
      .where(
        and(
          eq(caseIntakes.id, v.intakeId),
          eq(caseIntakes.organizationId, ctx.organizationId),
          eq(caseIntakes.processId, process.id),
        ),
      )
      .limit(1);
    if (!intake) throw new ValidationError("Entrada de processo inválida.", { intakeId: ["Entrada não encontrada para este processo."] });
  }

  const [running] = await db
    .select({ id: caseBriefs.id, version: caseBriefs.version, createdAt: caseBriefs.createdAt })
    .from(caseBriefs)
    .where(
      and(
        eq(caseBriefs.processId, process.id),
        eq(caseBriefs.status, "generating"),
        // Only a generation the requester can see is reused (another one may use documents they cannot access).
        caseBriefWhere(ctx),
      ),
    )
    .limit(1);
  if (running) {
    if (!isStuckGenerating(running.createdAt)) return { briefId: running.id, status: "generating" };
    // A generation that never finished (job lost) must not block new requests.
    await getDb()
      .update(caseBriefs)
      .set({ status: "failed", errorMessage: STUCK_MESSAGE, updatedAt: new Date() })
      .where(and(eq(caseBriefs.id, running.id), eq(caseBriefs.status, "generating")));
    await recordAudit(ctx, {
      action: "case_brief.status_change",
      entityType: "case_brief",
      entityId: running.id,
      summary: `Geração interrompida da análise preliminar (versão ${running.version}) encerrada.`,
      changes: { status: { from: "generating", to: "failed" } },
    });
  }

  const provider = getCaseBriefProvider();
  let briefId: string;
  try {
    briefId = await db.transaction(async (tx) => {
      const [{ last }] = await tx
        .select({ last: max(caseBriefs.version) })
        .from(caseBriefs)
        .where(and(eq(caseBriefs.processId, process.id), eq(caseBriefs.organizationId, ctx.organizationId)));
      const version = (last ?? 0) + 1;
      const docs = await candidateDocuments(ctx, process.id, tx);
      const candidateHash = sha256(
        canonical({ provider: provider.name, model: provider.model, prompt: provider.promptVersion, docs: docs.map((d) => d.versionId) }),
      );
      // The intake page passes its intake (and links it itself); any other request moves the
      // intake that still follows an older, not approved version to this one.
      const relinked = v.intakeId ? [] : await intakesFollowingOlderVersion(tx, ctx.organizationId, process.id);
      const [row] = await tx
        .insert(caseBriefs)
        .values({
          organizationId: ctx.organizationId,
          processId: process.id,
          intakeId: v.intakeId ?? relinked[0] ?? null,
          version,
          status: "generating",
          mode: provider.mode,
          provider: provider.name,
          model: provider.model,
          promptVersion: provider.promptVersion,
          inputHash: candidateHash,
          requestedById: ctx.userId,
        })
        .returning({ id: caseBriefs.id });
      // Candidate sources (finalized by the job). They already restrict who can see the brief.
      await tx.insert(caseBriefSources).values([
        {
          organizationId: ctx.organizationId,
          briefId: row.id,
          ref: "REG",
          sourceType: "legal_process",
          entityId: process.id,
          label: `Cadastro do processo ${process.number}`,
          contentHash: "pending",
        },
        ...docs.map((d, i) => ({
          organizationId: ctx.organizationId,
          briefId: row.id,
          ref: `D${i + 1}`,
          sourceType: "document_version",
          entityId: d.documentId,
          versionId: d.versionId,
          versionNumber: d.versionNumber,
          label: d.title,
          contentHash: "pending",
        })),
      ]);
      if (relinked.length) {
        const step: IntakeStep = {
          status: "analyzing",
          at: new Date().toISOString(),
          detail:
            `Nova versão da análise preliminar (versão ${version}) solicitada por ${ctx.name} na análise preliminar do processo` +
            `${provider.mode === "demo" ? " (simulação)" : ""}. A entrada passa a acompanhar esta versão e o e-mail ao advogado será refeito quando ela ficar pronta.`,
          actorName: ctx.name,
        };
        await tx
          .update(caseIntakes)
          .set({
            briefId: row.id,
            status: "analyzing",
            errorMessage: null,
            lastEmailId: null,
            steps: sql`${caseIntakes.steps} || ${JSON.stringify([step])}::jsonb`,
          })
          .where(and(eq(caseIntakes.organizationId, ctx.organizationId), inArray(caseIntakes.id, relinked)));
      }
      await recordAudit(
        ctx,
        {
          action: "case_brief.request",
          entityType: "case_brief",
          entityId: row.id,
          summary: `Análise preliminar (versão ${version}) solicitada para o processo ${process.number}.`,
          metadata: {
            processId: process.id,
            version,
            documentCount: docs.length,
            intakeId: v.intakeId ?? relinked[0] ?? null,
            relinkedIntakes: relinked.length,
            inline: !!v.inline,
          },
        },
        tx,
      );
      if (!v.inline) {
        await enqueueJob(
          {
            type: "case_brief.generate",
            organizationId: ctx.organizationId,
            payload: { briefId: row.id },
            dedupeKey: `case_brief:${row.id}`,
          },
          tx,
        );
      }
      return row.id;
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ConflictError("Outra versão da análise preliminar acabou de ser solicitada. Atualize a página.");
    }
    throw err;
  }

  if (!v.inline) return { briefId, status: "generating" };
  try {
    await runCaseBriefJob(briefId, { attempt: 1, maxAttempts: 1 });
  } catch (err) {
    // Already recorded as `failed` on the brief.
    logger.warn("case_brief_inline_failed", { briefId, errorName: err instanceof Error ? err.name : typeof err });
  }
  const [after] = await db.select({ status: caseBriefs.status }).from(caseBriefs).where(eq(caseBriefs.id, briefId));
  return { briefId, status: after?.status ?? "failed" };
}

/**
 * Intakes of the process bound to an older version that is not approved (and
 * not cancelled). Intakes without a brief are left to their own pipeline.
 */
async function intakesFollowingOlderVersion(db: DbOrTx, organizationId: string, processId: string): Promise<string[]> {
  const rows = await db
    .select({ id: caseIntakes.id })
    .from(caseIntakes)
    .innerJoin(caseBriefs, and(eq(caseBriefs.id, caseIntakes.briefId), eq(caseBriefs.organizationId, caseIntakes.organizationId)))
    .where(
      and(
        eq(caseIntakes.organizationId, organizationId),
        eq(caseIntakes.processId, processId),
        ne(caseIntakes.status, "cancelled"),
        ne(caseBriefs.status, "approved"),
      ),
    )
    .orderBy(desc(caseIntakes.receivedAt));
  return rows.map((r) => r.id);
}

/** Enqueues the intake pipeline (e-mail step) of intakes that follow a version that just became ready. */
async function resumeIntakes(organizationId: string, briefId: string, intakeIds: string[]): Promise<void> {
  for (const intakeId of intakeIds) {
    try {
      // Same dedupe key as the intake module: an already queued run is reused.
      await enqueueJob({ type: "intake.process", organizationId, payload: { intakeId }, dedupeKey: `intake.process:${intakeId}` });
    } catch (err) {
      // The brief is already stored; "Continuar processamento" on the intake page resumes it.
      logger.warn("case_brief_intake_resume_failed", { briefId, intakeId, errorName: err instanceof Error ? err.name : typeof err });
    }
  }
}

/**
 * After a version becomes `ready_for_review` (post-commit, best effort): its
 * pedidos become SUGGESTIONS in the process through the claims module (origin
 * `ai_suggested`, pending confirmation; never counted in the risk until a
 * person confirms them; idempotent). A failure is logged without content and
 * never fails the brief: the claims panel still offers the import by hand.
 */
async function suggestClaimsFromReadyBrief(organizationId: string, briefId: string): Promise<void> {
  try {
    const { suggestClaimsFromBriefAsSystem } = await import("@/modules/claims/service");
    const { created, skipped } = await suggestClaimsFromBriefAsSystem(organizationId, briefId);
    if (created > 0) logger.info("case_brief_claims_suggested", { briefId, created, skipped });
  } catch (err) {
    logger.warn("case_brief_claims_suggest_failed", { briefId, ...errorSummary(err) });
  }
}

class AlreadyProcessed extends Error {}

/**
 * Job handler body for `case_brief.generate`. Idempotent: does nothing unless
 * the brief is still `generating`. Pending text extractions of the source
 * documents are run first. Provider/transient errors are rethrown after being
 * recorded so the queue can retry; the last attempt marks the brief `failed`.
 */
export async function runCaseBriefJob(briefId: string, opts: { attempt: number; maxAttempts: number }): Promise<void> {
  if (!idSchema.safeParse(briefId).success) return;
  const db = getDb();
  const [b] = await db.select().from(caseBriefs).where(eq(caseBriefs.id, briefId)).limit(1);
  if (!b || b.status !== "generating") return;
  const sys = systemContext(b.organizationId);

  try {
    const record = await buildRecord(b.organizationId, b.processId);
    if (!record) throw new NotFoundError(PROCESS_GONE_MESSAGE);

    const candidates = await db
      .select()
      .from(caseBriefSources)
      .where(and(eq(caseBriefSources.briefId, b.id), eq(caseBriefSources.organizationId, b.organizationId)));
    const docCandidates = candidates
      .filter((s) => s.sourceType === "document_version" && s.versionId)
      .sort((x, y) => refNumber(x.ref) - refNumber(y.ref));
    const versionIds = docCandidates.map((s) => s.versionId!) as string[];

    // Make sure pending extractions are done (idempotent in the documents service).
    if (versionIds.length) {
      const pending = await db
        .select({ id: documentVersions.id })
        .from(documentVersions)
        .where(
          and(
            inArray(documentVersions.id, versionIds),
            eq(documentVersions.organizationId, b.organizationId),
            eq(documentVersions.extractionStatus, "pending"),
          ),
        );
      if (pending.length) {
        const { extractDocumentVersionText } = await import("@/modules/documents/service");
        for (const p of pending) await extractDocumentVersionText(p.id);
      }
    }

    const rows = versionIds.length
      ? await db
          .select({
            versionId: documentVersions.id,
            documentId: documents.id,
            processId: documents.processId,
            deletedAt: documents.deletedAt,
            title: documents.title,
            category: documents.category,
            fileName: documentVersions.fileName,
            versionNumber: documentVersions.versionNumber,
            status: documentVersions.extractionStatus,
            text: documentVersions.extractedText,
            pageCount: documentVersions.pageCount,
            pageOffsets: documentVersions.pageOffsets,
          })
          .from(documentVersions)
          .innerJoin(documents, eq(documents.id, documentVersions.documentId))
          .where(and(inArray(documentVersions.id, versionIds), eq(documentVersions.organizationId, b.organizationId)))
      : [];
    const byVersion = new Map(rows.map((r) => [r.versionId, r]));
    const usable = docCandidates
      .map((s) => byVersion.get(s.versionId!))
      .filter(
        (r): r is (typeof rows)[number] =>
          !!r && !r.deletedAt && r.processId === b.processId && r.status === "succeeded" && !!r.text,
      );
    const skipped = docCandidates.length - usable.length;

    const docSources: CaseBriefDocumentSource[] = usable.map((r, i) => ({
      ref: `D${i + 1}`,
      documentId: r.documentId,
      versionId: r.versionId,
      title: r.title,
      category: r.category as DocumentCategory,
      fileName: r.fileName,
      text: r.text ?? "",
      pageOffsets: Array.isArray(r.pageOffsets) && r.pageOffsets.length ? r.pageOffsets : null,
      pageCount: r.pageCount ?? (Array.isArray(r.pageOffsets) && r.pageOffsets.length ? r.pageOffsets.length : null),
    }));

    const provider = getCaseBriefProvider();
    const response = await provider.generate({ record, documents: docSources, today: todayISO() });
    const validated = caseBriefSchema.safeParse(response.brief);
    if (!validated.success) {
      throw new AiProviderError("invalid_case_brief_output", {
        retryable: true,
        userMessage: "O gerador da análise preliminar retornou um resultado em formato inválido.",
      });
    }

    const sourceInfo = new Map<string, SourceInfo>([["REG", { pageCount: 1, text: null }]]);
    for (const d of docSources) {
      sourceInfo.set(d.ref, { pageCount: Math.max(1, d.pageCount ?? d.pageOffsets?.length ?? 1), text: d.text });
    }
    const { brief, dropped, clearedDates } = sanitizeGeneratedBrief(validated.data, sourceInfo);
    const limitations = [...brief.limitations];
    if (skipped > 0) {
      limitations.push(
        `${skipped} documento(s) do processo não tinham texto extraído no momento da geração (imagem, PDF digitalizado ou falha de leitura) e não foram lidos.`,
      );
    }
    if (dropped) limitations.push(`${dropped} item(ns) sem referência válida às fontes foram descartados pelo sistema.`);
    if (clearedDates) {
      limitations.push(`${clearedDates} data(s) de possíveis prazos foram removidas por não aparecerem literalmente nas fontes.`);
    }
    const systemNotices = provider.mode === "demo" ? [CASE_BRIEF_DEMO_NOTICE, CASE_BRIEF_DISCLAIMER] : [CASE_BRIEF_DISCLAIMER];
    const stored: StoredCaseBrief = { ...brief, limitations, systemNotices };

    const recordJson = JSON.stringify(record);
    const finalSources = [
      {
        ref: "REG",
        sourceType: "legal_process",
        entityId: b.processId,
        versionId: null as string | null,
        versionNumber: null as number | null,
        label: `Cadastro do processo ${record.number}`,
        contentHash: sha256(recordJson),
        pageCount: null as number | null,
        charCount: recordJson.length,
      },
      ...docSources.map((d, i) => ({
        ref: d.ref,
        sourceType: "document_version",
        entityId: d.documentId,
        versionId: d.versionId,
        versionNumber: usable[i].versionNumber,
        label: d.title,
        contentHash: sha256(d.text),
        pageCount: d.pageCount,
        charCount: d.text.length,
      })),
    ];
    const inputHash = sha256(
      canonical({
        provider: provider.name,
        model: provider.model,
        prompt: provider.promptVersion,
        sources: finalSources.map((s) => ({ ref: s.ref, entityId: s.entityId, versionId: s.versionId, hash: s.contentHash })),
      }),
    );

    const [process] = await db
      .select({ number: legalProcesses.number })
      .from(legalProcesses)
      .where(eq(legalProcesses.id, b.processId))
      .limit(1);

    const intakesToResume = await db.transaction(async (tx) => {
      const now = new Date();
      const updated = await tx
        .update(caseBriefs)
        .set({
          status: "ready_for_review",
          mode: provider.mode,
          provider: provider.name,
          model: provider.model,
          promptVersion: provider.promptVersion,
          inputHash,
          originalContent: stored,
          content: stored,
          currentRevision: 1,
          errorMessage: null,
          generatedAt: now,
          isStale: false,
          staleReason: null,
          updatedAt: now,
        })
        .where(and(eq(caseBriefs.id, b.id), eq(caseBriefs.status, "generating")))
        .returning({ id: caseBriefs.id });
      if (!updated.length) throw new AlreadyProcessed();

      await tx.delete(caseBriefSources).where(eq(caseBriefSources.briefId, b.id));
      await tx.insert(caseBriefSources).values(
        finalSources.map((s) => ({ ...s, organizationId: b.organizationId, briefId: b.id })),
      );
      await tx.insert(caseBriefRevisions).values({
        organizationId: b.organizationId,
        briefId: b.id,
        revision: 1,
        content: stored,
        editedById: null,
        changeNote: provider.mode === "demo" ? "Conteúdo gerado pela simulação." : "Conteúdo gerado pelo provedor.",
      });

      // Older versions waiting for review are superseded by this one.
      const older = await tx
        .select({ id: caseBriefs.id })
        .from(caseBriefs)
        .where(
          and(
            eq(caseBriefs.processId, b.processId),
            eq(caseBriefs.organizationId, b.organizationId),
            sql`${caseBriefs.version} < ${b.version}`,
          ),
        );
      await resolveAlertsByDedupeKeys(b.organizationId, older.map((o) => alertKey(o.id)), tx);

      const demo = provider.mode === "demo";
      await upsertAlert(
        {
          organizationId: b.organizationId,
          type: "brief_pending_review",
          severity: stored.urgencies.length ? "warning" : "info",
          title: `${demo ? "[Simulação] " : ""}Análise preliminar pronta para revisão`,
          message:
            `A análise preliminar (versão ${b.version}) do processo ${process?.number ?? ""} está pronta para revisão do advogado` +
            `${demo ? " (gerada por simulação, conteúdo demonstrativo)" : ""}. ` +
            `${stored.urgencies.length} urgência(s) e ${stored.missingDocuments.length} documento(s) faltante(s) apontados.`,
          entityType: "case_brief",
          entityId: b.id,
          dedupeKey: alertKey(b.id),
        },
        tx,
      );
      await recordAudit(
        sys,
        {
          action: "case_brief.generate",
          entityType: "case_brief",
          entityId: b.id,
          summary: `Análise preliminar (versão ${b.version}) gerada${demo ? " por simulação" : ""} e pronta para revisão.`,
          metadata: {
            processId: b.processId,
            mode: provider.mode,
            documentCount: docSources.length,
            skippedDocuments: skipped,
            droppedItems: dropped,
            clearedDates,
            promptInjectionSuspected: stored.promptInjectionSuspected,
          },
        },
        tx,
      );

      // Intakes following this version (moved here by requestCaseBrief, or one that reused this
      // generation while it was running) continue: "brief_ready" now, the e-mail step via the
      // intake.process job enqueued after the commit. Never on failure (the intake retries itself).
      const readyStep: IntakeStep = {
        status: "brief_ready",
        at: now.toISOString(),
        detail: `Análise preliminar versão ${b.version} gerada${demo ? " pela simulação" : ""} e pronta para revisão do advogado.`,
        actorName: demo ? "Sistema (simulação)" : "Sistema",
      };
      await tx
        .update(caseIntakes)
        .set({ status: "brief_ready", errorMessage: null, steps: sql`${caseIntakes.steps} || ${JSON.stringify([readyStep])}::jsonb` })
        .where(and(eq(caseIntakes.organizationId, b.organizationId), eq(caseIntakes.briefId, b.id), eq(caseIntakes.status, "analyzing")));
      const following = await tx
        .select({ id: caseIntakes.id })
        .from(caseIntakes)
        .where(and(eq(caseIntakes.organizationId, b.organizationId), eq(caseIntakes.briefId, b.id), ne(caseIntakes.status, "cancelled")));
      return following.map((r) => r.id);
    });
    logger.info("case_brief_generated", { briefId: b.id, documents: docSources.length, dropped });
    await suggestClaimsFromReadyBrief(b.organizationId, b.id);
    await resumeIntakes(b.organizationId, b.id, intakesToResume);
  } catch (err) {
    if (err instanceof AlreadyProcessed) return;
    const retryable = err instanceof AiProviderError ? err.retryable : !(err instanceof AppError);
    const message = err instanceof AiProviderError ? err.userMessage : err instanceof AppError ? err.message : UNEXPECTED_RUN_ERROR;
    logger.warn("case_brief_run_failed", {
      briefId: b.id,
      attempt: opts.attempt,
      retryable,
      errorName: err instanceof Error ? err.name : typeof err,
      errorCode: err instanceof AiProviderError ? err.message : err instanceof AppError ? err.code : undefined,
    });
    if (retryable && opts.attempt < opts.maxAttempts) {
      await db
        .update(caseBriefs)
        .set({ errorMessage: `${message} Nova tentativa em andamento.`.slice(0, 500), updatedAt: new Date() })
        .where(and(eq(caseBriefs.id, b.id), eq(caseBriefs.status, "generating")));
    } else {
      await markFailed(b, sys, message);
    }
    throw err;
  }
}

async function markFailed(b: BriefRow, sys: AuthContext, message: string): Promise<void> {
  await getDb().transaction(async (tx) => {
    const updated = await tx
      .update(caseBriefs)
      .set({ status: "failed", errorMessage: message.slice(0, 500), updatedAt: new Date() })
      .where(and(eq(caseBriefs.id, b.id), eq(caseBriefs.status, "generating")))
      .returning({ id: caseBriefs.id });
    if (!updated.length) return;
    await recordAudit(
      sys,
      {
        action: "case_brief.status_change",
        entityType: "case_brief",
        entityId: b.id,
        summary: `Falha na geração da análise preliminar (versão ${b.version}).`,
        changes: { status: { from: "generating", to: "failed" } },
      },
      tx,
    );
  });
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

function contentCounts(content: StoredCaseBrief | null): CaseBriefListItem["counts"] {
  if (!content) return null;
  return {
    contradictions: content.contradictions.length,
    missingDocuments: content.missingDocuments.length,
    urgencies: content.urgencies.length,
  };
}

/**
 * Review queue (`brief:read`). Filters by status, process responsible and
 * process. Filtering by a review status (ready for review / in review) lists
 * only the latest generated version of each process: superseded versions are
 * no longer reviewable (`superseded` marks them in unfiltered lists).
 */
export async function listCaseBriefs(ctx: AuthContext, filters: ListBriefsFilters & Page = {}): Promise<Paginated<CaseBriefListItem>> {
  assertCan(ctx, "brief:read");
  const f = parseOrThrow(listBriefsSchema, filters ?? {});
  const { page, pageSize, offset } = normalizePage(f);
  const conds: (SQL | undefined)[] = [caseBriefWhere(ctx)];
  if (f.status) conds.push(eq(caseBriefs.status, f.status));
  if (f.status && REVIEWABLE_STATUSES.includes(f.status)) conds.push(sql`not ${supersededSql()}`);
  if (f.processId) conds.push(eq(caseBriefs.processId, f.processId));
  if (f.responsibleId) conds.push(eq(legalProcesses.responsibleId, f.responsibleId));
  if (f.staleOnly) conds.push(eq(caseBriefs.isStale, true));
  const where = and(...conds);
  const processJoin = and(eq(legalProcesses.id, caseBriefs.processId), eq(legalProcesses.organizationId, ctx.organizationId));

  const db = getDb();
  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        b: {
          id: caseBriefs.id,
          processId: caseBriefs.processId,
          version: caseBriefs.version,
          status: caseBriefs.status,
          mode: caseBriefs.mode,
          currentRevision: caseBriefs.currentRevision,
          isStale: caseBriefs.isStale,
          generatedAt: caseBriefs.generatedAt,
          approvedAt: caseBriefs.approvedAt,
          createdAt: caseBriefs.createdAt,
          content: caseBriefs.content,
        },
        superseded: sql<boolean>`${supersededSql()}`,
        processNumber: legalProcesses.number,
        processTitle: legalProcesses.title,
        responsibleId: legalProcesses.responsibleId,
      })
      .from(caseBriefs)
      .innerJoin(legalProcesses, processJoin)
      .where(where)
      .orderBy(desc(caseBriefs.createdAt), desc(caseBriefs.id))
      .limit(pageSize)
      .offset(offset),
    db.select({ total: count() }).from(caseBriefs).innerJoin(legalProcesses, processJoin).where(where),
  ]);
  const names = await userNames(ctx.organizationId, rows.map((r) => r.responsibleId));
  return {
    items: rows.map((r) => ({
      id: r.b.id,
      processId: r.b.processId,
      processNumber: r.processNumber,
      processTitle: r.processTitle,
      responsibleName: r.responsibleId ? (names.get(r.responsibleId) ?? null) : null,
      version: r.b.version,
      status: r.b.status,
      mode: r.b.mode,
      currentRevision: r.b.currentRevision,
      isStale: r.b.isStale,
      generatedAt: r.b.generatedAt,
      approvedAt: r.b.approvedAt,
      createdAt: r.b.createdAt,
      counts: contentCounts(r.b.content),
      superseded: r.superseded === true,
    })),
    total: Number(total),
    page,
    pageSize,
  };
}

/** Number of visible briefs per status (queue header); review statuses count only non-superseded versions. */
export async function countCaseBriefsByStatus(ctx: AuthContext): Promise<Record<CaseBriefStatus, number>> {
  assertCan(ctx, "brief:read");
  const rows = await getDb()
    .select({ status: caseBriefs.status, total: count() })
    .from(caseBriefs)
    .where(and(caseBriefWhere(ctx), or(notInArray(caseBriefs.status, [...REVIEWABLE_STATUSES]), sql`not ${supersededSql()}`)))
    .groupBy(caseBriefs.status);
  const out: Record<CaseBriefStatus, number> = {
    generating: 0,
    ready_for_review: 0,
    in_review: 0,
    approved: 0,
    rejected: 0,
    failed: 0,
  };
  for (const r of rows) out[r.status] = Number(r.total);
  return out;
}

export async function getCaseBrief(ctx: AuthContext, id: string): Promise<CaseBriefDetail> {
  assertCan(ctx, "brief:read");
  const b = await loadVisibleBrief(ctx, id);
  const db = getDb();
  const [process] = await db
    .select({
      id: legalProcesses.id,
      number: legalProcesses.number,
      title: legalProcesses.title,
      responsibleId: legalProcesses.responsibleId,
    })
    .from(legalProcesses)
    .where(and(eq(legalProcesses.id, b.processId), processWhere(ctx)))
    .limit(1);
  if (!process) throw new NotFoundError();

  const [sources, revisions, others, superseded] = await Promise.all([
    db
      .select()
      .from(caseBriefSources)
      .where(and(eq(caseBriefSources.briefId, b.id), eq(caseBriefSources.organizationId, ctx.organizationId))),
    db
      .select({
        revision: caseBriefRevisions.revision,
        editedById: caseBriefRevisions.editedById,
        changeNote: caseBriefRevisions.changeNote,
        createdAt: caseBriefRevisions.createdAt,
      })
      .from(caseBriefRevisions)
      .where(and(eq(caseBriefRevisions.briefId, b.id), eq(caseBriefRevisions.organizationId, ctx.organizationId)))
      .orderBy(desc(caseBriefRevisions.revision)),
    db
      .select({ id: caseBriefs.id, version: caseBriefs.version, status: caseBriefs.status, createdAt: caseBriefs.createdAt })
      .from(caseBriefs)
      .where(and(eq(caseBriefs.processId, b.processId), caseBriefWhere(ctx)))
      .orderBy(desc(caseBriefs.version)),
    isSuperseded(b),
  ]);
  const latestVisible = superseded
    ? (others.find((o) => o.version > b.version && GENERATED_STATUSES.includes(o.status)) ?? null)
    : null;
  const names = await userNames(ctx.organizationId, [
    b.requestedById,
    b.lastEditedById,
    b.approvedById,
    b.rejectedById,
    ...revisions.map((r) => r.editedById),
  ]);
  const name = (uid: string | null) => (uid ? (names.get(uid) ?? null) : null);

  return {
    id: b.id,
    version: b.version,
    status: b.status,
    mode: b.mode,
    provider: b.provider,
    model: b.model,
    promptVersion: b.promptVersion,
    process,
    intakeId: b.intakeId,
    content: b.content,
    currentRevision: b.currentRevision,
    errorMessage: b.errorMessage,
    isStale: b.isStale,
    staleReason: b.staleReason,
    requestedByName: name(b.requestedById),
    createdAt: b.createdAt,
    generatedAt: b.generatedAt,
    lastEditedByName: name(b.lastEditedById),
    lastEditedAt: b.lastEditedAt,
    approvedByName: name(b.approvedById),
    approvedAt: b.approvedAt,
    approvalNote: b.approvalNote,
    rejectedByName: name(b.rejectedById),
    rejectedAt: b.rejectedAt,
    rejectionReason: b.rejectionReason,
    sources: sources
      .map((s) => ({
        ref: s.ref,
        sourceType: (s.sourceType === "legal_process" ? "legal_process" : "document_version") as CaseBriefSourceItem["sourceType"],
        entityId: s.entityId,
        versionId: s.versionId,
        versionNumber: s.versionNumber,
        label: s.label,
        pageCount: s.pageCount,
        charCount: s.charCount,
      }))
      .sort((x, y) => refNumber(x.ref) - refNumber(y.ref)),
    revisions: revisions.map((r) => ({
      revision: r.revision,
      editedByName: name(r.editedById),
      changeNote: r.changeNote,
      createdAt: r.createdAt,
    })),
    otherVersions: others,
    superseded,
    latestVersion: latestVisible ? { id: latestVisible.id, version: latestVisible.version } : null,
  };
}

/**
 * Latest brief of a process visible to ctx. Returns null when there is none,
 * when it is not visible, or when the user lacks `brief:read` (so callers such
 * as the process page can render it unconditionally).
 */
export async function getLatestCaseBriefSummary(ctx: AuthContext, processId: string): Promise<CaseBriefSummary | null> {
  if (!can(ctx, "brief:read")) return null;
  const pid = idSchema.safeParse(processId);
  if (!pid.success) return null;
  const [b] = await getDb()
    .select({
      id: caseBriefs.id,
      processId: caseBriefs.processId,
      version: caseBriefs.version,
      status: caseBriefs.status,
      mode: caseBriefs.mode,
      content: caseBriefs.content,
      generatedAt: caseBriefs.generatedAt,
      approvedAt: caseBriefs.approvedAt,
      approvedById: caseBriefs.approvedById,
      isStale: caseBriefs.isStale,
    })
    .from(caseBriefs)
    .where(and(eq(caseBriefs.processId, pid.data), caseBriefWhere(ctx)))
    .orderBy(desc(caseBriefs.version))
    .limit(1);
  if (!b) return null;
  const names = await userNames(ctx.organizationId, [b.approvedById]);
  return {
    id: b.id,
    processId: b.processId,
    version: b.version,
    status: b.status,
    mode: b.mode,
    headline: b.content?.headline ?? null,
    generatedAt: b.generatedAt,
    approvedAt: b.approvedAt,
    approvedByName: b.approvedById ? (names.get(b.approvedById) ?? null) : null,
    isStale: b.isStale,
  };
}

/** Short digest for the "análise disponível" e-mail (requires `brief:read`; system context allowed). */
export async function getCaseBriefEmailDigest(ctx: AuthContext, briefId: string): Promise<CaseBriefEmailDigest> {
  assertCan(ctx, "brief:read");
  const b = await loadVisibleBrief(ctx, briefId);
  if (!b.content) throw new ConflictError("A análise preliminar ainda não foi gerada.");
  const c = b.content;
  return {
    briefId: b.id,
    version: b.version,
    headline: clip(c.headline, 600),
    urgencies: c.urgencies.slice(0, 5).map((u) => clip(u.text, 300)),
    possibleDeadlines: c.possibleDeadlines.slice(0, 5).map((d) => ({ description: clip(d.description, 300), date: d.date })),
    gapsCount: c.gaps.length,
    missingDocumentsCount: c.missingDocuments.length,
    isDemo: isDemoMode(b.mode),
  };
}

// ---------------------------------------------------------------------------
// Citation viewer
// ---------------------------------------------------------------------------

export type { BriefCitationPage } from "./types";

/**
 * Text of the page a citation points to. Requires `brief:read` + `document:read`;
 * the brief must be visible AND the document visible (checked again by the
 * documents service with `documentWhere`).
 */
export async function getBriefCitationPage(
  ctx: AuthContext,
  input: { briefId: string; ref: string; page: number | null },
): Promise<BriefCitationPage> {
  assertCan(ctx, "brief:read");
  assertCan(ctx, "document:read");
  const v = parseOrThrow(citationPageSchema, input);
  const b = await loadVisibleBrief(ctx, v.briefId);
  const [source] = await getDb()
    .select()
    .from(caseBriefSources)
    .where(
      and(
        eq(caseBriefSources.briefId, b.id),
        eq(caseBriefSources.organizationId, ctx.organizationId),
        eq(caseBriefSources.ref, v.ref),
        eq(caseBriefSources.sourceType, "document_version"),
      ),
    )
    .limit(1);
  if (!source?.versionId) throw new NotFoundError("Fonte não encontrada nesta análise.");
  const { getDocumentVersionPageText } = await import("@/modules/documents/service");
  const page = await getDocumentVersionPageText(ctx, source.entityId, source.versionId, v.page);
  return {
    ref: source.ref,
    documentId: page.documentId,
    versionId: page.versionId,
    title: page.title,
    versionNumber: page.versionNumber,
    page: page.page,
    pageCount: page.pageCount,
    text: page.text,
    truncated: page.truncated,
  };
}

// ---------------------------------------------------------------------------
// Review: revisions, approval, rejection, regeneration
// ---------------------------------------------------------------------------

function assertReviewable(b: BriefRow): asserts b is BriefRow & { content: StoredCaseBrief } {
  if (!b.content) throw new ConflictError("A análise preliminar ainda não foi gerada.");
  if (!REVIEWABLE_STATUSES.includes(b.status)) {
    throw new ConflictError(
      b.status === "approved"
        ? "Esta análise já foi aprovada. Para alterar, gere uma nova versão."
        : b.status === "rejected"
          ? "Esta análise foi rejeitada. Gere uma nova versão para revisar novamente."
          : "Esta análise não está disponível para revisão.",
    );
  }
}

type RevisionResult = { revision: number; changed: boolean };

/** Fields that cannot be empty in an item written by the reviewer. */
const REQUIRED_ITEM_FIELDS: Record<CaseBriefSectionKey, string[]> = {
  identification: ["label"],
  factsSummary: ["text"],
  timeline: ["description"],
  claims: ["description"],
  amounts: ["label"],
  evidence: ["description"],
  plaintiffArguments: ["text"],
  defendantArguments: ["text"],
  contradictions: ["text"],
  missingDocuments: ["text"],
  theses: ["text"],
  risks: ["description"],
  urgencies: ["text"],
  nextSteps: ["description"],
  possibleDeadlines: ["description", "basis"],
  gaps: ["text"],
};

/** Checks the headline and every item written by the reviewer (required text, valid dates and amounts). */
function assertItemsFilled(brief: CaseBrief): void {
  if (!brief.headline.trim()) throw new ValidationError("Informe o resumo da análise.", { headline: ["Informe o resumo."] });
  for (const { key, label } of CASE_BRIEF_SECTIONS) {
    const items = brief[key] as unknown as Record<string, unknown>[];
    items.forEach((item, i) => {
      // Generated items are validated at generation; only the reviewer's items are checked here.
      if (item.provenance !== "reviewer") return;
      for (const f of REQUIRED_ITEM_FIELDS[key]) {
        const v = item[f];
        if (typeof v !== "string" || !v.trim()) {
          throw new ValidationError(`Seção “${label}”, item ${i + 1}: preencha todos os campos obrigatórios.`, {
            [key]: [`Item ${i + 1} incompleto.`],
          });
        }
      }
      for (const dateField of ["date"]) {
        const d = item[dateField];
        if (typeof d === "string" && !isValidIsoDate(d)) {
          throw new ValidationError(`Seção “${label}”, item ${i + 1}: data inválida.`, { [key]: [`Item ${i + 1}: data inválida.`] });
        }
      }
      const amount = item.amountCents;
      if (typeof amount === "number" && (!Number.isSafeInteger(amount) || amount < 0)) {
        throw new ValidationError(`Seção “${label}”, item ${i + 1}: valor inválido.`, { [key]: [`Item ${i + 1}: valor inválido.`] });
      }
    });
  }
}

async function storeRevision(
  ctx: AuthContext,
  b: BriefRow & { content: StoredCaseBrief },
  next: CaseBrief,
  meta: { baseRevision: number; changeNote: string | null },
): Promise<RevisionResult> {
  if (meta.baseRevision !== b.currentRevision) {
    throw new ConflictError("A análise foi alterada por outra pessoa. Recarregue a página e refaça a edição.");
  }
  const current = b.content;
  const sources = await sourceInfoForBrief(b.id, ctx.organizationId);
  const merged: StoredCaseBrief = {
    ...current,
    headline: next.headline.trim() || current.headline,
  };
  const changedSections: string[] = [];
  if (merged.headline !== current.headline) changedSections.push("headline");
  let changedItems = 0;
  for (const key of CASE_BRIEF_SECTIONS.map((s) => s.key)) {
    const result = mergeSection(current[key] as AnyItem[], next[key] as AnyItem[], sources);
    if (result.changed) {
      changedSections.push(key);
      changedItems += result.items.filter((i) => i.provenance === "reviewer").length;
      (merged as Record<string, unknown>)[key] = result.items;
    }
  }
  if (!changedSections.length) return { revision: b.currentRevision, changed: false };
  assertItemsFilled(merged);
  if (JSON.stringify(merged).length > MAX_CONTENT_BYTES) {
    throw new ValidationError("O conteúdo da análise ficou grande demais. Reduza o texto dos itens.");
  }

  const revision = b.currentRevision + 1;
  await getDb().transaction(async (tx) => {
    const now = new Date();
    const updated = await tx
      .update(caseBriefs)
      .set({
        content: merged,
        currentRevision: revision,
        status: "in_review",
        lastEditedById: ctx.userId,
        lastEditedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(caseBriefs.id, b.id),
          eq(caseBriefs.organizationId, ctx.organizationId),
          eq(caseBriefs.currentRevision, b.currentRevision),
          inArray(caseBriefs.status, [...REVIEWABLE_STATUSES]),
          notSupersededGuard(b),
        ),
      )
      .returning({ id: caseBriefs.id });
    if (!updated.length) {
      throw new ConflictError("A análise foi alterada por outra pessoa. Recarregue a página e refaça a edição.");
    }
    await tx.insert(caseBriefRevisions).values({
      organizationId: ctx.organizationId,
      briefId: b.id,
      revision,
      content: merged,
      editedById: ctx.userId,
      changeNote: meta.changeNote,
    });
    await recordAudit(
      ctx,
      {
        action: "case_brief.edit",
        entityType: "case_brief",
        entityId: b.id,
        summary: `Análise preliminar (versão ${b.version}) editada pelo advogado: revisão ${revision}.`,
        changes: b.status !== "in_review" ? { status: { from: b.status, to: "in_review" } } : null,
        // Section keys only: the content itself is never audited.
        metadata: { revision, sections: changedSections, reviewerItems: changedItems },
      },
      tx,
    );
  });
  return { revision, changed: true };
}

/**
 * Saves a full revision of the brief (`brief:review`). The content is
 * validated against caseBriefSchema; new or changed items get provenance
 * "reviewer"; limitations, system notices and the injection flag are kept.
 */
export async function saveCaseBriefRevision(
  ctx: AuthContext,
  id: string,
  input: { content: unknown; baseRevision: number; changeNote?: string | null },
): Promise<RevisionResult> {
  assertCan(ctx, "brief:review");
  const meta = parseOrThrow(revisionMetaSchema, { baseRevision: input?.baseRevision, changeNote: input?.changeNote });
  const parsed = caseBriefSchema.safeParse(input?.content);
  if (!parsed.success) throw new ValidationError("O conteúdo da análise é inválido. Recarregue a página e tente novamente.");
  const b = await loadVisibleBrief(ctx, id);
  assertReviewable(b);
  await assertLatestVersion(b);
  return storeRevision(ctx, b, parsed.data, meta);
}

/** Saves one section (or the headline) of the brief as a new revision (`brief:review`). */
export async function saveCaseBriefSection(
  ctx: AuthContext,
  id: string,
  input: { section: EditableSectionKey; value: unknown; baseRevision: number; changeNote?: string | null },
): Promise<RevisionResult> {
  assertCan(ctx, "brief:review");
  const section = parseOrThrow(z.object({ section: sectionKeySchema }), { section: input?.section }).section;
  const meta = parseOrThrow(revisionMetaSchema, { baseRevision: input?.baseRevision, changeNote: input?.changeNote });
  const b = await loadVisibleBrief(ctx, id);
  assertReviewable(b);
  await assertLatestVersion(b);
  const schema =
    section === "headline"
      ? z.string().trim().min(1, "Informe o resumo.").max(3000, "O resumo pode ter no máximo 3.000 caracteres.")
      : caseBriefSchema.shape[section as CaseBriefSectionKey];
  const parsed = (schema as z.ZodType).safeParse(input?.value);
  if (!parsed.success) {
    throw new ValidationError("Verifique os itens da seção: há campos inválidos ou vazios.", {
      [section]: [parsed.error.issues[0]?.message ?? "Conteúdo inválido."],
    });
  }
  const next = { ...b.content, systemNotices: undefined, [section]: parsed.data } as unknown as CaseBrief;
  return storeRevision(ctx, b, next, meta);
}

export async function approveCaseBrief(ctx: AuthContext, id: string, input: { note?: string | null } = {}): Promise<void> {
  assertCan(ctx, "brief:review");
  const v = parseOrThrow(approveBriefSchema, input ?? {});
  const b = await loadVisibleBrief(ctx, id);
  assertReviewable(b);
  await assertLatestVersion(b);
  await getDb().transaction(async (tx) => {
    const now = new Date();
    const updated = await tx
      .update(caseBriefs)
      .set({ status: "approved", approvedById: ctx.userId, approvedAt: now, approvalNote: v.note, updatedAt: now })
      .where(
        and(
          eq(caseBriefs.id, b.id),
          eq(caseBriefs.organizationId, ctx.organizationId),
          inArray(caseBriefs.status, [...REVIEWABLE_STATUSES]),
          notSupersededGuard(b),
        ),
      )
      .returning({ id: caseBriefs.id });
    if (!updated.length) throw new ConflictError("A análise mudou de situação. Recarregue a página.");
    await resolveAlertsByDedupeKeys(ctx.organizationId, [alertKey(b.id)], tx);
    await recordAudit(
      ctx,
      {
        action: "case_brief.approve",
        entityType: "case_brief",
        entityId: b.id,
        summary: `Análise preliminar (versão ${b.version}) aprovada pelo advogado.`,
        changes: { status: { from: b.status, to: "approved" } },
        metadata: { revision: b.currentRevision, hasNote: !!v.note },
      },
      tx,
    );
  });
}

export async function rejectCaseBrief(ctx: AuthContext, id: string, input: { reason: string }): Promise<void> {
  assertCan(ctx, "brief:review");
  const v = parseOrThrow(rejectBriefSchema, input ?? {});
  const b = await loadVisibleBrief(ctx, id);
  assertReviewable(b);
  await assertLatestVersion(b);
  await getDb().transaction(async (tx) => {
    const now = new Date();
    const updated = await tx
      .update(caseBriefs)
      .set({ status: "rejected", rejectedById: ctx.userId, rejectedAt: now, rejectionReason: v.reason, updatedAt: now })
      .where(
        and(
          eq(caseBriefs.id, b.id),
          eq(caseBriefs.organizationId, ctx.organizationId),
          inArray(caseBriefs.status, [...REVIEWABLE_STATUSES]),
          notSupersededGuard(b),
        ),
      )
      .returning({ id: caseBriefs.id });
    if (!updated.length) throw new ConflictError("A análise mudou de situação. Recarregue a página.");
    await resolveAlertsByDedupeKeys(ctx.organizationId, [alertKey(b.id)], tx);
    await recordAudit(
      ctx,
      {
        action: "case_brief.reject",
        entityType: "case_brief",
        entityId: b.id,
        summary: `Análise preliminar (versão ${b.version}) rejeitada pelo advogado.`,
        changes: { status: { from: b.status, to: "rejected" } },
      },
      tx,
    );
  });
}

/** Generates a new version for the process of a visible brief (`brief:review`). */
export async function regenerateCaseBrief(ctx: AuthContext, briefId: string): Promise<{ briefId: string; status: CaseBriefStatus }> {
  assertCan(ctx, "brief:review");
  const b = await loadVisibleBrief(ctx, briefId);
  return requestCaseBrief(ctx, b.processId);
}

// ---------------------------------------------------------------------------
// Applying suggestions (explicit user actions)
// ---------------------------------------------------------------------------

async function loadApplicableBrief(ctx: AuthContext, briefId: string): Promise<BriefRow & { content: StoredCaseBrief }> {
  const b = await loadVisibleBrief(ctx, briefId);
  if (!b.content || !APPLICABLE_STATUSES.includes(b.status)) {
    throw new ConflictError("Somente análises prontas, em revisão ou aprovadas podem gerar prazos, tarefas ou valores.");
  }
  await assertLatestVersion(b);
  return b as BriefRow & { content: StoredCaseBrief };
}

function citationLabel(citations: BriefCitation[]): string {
  const refs = citations.map((c) => (c.page ? `${c.ref}, p. ${c.page}` : c.ref));
  return refs.length ? refs.join("; ") : "sem citação";
}

/**
 * Turns a possible deadline with a literal date into a deadline PENDING HUMAN
 * VALIDATION (`deadline:write`). Items without a date cannot be applied: the
 * lawyer counts the deadline and registers it manually.
 */
export async function applyBriefDeadline(ctx: AuthContext, briefId: string, index: number): Promise<{ deadlineId: string }> {
  assertCan(ctx, "deadline:write");
  const v = parseOrThrow(itemIndexSchema, { briefId, index });
  const b = await loadApplicableBrief(ctx, v.briefId);
  const d = b.content.possibleDeadlines[v.index];
  if (!d) throw new NotFoundError("Possível prazo não encontrado.");
  if (!d.date || !isValidIsoDate(d.date)) {
    throw new ValidationError(
      "Este possível prazo não tem data escrita no documento. Conte o prazo e cadastre-o manualmente em Prazos.",
    );
  }
  const title = clip(d.description, 300);
  const [dup] = await getDb()
    .select({ id: deadlines.id })
    .from(deadlines)
    .where(
      and(
        eq(deadlines.organizationId, ctx.organizationId),
        eq(deadlines.sourceAnalysisId, b.id),
        eq(deadlines.title, title),
        isNull(deadlines.deletedAt),
      ),
    )
    .limit(1);
  if (dup) throw new ConflictError("Este possível prazo já foi enviado para validação.");

  // The basis quotes the document: it goes only to `sourceExcerpt`, which the work module shows
  // only to whoever can open this brief (and so its sources). The description stays document-free.
  const excerpt = d.citations.find((c) => c.excerpt)?.excerpt ?? d.basis;
  const description =
    `Possível prazo da ${originLabel(b)}; fonte: ${citationLabel(d.citations)}. ` +
    "Data copiada do documento, não calculada: confirme o prazo antes de validar.";
  const input = {
    title,
    dueDate: d.date,
    kind: "procedural" as const,
    description: description.slice(0, 5000),
    sourceAnalysisId: b.id,
    sourceExcerpt: clip(excerpt, 2000),
    processId: b.processId,
  };
  // The work module accepts a visible case brief as source (pending human validation).
  const { createSuggestedDeadline } = await import("@/modules/work/service");
  const deadlineId = (await createSuggestedDeadline(ctx, input)).id;
  await recordAudit(ctx, {
    action: "case_brief.apply",
    entityType: "case_brief",
    entityId: b.id,
    summary: "Possível prazo da análise preliminar registrado para validação humana.",
    metadata: { deadlineId, index: v.index, kind: "deadline" },
  });
  return { deadlineId };
}

/** Turns a next step into a task (origin ai_suggested) linked to the process (`task:write`). */
export async function applyBriefNextStep(ctx: AuthContext, briefId: string, index: number): Promise<{ taskId: string }> {
  assertCan(ctx, "task:write");
  const v = parseOrThrow(itemIndexSchema, { briefId, index });
  const b = await loadApplicableBrief(ctx, v.briefId);
  const step = b.content.nextSteps[v.index];
  if (!step) throw new NotFoundError("Próximo passo não encontrado.");
  const title = clip(step.description, 300);
  const [dup] = await getDb()
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.organizationId, ctx.organizationId),
        eq(tasks.sourceAnalysisId, b.id),
        eq(tasks.title, title),
        isNull(tasks.deletedAt),
      ),
    )
    .limit(1);
  if (dup) throw new ConflictError("Esta tarefa já foi criada a partir da análise.");

  // Neither the note nor citation excerpts are copied (they may quote the documents, and the task
  // follows only the process visibility); the step itself is the title. Details stay in the brief.
  const description =
    `Sugestão da ${originLabel(b)}; fonte: ${citationLabel(step.citations)}.` +
    `${title !== step.description.replace(/\s+/g, " ").trim() ? " O texto completo do passo está na análise preliminar." : ""}`;
  const priority: Priority = step.priority;
  const input = {
    title,
    description: description.slice(0, 5000),
    priority,
    kind: "follow_up" as const,
    processId: b.processId,
    origin: "ai_suggested" as const,
    sourceAnalysisId: b.id,
  };
  const { createTask } = await import("@/modules/work/service");
  const taskId = (await createTask(ctx, input)).id;
  await recordAudit(ctx, {
    action: "case_brief.apply",
    entityType: "case_brief",
    entityId: b.id,
    summary: "Próximo passo da análise preliminar transformado em tarefa.",
    metadata: { taskId, index: v.index, kind: "task" },
  });
  return { taskId };
}

/** Valuation kind and confidence used when an amount of the brief is sent for review. */
export function amountProposalProfile(label: string, provenance: Provenance): { kind: ValuationKind; confidence: number; isEstimate: boolean } {
  const l = label
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
  if (/valor da causa/.test(l)) return { kind: "claim", confidence: provenance === "extracted" ? 90 : 70, isEstimate: false };
  if (/soma/.test(l)) return { kind: "claim", confidence: provenance === "extracted" ? 75 : 70, isEstimate: false };
  if (/liquidad|apurad|homologad/.test(l)) return { kind: "liquidated", confidence: provenance === "extracted" ? 85 : 70, isEstimate: false };
  if (/total devido|calculo/.test(l)) return { kind: "estimate", confidence: provenance === "extracted" ? 85 : 70, isEstimate: true };
  return { kind: "estimate", confidence: 70, isEstimate: true };
}

function baseDateFrom(note: string | null, fallback: string): string {
  const m = /data-base:?\s*(\d{2})\/(\d{2})\/(\d{4})/i.exec(note ?? "");
  if (m) {
    const iso = `${m[3]}-${m[2]}-${m[1]}`;
    if (isValidIsoDate(iso)) return iso;
  }
  return fallback;
}

/**
 * Sends an amount read from a document page to the contingency review queue
 * as a PROPOSED valuation (source "simulation" for simulated briefs).
 * Requires `contingency:write`. Only amounts with a document citation (page +
 * excerpt) can be sent.
 */
export async function proposeBriefAmount(ctx: AuthContext, briefId: string, index: number): Promise<{ valuationId: string }> {
  assertCan(ctx, "contingency:write");
  const v = parseOrThrow(itemIndexSchema, { briefId, index });
  const b = await loadApplicableBrief(ctx, v.briefId);
  const amount = b.content.amounts[v.index];
  if (!amount) throw new NotFoundError("Valor não encontrado na análise.");
  if (amount.amountCents === null) throw new ValidationError("Este item não tem valor apurado para enviar.");
  const citation = amount.citations.find((c) => c.ref !== "REG" && c.page !== null);
  if (!citation) {
    throw new ValidationError("Somente valores lidos em uma página de documento podem ser enviados para conferência.");
  }
  const [source] = await getDb()
    .select({ entityId: caseBriefSources.entityId, versionId: caseBriefSources.versionId })
    .from(caseBriefSources)
    .where(
      and(
        eq(caseBriefSources.briefId, b.id),
        eq(caseBriefSources.organizationId, ctx.organizationId),
        eq(caseBriefSources.ref, citation.ref),
      ),
    )
    .limit(1);
  if (!source) throw new NotFoundError("Fonte do valor não encontrada.");

  const profile = amountProposalProfile(amount.label, amount.provenance);
  const [dup] = await getDb()
    .select({ id: processValuations.id })
    .from(processValuations)
    .where(
      and(
        eq(processValuations.organizationId, ctx.organizationId),
        eq(processValuations.briefId, b.id),
        eq(processValuations.kind, profile.kind),
        eq(processValuations.amountCents, amount.amountCents),
        inArray(processValuations.status, ["proposed", "official"]),
      ),
    )
    .limit(1);
  if (dup) throw new ConflictError("Este valor já foi enviado para conferência.");

  const [process] = await getDb()
    .select({ filedAt: legalProcesses.filedAt })
    .from(legalProcesses)
    .where(and(eq(legalProcesses.id, b.processId), processWhere(ctx)))
    .limit(1);
  if (!process) throw new NotFoundError();
  const today = todayISO();
  const baseDate = baseDateFrom(amount.note, profile.kind === "claim" ? (process.filedAt ?? today) : today);

  const { proposeValuation } = await import("@/modules/contingency/service");
  const { id: valuationId } = await proposeValuation(ctx, {
    processId: b.processId,
    kind: profile.kind,
    amountCents: amount.amountCents,
    baseDate,
    source: isDemoMode(b.mode) ? "simulation" : "document",
    documentId: source.entityId,
    documentVersionId: source.versionId,
    page: citation.page,
    excerpt: citation.excerpt ? clip(citation.excerpt, 500) : null,
    confidence: profile.confidence,
    reason: `${amount.label}: enviado da ${originLabel(b)}. Conferir no documento antes de oficializar.`.slice(0, 1000),
    briefId: b.id,
    isEstimate: profile.isEstimate,
  });
  await recordAudit(ctx, {
    action: "case_brief.propose",
    entityType: "case_brief",
    entityId: b.id,
    summary: "Valor da análise preliminar enviado para conferência (proposto).",
    metadata: { valuationId, index: v.index, kind: profile.kind },
  });
  return { valuationId };
}

// ---------------------------------------------------------------------------
// Staleness (system)
// ---------------------------------------------------------------------------

/**
 * Marks generated briefs of a process (or briefs that used a document) as
 * stale. `exceptVersionId`: briefs that already used that version are left
 * untouched. Runs inside the caller's transaction when `db` is given.
 */
export async function markCaseBriefsStale(
  input: { organizationId: string; processId?: string | null; documentId?: string | null; reason: string; exceptVersionId?: string | null },
  db: DbOrTx = getDb(),
): Promise<number> {
  const conds: (SQL | undefined)[] = [
    eq(caseBriefs.organizationId, input.organizationId),
    eq(caseBriefs.isStale, false),
    notInArray(caseBriefs.status, ["generating", "failed"]),
  ];
  const scope: SQL[] = [];
  if (input.processId) scope.push(eq(caseBriefs.processId, input.processId));
  if (input.documentId) {
    scope.push(
      inArray(
        caseBriefs.id,
        db
          .select({ id: caseBriefSources.briefId })
          .from(caseBriefSources)
          .where(and(eq(caseBriefSources.organizationId, input.organizationId), eq(caseBriefSources.entityId, input.documentId))),
      ),
    );
  }
  if (!scope.length) return 0;
  conds.push(or(...scope));
  if (input.exceptVersionId) {
    conds.push(
      notInArray(
        caseBriefs.id,
        db
          .select({ id: caseBriefSources.briefId })
          .from(caseBriefSources)
          .where(and(eq(caseBriefSources.organizationId, input.organizationId), eq(caseBriefSources.versionId, input.exceptVersionId))),
      ),
    );
  }
  const updated = await db
    .update(caseBriefs)
    .set({ isStale: true, staleReason: input.reason.slice(0, 500), updatedAt: new Date() })
    .where(and(...conds))
    .returning({ id: caseBriefs.id });
  return updated.length;
}

/** Called by the extraction job when a document version's text is ready: marks briefs of its process stale. */
export async function onDocumentTextReadyForBriefs(input: {
  organizationId: string;
  documentId: string;
  versionId: string;
}): Promise<void> {
  const v = z.object({ organizationId: z.guid(), documentId: z.guid(), versionId: z.guid() }).safeParse(input);
  if (!v.success) return;
  const [doc] = await getDb()
    .select({
      title: documents.title,
      processId: documents.processId,
      versionNumber: documentVersions.versionNumber,
      status: documentVersions.extractionStatus,
    })
    .from(documents)
    .innerJoin(documentVersions, and(eq(documentVersions.documentId, documents.id), eq(documentVersions.id, v.data.versionId)))
    .where(
      and(
        eq(documents.id, v.data.documentId),
        eq(documents.organizationId, v.data.organizationId),
        isNull(documents.deletedAt),
      ),
    )
    .limit(1);
  if (!doc?.processId || doc.status !== "succeeded") return;
  const title = doc.title.length > 120 ? `${doc.title.slice(0, 119)}…` : doc.title;
  const marked = await markCaseBriefsStale({
    organizationId: v.data.organizationId,
    processId: doc.processId,
    reason:
      doc.versionNumber > 1
        ? `Nova versão do documento "${title}" (v${doc.versionNumber}) com texto disponível.`
        : `Novo documento com texto disponível: "${title}".`,
    exceptVersionId: v.data.versionId,
  });
  if (marked) logger.info("case_briefs_marked_stale", { documentId: v.data.documentId, briefs: marked });
}
