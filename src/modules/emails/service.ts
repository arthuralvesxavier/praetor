/**
 * Central de e-mails — SIMULATED delivery in this version.
 *
 * Messages are rendered (subject/text/HTML), stored in `email_messages` with an
 * event history (`email_events`) and handed to the active EmailProvider, which
 * is always the simulated one: nothing is delivered to any mail server.
 *
 * Content safety: subjects, bodies and addresses may contain process data. They
 * are never logged nor copied to the audit trail (only template + ids).
 */
import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import { alias, type AnyPgColumn, type PgTable } from "drizzle-orm/pg-core";
import { z } from "zod";
import type { EmailMode, EmailStatus, EmailTemplate, EntityType } from "@/domain/enums";
import { normalizePage, type Paginated } from "@/domain/entities";
import { loadOrganization } from "@/modules/analyses/org-settings";
import {
  caseBriefWhere,
  emailWhere,
  intakeWhere,
  processWhere,
} from "@/server/auth/access";
import type { AuthContext } from "@/server/auth/context";
import { assertCan, can } from "@/server/auth/permissions";
import { getDb, type DbOrTx } from "@/server/db/client";
import {
  aiAnalyses,
  caseBriefs,
  caseIntakes,
  contracts,
  deadlines,
  documents,
  emailEvents,
  emailMessages,
  hearings,
  legalProcesses,
  occurrences,
  processGuarantees,
  processValuations,
  settlements,
  tasks,
  users,
} from "@/server/db/schema";
import { env } from "@/server/env";
import { EmailProviderError, getEmailProvider } from "@/server/integrations/email";
import { NotFoundError, ValidationError } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";
import { recordAudit } from "@/server/services/audit";
import { emailEventLabel, type EmailEventType } from "./labels";
import { absoluteUrl, renderEmail } from "./render";
import {
  emailIdSchema,
  listEmailsSchema,
  sendTemplatedEmailSchema,
  templateDataSchemas,
  type ListEmailsFilters,
} from "./schemas";
import type { DailyDigestData, EmailTemplateDataMap } from "./templates";

export type SendTemplatedEmailInput<T extends EmailTemplate> = {
  template: T;
  /** Recipient user (must belong to ctx.organizationId and be active). */
  toUserId: string;
  data: EmailTemplateDataMap[T];
  /** App path the e-mail links to, e.g. `/processos/<id>?aba=analise-preliminar`. */
  linkPath: string;
  processId?: string | null;
  briefId?: string | null;
  intakeId?: string | null;
  entity?: { type: EntityType; id: string } | null;
};

export type SendEmailResult = { emailId: string; status: EmailStatus };

export type EmailListItem = {
  id: string;
  createdAt: Date;
  sentAt: Date | null;
  template: EmailTemplate;
  status: EmailStatus;
  mode: EmailMode;
  subject: string;
  toUserId: string | null;
  toName: string;
  toAddress: string;
  processId: string | null;
  /** Number of the linked process, only when ctx can see the process. */
  processNumber: string | null;
  triggeredById: string | null;
  /** Null when the message was produced by a system routine/pipeline. */
  triggeredByName: string | null;
};

export type EmailEventItem = {
  id: string;
  type: string;
  label: string;
  /** Human-readable detail (pt-BR) or null. */
  detail: string | null;
  /** Other message referenced by a resend event (the copy, or the original). */
  relatedEmailId: string | null;
  actorName: string | null;
  createdAt: Date;
};

export type EmailDetail = EmailListItem & {
  fromName: string;
  fromAddress: string;
  bodyText: string;
  bodyHtml: string;
  linkUrl: string | null;
  provider: string;
  providerMessageId: string | null;
  errorMessage: string | null;
  entityType: EntityType | null;
  entityId: string | null;
  process: { id: string; number: string; title: string } | null;
  briefId: string | null;
  /** True when ctx can open `/analises-preliminares/<briefId>`. */
  briefVisible: boolean;
  intakeId: string | null;
  /** True when ctx can open `/entrada/<intakeId>`. */
  intakeVisible: boolean;
  /** Set when this message is a resend copy. */
  resendOfId: string | null;
  events: EmailEventItem[];
};

