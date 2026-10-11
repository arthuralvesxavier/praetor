import { History } from "lucide-react";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { UserAvatar } from "@/components/ui/user-avatar";
import { ENTITY_TYPE_LABELS } from "@/domain/enums";
import { formatDateTime } from "@/lib/format";
import { formatRelativeTime } from "../format";
import type { ActivityItem } from "../service";

export function ActivityFeed({ items, now }: { items: ActivityItem[]; now: Date }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Atividades recentes</CardTitle>
        <CardDescription>Últimas alterações em registros que você pode acessar.</CardDescription>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <EmptyState icon={<History />} title="Nenhuma atividade recente" description="As alterações em processos, ocorrências, contratos, documentos e prazos aparecerão aqui." />
        ) : (
          <ol className="divide-y divide-border" aria-label="Atividades recentes">
            {items.map((a) => (
              <li key={a.id} className="flex gap-3 py-3 first:pt-0 last:pb-0">
                <UserAvatar name={a.actorName ?? "Sistema"} size="sm" className="mt-0.5" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-slate-800 break-words">
                    <span className="font-medium text-slate-900">{a.actorName ?? "Sistema"}</span>
                    <span className="text-muted-foreground"> · </span>
                    {a.summary}
                  </p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                    <time dateTime={a.createdAt.toISOString()} title={formatDateTime(a.createdAt)}>
                      {formatRelativeTime(a.createdAt, now)}
                    </time>
                    {a.entityHref ? (
                      <>
                        <span aria-hidden="true">·</span>
                        <Link href={a.entityHref} className="text-primary-700 hover:underline underline-offset-2">
                          Abrir {ENTITY_TYPE_LABELS[a.entityType].toLowerCase()}
                        </Link>
                      </>
                    ) : null}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
