import { CalendarCheck, CalendarClock, CalendarX, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { RENEWAL_TYPE_LABELS, type RenewalType } from "@/domain/enums";
import { daysUntil, formatDate, pluralize } from "@/lib/format";
import { cn } from "@/lib/utils";
import { NOTICE_DATE_HINT, NOTICE_DATE_LABEL, vigencyRelativeText, type VigencyState } from "../vigencia";
import { VigencyBadge } from "./vigency-badge";

type Props = {
  startDate: string | null;
  endDate: string | null;
  noticeDeadline: string | null;
  renewalType: RenewalType;
  renewalNoticeDays: number | null;
  vigency: VigencyState;
  daysToEnd: number | null;
  expirationDays: number;
  today: string;
  /** Renewal / termination buttons. */
  actions?: ReactNode;
};

function relativeTo(date: string, today: string, pastLabel: string, futureLabel: (n: number) => string): string {
  const d = daysUntil(date, today);
  if (d === 0) return "hoje";
  if (d > 0) return futureLabel(d);
  return `${pastLabel} há ${pluralize(-d, "dia", "dias", { withCount: true })}`;
}

function Milestone({
  icon,
  label,
  date,
  detail,
  passed,
  highlight,
  emptyLabel = "Não informado",
}: {
  icon: ReactNode;
  label: string;
  date: string | null;
  detail?: string | null;
  passed: boolean;
  highlight?: boolean;
  /** Muted text when there is no date ("Não informado"; "Não calculada" for a derived date). */
  emptyLabel?: string;
}) {
  return (
    <li className="relative flex gap-3 sm:flex-1 sm:flex-col sm:gap-2">
      <span
        aria-hidden="true"
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-full border [&_svg]:size-4",
          highlight
            ? "border-amber-300 bg-amber-50 text-amber-800"
            : passed
              ? "border-slate-200 bg-slate-100 text-slate-500"
              : "border-primary-200 bg-primary-50 text-primary-700",
        )}
      >
        {icon}
      </span>
      <div className="min-w-0">
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</p>
        <p className="text-sm font-semibold text-slate-900 tabular-nums">
          {date ? formatDate(date) : <span className="font-normal text-muted-foreground">{emptyLabel}</span>}
        </p>
        {detail ? <p className={cn("text-xs", highlight ? "font-medium text-amber-800" : "text-muted-foreground")}>{detail}</p> : null}
      </div>
    </li>
  );
}

/** Start → notice deadline → end indicators. Values are arithmetic over the informed dates. */
export function VigencyCard({
  startDate,
  endDate,
  noticeDeadline,
  renewalType,
  renewalNoticeDays,
  vigency,
  daysToEnd,
  expirationDays,
  today,
  actions,
}: Props) {
  const noticeDays = noticeDeadline ? daysUntil(noticeDeadline, today) : null;
  const endRelative = vigencyRelativeText(daysToEnd);

  return (
    <Card>
      <CardHeader actions={<VigencyBadge vigency={vigency} daysToEnd={daysToEnd} />}>
        <CardTitle>Vigência e renovação</CardTitle>
        <CardDescription>
          Datas calculadas a partir das datas informadas no cadastro. Confira sempre o texto do contrato e seus aditivos.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <ol className="flex flex-col gap-4 sm:flex-row sm:gap-6" aria-label="Marcos de vigência">
          <Milestone
            icon={<CalendarCheck />}
            label="Início"
            date={startDate}
            detail={startDate ? relativeTo(startDate, today, "iniciou", (n) => `inicia em ${pluralize(n, "dia", "dias", { withCount: true })}`) : null}
            passed={startDate !== null && daysUntil(startDate, today) <= 0}
          />
          <Milestone
            icon={<CalendarClock />}
            label={NOTICE_DATE_LABEL}
            date={noticeDeadline}
            emptyLabel="Não calculada"
            detail={
              noticeDeadline
                ? `${relativeTo(noticeDeadline, today, "encerrou", (n) => `em ${pluralize(n, "dia", "dias", { withCount: true })}`)} · ${NOTICE_DATE_HINT}`
                : endDate
                  ? "Informe a antecedência de aviso no cadastro para calcular."
                  : null
            }
            passed={noticeDays !== null && noticeDays < 0}
            highlight={noticeDays !== null && noticeDays >= 0 && noticeDays <= expirationDays}
          />
          <Milestone
            icon={<CalendarX />}
            label="Término"
            date={endDate}
            detail={endDate ? endRelative : "Prazo indeterminado"}
            passed={daysToEnd !== null && daysToEnd < 0}
            highlight={vigency === "vencendo"}
          />
        </ol>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-md bg-surface-muted px-3 py-2 text-sm">
          <span className="inline-flex items-center gap-2 text-slate-800">
            <RefreshCw aria-hidden="true" className="size-4 text-muted-foreground" />
            {RENEWAL_TYPE_LABELS[renewalType]}
          </span>
          <span className="text-muted-foreground">
            Antecedência de aviso:{" "}
            <span className="font-medium text-slate-800">
              {renewalNoticeDays !== null ? pluralize(renewalNoticeDays, "dia", "dias", { withCount: true }) : "não informada"}
            </span>
          </span>
          <span className="text-muted-foreground">
            Alerta de vencimento: <span className="font-medium text-slate-800">{expirationDays} dias antes</span>
          </span>
        </div>
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </CardContent>
    </Card>
  );
}