export type EmailFilterOptions = {
  recipients: { id: string; name: string }[];
  processes: { id: string; number: string; title: string }[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseOrThrow<S extends z.ZodType>(schema: S, input: unknown, field?: string): z.output<S> {
  const r = schema.safeParse(input);
  if (!r.success) {
    const flat = z.flattenError(r.error) as { formErrors: string[]; fieldErrors: Record<string, string[] | undefined> };
    const fieldErrors: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(flat.fieldErrors)) if (v && v.length) fieldErrors[field ? `${field}.${k}` : k] = v;
    if (field && flat.formErrors.length) fieldErrors[field] = flat.formErrors;
    throw new ValidationError(flat.formErrors[0] ?? "Verifique os dados do e-mail.", fieldErrors);
  }
  return r.data;
}

function parseId(id: string): string {
  const r = emailIdSchema.safeParse(id);
  if (!r.success) throw new NotFoundError();
  return r.data;
}

function invalid(field: string, message: string): ValidationError {
  return new ValidationError("Verifique os dados do e-mail.", { [field]: [message] });
}

/** Detail strings that reference another message (resend chain). */
const RESEND_OF = "resend_of:";
const COPY = "copy:";

async function loadRecipient(ctx: AuthContext, userId: string, db: DbOrTx) {
  const [u] = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.organizationId, ctx.organizationId), eq(users.isActive, true)));
  if (!u) throw invalid("toUserId", "O destinatário deve ser um usuário ativo da organização.");
  return u;
}

type EntityTableSpec = { table: PgTable; id: AnyPgColumn; org: AnyPgColumn };

/** Entity types an e-mail can point to (each checked against ctx.organizationId). */
const ENTITY_TABLES: Partial<Record<EntityType, EntityTableSpec>> = {
  legal_process: { table: legalProcesses, id: legalProcesses.id, org: legalProcesses.organizationId },
  occurrence: { table: occurrences, id: occurrences.id, org: occurrences.organizationId },
  contract: { table: contracts, id: contracts.id, org: contracts.organizationId },
  document: { table: documents, id: documents.id, org: documents.organizationId },
  task: { table: tasks, id: tasks.id, org: tasks.organizationId },
  deadline: { table: deadlines, id: deadlines.id, org: deadlines.organizationId },
  analysis: { table: aiAnalyses, id: aiAnalyses.id, org: aiAnalyses.organizationId },
  hearing: { table: hearings, id: hearings.id, org: hearings.organizationId },
  settlement: { table: settlements, id: settlements.id, org: settlements.organizationId },
  valuation: { table: processValuations, id: processValuations.id, org: processValuations.organizationId },
  guarantee: { table: processGuarantees, id: processGuarantees.id, org: processGuarantees.organizationId },
  case_brief: { table: caseBriefs, id: caseBriefs.id, org: caseBriefs.organizationId },
  intake: { table: caseIntakes, id: caseIntakes.id, org: caseIntakes.organizationId },
};

async function assertEntityInOrg(ctx: AuthContext, entity: { type: EntityType; id: string }, db: DbOrTx) {
  const spec = ENTITY_TABLES[entity.type];
  if (!spec) throw invalid("entity", "Tipo de vínculo não suportado para e-mails.");
  const [row] = await db
    .select({ id: spec.id })
    .from(spec.table)
    .where(and(eq(spec.id, entity.id), eq(spec.org, ctx.organizationId)))
    .limit(1);
  if (!row) throw invalid("entity", "Registro vinculado não encontrado na organização.");
}

type ResolvedRefs = { processId: string | null; briefId: string | null; intakeId: string | null };

/**
 * Checks every foreign id: the process must be visible to ctx (system: same
 * organization), brief and intake must belong to the organization and to the
 * same process. A brief/intake without explicit process adopts its process.
 */
