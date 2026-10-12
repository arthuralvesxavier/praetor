/**
 * Entrada de processos (pipeline central): chegada do processo → distribuição
 * → leitura dos documentos e análise preliminar (SIMULADA) → e-mail ao
 * advogado (SIMULADO) → revisão → aprovação (as duas últimas acontecem no
 * módulo de análises preliminares e são lidas aqui, nunca gravadas).
 *
 * - `registerIncomingProcess` creates the process (processes module), its
 *   parties and documents (documents module), the `case_intakes` row, the
 *   `new_process_received` alert and the `intake.process` job.
 * - `processIntakeJob` runs the steps; each step is idempotent (it is skipped
 *   when its result is already stored: assignedToId, briefId, lastEmailId; the
 *   e-mail step also reuses a message already stored for the same brief and
 *   recipient), so queue retries never duplicate work. Failures are recorded
 *   as a step with a sanitized message (never document text) and rethrown for
 *   the queue.
 * - The responsible of an OPEN intake is the responsible of its process (see
 *   ./assignment.ts): redistribution and process edits are followed at read
 *   time and the pipeline re-syncs the row before notifying.
 * - `simulateIncomingProcess` is the DEMO feed: a NEW fictitious labor case,
 *   consistent with the imported portfolio, labeled as fictitious everywhere.
 *
 * `intake:manage` is the permission to register an incoming case. Analysts
 * have it without `process:write`; the process of the incoming case is created
 * on their behalf (see `processContext`), keeping them as creator and actor.
 */
import { and, asc, count, desc, eq, gte, ilike, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { isValidCnj, parseCnj } from "@/domain/cnj";
import { normalizePage, type Page, type Paginated } from "@/domain/entities";
import {
  ASSIGNMENT_METHOD_LABELS,
  INTAKE_SOURCE_LABELS,
  INTAKE_SOURCES,
  type AssignmentMethod,
  type CaseBriefStatus,
  type DocumentCategory,
  type IntakeSource,
  type IntakeStatus,
  type LegalArea,
  type ProcessInstance,
  type ProcessPhase,
  type TextExtractionStatus,
} from "@/domain/enums";
import { formatMoneyCents, pluralize, todayISO } from "@/lib/format";
import { resolveAlertsByDedupeKeys, upsertAlert } from "@/modules/alerts/service";
import { loadOrganization } from "@/modules/analyses/org-settings";
import type { DemoCaseInfo } from "@/modules/briefs/demo-documents";
import { applyManualAssignment, assignResponsible, type AssignmentDecision } from "@/modules/distribution/service";
import { isAssignableRole, manualAssignmentSchema, type ManualAssignmentInput } from "@/modules/distribution/schemas";
import type { UploadFile } from "@/modules/documents/service";
import type { CaseBriefReadyData } from "@/modules/emails/templates";
import { addParty, createProcess, escapeLike, type ClaimValuationSource } from "@/modules/processes/service";
import { PROCESS_SECTION_IDS, processTabUrl } from "@/modules/processes/tabs";
import { caseBriefWhere, documentWhere, intakeWhere, processWhere } from "@/server/auth/access";
import { systemContext, type AuthContext } from "@/server/auth/context";
import { assertCan, can } from "@/server/auth/permissions";
import { getDb, type DbOrTx } from "@/server/db/client";
import {
  caseBriefs,
  caseIntakes,
  companies,
  distributionRules,
  documents,
  documentVersions,
  emailMessages,
  jobs,
  lawFirms,
  legalProcesses,
  processParties,
  units,
  users,
  type IntakeStep,
  type OrganizationSettings,
} from "@/server/db/schema";
import { safeErrorMessage } from "@/server/jobs/queue";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";
import { recordAudit } from "@/server/services/audit";
import {
  arrivalAlertKeys,
  enqueueIntakeJob,
  intakeAssigneeSql,
  intakeJobKey,
  sendAssignmentEmail,
  type AssignmentEmailOutcome,
} from "./assignment";
import { registerIntakeSchema, type RegisterIntakeInput } from "./schemas";
import {
  FALLBACK_COURT,
  FALLBACK_DEFENDANT,
  SIMULATION_DESCRIPTION,
  SIMULATION_LABEL,
  buildSimulatedCnj,
  shortPartyName,
  simulatedClaimCents,
  simulatedPlaintiff,
  tribunalCodeFromCourt,
} from "./simulation";
import {
  EFFECTIVE_INTAKE_STATUSES,
  buildPipelineStages,
  effectiveIntakeStatus,
  isOpenIntake,
  type EffectiveIntakeStatus,
  type PipelineStage,
} from "./status";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type IntakeRow = typeof caseIntakes.$inferSelect;
type IntakePatch = Partial<Omit<typeof caseIntakes.$inferInsert, "id" | "organizationId" | "processId" | "steps">>;

const INTAKE_NOT_FOUND = "Entrada não encontrada ou sem permissão de acesso.";
const PROCESS_RESPONSIBLE_CHANGED =
  "Responsável alterado no cadastro do processo, fora da entrada. A entrada segue o responsável do processo.";
const PROCESS_RESPONSIBLE_PENDING = "Responsável indicado no cadastro do processo; a entrada registra a atribuição no processamento.";
const SYSTEM_ACTOR = "Sistema (processamento automático)";
const SIMULATION_ACTOR = "Sistema (simulação)";
const MAX_DOCUMENTS = 20;

const STAGE_NAMES = {
  assign: "Definição do responsável",
  brief: "Leitura dos documentos e análise preliminar (simulação)",
  notify: "E-mail ao advogado (simulado)",
} as const;
type StageName = keyof typeof STAGE_NAMES;

const isGuid = (v: unknown): v is string => typeof v === "string" && z.guid().safeParse(v).success;

function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(undefined, z.flattenError(result.error).fieldErrors as Record<string, string[]>);
  }
  return result.data;
}

function fieldError(field: string, message: string): ValidationError {
  return new ValidationError(undefined, { [field]: [message] });
}

function assertCanManageIntake(ctx: AuthContext): void {
  if (!can(ctx, "intake:manage") && !can(ctx, "distribution:manage")) throw new ForbiddenError();
}

/**
 * Context used to create the process of an incoming case. `intake:manage`
 * grants registering an incoming case; roles without `process:write`
 * (analysts) create it on their behalf: same organization, same user id
 * (creator + audit actor), no other privilege is used (confidentiality is
 * never set by this flow).
 */
function processContext(ctx: AuthContext): AuthContext {
  if (can(ctx, "process:write")) return ctx;
  return { ...ctx, kind: "system" };
}

function newStep(status: IntakeStatus, detail: string, actorName: string | null): IntakeStep {
  return { status, at: new Date().toISOString(), detail, actorName };
}

async function updateIntake(current: IntakeRow, patch: IntakePatch, step: IntakeStep | null, db: DbOrTx = getDb()): Promise<IntakeRow> {
  const set: Record<string, unknown> = { ...patch };
  if (step) set.steps = sql`${caseIntakes.steps} || ${JSON.stringify([step])}::jsonb`;
  const [row] = await db
    .update(caseIntakes)
    .set(set)
    .where(and(eq(caseIntakes.id, current.id), eq(caseIntakes.organizationId, current.organizationId)))
    .returning();
  if (!row) throw new NotFoundError(INTAKE_NOT_FOUND);
  return row;
}

/** Appends a note unless the last step already says the same (keeps retries quiet). */
async function noteOnce(current: IntakeRow, status: IntakeStatus, detail: string, actorName: string, patch: IntakePatch = {}): Promise<IntakeRow> {
  const steps = current.steps ?? [];
  const last = steps[steps.length - 1];
  if (last && last.detail === detail) {
    return Object.keys(patch).length > 0 ? updateIntake(current, patch, null) : current;
  }
  return updateIntake(current, patch, newStep(status, detail, actorName));
}

/** Last completed stage of the pipeline (labels notes added while the intake is failed). */
function progressStatus(intake: IntakeRow): IntakeStatus {
  if (intake.status !== "failed") return intake.status;
  if (intake.lastEmailId) return "notified";
  if (intake.briefId) return "brief_ready";
  if (intake.assignedToId) return "assigned";
  return "received";
}

async function loadIntakeRow(intakeId: string): Promise<IntakeRow | null> {
  const [row] = await getDb().select().from(caseIntakes).where(eq(caseIntakes.id, intakeId)).limit(1);
  return row ?? null;
}

async function loadVisibleIntake(ctx: AuthContext, intakeId: string): Promise<IntakeRow> {
  if (!isGuid(intakeId)) throw new NotFoundError(INTAKE_NOT_FOUND);
  const [row] = await getDb()
    .select()
    .from(caseIntakes)
    .where(and(eq(caseIntakes.id, intakeId), intakeWhere(ctx)))
    .limit(1);
  if (!row) throw new NotFoundError(INTAKE_NOT_FOUND);
  return row;
}

async function userName(organizationId: string, userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const [row] = await getDb()
    .select({ name: users.name })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.organizationId, organizationId)))
    .limit(1);
  return row?.name ?? null;
}

type ProcessAssignment = { responsibleId: string | null; lawFirmId: string | null; unitId: string | null };

/** Responsible / firm / unit of the intake's process (internal read: callers already checked the intake). */
async function processAssignment(organizationId: string, processId: string): Promise<ProcessAssignment> {
  const [row] = await getDb()
    .select({ responsibleId: legalProcesses.responsibleId, lawFirmId: legalProcesses.lawFirmId, unitId: legalProcesses.unitId })
    .from(legalProcesses)
    .where(and(eq(legalProcesses.id, processId), eq(legalProcesses.organizationId, organizationId)))
    .limit(1);
  return row ?? { responsibleId: null, lawFirmId: null, unitId: null };
}

