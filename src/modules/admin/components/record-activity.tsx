import { ButtonLink } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Timeline } from "@/components/ui/timeline";
import type { EntityType } from "@/domain/enums";
import type { AuthContext } from "@/server/auth/context";
import { can } from "@/server/auth/permissions";
import { actionLabel } from "../history-format";
import { listAuditLogs } from "../service";
import { ChangeList } from "./change-list";

/**
 * Latest audit entries about an administrative record (user, team, unit, company, law firm).
 * Rendered only for users with `audit:read`.
 */
export async function RecordActivity({
  ctx,
  entityType,
  entityId,
}: {
  ctx: AuthContext;
  entityType: Extract<EntityType, "user" | "team" | "unit" | "company" | "law_firm">;
  entityId: string;
}) {
  if (!can(ctx, "audit:read")) return null;
  const { items, total } = await listAuditLogs(ctx, { entityType, entityId, pageSize: 10 });
  return (
    <Card>
      <CardHeader
        actions={
          total > items.length ? (
            <ButtonLink href={`/admin/auditoria?entidade=${entityType}`} variant="outline" size="sm">
              Ver auditoria
            </ButtonLink>
          ) : null
        }
      >
        <CardTitle>Histórico de alterações</CardTitle>
        <CardDescription>Ações mais recentes registradas na trilha de auditoria.</CardDescription>
      </CardHeader>
      <CardContent>
        <Timeline
          emptyMessage="Nenhuma ação registrada."
          items={items.map((e) => ({
            id: e.id,
            date: e.createdAt,
            title: actionLabel(e.action),
            description: (
              <>
                <p>{e.summary}</p>
                <ChangeList changes={e.changes} entityType={e.entityType} names={e.refNames} />
              </>
            ),
            meta: `Por ${e.actorName ?? "Sistema"}`,
          }))}
        />
      </CardContent>
    </Card>
  );
}