async function resolveReferences(
  ctx: AuthContext,
  input: { processId?: string | null; briefId?: string | null; intakeId?: string | null },
  db: DbOrTx,
): Promise<ResolvedRefs> {
  let processId = input.processId ?? null;

  let briefId: string | null = null;
  if (input.briefId) {
    const [b] = await db
      .select({ id: caseBriefs.id, processId: caseBriefs.processId })
      .from(caseBriefs)
      .where(and(eq(caseBriefs.id, input.briefId), eq(caseBriefs.organizationId, ctx.organizationId)));
    if (!b) throw invalid("briefId", "Análise preliminar não encontrada na organização.");
    if (processId && b.processId !== processId) throw invalid("briefId", "A análise preliminar é de outro processo.");
    processId = b.processId;
    briefId = b.id;
  }

  let intakeId: string | null = null;
  if (input.intakeId) {
    const [i] = await db
      .select({ id: caseIntakes.id, processId: caseIntakes.processId })
      .from(caseIntakes)
      .where(and(eq(caseIntakes.id, input.intakeId), eq(caseIntakes.organizationId, ctx.organizationId)));
    if (!i) throw invalid("intakeId", "Entrada de processo não encontrada na organização.");
    if (processId && i.processId !== processId) throw invalid("intakeId", "A entrada é de outro processo.");
    processId = i.processId;
    intakeId = i.id;
  }

  if (processId) {
    const [p] = await db
      .select({ id: legalProcesses.id })
      .from(legalProcesses)
      .where(and(eq(legalProcesses.id, processId), processWhere(ctx)));
    if (!p) throw invalid("processId", "Processo não encontrado ou sem acesso.");
  }
  return { processId, briefId, intakeId };
}

type NewMessage = Omit<typeof emailMessages.$inferInsert, "id" | "status" | "mode" | "provider" | "createdAt" | "sentAt">;

/**
 * Two-phase delivery: (1) store the message + "composed" event (status
 * `failed` / "Envio não concluído." until the provider answers — accurate if
 * the process dies in between); (2) call the provider OUTSIDE any transaction;
 * (3) record the outcome, the events and the audit entry.
 */