type BriefState = { id: string; status: CaseBriefStatus; version: number; mode: string; createdAt: Date };

async function loadBriefState(organizationId: string, briefId: string | null): Promise<BriefState | null> {
  if (!briefId) return null;
  const [row] = await getDb()
    .select({ id: caseBriefs.id, status: caseBriefs.status, version: caseBriefs.version, mode: caseBriefs.mode, createdAt: caseBriefs.createdAt })
    .from(caseBriefs)
    .where(and(eq(caseBriefs.id, briefId), eq(caseBriefs.organizationId, organizationId)))
    .limit(1);
  return row ?? null;
}

/** A version still "generating" past the briefs module's limit (its job died); `requestCaseBrief` replaces it. */
async function isLostGeneration(brief: BriefState): Promise<boolean> {
  if (brief.status !== "generating") return false;
  const { STUCK_GENERATION_MS } = await import("@/modules/briefs/service");
  return Date.now() - brief.createdAt.getTime() > STUCK_GENERATION_MS;
}

/**
 * Responsible of the intake now: while it is open, the process responsible
 * (a redistribution or a process edit changes it); otherwise what the intake
 * recorded. Same rule as `intakeAssigneeSql`.
 */
function currentAssigneeId(
  intake: Pick<IntakeRow, "status" | "assignedToId">,
  processResponsibleId: string | null,
  briefStatus: CaseBriefStatus | null | undefined,
): string | null {
  if (!isOpenIntake(intake.status, briefStatus)) return intake.assignedToId;
  return processResponsibleId ?? intake.assignedToId;
}

type ProcessBrief = { number: string; title: string; court: string; parties: string };

async function processBrief(organizationId: string, processId: string): Promise<ProcessBrief> {
  const db = getDb();
  const [proc] = await db
    .select({ number: legalProcesses.number, title: legalProcesses.title, court: legalProcesses.court })
    .from(legalProcesses)
    .where(and(eq(legalProcesses.id, processId), eq(legalProcesses.organizationId, organizationId)))
    .limit(1);
  if (!proc) throw new NotFoundError("Processo da entrada não encontrado.");
  const parties = await db
    .select({ name: processParties.name, role: processParties.role })
    .from(processParties)
    .where(and(eq(processParties.processId, processId), eq(processParties.organizationId, organizationId)))
    .orderBy(asc(processParties.createdAt));
  const plaintiffs = parties.filter((p) => p.role === "plaintiff").map((p) => p.name);
  const defendants = parties.filter((p) => p.role === "defendant").map((p) => shortPartyName(p.name));
  return {
    ...proc,
    parties: `${plaintiffs.join(", ") || "Autor não informado"} x ${defendants.join(", ") || "Réu não informado"}`,
  };
}

// ---------------------------------------------------------------------------
// Pipeline steps
// ---------------------------------------------------------------------------

async function raiseUnassignedAlert(current: IntakeRow, reason: string): Promise<void> {
  const proc = await processBrief(current.organizationId, current.processId);
  await upsertAlert({
    organizationId: current.organizationId,
    type: "intake_unassigned",
    severity: "warning",
    title: `Entrada sem responsável: ${proc.number}`,
    message: `${reason} Abra a entrada para atribuir o responsável.`.slice(0, 2000),
    entityType: "intake",
    entityId: current.id,
    dedupeKey: `intake_unassigned:${current.id}`,
  });
}

/**
 * Records the responsible on the intake. A change of responsible resets the
 * "análise disponível" e-mail (the new responsible gets it from the pipeline);
 * the stored status follows what is left to do. The arrival alerts are
 * resolved (the intake left "received"). After the update, the simulated
 * "Novo processo atribuído" e-mail goes to a NEW responsible when enabled
 * (`email.notifyOnAssignment`) — never to the person who made the assignment.
 */
async function recordAssignment(
  current: IntakeRow,
  decision: AssignmentDecision,
  actorName: string,
  opts: { detail?: string; actorUserId?: string | null } = {},
): Promise<{ row: IntakeRow; email: AssignmentEmailOutcome }> {
  const text =
    opts.detail ??
    (decision.method === "kept"
      ? `Responsável mantido: ${decision.userName}. ${decision.reason}`
      : `Responsável definido: ${decision.userName} (${ASSIGNMENT_METHOD_LABELS[decision.method]}). ${decision.reason}`);
  const changed = current.assignedToId !== decision.userId;
  const lastEmailId = current.assignedToId && changed ? null : current.lastEmailId;
  const status: IntakeStatus = !current.briefId
    ? "assigned"
    : lastEmailId
      ? "notified"
      : current.status === "analyzing"
        ? "analyzing"
        : "brief_ready";
  const row = await updateIntake(
    current,
    {
      assignedToId: decision.userId,
      assignmentMethod: decision.method,
      distributionRuleId: decision.ruleId,
      assignedLawFirmId: decision.lawFirmId,
      assignedUnitId: decision.unitId,
      assignmentReason: decision.reason,
      assignedAt: new Date(),
      lastEmailId,
      status,
      errorMessage: null,
    },
    newStep("assigned", text, actorName),
  );
  await resolveAlertsByDedupeKeys(current.organizationId, arrivalAlertKeys(current.id));
  let email: AssignmentEmailOutcome = "skipped";
  if (changed && decision.userId) {
    // A responsible kept from the registration form was chosen by whoever registered the intake.
    const actorUserId = opts.actorUserId ?? (decision.method === "kept" ? current.createdById : null);
    email = await sendAssignmentEmail({
      organizationId: current.organizationId,
      processId: current.processId,
      intakeId: current.id,
      toUserId: decision.userId,
      reason: decision.reason,
      actorUserId,
    });
  }
  return { row, email };
}

/** Runs text extraction inline for document versions of the process still pending. Returns the number of documents. */
async function ensureTextsExtracted(organizationId: string, processId: string): Promise<number> {
  const rows = await getDb()
    .select({ versionId: documentVersions.id, status: documentVersions.extractionStatus })
    .from(documents)
    .innerJoin(documentVersions, eq(documentVersions.id, documents.currentVersionId))
    .where(
      and(eq(documents.organizationId, organizationId), eq(documents.processId, processId), isNull(documents.deletedAt)),
    );
  const pending = rows.filter((r) => r.status === "pending");
  if (pending.length > 0) {
    const { extractDocumentVersionText } = await import("@/modules/documents/service");
    for (const r of pending) await extractDocumentVersionText(r.versionId);
  }
  return rows.length;
}

async function briefVersion(organizationId: string, briefId: string): Promise<number | null> {
  const [row] = await getDb()
    .select({ version: caseBriefs.version })
    .from(caseBriefs)
    .where(and(eq(caseBriefs.id, briefId), eq(caseBriefs.organizationId, organizationId)))
    .limit(1);
  return row?.version ?? null;
}

async function generateBrief(ctx: AuthContext, current: IntakeRow, actorName: string, opts: { resetEmail?: boolean } = {}): Promise<IntakeRow> {
  const docCount = await ensureTextsExtracted(current.organizationId, current.processId);
  let row = await updateIntake(
    current,
    { status: "analyzing", errorMessage: null },
    newStep(
      "analyzing",
      `Leitura de ${pluralize(docCount, "documento", "documentos")} e geração da análise preliminar iniciadas (simulação, sem inteligência artificial real).`,
      actorName,
    ),
  );
  const { requestCaseBrief } = await import("@/modules/briefs/service");
  const result = await requestCaseBrief(ctx, current.processId, { intakeId: current.id, inline: true });
  if (result.status === "failed") {
    throw new ConflictError("A geração da análise preliminar (simulação) falhou. Confira os documentos e gere novamente.");
  }
  const reset = opts.resetEmail ? { lastEmailId: null } : {};
  if (result.status === "generating") {
    return updateIntake(row, { briefId: result.briefId, ...reset }, newStep("analyzing", "Análise preliminar em processamento (simulação).", SIMULATION_ACTOR));
  }
  const version = await briefVersion(current.organizationId, result.briefId);
  row = await updateIntake(
    row,
    { briefId: result.briefId, status: "brief_ready", errorMessage: null, ...reset },
    newStep(
      "brief_ready",
      `Análise preliminar${version ? ` versão ${version}` : ""} gerada pela simulação e pronta para revisão do advogado.`,
      SIMULATION_ACTOR,
    ),
  );
  return row;
}

/**
 * An open intake whose process responsible was changed outside the intake and
 * distribution flows (e.g. editing the process) follows the process: the new
 * responsible is recorded (and will receive the "análise disponível" e-mail).
 */
async function followProcessResponsible(current: IntakeRow, actorName: string): Promise<IntakeRow> {
  if (!current.assignedToId) return current;
  const [proc, brief] = await Promise.all([
    processAssignment(current.organizationId, current.processId),
    loadBriefState(current.organizationId, current.briefId),
  ]);
  if (!isOpenIntake(current.status, brief?.status) || !proc.responsibleId || proc.responsibleId === current.assignedToId) {
    return current;
  }
  const name = (await userName(current.organizationId, proc.responsibleId)) ?? "usuário cadastrado";
  const decision: AssignmentDecision = {
    userId: proc.responsibleId,
    userName: name,
    method: "manual",
    ruleId: null,
    ruleName: null,
    lawFirmId: proc.lawFirmId,
    unitId: proc.unitId,
    reason: "Responsável alterado no cadastro do processo, fora da entrada.",
  };
  const { row } = await recordAssignment(current, decision, actorName, {
    detail: `Responsável atualizado conforme o cadastro do processo: ${name}. A entrada segue o responsável do processo.`,
  });
  return row;
}

