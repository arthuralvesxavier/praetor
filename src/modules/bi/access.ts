import { and, count, eq, notInArray, sql } from "drizzle-orm";
import { pgTable, timestamp } from "drizzle-orm/pg-core";
import type { AuthContext } from "@/server/auth/context";
import { processWhere, scopedRecordWhere } from "@/server/auth/access";
import { getDb } from "@/server/db/client";
import {
  biProcessAccess,
  biSettings,
  legalProcesses,
  organizations,
  portfolioSnapshotItems,
  portfolioSnapshots,
  users,
} from "@/server/db/schema";
import { NotFoundError } from "@/server/lib/errors";
import { lockBiSettingsRow } from "./config";

/**
 * Tabela de acessos do Power BI (`bi_process_access`, view `bi.acesso`): para
 * cada usuário ATIVO, os processos que ele vê no Praetor, calculados com a
 * mesma regra de visibilidade das telas (`processWhere(ctx)` de
 * src/server/auth/access.ts). O papel RLS do conjunto de dados filtra
 * `[user_key] = USERNAME()`, e o token de incorporação usa `biUserKey(userId)`
 * como identidade efetiva: executivo, contabilidade, auditoria, advogado e
 * escritório externo veem no painel exatamente o que veem no sistema.
 *
 * RN-10: um processo excluído (exclusão lógica) depois de constar de uma
 * competência FECHADA continua visível nessa competência, como no Praetor
 * (snapshot-service `loadVisibleItems`: regra atual de visibilidade do
 * processo, sem a condição de exclusão). Por isso ele continua aqui para quem
 * o veria, e em `bi.processos` com `excluido = true`.
 */

/**
 * Stand-in for `legal_processes.deleted_at` that is always NULL, so
 * `scopedRecordWhere` applies the real visibility rule without the soft-delete
 * condition. Never created in the database: the query provides it as a
 * one-row derived table.
 */
const noSoftDelete = pgTable("bi_access_no_soft_delete", {
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

/** Visibility of a soft-deleted process for the closed months (RN-10). */
function processWhereIgnoringSoftDelete(ctx: AuthContext) {
  return scopedRecordWhere(ctx, {
    organizationId: legalProcesses.organizationId,
    unitId: legalProcesses.unitId,
    responsibleId: legalProcesses.responsibleId,
    createdById: legalProcesses.createdById,
    isConfidential: legalProcesses.isConfidential,
    lawFirmId: legalProcesses.lawFirmId,
    deletedAt: noSoftDelete.deletedAt,
  });
}

/** Identity sent to Power BI (effective identity `username`) and stored in `bi.acesso.user_key`. */
export function biUserKey(userId: string): string {
  return userId;
}

/** The AuthContext a user would get on sign-in (same fields as `resolveSession`). */
function contextFor(
  u: { id: string; organizationId: string; role: AuthContext["role"]; unitId: string | null; lawFirmId: string | null; name: string; email: string },
  isDemo: boolean,
): AuthContext {
  return {
    kind: "user",
    userId: u.id,
    organizationId: u.organizationId,
    role: u.role,
    unitId: u.unitId,
    lawFirmId: u.lawFirmId,
    name: u.name,
    email: u.email,
    isDemoOrganization: isDemo,
  };
}

export type BiAccessRefreshResult = {
  users: number;
  rows: number;
  /** Links added plus links removed by this run (0 = nobody gained or lost a process). */
  changes: number;
  refreshedAt: Date;
};

/**
 * Brings the organization's access rows up to date in one transaction (the
 * previous rows stay visible to Power BI until it commits), changing only
 * what differs, and records `access_changed_at` when anything changed: a
 * revoked or granted access is a reason to refresh the Power BI dataset (see
 * `decideAutomaticRefresh`). Serialized per organization by locking its
 * `bi_settings` row.
 */
export async function refreshBiAccess(organizationId: string): Promise<BiAccessRefreshResult> {
  return getDb().transaction(async (tx) => {
    const [org] = await tx
      .select({ id: organizations.id, isDemo: organizations.isDemo })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);
    if (!org) throw new NotFoundError("Organização não encontrada.");
    await lockBiSettingsRow(organizationId, tx);

    const people = await tx
      .select({
        id: users.id,
        organizationId: users.organizationId,
        role: users.role,
        unitId: users.unitId,
        lawFirmId: users.lawFirmId,
        name: users.name,
        email: users.email,
      })
      .from(users)
      .where(and(eq(users.organizationId, organizationId), eq(users.isActive, true)));

    let changes = 0;
    // Users no longer active (or no longer in the organization) lose every link.
    const gone = await tx
      .delete(biProcessAccess)
      .where(
        and(
          eq(biProcessAccess.organizationId, organizationId),
          notInArray(
            biProcessAccess.userId,
            people.map((p) => p.id),
          ),
        ),
      )
      .returning({ userId: biProcessAccess.userId });
    changes += gone.length;

    for (const person of people) {
      const ctx = contextFor(person, org.isDemo);
      const res = (await tx.execute(sql`
        with next as (
          select ${legalProcesses.id} as process_id
          from ${legalProcesses}
          where ${processWhere(ctx)}
          union
          select ${legalProcesses.id}
          from ${legalProcesses}
          cross join (select null::timestamptz as deleted_at) as ${noSoftDelete}
          where ${legalProcesses.deletedAt} is not null
            and ${processWhereIgnoringSoftDelete(ctx)}
            and exists (
              select 1
              from ${portfolioSnapshotItems}
              join ${portfolioSnapshots}
                on ${portfolioSnapshots.id} = ${portfolioSnapshotItems.snapshotId}
               and ${portfolioSnapshots.organizationId} = ${portfolioSnapshotItems.organizationId}
              where ${portfolioSnapshotItems.processId} = ${legalProcesses.id}
                and ${portfolioSnapshots.status} = 'closed'
            )
        ),
        removed as (
          delete from ${biProcessAccess}
          where ${biProcessAccess.organizationId} = ${organizationId}
            and ${biProcessAccess.userId} = ${person.id}
            and ${biProcessAccess.processId} not in (select process_id from next)
          returning 1
        ),
        added as (
          insert into ${biProcessAccess} (organization_id, user_id, user_key, process_id, refreshed_at)
          select ${organizationId}::uuid, ${person.id}::uuid, ${biUserKey(person.id)}, process_id, now()
          from next
          on conflict (user_id, process_id) do nothing
          returning 1
        )
        select (select count(*) from removed)::int as removed, (select count(*) from added)::int as added
      `)) as unknown as { rows: { removed: number | string; added: number | string }[] };
      changes += Number(res.rows[0]?.removed ?? 0) + Number(res.rows[0]?.added ?? 0);
    }

    const [{ n }] = await tx
      .select({ n: count() })
      .from(biProcessAccess)
      .where(eq(biProcessAccess.organizationId, organizationId));
    const refreshedAt = new Date();
    await tx
      .update(biSettings)
      .set({
        accessRefreshedAt: refreshedAt,
        accessUserCount: people.length,
        accessRowCount: Number(n),
        ...(changes > 0 ? { accessChangedAt: refreshedAt } : {}),
      })
      .where(eq(biSettings.organizationId, organizationId));
    return { users: people.length, rows: Number(n), changes, refreshedAt };
  });
}
