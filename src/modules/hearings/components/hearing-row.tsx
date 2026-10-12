import { ExternalLink, MapPin, UserRound } from "lucide-react";
import Link from "next/link";
import { HEARING_KIND_LABELS, HEARING_STATUS_LABELS } from "@/domain/enums";
import { formatDate, formatDateTime, toISODate } from "@/lib/format";
import type { Option } from "@/lib/options";
import { cn } from "@/lib/utils";
import type { HearingListItem } from "../service";
import { formatTime, zonedDateAndTime } from "../time";
import { HearingKindBadge, HearingModeBadge, HearingOriginBadge, HearingStatusBadge } from "./hearing-badges";
import { HearingFormDialog } from "./hearing-form-dialog";
import { HearingStatusDialog } from "./hearing-status-dialog";

const MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"] as const;

/** "Instrução em 12/11/2026 às 14:00". */
export function hearingLabel(h: Pick<HearingListItem, "kind" | "scheduledAt">): string {
  return `${HEARING_KIND_LABELS[h.kind]} em ${formatDate(h.scheduledAt)} às ${formatTime(h.scheduledAt)}`;
}

/** Navy date tile (day / month / time) shown on the left of each hearing. */
export function HearingDateTile({ at, muted = false }: { at: Date; muted?: boolean }) {
  const iso = toISODate(at);
  const day = iso.slice(8, 10);
  const month = MONTHS[Number(iso.slice(5, 7)) - 1];
  return (
    <div
      className={cn(
        "flex w-16 shrink-0 flex-col items-center justify-center rounded-md border py-1.5 text-center leading-tight",
        muted ? "border-border bg-surface-muted text-slate-600" : "border-primary-200 bg-primary-50 text-primary-900",
      )}
      aria-hidden="true"
    >
      <span className="text-lg font-semibold tabular-nums">{day}</span>
      <span className="text-[11px] font-medium uppercase">{month}</span>
      <span className="mt-0.5 text-xs font-semibold tabular-nums">{formatTime(at)}</span>
    </div>
  );
}

export function HearingWhere({ item }: { item: Pick<HearingListItem, "location" | "meetingUrl" | "status"> }) {
  if (!item.location && !item.meetingUrl) {
    return <span className="text-muted-foreground">Local ou link não informado</span>;
  }
  return (
    <span className="flex flex-col gap-0.5">
      {item.location ? (
        <span className="inline-flex items-start gap-1">
          <MapPin aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-slate-500" />
          <span className="break-words">{item.location}</span>
        </span>
      ) : null}
      {item.meetingUrl && item.status === "scheduled" ? (
        <a
          href={item.meetingUrl}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="inline-flex items-center gap-1 font-medium text-primary-700 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
        >
          Abrir sala virtual
          <ExternalLink aria-hidden="true" className="size-3.5" />
          <span className="sr-only">(abre em nova aba)</span>
        </a>
      ) : null}
    </span>
  );
}

const OUTCOME_LABELS = {
  held: "Resultado",
  cancelled: "Motivo do cancelamento",
  rescheduled: "Motivo da redesignação",
  scheduled: "Registro",
} as const;

/**
 * One hearing: date tile, badges, process (optional), place, responsible,
 * notes/outcome and — for scheduled hearings the user can manage — the
 * edit / result / reschedule / cancel actions.
 */
export function HearingRow({
  item,
  users,
  today,
  showProcess = false,
}: {
  item: HearingListItem;
  /** Responsible options (only needed when the user can manage the hearing). */
  users: Option[];
  today: string;
  showProcess?: boolean;
}) {
  const label = hearingLabel(item);
  const inactive = item.status === "cancelled" || item.status === "rescheduled";
  const notYet = toISODate(item.scheduledAt) > today;
  const values = zonedDateAndTime(item.scheduledAt);
  const current = { mode: item.mode, location: item.location, meetingUrl: item.meetingUrl };
  return (
    <article
      aria-label={`${label} — ${HEARING_STATUS_LABELS[item.status]}`}
      className="flex flex-col gap-3 sm:flex-row sm:items-start"
    >
      <HearingDateTile at={item.scheduledAt} muted={inactive || item.status === "held"} />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <HearingKindBadge kind={item.kind} />
          <HearingModeBadge mode={item.mode} />
          <HearingStatusBadge status={item.status} awaitingRecord={item.awaitingRecord} />
          {item.origin !== "manual" ? <HearingOriginBadge origin={item.origin} /> : null}
        </div>
        <p className="text-sm text-slate-900">
          <time dateTime={item.scheduledAt.toISOString()} className={cn("font-medium", inactive && "line-through")}>
            {formatDateTime(item.scheduledAt)}
          </time>
          {showProcess ? (
            <>
              <span className="text-muted-foreground"> · </span>
              <Link
                href={`/processos/${item.processId}?aba=audiencias`}
                className="font-medium text-primary-700 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
              >
                <span className="font-mono">{item.processNumber}</span>
              </Link>
              <span className="text-muted-foreground"> — {item.processTitle}</span>
            </>
          ) : null}
        </p>
        {showProcess ? <p className="text-xs text-muted-foreground">{item.processCourt}</p> : null}
        <div className="grid gap-1 text-sm sm:grid-cols-2">
          <HearingWhere item={item} />
          <span className="inline-flex items-start gap-1 text-slate-700">
            <UserRound aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-slate-500" />
            <span>
              <span className="sr-only">Responsável: </span>
              {item.responsibleName ?? <span className="text-muted-foreground">Sem responsável</span>}
            </span>
          </span>
        </div>
        {item.outcome ? (
          <p className="rounded-md border border-border bg-surface-muted px-3 py-2 text-sm whitespace-pre-wrap text-slate-800">
            <span className="block text-xs font-medium text-muted-foreground">{OUTCOME_LABELS[item.status]}</span>
            {item.outcome}
          </p>
        ) : null}
        {item.notes ? (
          <p className="text-sm whitespace-pre-wrap text-muted-foreground">
            <span className="font-medium text-slate-700">Observações: </span>
            {item.notes}
          </p>
        ) : null}
        {item.awaitingRecord ? (
          <p className="text-xs font-medium text-orange-800">
            A data já passou e o resultado ainda não foi registrado.
          </p>
        ) : null}
      </div>
      {item.canManage ? (
        <div className="flex shrink-0 flex-wrap gap-1.5 sm:max-w-56 sm:flex-col sm:items-stretch">
          <HearingStatusDialog
            hearingId={item.id}
            hearingLabel={label}
            target="held"
            current={current}
            disabled={notYet}
            disabledReason="Disponível a partir da data da audiência"
          />
          <HearingStatusDialog hearingId={item.id} hearingLabel={label} target="rescheduled" current={current} />
          <HearingFormDialog
            users={users}
            triggerLabel={`Editar ${label}`}
            hearing={{
              id: item.id,
              kind: item.kind,
              mode: item.mode,
              date: values.date,
              time: values.time,
              location: item.location,
              meetingUrl: item.meetingUrl,
              responsibleId: item.responsibleId,
              notes: item.notes,
            }}
          />
          <HearingStatusDialog hearingId={item.id} hearingLabel={label} target="cancelled" current={current} />
        </div>
      ) : null}
    </article>
  );
}