/** Message already stored for this brief and recipient since the current assignment (retry after a failure). */
async function storedBriefEmail(current: IntakeRow, recipientId: string): Promise<string | null> {
  if (!current.briefId) return null;
  const [row] = await getDb()
    .select({ id: emailMessages.id })
    .from(emailMessages)
    .where(
      and(
        eq(emailMessages.organizationId, current.organizationId),
        eq(emailMessages.template, "case_brief_ready"),
        eq(emailMessages.intakeId, current.id),
        eq(emailMessages.briefId, current.briefId),
        eq(emailMessages.toUserId, recipientId),
        eq(emailMessages.status, "simulated"),
        current.assignedAt ? gte(emailMessages.createdAt, current.assignedAt) : undefined,
      ),
    )
    .orderBy(desc(emailMessages.createdAt))
    .limit(1);
  return row?.id ?? null;
}

/** Whether the recipient may open the brief (role + `caseBriefWhere` of their own context). */
async function recipientSeesBrief(organizationId: string, recipientId: string, briefId: string): Promise<boolean> {
  const [u] = await getDb()
    .select({ id: users.id, role: users.role, unitId: users.unitId, lawFirmId: users.lawFirmId, name: users.name, email: users.email })
    .from(users)
    .where(and(eq(users.id, recipientId), eq(users.organizationId, organizationId)))
    .limit(1);
  if (!u) return false;
  const recipient: AuthContext = {
    kind: "user",
    userId: u.id,
    organizationId,
    role: u.role,
    unitId: u.unitId,
    lawFirmId: u.lawFirmId,
    name: u.name,
    email: u.email,
    isDemoOrganization: false,
  };
  if (!can(recipient, "brief:read")) return false;
  const [visible] = await getDb()
    .select({ id: caseBriefs.id })
    .from(caseBriefs)
    .where(and(eq(caseBriefs.id, briefId), caseBriefWhere(recipient)))
    .limit(1);
  return Boolean(visible);
}

async function notifyResponsible(ctx: AuthContext, intake: IntakeRow, actorName: string, mode: "auto" | "manual"): Promise<IntakeRow> {
  const current = await followProcessResponsible(intake, actorName);
  const recipientId = current.assignedToId;
  if (!recipientId) throw new ConflictError("Defina o responsável antes de enviar o e-mail.");
  if (!current.briefId) throw new ConflictError("Gere a análise preliminar antes de enviar o e-mail.");
  const brief = await loadBriefState(current.organizationId, current.briefId);
  if (!brief) throw new ConflictError("A análise preliminar vinculada à entrada não foi encontrada. Gere uma nova versão.");
  const toName = (await userName(current.organizationId, recipientId)) ?? "o advogado responsável";

  // Idempotent: a retry after a failure that happened once the message was stored reuses it.
  let emailId = mode === "auto" ? await storedBriefEmail(current, recipientId) : null;
  let digestOmitted = false;
  if (!emailId) {
    const proc = await processBrief(current.organizationId, current.processId);
    const base = { processNumber: proc.number, processTitle: proc.title, court: proc.court, parties: proc.parties };
    // The digest is built from the brief: only for a recipient who can open it (a source document
    // may be hidden from them, e.g. also linked to a restricted record).
    digestOmitted = !(await recipientSeesBrief(current.organizationId, recipientId, brief.id));
    let data: CaseBriefReadyData;
    if (digestOmitted) {
      data = {
        ...base,
        headline: "",
        urgencies: [],
        possibleDeadlines: [],
        gapsCount: 0,
        missingDocumentsCount: 0,
        isDemo: brief.mode === "demo",
        briefVersion: brief.version,
        digestOmitted: true,
      };
    } else {
      const { getCaseBriefEmailDigest } = await import("@/modules/briefs/service");
      const digest = await getCaseBriefEmailDigest(ctx, brief.id);
      data = {
        ...base,
        headline: digest.headline,
        urgencies: digest.urgencies,
        possibleDeadlines: digest.possibleDeadlines,
        gapsCount: digest.gapsCount,
        missingDocumentsCount: digest.missingDocumentsCount,
        isDemo: digest.isDemo,
        briefVersion: digest.version,
      };
    }
    const { sendTemplatedEmail } = await import("@/modules/emails/service");
    ({ emailId } = await sendTemplatedEmail(ctx, {
      template: "case_brief_ready",
      toUserId: recipientId,
      data,
      linkPath: processTabUrl(current.processId, "documentos-e-analises", PROCESS_SECTION_IDS.brief),
      processId: current.processId,
      briefId: brief.id,
      intakeId: current.id,
      entity: { type: "intake", id: current.id },
    }));
  }
  const omittedNote = digestOmitted
    ? ` O resumo da análise não foi incluído: ela usa documentos que ${toName} não pode abrir (revise o acesso aos documentos do processo).`
    : "";
  const detail =
    mode === "auto"
      ? `E-mail simulado enviado a ${toName} com ${digestOmitted ? "o link" : "o resumo da análise e o link"} para a revisão. Nenhuma mensagem real foi enviada.${omittedNote}`
      : `E-mail simulado reenviado a ${toName} por ${actorName}. Nenhuma mensagem real foi enviada.${omittedNote}`;
  const updated = await updateIntake(current, { lastEmailId: emailId, status: "notified", errorMessage: null }, newStep("notified", detail, actorName));
  await resolveAlertsByDedupeKeys(current.organizationId, arrivalAlertKeys(current.id));
  return updated;
}

type PipelineMeta = { actorName: string; attempt?: number; maxAttempts?: number };

