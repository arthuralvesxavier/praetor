import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id } from "./_columns";
import { portfolioSnapshots } from "./contingency";
import { organizations, users } from "./core";

/**
 * Fechamento mensal com justificativa (P1.9). Uma competência só fecha sem
 * ressalva quando todos os processos ativos na data-base têm classificação de
 * risco OFICIAL em vigor nessa data. Quem fecha mesmo assim registra aqui o
 * motivo e QUAIS processos estavam sem classificação. INSERT-ONLY: a linha
 * nasce na mesma transação do fechamento e nunca é alterada (a competência
 * fechada é imutável, RN-10). Uma por competência.
 */
export const snapshotCloseOverrides = pgTable(
  "snapshot_close_overrides",
  {
    id: id(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    snapshotId: uuid("snapshot_id").notNull().references(() => portfolioSnapshots.id),
    /** Justificativa de quem fechou (mínimo de 20 caracteres, também verificado pelo banco). */
    reason: text("reason").notNull(),
    /** Processos sem classificação oficial em vigor na data-base, no momento do fechamento. */
    unclassifiedProcessIds: jsonb("unclassified_process_ids").$type<string[]>().notNull(),
    unclassifiedCount: integer("unclassified_count").notNull(),
    closedById: uuid("closed_by_id").notNull().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("snapshot_close_overrides_snapshot_uq").on(t.snapshotId),
    index("snapshot_close_overrides_org_idx").on(t.organizationId),
    check("snapshot_close_overrides_reason_len", sql`char_length(btrim(${t.reason})) >= 20`),
    check("snapshot_close_overrides_count_positive", sql`${t.unclassifiedCount} > 0`),
  ],
);
