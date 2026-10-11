import { CalendarClock, CheckCircle2, ChevronLeft, ChevronRight, ListChecks, Sparkles } from "lucide-react";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { DEADLINE_KIND_LABELS, DEADLINE_KINDS, TASK_STATUS_LABELS } from "@/domain/enums";
import { formatDate, formatMonthYear } from "@/lib/format";
import { cn } from "@/lib/utils";
import { buildMonthGrid, WEEKDAY_LABELS, WEEKDAY_SHORT_LABELS } from "../calendar";
import type { CalendarData, CalendarDeadline, CalendarTask } from "../service";
import { DEADLINE_KIND_STYLES } from "./work-badges";

type DayItems = { deadlines: CalendarDeadline[]; tasks: CalendarTask[] };

function groupByDay(data: CalendarData): Map<string, DayItems> {
  const map = new Map<string, DayItems>();
  const get = (date: string) => {
    let v = map.get(date);
    if (!v) {
      v = { deadlines: [], tasks: [] };
      map.set(date, v);
    }
    return v;
  };
  for (const d of data.deadlines) get(d.dueDate).deadlines.push(d);
  for (const t of data.tasks) get(t.dueDate).tasks.push(t);
  return map;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function deadlineHref(d: CalendarDeadline): string {
  return d.isPendingValidation ? `/prazos?aba=validacao&prazo=${d.id}` : `/prazos?aba=prazos&prazo=${d.id}`;
}

function deadlineAccessibleLabel(d: CalendarDeadline): string {
  const parts = [`Prazo ${DEADLINE_KIND_LABELS[d.kind].toLowerCase()}: ${d.title}`];
  if (d.isPendingValidation) parts.push("sugerido pela IA, aguardando validação");
  else if (d.status === "done") parts.push("cumprido");
  else if (d.isOverdue) parts.push("vencido");
  return parts.join(" — ");
}

function DeadlineChip({ d }: { d: CalendarDeadline }) {
  const style = DEADLINE_KIND_STYLES[d.kind];
  return (
    <Link
      href={deadlineHref(d)}
      aria-label={deadlineAccessibleLabel(d)}
      title={deadlineAccessibleLabel(d)}
      className={cn(
        "group flex items-start gap-1.5 rounded border px-1.5 py-1 text-xs leading-tight transition-colors hover:brightness-95",
        "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
        d.isPendingValidation ? "border-dashed border-ai-500 bg-ai-50 text-ai-900" : style.chip,
        d.status === "done" && "opacity-75",
      )}
    >
      {d.isPendingValidation ? (
        <Sparkles aria-hidden="true" className="mt-px size-3 shrink-0 text-ai-600" />
      ) : d.status === "done" ? (
        <CheckCircle2 aria-hidden="true" className="mt-px size-3 shrink-0 text-emerald-700" />
      ) : d.isOverdue ? (
        <span aria-hidden="true" className="mt-1 size-2 shrink-0 rounded-full bg-red-600 ring-2 ring-red-200" />
      ) : (
        <span aria-hidden="true" className={cn("mt-1 size-2 shrink-0 rounded-full", style.bar)} />
      )}
      <span className="min-w-0">
        <span className={cn("line-clamp-2 font-medium", d.status === "done" && "line-through")}>{d.title}</span>
        {d.isPendingValidation ? (
          <span aria-hidden="true" className="block text-[11px] font-normal text-ai-700">
            aguardando validação
          </span>
        ) : d.isOverdue ? (
          <span aria-hidden="true" className="block text-[11px] font-semibold text-red-700">
            vencido
          </span>
        ) : null}
      </span>
    </Link>
  );
}

function TaskChip({ t }: { t: CalendarTask }) {
  const label = `Tarefa: ${t.title} — ${TASK_STATUS_LABELS[t.status].toLowerCase()}${t.isOverdue ? ", atrasada" : ""}`;
  return (
    <Link
      href={`/prazos?aba=tarefas&tarefa=${t.id}`}
      aria-label={label}
      title={label}
      className={cn(
        "flex items-start gap-1.5 rounded border border-slate-200 bg-white px-1.5 py-1 text-xs leading-tight text-slate-800 transition-colors hover:bg-slate-50",
        "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
        t.isOverdue && "border-red-300",
      )}
    >
      <ListChecks aria-hidden="true" className={cn("mt-px size-3 shrink-0", t.isOverdue ? "text-red-600" : "text-slate-500")} />
      <span className={cn("line-clamp-2 min-w-0", t.status === "done" && "line-through opacity-75")}>{t.title}</span>
    </Link>
  );
}

function DayList({ items, date }: { items: DayItems; date: string }) {
  return (
    <ul aria-label={`Itens de ${formatDate(date)}`} className="flex flex-col gap-1">
      {items.deadlines.map((d) => (
        <li key={`d-${d.id}`}>
          <DeadlineChip d={d} />
        </li>
      ))}
      {items.tasks.map((t) => (
        <li key={`t-${t.id}`}>
          <TaskChip t={t} />
        </li>
      ))}
    </ul>
  );
}

export type WorkCalendarProps = {
  data: CalendarData;
  prevHref: string;
  nextHref: string;
  todayHref: string;
};

/** Month grid (Mon–Sun) on md+; agenda list on small screens. Server-rendered. */
export function WorkCalendar({ data, prevHref, nextHref, todayHref }: WorkCalendarProps) {
  const weeks = buildMonthGrid(data.month);
  const byDay = groupByDay(data);
  const monthLabel = capitalize(formatMonthYear(data.month));
  const daysWithItems = [...byDay.keys()].sort();
  const isCurrentMonth = data.today.startsWith(data.month);

  return (
    <section aria-labelledby="calendario-titulo" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="calendario-titulo" className="text-lg font-semibold text-slate-900">
          {monthLabel}
        </h2>
        <nav aria-label="Navegação entre meses" className="flex items-center gap-1.5">
          <Link href={prevHref} className={buttonVariants({ variant: "outline", size: "sm" })}>
            <ChevronLeft aria-hidden="true" />
            <span>Anterior</span>
          </Link>
          <Link
            href={todayHref}
            aria-current={isCurrentMonth ? "date" : undefined}
            className={buttonVariants({ variant: "ghost", size: "sm" })}
          >
            Hoje
          </Link>
          <Link href={nextHref} className={buttonVariants({ variant: "outline", size: "sm" })}>
            <span>Próximo</span>
            <ChevronRight aria-hidden="true" />
          </Link>
        </nav>
      </div>

      {/* Month grid (tablet/desktop) */}
      <div className="hidden overflow-hidden rounded-lg border border-border bg-surface shadow-xs md:block">
        <table className="w-full table-fixed border-collapse text-sm">
          <caption className="sr-only">
            Calendário de prazos e tarefas — {monthLabel}. Prazos sugeridos pela IA aparecem com contorno tracejado e
            só contam como prazo após validação humana.
          </caption>
          <thead className="border-b border-border bg-slate-50">
            <tr>
              {WEEKDAY_LABELS.map((label, i) => (
                <th key={label} scope="col" className="px-2 py-2 text-left text-xs font-semibold text-slate-600">
                  <abbr title={label} className="no-underline">
                    {WEEKDAY_SHORT_LABELS[i]}
                  </abbr>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {weeks.map((week) => (
              <tr key={week[0].date} className="border-b border-border last:border-0">
                {week.map((day) => {
                  const items = day.inMonth ? byDay.get(day.date) : undefined;
                  const isToday = day.date === data.today;
                  return (
                    <td
                      key={day.date}
                      className={cn(
                        "h-28 border-r border-border p-1.5 align-top last:border-r-0",
                        !day.inMonth && "bg-slate-50/70",
                        day.weekday >= 5 && day.inMonth && "bg-slate-50/40",
                      )}
                    >
                      <div className="mb-1 flex items-center justify-between">
                        <time
                          dateTime={day.date}
                          className={cn(
                            "inline-flex size-6 items-center justify-center rounded-full text-xs font-medium tabular-nums",
                            !day.inMonth && "text-slate-400",
                            isToday && "bg-primary text-primary-foreground",
                          )}
                        >
                          {day.day}
                          {isToday ? <span className="sr-only"> (hoje)</span> : null}
                        </time>
                      </div>
                      {items ? <DayList items={items} date={day.date} /> : null}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Agenda (mobile) */}
      <div className="md:hidden">
        {daysWithItems.length === 0 ? (
          <EmptyState
            icon={<CalendarClock />}
            title="Nenhum prazo ou tarefa neste mês"
            description="Use as setas para navegar entre os meses."
          />
        ) : (
          <ol className="flex flex-col gap-3" aria-label={`Agenda de ${monthLabel}`}>
            {daysWithItems.map((date) => {
              const isToday = date === data.today;
              const weekday = WEEKDAY_LABELS[(new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7];
              return (
                <li key={date} className="rounded-lg border border-border bg-surface p-3 shadow-xs">
                  <h3 className="mb-2 text-sm font-semibold text-slate-900">
                    <time dateTime={date}>
                      {weekday}, {formatDate(date)}
                    </time>
                    {isToday ? <span className="ml-2 text-xs font-medium text-primary-700">Hoje</span> : null}
                  </h3>
                  <DayList items={byDay.get(date)!} date={date} />
                </li>
              );
            })}
          </ol>
        )}
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground" aria-label="Legenda do calendário" role="group">
        {DEADLINE_KINDS.map((k) => (
          <span key={k} className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className={cn("size-2 rounded-full", DEADLINE_KIND_STYLES[k].bar)} />
            Prazo {DEADLINE_KIND_LABELS[k].toLowerCase()}
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="size-2 rounded-full bg-red-600 ring-2 ring-red-200" />
          Vencido
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="inline-block h-3 w-4 rounded-sm border border-dashed border-ai-500 bg-ai-50" />
          Sugerido pela IA · aguardando validação
        </span>
        <span className="inline-flex items-center gap-1.5">
          <ListChecks aria-hidden="true" className="size-3.5" />
          Tarefa
        </span>
      </div>
    </section>
  );
}