/** Runs the remaining steps. Each step is skipped when its result is already stored. */
async function runPipeline(ctx: AuthContext, intake: IntakeRow, settings: OrganizationSettings, meta: PipelineMeta): Promise<IntakeRow> {
  let current = intake;
  let stage: StageName = "assign";
  try {
    // 1. Responsável
    if (!current.assignedToId) {
      // A responsible chosen at registration is kept even when automatic distribution is off.
      const { responsibleId } = await processAssignment(current.organizationId, current.processId);
      if (!responsibleId && !settings.intake.autoAssign) {
        current = await noteOnce(
          current,
          "received",
          "Distribuição automática desativada nas configurações: atribua o responsável manualmente.",
          meta.actorName,
          current.status === "failed" ? { status: "received", errorMessage: null } : {},
        );
        await raiseUnassignedAlert(current, "Distribuição automática desativada.");
        return current;
      }
      const decision = await assignResponsible(ctx, current.processId, { handledIntakeId: current.id });
      if (!decision.userId) {
        current = await noteOnce(
          current,
          "received",
          `Nenhum responsável definido: ${decision.reason}`,
          meta.actorName,
          current.status === "failed" ? { status: "received", errorMessage: null } : {},
        );
        await raiseUnassignedAlert(current, decision.reason);
        return current;
      }
      current = (await recordAssignment(current, decision, meta.actorName)).row;
    } else {
      current = await followProcessResponsible(current, meta.actorName);
    }

    // 2. Leitura dos documentos e análise preliminar (simulação)
    stage = "brief";
    let brief = await loadBriefState(current.organizationId, current.briefId);
    // A linked version that failed (or whose generation died) counts as missing: generate again.
    const replaceBrief = Boolean(current.briefId) && (!brief || brief.status === "failed" || (await isLostGeneration(brief)));
    if (!current.briefId || replaceBrief) {
      if (!settings.intake.autoGenerateBrief) {
        current = await noteOnce(
          current,
          "assigned",
          replaceBrief
            ? "A geração da análise preliminar vinculada não foi concluída e a geração automática está desativada nas configurações. Use “Gerar nova versão da análise”."
            : "Geração automática da análise preliminar desativada nas configurações. Use “Gerar análise preliminar”.",
          meta.actorName,
          current.status === "failed" ? { status: "assigned", errorMessage: null } : {},
        );
        return current;
      }
      current = await generateBrief(ctx, current, meta.actorName, { resetEmail: replaceBrief });
      if (current.status !== "brief_ready") return current;
      brief = await loadBriefState(current.organizationId, current.briefId);
    } else if (brief?.status === "generating") {
      // Version still being generated (reused): the briefs module resumes this intake when it is ready.
      return current;
    }

    // 3. E-mail ao advogado (simulado)
    stage = "notify";
    if (!current.lastEmailId) {
      if (brief?.status === "approved") return current;
      if (brief?.status === "rejected") {
        current = await noteOnce(
          current,
          "brief_ready",
          "Análise preliminar rejeitada pelo advogado. Gere uma nova versão para continuar.",
          meta.actorName,
          current.status === "failed" ? { status: "brief_ready", errorMessage: null } : {},
        );
        return current;
      }
      if (!settings.intake.autoNotify || !settings.email.notifyOnBriefReady) {
        current = await noteOnce(
          current,
          "brief_ready",
          "Envio automático do e-mail desativado nas configurações. Use “Enviar e-mail (simulado)”.",
          meta.actorName,
          current.status === "failed" ? { status: "brief_ready", errorMessage: null } : {},
        );
        // Nothing else will happen automatically: the arrival notice is done.
        await resolveAlertsByDedupeKeys(current.organizationId, arrivalAlertKeys(current.id));
        return current;
      }
      current = await notifyResponsible(ctx, current, meta.actorName, "auto");
    }
    return current;
  } catch (err) {
    const message = safeErrorMessage(err);
    const attemptText = meta.attempt && meta.maxAttempts ? ` (tentativa ${meta.attempt} de ${meta.maxAttempts})` : "";
    try {
      await updateIntake(
        current,
        { status: "failed", errorMessage: `${STAGE_NAMES[stage]}: ${message}`.slice(0, 1000) },
        newStep("failed", `Falha na etapa “${STAGE_NAMES[stage]}”${attemptText}: ${message}`.slice(0, 1000), meta.actorName),
      );
    } catch (recordErr) {
      logger.error("intake_failure_not_recorded", { intakeId: current.id, error: safeErrorMessage(recordErr) });
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export type IncomingDocument = {
  title: string;
  category: DocumentCategory;
  description?: string | null;
  file: UploadFile;
};

export type RegisterIncomingOptions = {
  source?: IntakeSource;
  /** Files uploaded with the case (server-side callers; the UI posts files to /api/documents/upload). */
  documents?: IncomingDocument[];
  /**
   * Create the intake without enqueueing the pipeline yet. The registration
   * form uses it: it uploads the files first and then calls
   * `requestIntakeProcessing(ctx, id, { reason: "start" })`.
   */
  deferProcessing?: boolean;
  /** Extra pt-BR note for the "received" step. */
  receivedNote?: string | null;
};

export type RegisterIncomingResult = {
  intakeId: string;
  processId: string;
  documentIds: string[];
  jobQueued: boolean;
};

/**
 * Options set only by this module (never by a caller, never read from a form):
 * `claimSource` labels the valor da causa that the DEMO feed generated
 * (`createProcess` option, see MODULE_CONTRACTS "Denormalized mirrors").
 */
type RegisterIncomingInternal = { claimSource: ClaimValuationSource };

/** Reason of the simulated valor da causa proposed when no person registered the arrival. */
const UNATTENDED_SIMULATED_CLAIM_REASON =
  "Valor da causa simulado (demonstração) na chegada automática do processo. Não é um valor real.";

/** Note of the "received" step when the informed valor da causa went to the review queue. */
function pendingClaimNote(source: ClaimValuationSource, amountCents: number): string {
  const label = source === "simulation" ? "Valor da causa simulado (demonstração)" : "Valor da causa";
  return `${label} de ${formatMoneyCents(amountCents)} enviado para a conferência de valores; até a aprovação, o processo fica sem valor da causa.`;
}

/**
 * Registers an incoming process: process + parties + documents + intake row +
 * `new_process_received` alert + `intake.process` job. Requires `intake:manage`.
 *
 * The `simulated_feed` source is reserved to `simulateIncomingProcess` (demo
 * organizations only, valor da causa labeled as simulated): passing it here is refused.
 */
export async function registerIncomingProcess(
  ctx: AuthContext,
  input: RegisterIntakeInput & RegisterIncomingOptions,
): Promise<RegisterIncomingResult> {
  if (input.source === "simulated_feed") {
    assertCan(ctx, "intake:manage");
    throw new ValidationError("A chegada simulada é registrada apenas pela demonstração (Simular chegada de processo).");
  }
  return registerIncoming(ctx, input, { claimSource: "manual" });
}

async function registerIncoming(
  ctx: AuthContext,
  input: RegisterIntakeInput & RegisterIncomingOptions,
  internal: RegisterIncomingInternal,
): Promise<RegisterIncomingResult> {
  assertCan(ctx, "intake:manage");
  const { source = "manual", documents: incoming = [], deferProcessing = false, receivedNote = null, ...fields } = input;
  if (!(INTAKE_SOURCES as readonly string[]).includes(source)) throw new ValidationError("Origem da entrada inválida.");
  if (incoming.length > MAX_DOCUMENTS) throw new ValidationError(`Envie no máximo ${MAX_DOCUMENTS} documentos por entrada.`);
  const v = parse(registerIntakeSchema, fields);
  const db = getDb();

  let companyName: string | null = null;
  if (v.companyId) {
    const [company] = await db
      .select({ name: companies.name })
      .from(companies)
      .where(and(eq(companies.id, v.companyId), eq(companies.organizationId, ctx.organizationId)))
      .limit(1);
    if (!company) throw fieldError("companyId", "Selecione uma empresa da organização.");
    companyName = company.name;
  }
  const defendant = v.defendantName ?? companyName;
  if (!defendant) throw fieldError("defendantName", "Informe a parte ré (ou selecione a empresa).");
  if (v.responsibleId) {
    const [person] = await db
      .select({ role: users.role, isActive: users.isActive })
      .from(users)
      .where(and(eq(users.id, v.responsibleId), eq(users.organizationId, ctx.organizationId)))
      .limit(1);
    if (!person || !person.isActive || !isAssignableRole(person.role)) {
      throw fieldError("responsibleId", "Selecione um advogado, gestor jurídico ou escritório externo ativo, ou deixe em branco para a distribuição automática.");
    }
    if (person.role === "external_counsel" && !can(ctx, "distribution:manage")) {
      throw fieldError(
        "responsibleId",
        "Atribuir a um escritório externo exige a permissão de redistribuir demandas (gestão jurídica). Deixe em branco para a distribuição automática.",
      );
    }
  }

  const checkDigitOk = isValidCnj(v.number);
  const title = (v.title ?? `${v.plaintiffName} x ${shortPartyName(defendant)}`).slice(0, 200);
  const delegated = processContext(ctx);
  const informedClaimCents = v.claimAmountCents ?? null;
  // With no identified person (the worker's automatic feed runs with `systemContext`),
  // `createProcess` would keep the value on the record as a plain value: no valuation, no
  // "simulated" label, no review. A simulated valor da causa is held back from the record
  // instead and proposed below, labeled as simulated, for the review queue.
  const unattendedSimulatedClaim = internal.claimSource === "simulation" && ctx.userId === null ? informedClaimCents : null;
  let processId: string;
  let claimStatus: Awaited<ReturnType<typeof createProcess>>["claimValuationStatus"];
  try {
    // A simulated valor da causa is labeled as such: official for an approver, a proposal
    // in the review queue for anyone else (an analyst's never reaches the record unreviewed).
    ({ id: processId, claimValuationStatus: claimStatus } = await createProcess(
      delegated,
      {
        number: v.number,
        title,
        court: v.court,
        courtDivision: v.courtDivision ?? null,
        city: v.city ?? null,
        state: v.state ?? null,
        processClass: v.processClass ?? null,
        area: v.area,
        phase: v.phase,
        instance: v.instance,
        companyId: v.companyId ?? null,
        unitId: v.unitId ?? null,
        responsibleId: v.responsibleId ?? null,
        claimAmountCents: unattendedSimulatedClaim !== null ? null : informedClaimCents,
        filedAt: v.filedAt ?? null,
        description: v.description ?? null,
        ...(checkDigitOk
          ? {}
          : {
              needsVerification: true,
              verificationNote: "Dígito verificador do número CNJ não confere: conferir o número informado na entrada.",
            }),
      },
      { claimSource: internal.claimSource },
    ));
  } catch (err) {
    if (err instanceof ConflictError) throw new ValidationError(err.message, { number: [err.message] });
    throw err;
  }

  // Parties, documents and the intake run in separate steps (the documents
  // module stores files): if any of them fails, the process just created is
  // soft-deleted so the same number can be registered again.
  const documentIds: string[] = [];
  try {
    if (unattendedSimulatedClaim !== null) {
      // Contract API of the review queue (system context allowed): PROPOSED, source
      // "simulation", no author; it reaches the record only when an approver confers it.
      const { proposeValuation } = await import("@/modules/contingency/service");
      await proposeValuation(delegated, {
        processId,
        kind: "claim",
        amountCents: unattendedSimulatedClaim,
        baseDate: todayISO(),
        source: "simulation",
        instance: v.instance ?? null,
        reason: UNATTENDED_SIMULATED_CLAIM_REASON,
      });
    }
    const claimPending = unattendedSimulatedClaim !== null || claimStatus === "proposed";
    return await completeRegistration(ctx, {
      processId,
      delegated,
      number: v.number,
      plaintiffName: v.plaintiffName,
      defendant,
      defendantIsClient: Boolean(v.companyId),
      incoming,
      documentIds,
      source,
      receivedNote,
      claimNote: claimPending && informedClaimCents !== null ? pendingClaimNote(internal.claimSource, informedClaimCents) : null,
      checkDigitOk,
      deferProcessing,
    });
  } catch (err) {
    await discardInterruptedRegistration(ctx, processId, v.number, documentIds);
    throw err;
  }
}

/**
 * Undo of an interrupted registration: soft-deletes the process (and the
 * documents already uploaded to it), audited, so a retry with the same CNJ
 * number is not rejected as a duplicate. Never throws (the original error is
 * what the caller must see); a cleanup failure is logged by name/code only.
 */
async function discardInterruptedRegistration(ctx: AuthContext, processId: string, number: string, documentIds: string[]): Promise<void> {
  try {
    await getDb().transaction(async (tx) => {
      const now = new Date();
      if (documentIds.length > 0) {
        await tx
          .update(documents)
          .set({ deletedAt: now })
          .where(and(eq(documents.organizationId, ctx.organizationId), inArray(documents.id, documentIds), isNull(documents.deletedAt)));
      }
      const removed = await tx
        .update(legalProcesses)
        .set({ deletedAt: now })
        .where(and(eq(legalProcesses.id, processId), eq(legalProcesses.organizationId, ctx.organizationId), isNull(legalProcesses.deletedAt)))
        .returning({ id: legalProcesses.id });
      if (removed.length === 0) return;
      await recordAudit(
        ctx,
        {
          action: "legal_process.delete",
          entityType: "legal_process",
          entityId: processId,
          summary: `Cadastro de entrada do processo ${number} interrompido: processo removido para permitir nova tentativa.`,
          metadata: { reason: "intake_registration_failed", documents: documentIds.length },
        },
        tx,
      );
    });
  } catch (cleanupErr) {
    logger.error("intake_registration_cleanup_failed", { processId, error: safeErrorMessage(cleanupErr) });
  }
}

async function completeRegistration(
  ctx: AuthContext,
  r: {
    processId: string;
    delegated: AuthContext;
    number: string;
    plaintiffName: string;
    defendant: string;
    defendantIsClient: boolean;
    incoming: IncomingDocument[];
    /** Filled as documents are uploaded (the caller removes them on failure). */
    documentIds: string[];
    source: IntakeSource;
    receivedNote: string | null;
    /** The informed valor da causa waits in the review queue (`pendingClaimNote`). */
    claimNote: string | null;
    checkDigitOk: boolean;
    deferProcessing: boolean;
  },
): Promise<RegisterIncomingResult> {
  const { processId, delegated, documentIds, source, receivedNote, claimNote, checkDigitOk, deferProcessing } = r;
  const db = getDb();
  await addParty(delegated, processId, { name: r.plaintiffName, role: "plaintiff" });
  await addParty(delegated, processId, { name: r.defendant, role: "defendant", isClient: r.defendantIsClient });

  if (r.incoming.length > 0) {
    const { uploadDocument } = await import("@/modules/documents/service");
    for (const doc of r.incoming) {
      const { documentId } = await uploadDocument(ctx, {
        title: doc.title,
        category: doc.category,
        description: doc.description ?? null,
        processId,
        file: doc.file,
      });
      documentIds.push(documentId);
    }
  }

  const receivedDetail = [
    source === "simulated_feed"
      ? `${SIMULATION_LABEL}: processo e ${pluralize(documentIds.length, "documento fictício", "documentos fictícios")} gerados pela demonstração.`
      : `Processo registrado (${INTAKE_SOURCE_LABELS[source].toLowerCase()})${documentIds.length ? ` com ${pluralize(documentIds.length, "documento", "documentos")}` : ""}.`,
    receivedNote,
    claimNote,
    checkDigitOk ? null : "Dígito verificador do CNJ não confere: processo pendente de conferência.",
  ]
    .filter(Boolean)
    .join(" ");

  const { intakeId, jobQueued } = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(caseIntakes)
      .values({
        organizationId: ctx.organizationId,
        processId,
        source,
        status: "received",
        receivedAt: new Date(),
        steps: [newStep("received", receivedDetail, ctx.name)],
        createdById: ctx.userId,
      })
      .returning({ id: caseIntakes.id });
    await upsertAlert(
      {
        organizationId: ctx.organizationId,
        type: "new_process_received",
        severity: "info",
        title: `Novo processo recebido: ${r.number}`,
        message:
          source === "simulated_feed"
            ? "Chegada simulada (dados fictícios). Distribuição, análise preliminar e e-mail são simulações."
            : `Registrado por ${ctx.name}. A distribuição e a análise preliminar (simulação) seguem automaticamente.`,
        entityType: "intake",
        entityId: row.id,
        dedupeKey: `new_process_received:${row.id}`,
      },
      tx,
    );
    await recordAudit(
      ctx,
      {
        action: "intake.create",
        entityType: "intake",
        entityId: row.id,
        summary: `Entrada do processo ${r.number} registrada (${INTAKE_SOURCE_LABELS[source]}).`,
        metadata: { processId, source, documents: documentIds.length, checkDigitOk },
      },
      tx,
    );
    if (deferProcessing) return { intakeId: row.id, jobQueued: false };
    await enqueueIntakeJob(ctx.organizationId, row.id, tx);
    return { intakeId: row.id, jobQueued: true };
  });

  logger.info("intake_registered", { intakeId, processId, source, documents: documentIds.length });
  return { intakeId, processId, documentIds, jobQueued };
}

// ---------------------------------------------------------------------------
// DEMO: simulated arrival
// ---------------------------------------------------------------------------

type CourtSample = {
  court: string;
  tribunal: string;
  origin: string;
  city: string | null;
  state: string | null;
  processClass: string | null;
  courtDivision: string | null;
  fromPortfolio: boolean;
};

const NON_CITY = /cejusc|secretaria|c[aá]lculo|central|n[uú]cleo/i;

function splitCityState(city: string | null, state: string | null): { city: string | null; state: string | null } {
  if (!city) return { city: null, state };
  const m = /^(.*?)\s*[-/–(]\s*([A-Za-z]{2})\)?\s*$/.exec(city.trim());
  if (m && m[1]) return { city: m[1].trim(), state: state ?? m[2].toUpperCase() };
  return { city: city.trim(), state };
}

/** Court / city / class sampled deterministically from the imported labor portfolio (first instance). */
async function sampleCourt(organizationId: string, seed: number): Promise<CourtSample> {
  const db = getDb();
  const p = legalProcesses;
  const n = sql<number>`count(*)::int`;
  const rows = await db
    .select({ court: p.court, city: p.city, state: p.state, processClass: p.processClass, courtDivision: p.courtDivision, n })
    .from(p)
    .where(
      and(
        eq(p.organizationId, organizationId),
        isNull(p.deletedAt),
        eq(p.area, "labor"),
        or(isNull(p.instance), eq(p.instance, "first")),
        ilike(p.court, "TRT%"),
      ),
    )
    .groupBy(p.court, p.city, p.state, p.processClass, p.courtDivision)
    .orderBy(desc(n), asc(p.court), asc(p.city), asc(p.processClass), asc(p.courtDivision))
    .limit(40);
  const candidates = rows.filter((r) => tribunalCodeFromCourt(r.court) && r.city && !NON_CITY.test(r.city));
  if (candidates.length === 0) {
    return { ...FALLBACK_COURT, tribunal: "10", courtDivision: null, fromPortfolio: false };
  }
  const pick = candidates[(Math.abs(Math.trunc(seed)) % candidates.length + candidates.length) % candidates.length];
  const tribunal = tribunalCodeFromCourt(pick.court)!;
  // Origin code (OOOO) most used by this court/city in the portfolio's own numbers.
  const numbers = await db
    .select({ number: p.number })
    .from(p)
    .where(and(eq(p.organizationId, organizationId), eq(p.court, pick.court), pick.city ? eq(p.city, pick.city) : undefined))
    .limit(200);
  const origins = new Map<string, number>();
  for (const r of numbers) {
    const parts = parseCnj(r.number);
    if (parts && parts.segment === "5" && parts.tribunal === tribunal) origins.set(parts.origin, (origins.get(parts.origin) ?? 0) + 1);
  }
  const origin = [...origins.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "0001";
  const place = splitCityState(pick.city, pick.state);
  return {
    court: pick.court,
    tribunal,
    origin,
    city: place.city,
    state: place.state,
    processClass: pick.processClass ?? "ATOrd",
    courtDivision: pick.courtDivision,
    fromPortfolio: true,
  };
}

/** Company with most processes in the portfolio (the defendant of the simulated case). */
async function portfolioCompany(organizationId: string): Promise<{ id: string; name: string } | null> {
  const n = sql<number>`count(${legalProcesses.id})::int`;
  const [row] = await getDb()
    .select({ id: companies.id, name: companies.name, n })
    .from(companies)
    .leftJoin(
      legalProcesses,
      and(eq(legalProcesses.companyId, companies.id), isNull(legalProcesses.deletedAt)),
    )
    .where(and(eq(companies.organizationId, organizationId), eq(companies.isActive, true)))
    .groupBy(companies.id, companies.name)
    .orderBy(desc(n), asc(companies.name))
    .limit(1);
  return row ? { id: row.id, name: row.name } : null;
}

async function numberExists(organizationId: string, number: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: legalProcesses.id })
    .from(legalProcesses)
    .where(and(eq(legalProcesses.organizationId, organizationId), eq(legalProcesses.number, number), isNull(legalProcesses.deletedAt)))
    .limit(1);
  return Boolean(row);
}

