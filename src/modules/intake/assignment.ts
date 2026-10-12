/**
 * Responsible of an intake = responsible of its process.
 *
 * The process (`legal_processes.responsible_id`) is the source of truth while
 * the intake is open (not cancelled, brief not approved). This file holds what
 * both the distribution service and the intake service need to keep them in
 * line, without importing either service (no import cycle):
 *
 * - `syncOpenIntakesWithResponsible` runs INSIDE the distribution transaction
 *   when the process responsible changes: it moves the open intakes of the
 *   process to the new responsible, resets the "análise disponível" e-mail and
 *   enqueues `intake.process`, so the new responsible is notified.
 * - `intakeAssigneeSql` is the read-time rule (a process edit made elsewhere
 *   also changes the intake responsible): queries join `legal_processes` and
 *   `case_briefs` and use it instead of `case_intakes.assigned_to_id`.
 * - `sendAssignmentEmail` sends the simulated "Novo processo atribuído" e-mail
 *   when `settings.email.notifyOnAssignment` is on. Call it AFTER the
 *   assignment committed; it never throws (the assignment stays valid).
 */
import { and, eq, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { ASSIGNMENT_METHOD_LABELS, type AssignmentMethod, type IntakeStatus } from "@/domain/enums";
import { resolveAlertsByDedupeKeys } from "@/modules/alerts/service";
import { loadOrganization } from "@/modules/analyses/org-settings";
import { systemContext } from "@/server/auth/context";
import { getDb, type DbOrTx } from "@/server/db/client";
import { caseBriefs, caseIntakes, legalProcesses, type IntakeStep } from "@/server/db/schema";
import { enqueueJob, safeErrorMessage } from "@/server/jobs/queue";
import { logger } from "@/server/lib/logger";

export function intakeJobKey(intakeId: string): string {
  return `intake.process:${intakeId}`;
}

export async function enqueueIntakeJob(organizationId: string, intakeId: string, db: DbOrTx = getDb()) {
  return enqueueJob(
    { type: "intake.process", organizationId, payload: { intakeId }, dedupeKey: intakeJobKey(intakeId) },
    db,
  );
}

/** Dedupe keys of the alerts that only make sense while an intake waits for its responsible. */
export function arrivalAlertKeys(intakeId: string): string[] {
  return [`intake_unassigned:${intakeId}`, `new_process_received:${intakeId}`];
}

/**
 * Current responsible of an intake (SQL). Needs `legal_processes` (by
 * `case_intakes.process_id`) and `case_briefs` (by `case_intakes.brief_id`,
 * left join) in the query. Keep in sync with `isOpenIntake` (./status.ts).
 */
export function intakeAssigneeSql(): SQL<string | null> {
  return sql<string | null>`(case when ${caseIntakes.status} <> 'cancelled' and (${caseBriefs.status} is null or ${caseBriefs.status} <> 'approved') then coalesce(${legalProcesses.responsibleId}, ${caseIntakes.assignedToId}) else ${caseIntakes.assignedToId} end)`;
}

export type AssignmentChange = {
  userId: string;
  userName: string | null;
  method: AssignmentMethod;
  ruleId: string | null;
  lawFirmId: string | null;
  unitId: string | null;
  /** pt-BR explanation (rule, load or "Atribuição manual por … Motivo: …"). */
  reason: string;
};

/**
 * Moves the open intakes of a process to its new responsible (same
 * transaction as the process change). `skipIntakeId`: the intake whose own
 * flow is recording the assignment. Returns the ids of the updated intakes.
 */
export async function syncOpenIntakesWithResponsible(
  tx: DbOrTx,
  input: {
    organizationId: string;
    processId: string;
    change: AssignmentChange;
    actorName: string;
    skipIntakeId?: string | null;
  },
): Promise<string[]> {
  const rows = await tx
    .select({
      id: caseIntakes.id,
      status: caseIntakes.status,
      briefId: caseIntakes.briefId,
      assignedToId: caseIntakes.assignedToId,
    })
    .from(caseIntakes)
    .leftJoin(caseBriefs, eq(caseBriefs.id, caseIntakes.briefId))
    .where(
      and(
        eq(caseIntakes.organizationId, input.organizationId),
        eq(caseIntakes.processId, input.processId),
        ne(caseIntakes.status, "cancelled"),
        or(isNull(caseBriefs.status), ne(caseBriefs.status, "approved")),
        input.skipIntakeId ? ne(caseIntakes.id, input.skipIntakeId) : undefined,
      ),
    );
  const { change } = input;
  const updated: string[] = [];
  const now = new Date();
  for (const row of rows) {
    if (row.assignedToId === change.userId) continue;
    const status: IntakeStatus = row.status === "analyzing" ? "analyzing" : row.briefId ? "brief_ready" : "assigned";
    const step: IntakeStep = {
      status: "assigned",
      at: now.toISOString(),
      detail: `Responsável ${row.assignedToId ? "alterado" : "definido"} na distribuição do processo: ${change.userName ?? "usuário cadastrado"} (${ASSIGNMENT_METHOD_LABELS[change.method]}). ${change.reason}`.slice(0, 1000),
      actorName: input.actorName,
    };
    await tx
      .update(caseIntakes)
      .set({
        assignedToId: change.userId,
        assignmentMethod: change.method,
        distributionRuleId: change.ruleId,
        assignedLawFirmId: change.lawFirmId,
        assignedUnitId: change.unitId,
        assignmentReason: change.reason,
        assignedAt: now,
        // The "análise disponível" e-mail went to someone else (or was not sent yet).
        lastEmailId: null,
        status,
        errorMessage: null,
        steps: sql`${caseIntakes.steps} || ${JSON.stringify([step])}::jsonb`,
      })
      .where(and(eq(caseIntakes.id, row.id), eq(caseIntakes.organizationId, input.organizationId)));
    await resolveAlertsByDedupeKeys(input.organizationId, arrivalAlertKeys(row.id), tx);
    // Visible to the worker only after the commit: the pipeline notifies the new responsible.
    await enqueueIntakeJob(input.organizationId, row.id, tx);
    updated.push(row.id);
  }
  return updated;
}

export type AssignmentEmailOutcome = "sent" | "disabled" | "skipped" | "failed";

/**
 * Simulated "Novo processo atribuído" e-mail to the new responsible, when the
 * organization enabled `email.notifyOnAssignment`. Skipped when the recipient
 * is the person who made the assignment. Never throws: a failure is logged
 * (name/code only) and reported as "failed".
 */
export async function sendAssignmentEmail(input: {
  organizationId: string;
  processId: string;
  toUserId: string;
  reason: string;
  /** Intake of the process, when known (otherwise the open intake is looked up). */
  intakeId?: string | null;
  /** User who made the assignment (no e-mail to oneself). */
  actorUserId?: string | null;
}): Promise<AssignmentEmailOutcome> {
  if (input.actorUserId && input.actorUserId === input.toUserId) return "skipped";
  try {
    const org = await loadOrganization(input.organizationId);
    if (!org.settings.email.notifyOnAssignment) return "disabled";
    const db = getDb();
    const [proc] = await db
      .select({
        number: legalProcesses.number,
        title: legalProcesses.title,
        court: legalProcesses.court,
        createdAt: legalProcesses.createdAt,
      })
      .from(legalProcesses)
      .where(
        and(
          eq(legalProcesses.id, input.processId),
          eq(legalProcesses.organizationId, input.organizationId),
          isNull(legalProcesses.deletedAt),
        ),
      )
      .limit(1);
    if (!proc) return "skipped";
    const [intake] = await db
      .select({ id: caseIntakes.id, receivedAt: caseIntakes.receivedAt })
      .from(caseIntakes)
      .where(
        and(
          eq(caseIntakes.organizationId, input.organizationId),
          eq(caseIntakes.processId, input.processId),
          input.intakeId ? eq(caseIntakes.id, input.intakeId) : ne(caseIntakes.status, "cancelled"),
        ),
      )
      .orderBy(sql`${caseIntakes.receivedAt} desc`)
      .limit(1);
    const { sendTemplatedEmail } = await import("@/modules/emails/service");
    const { status } = await sendTemplatedEmail(systemContext(input.organizationId, org.isDemo), {
      template: "intake_assigned",
      toUserId: input.toUserId,
      data: {
        processNumber: proc.number,
        processTitle: proc.title,
        court: proc.court,
        assignmentReason: input.reason,
        receivedAt: (intake?.receivedAt ?? proc.createdAt).toISOString(),
      },
      linkPath: `/processos/${input.processId}`,
      processId: input.processId,
      intakeId: intake?.id ?? null,
      entity: intake ? { type: "intake", id: intake.id } : { type: "legal_process", id: input.processId },
    });
    return status === "simulated" ? "sent" : "failed";
  } catch (err) {
    logger.warn("assignment_email_failed", { processId: input.processId, error: safeErrorMessage(err) });
    return "failed";
  }
}
