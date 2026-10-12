import { AlertOctagon, AlertTriangle, ArrowRight, BellOff, CheckCircle2, Info } from "lucide-react";
import Link from "next/link";
import { ALERT_SEVERITY_LABELS, ALERT_TYPE_LABELS, type AlertSeverity } from "@/domain/enums";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { formatDateTime } from "@/lib/format";
import { ALERT_SEVERITY_TONES, TONE_CLASSES } from "@/lib/tones";
import { cn } from "@/lib/utils";
import type { AuthContext } from "@/server/auth/context";
import { can } from "@/server/auth/permissions";
import { listAlerts, type AlertItem } from "../service";
import { ResolveAlertButton } from "./resolve-alert-button";

const SEVERITY_ICONS: Record<AlertSeverity, typeof Info> = {
  critical: AlertOctagon,
  warning: AlertTriangle,
  info: Info,
};

/** "agora mesmo" / "há 5 minutos" / "há 3 horas" / "há 2 dias" (server-rendered). */
export function relativeTime(date: Date, now: Date = new Date()): string {
  const diffMin = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 60_000));
  if (diffMin < 1) return "agora mesmo";
  if (diffMin < 60) return diffMin === 1 ? "há 1 minuto" : `há ${diffMin} minutos`;
  const hours = Math.floor(diffMin / 60);
  if (hours < 24) return hours === 1 ? "há 1 hora" : `há ${hours} horas`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "há 1 dia" : `há ${days} dias`;
}

/** Rows of alerts (most severe first as given), with "Abrir" and "Resolver" when allowed. */
export function AlertRows({
  items,
  canResolve,
  label,
  showOpenLink = false,
}: {
  items: AlertItem[];
  canResolve: boolean;
  label: string;
  /** Explicit "Abrir" link next to the actions (alerts center). */
  showOpenLink?: boolean;
}) {
  const now = new Date();
  return (
    <ul className="divide-y divide-border" aria-label={label}>
      {items.map((a) => {
        const Icon = SEVERITY_ICONS[a.severity];
        const tone = ALERT_SEVERITY_TONES[a.severity];
        return (
          <li key={a.id} className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-start">
            <span
              aria-hidden="true"
              className={cn("inline-flex size-8 shrink-0 items-center justify-center rounded-full [&_svg]:size-4", TONE_CLASSES[tone].icon)}
            >
              <Icon />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={tone}>{ALERT_SEVERITY_LABELS[a.severity]}</Badge>
                <span className="text-xs text-muted-foreground">{ALERT_TYPE_LABELS[a.type]}</span>
              </div>
              <p className="text-sm font-medium break-words text-slate-900">
                {a.href ? (
                  <Link href={a.href} className="hover:underline focus-visible:underline">
                    {a.title}
                  </Link>
                ) : (
                  a.title
                )}
              </p>
              <p className="text-sm break-words text-muted-foreground">{a.message}</p>
              <p className="text-xs text-muted-foreground">
                <time dateTime={a.createdAt.toISOString()} title={formatDateTime(a.createdAt)}>
                  Criado {relativeTime(a.createdAt, now)}
                </time>
                {a.resolvedAt ? (
                  <span className="ml-2 inline-flex items-center gap-1">
                    <CheckCircle2 aria-hidden="true" className="size-3.5" /> Resolvido em {formatDateTime(a.resolvedAt)}
                    {a.resolvedByName ? ` por ${a.resolvedByName}` : " (automaticamente, condição encerrada)"}
                  </span>
                ) : null}
              </p>
            </div>
            {(showOpenLink && a.href) || (canResolve && !a.resolvedAt) ? (
              <div className="flex shrink-0 flex-wrap items-start gap-2 sm:flex-col sm:items-end sm:self-center">
                {showOpenLink && a.href ? (
                  <Link
                    href={a.href}
                    className="inline-flex items-center gap-1 rounded-md text-sm font-medium text-primary-700 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    aria-label={`Abrir registro do alerta: ${a.title}`}
                  >
                    Abrir
                    <ArrowRight aria-hidden="true" className="size-3.5" />
                  </Link>
                ) : null}
                {canResolve && !a.resolvedAt ? <ResolveAlertButton alertId={a.id} alertTitle={a.title} /> : null}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

export type AlertListProps = {
  ctx: AuthContext;
  /** Max alerts shown (default 20). */
  limit?: number;
  /** Only open alerts (default true). */
  openOnly?: boolean;
  /** Card title (default "Alertas"). */
  title?: string;
  /** Render without the surrounding card. */
  bare?: boolean;
  /** Pre-loaded alerts (skips the query). They must come from listAlerts(ctx, ...). */
  items?: AlertItem[];
  className?: string;
};

/** Preventive alerts visible to the user, most severe first, with a "Resolver" action when allowed. */
export async function AlertList({ ctx, limit = 20, openOnly = true, title = "Alertas", bare = false, items, className }: AlertListProps) {
  const alerts = items ?? (await listAlerts(ctx, { openOnly, limit }));
  const canResolve = can(ctx, "alert:resolve");

  const list = alerts.length ? (
    <AlertRows items={alerts} canResolve={canResolve} label={title} />
  ) : (
    <EmptyState
      icon={<BellOff />}
      title={openOnly ? "Nenhum alerta em aberto" : "Nenhum alerta"}
      description="Alertas de prazos, audiências, valores, contratos e análises aparecerão aqui quando houver algo que exija atenção."
    />
  );

  if (bare) return <div className={className}>{list}</div>;
  return (
    <Card className={className}>
      <CardHeader
        actions={
          <Link
            href="/alertas"
            className="inline-flex items-center gap-1 text-sm font-medium text-primary-700 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            Ver todos
            <ArrowRight aria-hidden="true" className="size-3.5" />
          </Link>
        }
      >
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>{list}</CardContent>
    </Card>
  );
}