/**
 * DEMO "Simular chegada de processo": a NEW fictitious labor case consistent
 * with the portfolio, with fictitious documents, registered as
 * `simulated_feed`. Only in demo organizations. Requires `intake:manage`.
 * Its valor da causa is always a valuation with source `simulation` (labeled
 * "Extração simulada (demonstração)" in the queue, the band and BI):
 * - an approver (gestor, contabilidade, admin): OFFICIAL, reviewed by the person;
 * - any other person (analyst, lawyer): PROPOSED by the person;
 * - no identified person (the worker's automatic feed, `systemContext`): PROPOSED
 *   with no author (`proposeValuation`).
 * While it is a proposal the record stays without valor da causa (null, never 0)
 * and the "received" step says the value waits in the "Conferência de valores".
 */
export async function simulateIncomingProcess(
  ctx: AuthContext,
  opts: { seed?: number; variant?: number } = {},
): Promise<RegisterIncomingResult & { number: string }> {
  assertCan(ctx, "intake:manage");
  const org = await loadOrganization(ctx.organizationId);
  if (!org.isDemo) {
    throw new ForbiddenError("A chegada simulada só está disponível em organizações de demonstração.");
  }
  const [{ n: simulatedSoFar }] = await getDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(caseIntakes)
    .where(and(eq(caseIntakes.organizationId, ctx.organizationId), eq(caseIntakes.source, "simulated_feed")));
  const seed = opts.seed ?? simulatedSoFar + 1;
  const [sample, company] = await Promise.all([sampleCourt(ctx.organizationId, seed), portfolioCompany(ctx.organizationId)]);
  const plaintiff = simulatedPlaintiff(seed);
  const defendant = company?.name ?? FALLBACK_DEFENDANT;
  const year = Number(todayISO().slice(0, 4));

  let number = "";
  for (let salt = 0; salt < 50; salt++) {
    number = buildSimulatedCnj({ seed, salt, year, tribunal: sample.tribunal, origin: sample.origin });
    if (!(await numberExists(ctx.organizationId, number))) break;
    number = "";
  }
  if (!number) throw new ConflictError("Não foi possível gerar um número CNJ fictício inédito. Tente novamente.");

  const claimAmountCents = simulatedClaimCents(seed);
  const filedAt = todayISO();
  const info: DemoCaseInfo = {
    number,
    court: sample.court,
    courtDivision: sample.courtDivision,
    city: sample.city,
    state: sample.state,
    plaintiff,
    defendant,
    processClass: sample.processClass,
    claimAmountCents,
    filedAt,
  };
  const { buildDemoCaseDocuments } = await import("@/modules/briefs/demo-documents");
  const docs = await buildDemoCaseDocuments(info, { variant: opts.variant ?? seed });

  const result = await registerIncoming(
    ctx,
    {
      number,
      court: sample.court,
      courtDivision: sample.courtDivision,
      city: sample.city,
      state: sample.state,
      processClass: sample.processClass,
      area: "labor" satisfies LegalArea,
      phase: "knowledge" satisfies ProcessPhase,
      instance: "first" satisfies ProcessInstance,
      companyId: company?.id ?? null,
      claimAmountCents,
      filedAt,
      plaintiffName: plaintiff,
      defendantName: defendant,
      title: `${plaintiff} x ${shortPartyName(defendant)} (${SIMULATION_LABEL.toLowerCase()})`.slice(0, 200),
      description: SIMULATION_DESCRIPTION,
      source: "simulated_feed",
      documents: docs.map((d) => ({
        title: d.title,
        category: d.category,
        description: d.description,
        file: { name: d.fileName, bytes: d.bytes },
      })),
      receivedNote: sample.fromPortfolio
        ? `Tribunal, cidade e classe sorteados da carteira importada (${[sample.court, sample.city].filter(Boolean).join(", ")}).`
        : "Carteira sem processos trabalhistas de 1º grau: usado o padrão da demonstração (TRT10, Palmas/TO).",
    },
    { claimSource: "simulation" },
  );
  return { ...result, number };
}

