import { AlertTriangle, Bell, Mail } from "lucide-react";
import Link from "next/link";
import { AiModeBadge } from "@/components/ui/ai-mode-badge";
import { Badge } from "@/components/ui/badge";
import type { AiMode } from "@/domain/enums";
import { cn } from "@/lib/utils";
import { alertsBellLabel, formatBadgeCount } from "./shell-format";

const iconButton =
  "relative inline-flex size-9 shrink-0 items-center justify-center rounded-md text-slate-700 transition-colors hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/**
 * Bell linking to /alertas. Counts come from countOpenAlerts(ctx) (row-scoped).
 * Critical alerts are signalled by color AND shape (warning icon) AND text
 * ("N críticos" from xl, plus the accessible name on every size).
 */
export function AlertsBell({ counts }: { counts: { total: number; critical: number } }) {
  const label = alertsBellLabel(counts);
  const hasCritical = counts.critical > 0;
  return (
    <span className="inline-flex items-center gap-1.5">
      <Link href="/alertas" aria-label={label} title={label} className={iconButton}>
        <Bell aria-hidden="true" className="size-5" />
        {counts.total > 0 ? (
          <span
            aria-hidden="true"
            className={cn(
              "absolute -top-0.5 -right-0.5 inline-flex h-[18px] min-w-[18px] items-center justify-center gap-0.5 rounded-full px-1 text-[10px] leading-none font-semibold tabular-nums ring-2 ring-white",
              hasCritical ? "bg-red-700 text-white" : "bg-primary text-white",
            )}
          >
            {hasCritical ? <AlertTriangle className="size-2.5" /> : null}
            {formatBadgeCount(counts.total)}
          </span>
        ) : null}
      </Link>
      {hasCritical ? (
        <Link
          href="/alertas?severidade=critical"
          className="hidden rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring xl:inline-flex"
        >
          <Badge tone="danger" icon={<AlertTriangle />}>
            {counts.critical === 1 ? "1 crítico" : `${formatBadgeCount(counts.critical)} críticos`}
          </Badge>
          <span className="sr-only"> — ver alertas críticos</span>
        </Link>
      ) : null}
    </span>
  );
}

/** Compact "E-mail simulado" badge linking to the e-mail center (users with email:read). */
export function SimulatedEmailBadge({ mode, className }: { mode: "simulated" | "live"; className?: string }) {
  const simulated = mode === "simulated";
  const title = simulated
    ? "Envio simulado — nenhuma mensagem é enviada. Abrir a Central de e-mails."
    : "Abrir a Central de e-mails.";
  return (
    <Link
      href="/emails"
      title={title}
      className={cn(
        "items-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        className,
      )}
    >
      <Badge tone={simulated ? "warning" : "neutral"} icon={<Mail />}>
        {simulated ? "E-mail simulado" : "E-mail"}
      </Badge>
      <span className="sr-only">
        {simulated ? " (nenhuma mensagem é enviada) — abrir a Central de e-mails" : " — abrir a Central de e-mails"}
      </span>
    </Link>
  );
}

/** AI mode badge; links to the AI center when the user can read analyses. */
export function AiModeIndicator({ mode, linked, className }: { mode: AiMode; linked: boolean; className?: string }) {
  if (!linked) return <AiModeBadge mode={mode} className={className} />;
  return (
    <Link
      href="/ia"
      title="Abrir a Central de IA"
      className={cn(
        "items-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        className,
      )}
    >
      <AiModeBadge mode={mode} />
      <span className="sr-only"> — abrir a Central de IA</span>
    </Link>
  );
}