async function composeAndDeliver(
  ctx: AuthContext,
  message: NewMessage,
  opts: { resendOfId?: string | null } = {},
): Promise<SendEmailResult> {
  const db = getDb();
  const provider = getEmailProvider();
  const emailId = randomUUID();

  await db.transaction(async (tx) => {
    await tx.insert(emailMessages).values({
      ...message,
      id: emailId,
      organizationId: ctx.organizationId,
      mode: provider.mode,
      provider: provider.name,
      status: "failed",
      errorMessage: "Envio não concluído.",
      triggeredById: ctx.userId,
    });
    await tx.insert(emailEvents).values({
      organizationId: ctx.organizationId,
      messageId: emailId,
      type: "composed" satisfies EmailEventType,
      detail: opts.resendOfId ? `${RESEND_OF}${opts.resendOfId}` : null,
      actorId: ctx.userId,
    });
  });

  let outcome: { ok: true; providerMessageId: string; acceptedAt: Date } | { ok: false; error: string };
  try {
    const result = await provider.send({
      from: { name: message.fromName, address: message.fromAddress },
      to: { name: message.toName, address: message.toAddress },
      subject: message.subject,
      text: message.bodyText,
      html: message.bodyHtml,
      messageId: emailId,
    });
    outcome = { ok: true, providerMessageId: result.providerMessageId, acceptedAt: result.acceptedAt };
  } catch (err) {
    // Never log err.message: a provider error may echo addresses or content.
    logger.warn("email_send_failed", {
      emailId,
      template: message.template,
      errorName: err instanceof Error ? err.name : "unknown",
    });
    outcome = {
      ok: false,
      error: err instanceof EmailProviderError ? err.userMessage : "Falha no provedor de e-mail (simulação).",
    };
  }

  const status: EmailStatus = outcome.ok ? "simulated" : "failed";
  await db.transaction(async (tx) => {
    await tx
      .update(emailMessages)
      .set(
        outcome.ok
          ? { status, providerMessageId: outcome.providerMessageId, sentAt: outcome.acceptedAt, errorMessage: null }
          : { status, errorMessage: outcome.error },
      )
      .where(and(eq(emailMessages.id, emailId), eq(emailMessages.organizationId, ctx.organizationId)));
    await tx.insert(emailEvents).values({
      organizationId: ctx.organizationId,
      messageId: emailId,
      type: (outcome.ok ? "simulated_delivery" : "failed") satisfies EmailEventType,
      detail: outcome.ok ? `Provedor ${provider.name} · ${outcome.providerMessageId}` : outcome.error,
      actorId: ctx.userId,
    });
    if (opts.resendOfId) {
      await tx.insert(emailEvents).values({
        organizationId: ctx.organizationId,
        messageId: opts.resendOfId,
        type: "resent" satisfies EmailEventType,
        detail: `${COPY}${emailId}`,
        actorId: ctx.userId,
      });
    }
    await recordAudit(
      ctx,
      {
        action: opts.resendOfId ? "email.resend" : "email.simulated_send",
        entityType: "email",
        entityId: emailId,
        summary: opts.resendOfId
          ? "Reenvio simulado de e-mail registrado (nenhuma mensagem foi enviada)."
          : "Envio simulado de e-mail registrado (nenhuma mensagem foi enviada).",
        // Template and ids only — never subject, body or addresses.
        metadata: {
          template: message.template,
          status,
          mode: provider.mode,
          toUserId: message.toUserId ?? null,
          processId: message.processId ?? null,
          briefId: message.briefId ?? null,
          intakeId: message.intakeId ?? null,
          ...(opts.resendOfId ? { originalEmailId: opts.resendOfId } : {}),
        },
      },
      tx,
    );
  });

  return { emailId, status };
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

/**
 * Renders the template, stores the message and "sends" it through the active
 * EmailProvider (simulated: nothing is delivered). System context allowed;
 * user contexts need `email:send`. Never logs subject/body/addresses.
 *
 * Call it AFTER the caller's own transaction commits (it uses its own
 * transactions and must see the referenced process/brief/intake). A provider
 * failure does not throw: the message is stored with status `failed`.
 */
export async function sendTemplatedEmail<T extends EmailTemplate>(
  ctx: AuthContext,
  input: SendTemplatedEmailInput<T>,
): Promise<SendEmailResult> {
  if (ctx.kind !== "system") assertCan(ctx, "email:send");
  const parsed = parseOrThrow(sendTemplatedEmailSchema, input);
  const template = parsed.template as T;
  const data = parseOrThrow(templateDataSchemas[template], input.data, "data") as EmailTemplateDataMap[T];

  const db = getDb();
  const recipient = await loadRecipient(ctx, parsed.toUserId, db);
  const refs = await resolveReferences(ctx, parsed, db);
  if (parsed.entity) await assertEntityInOrg(ctx, parsed.entity, db);
  const org = await loadOrganization(ctx.organizationId, db);

  const appUrl = env().APP_URL;
  const linkUrl = absoluteUrl(appUrl, parsed.linkPath);
  const rendered = renderEmail(template, data, { recipientName: recipient.name, linkUrl, appUrl });

  return composeAndDeliver(ctx, {
    organizationId: ctx.organizationId,
    template,
    toUserId: recipient.id,
    toName: recipient.name,
    toAddress: recipient.email,
    fromName: org.settings.email.senderName,
    fromAddress: org.settings.email.senderAddress,
    subject: rendered.subject,
    bodyText: rendered.text,
    bodyHtml: rendered.html,
    linkUrl,
    entityType: parsed.entity?.type ?? null,
    entityId: parsed.entity?.id ?? null,
    processId: refs.processId,
    briefId: refs.briefId,
    intakeId: refs.intakeId,
  });
}

/**
 * Sends a copy of a visible message to the same recipient (requires
 * `email:send`). The copy keeps the rendered content; sender comes from the
 * current organization settings. The original gets a "resent" event.
 */
export async function resendEmail(ctx: AuthContext, id: string): Promise<SendEmailResult> {
  assertCan(ctx, "email:send");
  const db = getDb();
  const [original] = await db
    .select()
    .from(emailMessages)
    .where(and(eq(emailMessages.id, parseId(id)), emailWhere(ctx)));
  if (!original) throw new NotFoundError();
  if (!original.toUserId) throw invalid("toUserId", "A mensagem não tem destinatário cadastrado; não é possível reenviar.");
  const recipient = await loadRecipient(ctx, original.toUserId, db).catch(() => {
    throw invalid("toUserId", "O destinatário não é mais um usuário ativo da organização.");
  });
  const org = await loadOrganization(ctx.organizationId, db);

  return composeAndDeliver(
    ctx,
    {
      organizationId: ctx.organizationId,
      template: original.template,
      toUserId: recipient.id,
      toName: recipient.name,
      toAddress: recipient.email,
      fromName: org.settings.email.senderName,
      fromAddress: org.settings.email.senderAddress,
      subject: original.subject,
      bodyText: original.bodyText,
      bodyHtml: original.bodyHtml,
      linkUrl: original.linkUrl,
      entityType: original.entityType,
      entityId: original.entityId,
      processId: original.processId,
      briefId: original.briefId,
      intakeId: original.intakeId,
    },
    { resendOfId: original.id },
  );
}

// ---------------------------------------------------------------------------
// Daily digest
// ---------------------------------------------------------------------------

const DIGEST_HEARING_DAYS = 7;

/**
 * Counts the current user's pending items (scoped exactly like the screens they
 * link to) and sends the `daily_digest` template to the user. Requires a user
 * context with `email:send`.
 */
export async function sendDailyDigest(ctx: AuthContext): Promise<SendEmailResult> {
  assertCan(ctx, "email:send");
  if (ctx.kind !== "user" || !ctx.userId) throw new ValidationError("O resumo diário é gerado para um usuário.");
  const data = await buildDailyDigestData(ctx);
  return sendTemplatedEmail(ctx, {
    template: "daily_digest",
    toUserId: ctx.userId,
    data,
    linkPath: "/dashboard",
    entity: null,
  });
}

/** Digest items visible to ctx (each source is used only when ctx has its permission). */
export async function buildDailyDigestData(ctx: AuthContext): Promise<DailyDigestData> {
  const items: DailyDigestData["items"] = [];

  // Dynamic imports keep this module free of load-order cycles with the producers.
  if (can(ctx, "dashboard:read")) {
    const { countOpenAlerts } = await import("@/modules/alerts/service");
    const alerts = await countOpenAlerts(ctx);
    items.push({ label: "Alertas abertos", count: alerts.total, path: "/alertas?situacao=abertos" });
    items.push({ label: "Alertas críticos", count: alerts.critical, path: "/alertas?situacao=abertos&severidade=critical" });
  }

  if (can(ctx, "deadline:read")) {
    const { getWorkSummary } = await import("@/modules/work/service");
    const work = await getWorkSummary(ctx);
    items.push({
      label: `Prazos com vencimento nos próximos ${work.upcomingDeadlineDays} dias`,
      count: work.upcomingDeadlines,
      path: "/prazos?aba=prazos&situacao=proximos",
    });
    items.push({ label: "Prazos vencidos", count: work.overdueDeadlines, path: "/prazos?aba=prazos&situacao=vencidos" });
    items.push({
      label: "Prazos sugeridos aguardando validação",
      count: work.pendingValidation,
      path: "/prazos?aba=validacao",
    });
  }

  if (can(ctx, "process:read")) {
    const { listUpcomingHearings } = await import("@/modules/hearings/service");
    const hearingsSoon = await listUpcomingHearings(ctx, { days: DIGEST_HEARING_DAYS, limit: 500 });
    items.push({
      label: `Audiências nos próximos ${DIGEST_HEARING_DAYS} dias`,
      count: hearingsSoon.length,
      path: "/audiencias?periodo=7d",
    });
  }

  if (can(ctx, "brief:read")) {
    const [row] = await getDb()
      .select({
        ready: sql<number>`count(*) filter (where ${caseBriefs.status} = 'ready_for_review')`.mapWith(Number),
        inReview: sql<number>`count(*) filter (where ${caseBriefs.status} = 'in_review')`.mapWith(Number),
      })
      .from(caseBriefs)
      .where(and(caseBriefWhere(ctx), inArray(caseBriefs.status, ["ready_for_review", "in_review"])));
    items.push({
      label: "Análises preliminares prontas para revisão",
      count: row?.ready ?? 0,
      path: "/analises-preliminares?status=ready_for_review",
    });
    items.push({
      label: "Análises preliminares em revisão (aguardando aprovação)",
      count: row?.inReview ?? 0,
      path: "/analises-preliminares?status=in_review",
    });
  }

  return { items };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const triggeredBy = alias(users, "email_triggered_by");

function listColumns() {
  return {
    id: emailMessages.id,
    createdAt: emailMessages.createdAt,
    sentAt: emailMessages.sentAt,
    template: emailMessages.template,
    status: emailMessages.status,
    mode: emailMessages.mode,
    subject: emailMessages.subject,
    toUserId: emailMessages.toUserId,
    toName: emailMessages.toName,
    toAddress: emailMessages.toAddress,
    processId: emailMessages.processId,
    processNumber: legalProcesses.number,
    triggeredById: emailMessages.triggeredById,
    triggeredByName: triggeredBy.name,
  };
}

export async function listEmails(ctx: AuthContext, filters: ListEmailsFilters = {}): Promise<Paginated<EmailListItem>> {
  assertCan(ctx, "email:read");
  const f = parseOrThrow(listEmailsSchema, filters);
  const { page, pageSize, offset } = normalizePage(f);
  const db = getDb();

  const conds: (SQL | undefined)[] = [emailWhere(ctx)];
  if (f.template) conds.push(eq(emailMessages.template, f.template));
  if (f.toUserId) conds.push(eq(emailMessages.toUserId, f.toUserId));
  if (f.processId) conds.push(eq(emailMessages.processId, f.processId));
  const where = and(...conds);

  const [rows, [{ total }]] = await Promise.all([
    db
      .select(listColumns())
      .from(emailMessages)
      // Parent scope on the join: the number only shows when the process is visible.
      .leftJoin(legalProcesses, and(eq(legalProcesses.id, emailMessages.processId), processWhere(ctx)))
      .leftJoin(
        triggeredBy,
        and(eq(triggeredBy.id, emailMessages.triggeredById), eq(triggeredBy.organizationId, ctx.organizationId)),
      )
      .where(where)
      .orderBy(desc(emailMessages.createdAt), desc(emailMessages.id))
      .limit(pageSize)
      .offset(offset),
    db.select({ total: count() }).from(emailMessages).where(where),
  ]);

  return { items: rows, total: Number(total), page, pageSize };
}

/** Options for the list filters, built only from messages ctx can see. */
export async function listEmailFilterOptions(ctx: AuthContext): Promise<EmailFilterOptions> {
  assertCan(ctx, "email:read");
  const db = getDb();
  const visibleMessages = (col: AnyPgColumn) =>
    db.select({ v: col }).from(emailMessages).where(and(emailWhere(ctx), isNotNull(col)));

  const [recipients, processes] = await Promise.all([
    db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(and(eq(users.organizationId, ctx.organizationId), inArray(users.id, visibleMessages(emailMessages.toUserId))))
      .orderBy(asc(users.name))
      .limit(300),
    db
      .select({ id: legalProcesses.id, number: legalProcesses.number, title: legalProcesses.title })
      .from(legalProcesses)
      .where(and(processWhere(ctx), inArray(legalProcesses.id, visibleMessages(emailMessages.processId))))
      .orderBy(asc(legalProcesses.number))
      .limit(300),
  ]);
  return { recipients, processes };
}

function describeEvent(type: string, detail: string | null): { detail: string | null; relatedEmailId: string | null } {
  if (detail?.startsWith(RESEND_OF)) {
    return { detail: "Cópia gerada a partir de outra mensagem (reenvio).", relatedEmailId: detail.slice(RESEND_OF.length) };
  }
  if (detail?.startsWith(COPY)) {
    return { detail: "Uma cópia desta mensagem foi gerada.", relatedEmailId: detail.slice(COPY.length) };
  }
  if (type === "viewed") return { detail: null, relatedEmailId: null };
  return { detail, relatedEmailId: null };
}

/**
 * Message visible to ctx (emailWhere). The first time the RECIPIENT opens it,
 * a "viewed" event is recorded.
 */
export async function getEmail(ctx: AuthContext, id: string): Promise<EmailDetail> {
  assertCan(ctx, "email:read");
  const db = getDb();
  const [row] = await db
    .select({
      ...listColumns(),
      fromName: emailMessages.fromName,
      fromAddress: emailMessages.fromAddress,
      bodyText: emailMessages.bodyText,
      bodyHtml: emailMessages.bodyHtml,
      linkUrl: emailMessages.linkUrl,
      provider: emailMessages.provider,
      providerMessageId: emailMessages.providerMessageId,
      errorMessage: emailMessages.errorMessage,
      entityType: emailMessages.entityType,
      entityId: emailMessages.entityId,
      briefId: emailMessages.briefId,
      intakeId: emailMessages.intakeId,
      processTitle: legalProcesses.title,
      visibleProcessId: legalProcesses.id,
    })
    .from(emailMessages)
    .leftJoin(legalProcesses, and(eq(legalProcesses.id, emailMessages.processId), processWhere(ctx)))
    .leftJoin(
      triggeredBy,
      and(eq(triggeredBy.id, emailMessages.triggeredById), eq(triggeredBy.organizationId, ctx.organizationId)),
    )
    .where(and(eq(emailMessages.id, parseId(id)), emailWhere(ctx)));
  if (!row) throw new NotFoundError();

  if (ctx.userId && row.toUserId === ctx.userId) {
    const [seen] = await db
      .select({ id: emailEvents.id })
      .from(emailEvents)
      .where(and(eq(emailEvents.messageId, row.id), eq(emailEvents.type, "viewed")))
      .limit(1);
    if (!seen) {
      await db.insert(emailEvents).values({
        organizationId: ctx.organizationId,
        messageId: row.id,
        type: "viewed" satisfies EmailEventType,
        actorId: ctx.userId,
      });
    }
  }

  const actor = alias(users, "email_event_actor");
  const [events, briefVisible, intakeVisible] = await Promise.all([
    db
      .select({
        id: emailEvents.id,
        type: emailEvents.type,
        detail: emailEvents.detail,
        actorName: actor.name,
        createdAt: emailEvents.createdAt,
      })
      .from(emailEvents)
      .leftJoin(actor, and(eq(actor.id, emailEvents.actorId), eq(actor.organizationId, ctx.organizationId)))
      .where(and(eq(emailEvents.messageId, row.id), eq(emailEvents.organizationId, ctx.organizationId)))
      .orderBy(asc(emailEvents.createdAt), asc(emailEvents.id)),
    row.briefId
      ? db
          .select({ id: caseBriefs.id })
          .from(caseBriefs)
          .where(and(eq(caseBriefs.id, row.briefId), caseBriefWhere(ctx)))
          .then((r) => r.length > 0 && can(ctx, "brief:read"))
      : Promise.resolve(false),
    row.intakeId
      ? db
          .select({ id: caseIntakes.id })
          .from(caseIntakes)
          .where(and(eq(caseIntakes.id, row.intakeId), intakeWhere(ctx)))
          .then((r) => r.length > 0 && can(ctx, "intake:manage"))
      : Promise.resolve(false),
  ]);

  const mapped = events.map((e) => ({ ...e, label: emailEventLabel(e.type), ...describeEvent(e.type, e.detail) }));
  const resendOfId = mapped.find((e) => e.type === "composed" && e.relatedEmailId)?.relatedEmailId ?? null;
  const { processTitle, visibleProcessId, ...rest } = row;

  return {
    ...rest,
    process:
      visibleProcessId && rest.processNumber
        ? { id: visibleProcessId, number: rest.processNumber, title: processTitle ?? "" }
        : null,
    briefVisible,
    intakeVisible,
    resendOfId,
    events: mapped,
  };
}