// ---------------------------------------------------------------------------
// Job (contract)
// ---------------------------------------------------------------------------

/** Job handler body for `intake.process`: assign → generate brief → notify (simulated e-mail). Idempotent per step. */
export async function processIntakeJob(intakeId: string, opts: { attempt: number; maxAttempts: number }): Promise<void> {
  if (!isGuid(intakeId)) throw new ValidationError("Entrada inválida.");
  const intake = await loadIntakeRow(intakeId);
  if (!intake) {
    logger.warn("intake_not_found", { intakeId });
    return;
  }
  if (intake.status === "cancelled") {
    await resolveAlertsByDedupeKeys(intake.organizationId, arrivalAlertKeys(intake.id));
    return;
  }
  const org = await loadOrganization(intake.organizationId);
  const ctx = systemContext(intake.organizationId, org.isDemo);
  await runPipeline(ctx, intake, org.settings, { actorName: SYSTEM_ACTOR, attempt: opts.attempt, maxAttempts: opts.maxAttempts });
}

// ---------------------------------------------------------------------------
// Manual actions (intake page)
// ---------------------------------------------------------------------------

/**
 * Enqueues the pipeline: "start" after the registration form uploaded the
 * files, "retry" to reprocess a failed / pending step.
 */
export async function requestIntakeProcessing(
  ctx: AuthContext,
  intakeId: string,
  opts: { reason: "start" | "retry"; failedUploads?: number } = { reason: "retry" },
): Promise<{ deduplicated: boolean }> {
  assertCan(ctx, "intake:manage");
  const intake = await loadVisibleIntake(ctx, intakeId);
  if (intake.status === "cancelled") throw new ConflictError("Esta entrada foi cancelada.");
  let detail: string;
  if (opts.reason === "start") {
    const [{ n }] = await getDb()
      .select({ n: sql<number>`count(*)::int` })
      .from(documents)
      .where(and(eq(documents.organizationId, ctx.organizationId), eq(documents.processId, intake.processId), isNull(documents.deletedAt)));
    const failed = Math.max(0, Math.min(MAX_DOCUMENTS, Math.trunc(opts.failedUploads ?? 0)));
    detail =
      `${pluralize(n, "documento anexado", "documentos anexados")} no registro.` +
      (failed > 0
        ? ` ${pluralize(failed, "arquivo não pôde ser enviado", "arquivos não puderam ser enviados")}. Envie pela aba Documentos e análises do processo e gere a análise novamente.`
        : "");
  } else {
    detail = `Reprocessamento solicitado por ${ctx.name}.`;
  }
  return getDb().transaction(async (tx) => {
    await updateIntake(intake, {}, newStep(progressStatus(intake), detail, ctx.name), tx);
    const job = await enqueueIntakeJob(ctx.organizationId, intake.id, tx);
    await recordAudit(
      ctx,
      {
        action: opts.reason === "start" ? "intake.process_start" : "intake.reprocess",
        entityType: "intake",
        entityId: intake.id,
        summary: opts.reason === "start" ? "Processamento da entrada iniciado." : "Reprocessamento da entrada solicitado.",
        metadata: { deduplicated: job.deduplicated },
      },
      tx,
    );
    return { deduplicated: job.deduplicated };
  });
}

/** Applies the distribution rules to an intake without responsible, then continues the pipeline. */
export async function autoAssignIntake(ctx: AuthContext, intakeId: string): Promise<AssignmentDecision> {
  assertCanManageIntake(ctx);
  const intake = await loadVisibleIntake(ctx, intakeId);
  if (intake.status === "cancelled") throw new ConflictError("Esta entrada foi cancelada.");
  if (intake.assignedToId) throw new ConflictError("A entrada já tem responsável. Use “Reatribuir” para trocar.");
  const decision = await assignResponsible(ctx, intake.processId, { handledIntakeId: intake.id });
  if (!decision.userId) {
    await raiseUnassignedAlert(intake, decision.reason);
    throw new ConflictError(decision.reason);
  }
  await recordAssignment(intake, decision, ctx.name, { actorUserId: ctx.userId });
  await enqueueIntakeJob(ctx.organizationId, intake.id);
  return decision;
}

export type IntakeAssignmentResult = AssignmentDecision & {
  /** What happened to the simulated "Novo processo atribuído" e-mail (settings may turn it off). */
  assignmentEmail: AssignmentEmailOutcome;
};

/**
 * Manual assignment with a reason. `intake:manage` defines the FIRST
 * responsible (an internal lawyer or legal manager); replacing a responsible
 * already defined on the intake or on the process requires
 * `distribution:manage`. When the chosen person already is the process
 * responsible (changed elsewhere), only the intake is brought in line. The
 * pipeline then notifies the new responsible (simulated e-mail) and, if
 * needed, generates the brief.
 */
export async function assignIntakeManually(
  ctx: AuthContext,
  intakeId: string,
  input: ManualAssignmentInput,
): Promise<IntakeAssignmentResult> {
  assertCanManageIntake(ctx);
  const intake = await loadVisibleIntake(ctx, intakeId);
  if (intake.status === "cancelled") throw new ConflictError("Esta entrada foi cancelada.");
  const proc = await processAssignment(ctx.organizationId, intake.processId);
  if (!can(ctx, "distribution:manage") && (intake.assignedToId || proc.responsibleId)) {
    throw new ForbiddenError("Trocar o responsável já definido exige a permissão de redistribuir demandas (gestão jurídica).");
  }
  const v = parse(manualAssignmentSchema, input);
  let decision: AssignmentDecision;
  if (proc.responsibleId && v.userId === proc.responsibleId) {
    const name = (await userName(ctx.organizationId, v.userId)) ?? "usuário cadastrado";
    if (intake.assignedToId === v.userId) throw new ConflictError(`${name} já é o responsável por este processo.`);
    // The process already has this responsible (changed outside the intake): only the intake follows it.
    decision = {
      userId: v.userId,
      userName: name,
      method: "manual",
      ruleId: null,
      ruleName: null,
      lawFirmId: proc.lawFirmId,
      unitId: proc.unitId,
      reason: `Atribuição manual por ${ctx.name}. Motivo: ${v.reason}`,
    };
  } else {
    decision = await applyManualAssignment(ctx, intake.processId, v, { handledIntakeId: intake.id });
  }
  const detail = `Responsável ${intake.assignedToId ? "alterado" : "definido"} manualmente por ${ctx.name}: ${decision.userName}. ${decision.reason}`;
  const { email } = await recordAssignment(intake, decision, ctx.name, { detail, actorUserId: ctx.userId });
  await enqueueIntakeJob(ctx.organizationId, intake.id);
  return { ...decision, assignmentEmail: email };
}

