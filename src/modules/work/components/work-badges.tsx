import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  DEADLINE_KIND_LABELS,
  ENTITY_TYPE_LABELS,
  TASK_STATUS_LABELS,
  type DeadlineKind,
  type DeadlineStatus,
  type TaskStatus,
  type ValidationStatus,
} from "@/domain/enums";
import { TASK_STATUS_TONES, type Tone } from "@/lib/tones";
import { cn } from "@/lib/utils";
import type { WorkLink } from "../service";

/** Visual identity of each deadline kind (badge tone + calendar chip classes). */
export const DEADLINE_KIND_STYLES: Record<DeadlineKind, { tone: Tone; chip: string; bar: string }> = {
  procedural: { tone: "primary", chip: "border-primary-200 bg-primary-50 text-primary-900", bar: "bg-primary-600" },
  contractual: { tone: "info", chip: "border-sky-200 bg-sky-50 text-sky-900", bar: "bg-sky-600" },
  regulatory: { tone: "warning", chip: "border-amber-200 bg-amber-50 text-amber-900", bar: "bg-amber-500" },
  internal: { tone: "neutral", chip: "border-slate-200 bg-slate-50 text-slate-800", bar: "bg-slate-500" },
};

export function DeadlineKindBadge({ kind }: { kind: DeadlineKind }) {
  return (
    <Badge tone={DEADLINE_KIND_STYLES[kind].tone} dot>
      {DEADLINE_KIND_LABELS[kind]}
    </Badge>
  );
}

export function deadlineSituation(d: {
  status: DeadlineStatus;
  validationStatus: ValidationStatus;
  isOverdue: boolean;
}): { label: string; tone: Tone } {
  if (d.validationStatus === "pending_validation") return { label: "Aguardando validação", tone: "ai" };
  if (d.validationStatus === "rejected") return { label: "Sugestão rejeitada", tone: "neutral" };
  if (d.status === "done") return { label: "Cumprido", tone: "success" };
  if (d.status === "cancelled") return { label: "Cancelado", tone: "neutral" };
  if (d.isOverdue) return { label: "Vencido", tone: "danger" };
  return { label: "Em aberto", tone: "info" };
}

export function DeadlineSituationBadge(props: { status: DeadlineStatus; validationStatus: ValidationStatus; isOverdue: boolean }) {
  const s = deadlineSituation(props);
  return <StatusBadge label={s.label} tone={s.tone} />;
}

export function TaskStatusBadge({ status, isOverdue }: { status: TaskStatus; isOverdue?: boolean }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <StatusBadge label={TASK_STATUS_LABELS[status]} tone={TASK_STATUS_TONES[status]} />
      {isOverdue ? <StatusBadge label="Atrasada" tone="danger" /> : null}
    </span>
  );
}

/** Linked records. Records the user cannot see are shown without title or link. */
export function WorkLinks({ links, className }: { links: WorkLink[]; className?: string }) {
  if (links.length === 0) return <span className={cn("text-muted-foreground", className)}>Sem vínculo</span>;
  return (
    <ul className={cn("flex flex-col gap-0.5", className)}>
      {links.map((l) => (
        <li key={`${l.type}-${l.id}`} className="min-w-0">
          <span className="text-xs text-muted-foreground">{ENTITY_TYPE_LABELS[l.type]}: </span>
          {l.href && l.label ? (
            <Link
              href={l.href}
              className="font-medium text-primary-700 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
            >
              {l.label}
            </Link>
          ) : (
            <span className="text-muted-foreground italic">registro sem acesso</span>
          )}
        </li>
      ))}
    </ul>
  );
}
