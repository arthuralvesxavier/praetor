import { History } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Timeline } from "@/components/ui/timeline";
import type { EntityRef } from "@/domain/entities";
import type { AuthContext } from "@/server/auth/context";
import { actionLabel } from "../history-format";
import { listEntityHistory } from "../service";
import { ChangeList } from "./change-list";

export type EntityHistoryProps = {
  ctx: AuthContext;
  entity: EntityRef;
  title?: string;
  description?: string;
};

/**
 * Change history of a record (server component), built from the audit trail:
 * who did what and when, with field diffs "campo: de → para". Shows nothing
 * beyond an empty state when the record is not visible to the user.
 */
export async function EntityHistory({
  ctx,
  entity,
  title = "Histórico de alterações",
  description = "Registro das ações realizadas neste item, da mais recente para a mais antiga.",
}: EntityHistoryProps) {
  const entries = await listEntityHistory(ctx, entity);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <History aria-hidden="true" className="size-4 text-muted-foreground" />
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <Timeline
          emptyMessage="Nenhuma alteração registrada para este item."
          items={entries.map((e) => ({
            id: e.id,
            date: e.createdAt,
            title: actionLabel(e.action),
            description: (
              <>
                <p>{e.summary}</p>
                <ChangeList changes={e.changes} entityType={entity.type} names={e.refNames} />
              </>
            ),
            meta: `Por ${e.actorName ?? "Sistema"}`,
          }))}
        />
        {entries.length === 100 ? (
          <p className="mt-4 text-xs text-muted-foreground">Exibindo as 100 ações mais recentes.</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