/** Generates a new brief version now (simulation) and lets the pipeline notify the responsible. */
export async function regenerateIntakeBrief(ctx: AuthContext, intakeId: string): Promise<{ briefId: string | null }> {
  assertCan(ctx, "intake:manage");
  const intake = await loadVisibleIntake(ctx, intakeId);
  if (intake.status === "cancelled") throw new ConflictError("Esta entrada foi cancelada.");
  const { responsibleId } = await processAssignment(ctx.organizationId, intake.processId);
  if (!intake.assignedToId && !responsibleId) throw new ConflictError("Defina o responsável antes de gerar a análise preliminar.");
  let updated: IntakeRow;
  try {
    updated = await generateBrief(ctx, intake, ctx.name, { resetEmail: true });
  } catch (err) {
    const message = safeErrorMessage(err);
    await updateIntake(
      intake,
      { status: "failed", errorMessage: `${STAGE_NAMES.brief}: ${message}`.slice(0, 1000) },
      newStep("failed", `Falha ao gerar a análise preliminar a pedido de ${ctx.name}: ${message}`.slice(0, 1000), ctx.name),
    );
    throw err;
  }
  await recordAudit(ctx, {
    action: "intake.brief_request",
    entityType: "intake",
    entityId: intake.id,
    summary: "Nova análise preliminar (simulação) solicitada na entrada.",
    metadata: { briefId: updated.briefId },
  });
  if (updated.status === "brief_ready") await enqueueIntakeJob(ctx.organizationId, intake.id);
  return { briefId: updated.briefId };
}

/** Sends the "análise disponível" e-mail again (simulated). Requires `email:send`. */
export async function resendIntakeEmail(ctx: AuthContext, intakeId: string): Promise<{ emailId: string | null }> {
  assertCan(ctx, "email:send");
  const intake = await loadVisibleIntake(ctx, intakeId);
  const updated = await notifyResponsible(ctx, intake, ctx.name, "manual");
  await recordAudit(ctx, {
    action: "intake.email_resend",
    entityType: "intake",
    entityId: intake.id,
    summary: "E-mail (simulado) da análise preliminar reenviado ao responsável.",
    metadata: { emailId: updated.lastEmailId },
  });
  return { emailId: updated.lastEmailId };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export type IntakeCounts = {
  received: number;
  inProgress: number;
  awaitingReview: number;
  approved: number;
  failed: number;
};

/** SQL twin of `effectiveIntakeStatus` (./status.ts) — keep both identical. */
function effectiveStatusSql(): SQL<EffectiveIntakeStatus> {
  return sql<EffectiveIntakeStatus>`(case when ${caseIntakes.status} in ('failed', 'cancelled') then ${caseIntakes.status} when ${caseBriefs.status} = 'approved' then 'approved' when ${caseBriefs.status} = 'in_review' then 'in_review' when ${caseBriefs.status} = 'rejected' then 'brief_rejected' else ${caseIntakes.status} end)`;
}

/** Number of visible intakes per effective status. Requires `process:read`. */
export async function getIntakeStatusCounts(ctx: AuthContext): Promise<Record<EffectiveIntakeStatus, number>> {
  const out = Object.fromEntries(EFFECTIVE_INTAKE_STATUSES.map((s) => [s, 0])) as Record<EffectiveIntakeStatus, number>;
  if (!can(ctx, "process:read")) return out;
  const rows = await getDb()
    .select({ status: caseIntakes.status, briefStatus: caseBriefs.status, n: sql<number>`count(*)::int` })
    .from(caseIntakes)
    .leftJoin(caseBriefs, eq(caseBriefs.id, caseIntakes.briefId))
    .where(intakeWhere(ctx))
    .groupBy(caseIntakes.status, caseBriefs.status);
  for (const r of rows) {
    const eff = effectiveIntakeStatus(r.status, r.briefStatus);
    out[eff] = (out[eff] ?? 0) + r.n;
  }
  return out;
}

/**
 * Counts of intakes visible to ctx (dashboard / nav badges). Requires
 * `process:read`. An intake whose brief was rejected (`brief_rejected`) is in
 * none of these counters (like a cancelled one): it waits for a new version,
 * not for the lawyer's review, and shows in its own chip on /entrada.
 */
export async function getIntakeCounts(ctx: AuthContext): Promise<IntakeCounts> {
  const s = await getIntakeStatusCounts(ctx);
  return {
    received: s.received,
    inProgress: s.assigned + s.analyzing + s.brief_ready,
    awaitingReview: s.notified + s.in_review,
    approved: s.approved,
    failed: s.failed,
  };
}

export type IntakeListItem = {
  id: string;
  processId: string;
  processNumber: string;
  processTitle: string;
  court: string;
  city: string | null;
  state: string | null;
  source: IntakeSource;
  status: IntakeStatus;
  effectiveStatus: EffectiveIntakeStatus;
  receivedAt: Date;
  /** Current responsible (the process responsible while the intake is open). */
  assignedToName: string | null;
  /** How the intake recorded its responsible; null when the process responsible changed elsewhere since. */
  assignmentMethod: AssignmentMethod | null;
  briefStatus: CaseBriefStatus | null;
  errorMessage: string | null;
  emailSent: boolean;
};

export type IntakeFilters = { status?: EffectiveIntakeStatus; source?: IntakeSource; q?: string } & Page;

export async function listIntakes(ctx: AuthContext, filters: IntakeFilters = {}): Promise<Paginated<IntakeListItem>> {
  assertCan(ctx, "process:read");
  const { page, pageSize, offset } = normalizePage(filters);
  const status =
    filters.status && (EFFECTIVE_INTAKE_STATUSES as readonly string[]).includes(filters.status) ? filters.status : undefined;
  const source = filters.source && (INTAKE_SOURCES as readonly string[]).includes(filters.source) ? filters.source : undefined;
  const q = filters.q?.trim().slice(0, 200);
  const eff = effectiveStatusSql();
  const pattern = q ? `%${escapeLike(q)}%` : null;
  // "00012345620265100801" also finds "0001234-56.2026.5.10.0801".
  const digits = q && /^[\d.\-\s/]+$/.test(q) ? q.replace(/\D/g, "") : "";
  const where = and(
    intakeWhere(ctx),
    status ? sql`${eff} = ${status}` : undefined,
    source ? eq(caseIntakes.source, source) : undefined,
    pattern
      ? or(
          ilike(legalProcesses.number, pattern),
          ilike(legalProcesses.title, pattern),
          digits.length >= 4 ? sql`regexp_replace(${legalProcesses.number}, '[^0-9]', '', 'g') like ${`%${digits}%`}` : undefined,
        )
      : undefined,
  );
  const db = getDb();
  const assignee = intakeAssigneeSql();
  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: caseIntakes.id,
        processId: caseIntakes.processId,
        processNumber: legalProcesses.number,
        processTitle: legalProcesses.title,
        court: legalProcesses.court,
        city: legalProcesses.city,
        state: legalProcesses.state,
        source: caseIntakes.source,
        status: caseIntakes.status,
        effectiveStatus: eff,
        receivedAt: caseIntakes.receivedAt,
        assignedToName: users.name,
        recordedAssigneeId: caseIntakes.assignedToId,
        currentAssigneeId: assignee,
        assignmentMethod: caseIntakes.assignmentMethod,
        briefStatus: caseBriefs.status,
        errorMessage: caseIntakes.errorMessage,
        lastEmailId: caseIntakes.lastEmailId,
      })
      .from(caseIntakes)
      .innerJoin(legalProcesses, eq(legalProcesses.id, caseIntakes.processId))
      .leftJoin(caseBriefs, eq(caseBriefs.id, caseIntakes.briefId))
      .leftJoin(users, sql`${users.id} = ${assignee}`)
      .where(where)
      .orderBy(desc(caseIntakes.receivedAt), desc(caseIntakes.id))
      .limit(pageSize)
      .offset(offset),
    db
      .select({ total: count() })
      .from(caseIntakes)
      .innerJoin(legalProcesses, eq(legalProcesses.id, caseIntakes.processId))
      .leftJoin(caseBriefs, eq(caseBriefs.id, caseIntakes.briefId))
      .where(where),
  ]);
  return {
    items: rows.map(({ lastEmailId, recordedAssigneeId, currentAssigneeId, assignmentMethod, ...r }) => ({
      ...r,
      assignmentMethod: recordedAssigneeId === currentAssigneeId ? assignmentMethod : null,
      emailSent: Boolean(lastEmailId),
    })),
    total,
    page,
    pageSize,
  };
}

export type IntakeDocument = {
  id: string;
  title: string;
  category: DocumentCategory;
  extractionStatus: TextExtractionStatus | null;
};

export type IntakeDetail = {
  id: string;
  source: IntakeSource;
  status: IntakeStatus;
  effectiveStatus: EffectiveIntakeStatus;
  receivedAt: Date;
  createdByName: string | null;
  /** Current responsible: the process responsible while the intake is open. */
  assignedToId: string | null;
  assignedToName: string | null;
  assignmentMethod: AssignmentMethod | null;
  assignmentReason: string | null;
  ruleName: string | null;
  assignedLawFirmName: string | null;
  assignedUnitName: string | null;
  errorMessage: string | null;
  /** The pipeline already produced a brief / sent the e-mail (even when the user cannot open them). */
  hasBrief: boolean;
  emailSent: boolean;
  steps: IntakeStep[];
  stages: PipelineStage[];
  /** A job for this intake is queued or running (the page refreshes itself). */
  processing: boolean;
  process: {
    id: string;
    number: string;
    title: string;
    court: string;
    courtDivision: string | null;
    city: string | null;
    state: string | null;
    area: LegalArea;
    phase: ProcessPhase;
    instance: ProcessInstance | null;
    processClass: string | null;
    claimAmountCents: number | null;
    companyName: string | null;
    needsVerification: boolean;
    verificationNote: string | null;
  };
  brief: { id: string; status: CaseBriefStatus; version: number; mode: string } | null;
  email: { id: string; createdAt: Date; toName: string; subject: string } | null;
  documents: IntakeDocument[];
  permissions: {
    /** First assignment (`intake:manage`) or redistribution (`distribution:manage`). */
    canAssign: boolean;
    canProcess: boolean;
    canGenerateBrief: boolean;
    canResendEmail: boolean;
    canViewBrief: boolean;
    canViewEmail: boolean;
  };
};

