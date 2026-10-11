import { index, pgTable, text, uuid } from "drizzle-orm/pg-core";
import type { EmailMode, EmailStatus, EmailTemplate, EntityType } from "@/domain/enums";
import { createdAt, id, ts } from "./_columns";
import { organizations, users } from "./core";
import { legalProcesses } from "./legal";

/**
 * E-mails gerados pelo sistema. Nesta etapa TODOS são `mode = simulated`: o
 * conteúdo é renderizado e guardado para visualização na Central de e-mails,
 * mas nada é entregue a servidor de e-mail algum. O corpo pode conter dados do
 * processo: nunca é logado nem copiado para a auditoria.
 */
export const emailMessages = pgTable(
  "email_messages",
  {
    id: id(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    mode: text("mode").$type<EmailMode>().notNull(),
    provider: text("provider").notNull(),
    template: text("template").$type<EmailTemplate>().notNull(),
    status: text("status").$type<EmailStatus>().notNull(),
    toUserId: uuid("to_user_id").references(() => users.id),
    toName: text("to_name").notNull(),
    toAddress: text("to_address").notNull(),
    fromName: text("from_name").notNull(),
    fromAddress: text("from_address").notNull(),
    subject: text("subject").notNull(),
    bodyText: text("body_text").notNull(),
    bodyHtml: text("body_html").notNull(),
    /** Absolute link to the record in the app. */
    linkUrl: text("link_url"),
    entityType: text("entity_type").$type<EntityType>(),
    entityId: uuid("entity_id"),
    processId: uuid("process_id").references(() => legalProcesses.id),
    briefId: uuid("brief_id"),
    intakeId: uuid("intake_id"),
    /** Id returned by the provider (simulated: `sim-…`). */
    providerMessageId: text("provider_message_id"),
    errorMessage: text("error_message"),
    /** User who triggered the send (null = system routine/pipeline). */
    triggeredById: uuid("triggered_by_id").references(() => users.id),
    createdAt: createdAt(),
    sentAt: ts("sent_at"),
  },
  (t) => [
    index("email_messages_org_created_idx").on(t.organizationId, t.createdAt),
    index("email_messages_to_user_idx").on(t.toUserId),
    index("email_messages_process_idx").on(t.processId),
  ],
);

/** Event history of a message (composed, simulated delivery, viewed, failed). */
export const emailEvents = pgTable(
  "email_events",
  {
    id: id(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    messageId: uuid("message_id").notNull().references(() => emailMessages.id, { onDelete: "cascade" }),
    /** `composed` | `simulated_delivery` | `viewed` | `failed` | `resent`. */
    type: text("type").notNull(),
    detail: text("detail"),
    actorId: uuid("actor_id").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index("email_events_message_idx").on(t.messageId, t.createdAt)],
);
