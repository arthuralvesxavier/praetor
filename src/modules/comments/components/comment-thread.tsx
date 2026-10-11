import { MessageSquare, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { UserAvatar } from "@/components/ui/user-avatar";
import type { EntityRef } from "@/domain/entities";
import { formatDateTime, formatNumber } from "@/lib/format";
import type { AuthContext } from "@/server/auth/context";
import { deleteCommentAction } from "../actions";
import { canComment, COMMENT_MAX_LENGTH, listComments } from "../service";
import { CommentForm } from "./comment-form";

/** "agora", "há 5 minutos", "há 3 horas", "ontem", "há 4 dias", then the date. */
export function formatRelativeTime(date: Date, now: Date = new Date()): string {
  const diffSec = Math.max(0, Math.round((now.getTime() - date.getTime()) / 1000));
  if (diffSec < 60) return "agora";
  const min = Math.floor(diffSec / 60);
  if (min < 60) return min === 1 ? "há 1 minuto" : `há ${min} minutos`;
  const h = Math.floor(min / 60);
  if (h < 24) return h === 1 ? "há 1 hora" : `há ${h} horas`;
  const d = Math.floor(h / 24);
  if (d === 1) return "ontem";
  if (d < 30) return `há ${d} dias`;
  return `em ${formatDateTime(date)}`;
}

export type CommentThreadProps = {
  ctx: AuthContext;
  entity: EntityRef;
  title?: string;
  /** Render without the surrounding Card (e.g. inside another card). */
  bare?: boolean;
};

/**
 * Comments of a record (server component): list + form when the user can
 * comment. Bodies are plain text rendered with whitespace preserved — never HTML.
 * The parent page must already have checked that the entity is visible;
 * listComments re-checks it (NotFoundError otherwise).
 */
export async function CommentThread({ ctx, entity, title = "Comentários", bare = false }: CommentThreadProps) {
  const comments = await listComments(ctx, entity);
  const allowed = canComment(ctx);
  const headingId = `comentarios-${entity.type}-${entity.id}`;

  const body = (
    <div className="flex flex-col gap-4">
      {comments.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nenhum comentário ainda.</p>
      ) : (
        <ol className="flex flex-col gap-4" aria-labelledby={headingId}>
          {comments.map((c) => (
            <li key={c.id} className="flex gap-3">
              <UserAvatar name={c.authorName} size="md" />
              <article className="min-w-0 flex-1" aria-label={`Comentário de ${c.authorName}`}>
                <header className="flex flex-wrap items-baseline justify-between gap-x-2">
                  <p className="text-sm">
                    <span className="font-semibold text-slate-900">{c.authorName}</span>{" "}
                    <time
                      dateTime={c.createdAt.toISOString()}
                      title={formatDateTime(c.createdAt)}
                      className="text-xs text-muted-foreground"
                    >
                      {formatRelativeTime(c.createdAt)}
                    </time>
                  </p>
                  {c.canDelete && allowed ? (
                    <ConfirmDialog
                      action={deleteCommentAction}
                      hiddenFields={{ commentId: c.id }}
                      title="Excluir comentário?"
                      description="O comentário deixará de ser exibido. A exclusão fica registrada na auditoria."
                      confirmLabel="Excluir"
                      trigger={
                        <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs text-slate-500">
                          <Trash2 aria-hidden="true" />
                          Excluir
                        </Button>
                      }
                    />
                  ) : null}
                </header>
                <p className="mt-1 text-sm break-words whitespace-pre-wrap text-slate-800">{c.body}</p>
              </article>
            </li>
          ))}
        </ol>
      )}
      {allowed ? <CommentForm entityType={entity.type} entityId={entity.id} maxLength={COMMENT_MAX_LENGTH} /> : null}
    </div>
  );

  if (bare) {
    return (
      <section aria-labelledby={headingId} className="flex flex-col gap-3">
        <h3 id={headingId} className="flex items-center gap-2 text-sm font-semibold text-slate-900">
          <MessageSquare aria-hidden="true" className="size-4 text-slate-500" />
          {title}
          {comments.length > 0 ? <span className="font-normal text-muted-foreground">({formatNumber(comments.length)})</span> : null}
        </h3>
        {body}
      </section>
    );
  }

  return (
    <Card aria-labelledby={headingId}>
      <CardHeader>
        <CardTitle id={headingId} className="flex items-center gap-2">
          <MessageSquare aria-hidden="true" className="size-4 text-slate-500" />
          {title}
          {comments.length > 0 ? <span className="font-normal text-muted-foreground">({formatNumber(comments.length)})</span> : null}
        </CardTitle>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}