export async function getIntake(ctx: AuthContext, intakeId: string): Promise<IntakeDetail> {
  assertCan(ctx, "process:read");
  const intake = await loadVisibleIntake(ctx, intakeId);
  const db = getDb();
  const [proc] = await db
    .select({
      id: legalProcesses.id,
      number: legalProcesses.number,
      title: legalProcesses.title,
      court: legalProcesses.court,
      courtDivision: legalProcesses.courtDivision,
      city: legalProcesses.city,
      state: legalProcesses.state,
      area: legalProcesses.area,
      phase: legalProcesses.phase,
      instance: legalProcesses.instance,
      processClass: legalProcesses.processClass,
      claimAmountCents: legalProcesses.claimAmountCents,
      companyName: companies.name,
      needsVerification: legalProcesses.needsVerification,
      verificationNote: legalProcesses.verificationNote,
      responsibleId: legalProcesses.responsibleId,
    })
    .from(legalProcesses)
    .leftJoin(companies, eq(companies.id, legalProcesses.companyId))
    .where(and(eq(legalProcesses.id, intake.processId), processWhere(ctx)))
    .limit(1);
  if (!proc) throw new NotFoundError(INTAKE_NOT_FOUND);
  const { responsibleId: processResponsibleId, ...process } = proc;

  const userIds = [intake.assignedToId, processResponsibleId, intake.createdById].filter((x): x is string => Boolean(x));
  const [people, rule, firm, unit, briefRaw, email, docs, pendingJob] = await Promise.all([
    userIds.length
      ? db.select({ id: users.id, name: users.name }).from(users).where(and(eq(users.organizationId, ctx.organizationId), inArray(users.id, userIds)))
      : Promise.resolve([] as { id: string; name: string }[]),
    intake.distributionRuleId
      ? db.select({ name: distributionRules.name }).from(distributionRules).where(and(eq(distributionRules.id, intake.distributionRuleId), eq(distributionRules.organizationId, ctx.organizationId))).limit(1)
      : Promise.resolve([] as { name: string }[]),
    intake.assignedLawFirmId
      ? db.select({ name: lawFirms.name }).from(lawFirms).where(and(eq(lawFirms.id, intake.assignedLawFirmId), eq(lawFirms.organizationId, ctx.organizationId))).limit(1)
      : Promise.resolve([] as { name: string }[]),
    intake.assignedUnitId
      ? db.select({ name: units.name }).from(units).where(and(eq(units.id, intake.assignedUnitId), eq(units.organizationId, ctx.organizationId))).limit(1)
      : Promise.resolve([] as { name: string }[]),
    intake.briefId
      ? db
          .select({
            id: caseBriefs.id,
            status: caseBriefs.status,
            version: caseBriefs.version,
            mode: caseBriefs.mode,
            generatedAt: caseBriefs.generatedAt,
            lastEditedAt: caseBriefs.lastEditedAt,
            lastEditedById: caseBriefs.lastEditedById,
            approvedAt: caseBriefs.approvedAt,
            approvedById: caseBriefs.approvedById,
            rejectedAt: caseBriefs.rejectedAt,
            rejectedById: caseBriefs.rejectedById,
          })
          .from(caseBriefs)
          .where(and(eq(caseBriefs.id, intake.briefId), eq(caseBriefs.organizationId, ctx.organizationId)))
          .limit(1)
      : Promise.resolve([]),
    intake.lastEmailId
      ? db
          .select({ id: emailMessages.id, createdAt: emailMessages.createdAt, toName: emailMessages.toName, subject: emailMessages.subject })
          .from(emailMessages)
          .where(and(eq(emailMessages.id, intake.lastEmailId), eq(emailMessages.organizationId, ctx.organizationId)))
          .limit(1)
      : Promise.resolve([] as { id: string; createdAt: Date; toName: string; subject: string }[]),
    db
      .select({
        id: documents.id,
        title: documents.title,
        category: documents.category,
        extractionStatus: documentVersions.extractionStatus,
      })
      .from(documents)
      .leftJoin(documentVersions, eq(documentVersions.id, documents.currentVersionId))
      .where(and(eq(documents.processId, intake.processId), documentWhere(ctx)))
      .orderBy(asc(documents.createdAt)),
    db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.dedupeKey, intakeJobKey(intake.id)), inArray(jobs.status, ["queued", "running"])))
      .limit(1),
  ]);

  const brief = briefRaw[0] ?? null;
  const assigneeId = currentAssigneeId(intake, processResponsibleId, brief?.status ?? null);
  // The process responsible changed outside the intake: what the intake recorded about it no longer applies.
  const followsRecord = assigneeId === intake.assignedToId;
  const followNote = intake.assignedToId ? PROCESS_RESPONSIBLE_CHANGED : PROCESS_RESPONSIBLE_PENDING;
  // The status feeds the stepper for everyone; the link to the brief only when it is visible (rule 11).
  let briefVisible = false;
  if (brief && can(ctx, "brief:read")) {
    const [visible] = await db
      .select({ id: caseBriefs.id })
      .from(caseBriefs)
      .where(and(eq(caseBriefs.id, brief.id), caseBriefWhere(ctx)))
      .limit(1);
    briefVisible = Boolean(visible);
  }
  const names = new Map(people.map((p) => [p.id, p.name]));
  const reviewerIds = brief ? [brief.lastEditedById, brief.approvedById, brief.rejectedById].filter((x): x is string => Boolean(x)) : [];
  if (reviewerIds.length) {
    const more = await db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(and(eq(users.organizationId, ctx.organizationId), inArray(users.id, reviewerIds)));
    for (const p of more) names.set(p.id, p.name);
  }
  const nameOf = (id: string | null | undefined) => (id ? (names.get(id) ?? null) : null);
  const processing = pendingJob.length > 0;
  const emailRow = email[0] ?? null;
  const effectiveStatus = effectiveIntakeStatus(intake.status, brief?.status ?? null);

  const stages = buildPipelineStages({
    status: intake.status,
    receivedAt: intake.receivedAt,
    createdByName: nameOf(intake.createdById),
    source: intake.source,
    assignedToName: nameOf(assigneeId),
    assignedAt: intake.assignedAt,
    assignmentMethod: followsRecord ? intake.assignmentMethod : null,
    assignmentReason: followsRecord ? intake.assignmentReason : followNote,
    briefId: intake.briefId,
    lastEmailId: intake.lastEmailId,
    steps: intake.steps ?? [],
    errorMessage: intake.errorMessage,
    processing,
    brief: brief
      ? {
          status: brief.status,
          version: brief.version,
          generatedAt: brief.generatedAt,
          lastEditedAt: brief.lastEditedAt,
          lastEditedByName: nameOf(brief.lastEditedById),
          approvedAt: brief.approvedAt,
          approvedByName: nameOf(brief.approvedById),
          rejectedAt: brief.rejectedAt,
          rejectedByName: nameOf(brief.rejectedById),
        }
      : null,
    email: emailRow ? { createdAt: emailRow.createdAt, toName: emailRow.toName } : null,
  });

  return {
    id: intake.id,
    source: intake.source,
    status: intake.status,
    effectiveStatus,
    receivedAt: intake.receivedAt,
    createdByName: nameOf(intake.createdById),
    assignedToId: assigneeId,
    assignedToName: nameOf(assigneeId),
    assignmentMethod: followsRecord ? intake.assignmentMethod : null,
    assignmentReason: followsRecord
      ? intake.assignmentReason
      : followNote,
    ruleName: followsRecord ? (rule[0]?.name ?? null) : null,
    assignedLawFirmName: followsRecord ? (firm[0]?.name ?? null) : null,
    assignedUnitName: followsRecord ? (unit[0]?.name ?? null) : null,
    errorMessage: intake.errorMessage,
    hasBrief: Boolean(intake.briefId),
    emailSent: Boolean(intake.lastEmailId),
    steps: intake.steps ?? [],
    stages,
    processing,
    process,
    brief: brief && briefVisible ? { id: brief.id, status: brief.status, version: brief.version, mode: brief.mode } : null,
    email: emailRow && can(ctx, "email:read") ? emailRow : null,
    documents: docs,
    permissions: {
      // intake:manage defines the first responsible; replacing one is a redistribution.
      canAssign: can(ctx, "distribution:manage") || (can(ctx, "intake:manage") && !assigneeId && !intake.assignedToId),
      canProcess: can(ctx, "intake:manage"),
      canGenerateBrief: can(ctx, "intake:manage"),
      canResendEmail: can(ctx, "email:send"),
      canViewBrief: can(ctx, "brief:read"),
      canViewEmail: can(ctx, "email:read"),
    },
  };
}

/** Recent intakes of a process (for links from other screens). */
export async function listProcessIntakes(
  ctx: AuthContext,
  processId: string,
): Promise<{ id: string; receivedAt: Date; status: EffectiveIntakeStatus }[]> {
  assertCan(ctx, "process:read");
  if (!isGuid(processId)) return [];
  const rows = await getDb()
    .select({ id: caseIntakes.id, receivedAt: caseIntakes.receivedAt, status: caseIntakes.status, briefStatus: caseBriefs.status })
    .from(caseIntakes)
    .leftJoin(caseBriefs, eq(caseBriefs.id, caseIntakes.briefId))
    .where(and(eq(caseIntakes.processId, processId), intakeWhere(ctx), ne(caseIntakes.status, "cancelled")))
    .orderBy(desc(caseIntakes.receivedAt));
  return rows.map((r) => ({ id: r.id, receivedAt: r.receivedAt, status: effectiveIntakeStatus(r.status, r.briefStatus) }));
}
