import { formatNumber, formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ActionPlanProgress } from "../service";

/** Progress bar + counters for the occurrence's action plan (tasks of kind `action_plan`). */
export function ActionPlanSummary({ progress }: { progress: ActionPlanProgress }) {
  const { total, done, inProgress, blocked, overdue } = progress;
  const ratio = total > 0 ? done / total : 0;
  const items = [
    { label: "Concluídas", value: done, className: "text-emerald-800" },
    { label: "Em andamento", value: inProgress, className: "text-slate-900" },
    { label: "Bloqueadas", value: blocked, className: blocked > 0 ? "text-amber-800" : "text-slate-900" },
    { label: "Atrasadas", value: overdue, className: overdue > 0 ? "text-red-700" : "text-slate-900" },
  ];

  return (
    <section aria-labelledby="action-plan-progress" className="rounded-lg border border-border bg-surface p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="action-plan-progress" className="text-sm font-semibold text-slate-900">
          Progresso do plano de ação
        </h2>
        <p className="text-sm text-muted-foreground">
          {total === 0
            ? "Nenhuma ação cadastrada ainda."
            : `${formatNumber(done)} de ${formatNumber(total)} ações concluídas (${formatPercent(ratio)})`}
        </p>
      </div>
      <div
        className="mt-3 h-2 w-full overflow-hidden rounded-full bg-slate-100"
        role="progressbar"
        aria-label="Ações concluídas"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        aria-valuetext={total === 0 ? "Sem ações" : `${done} de ${total} concluídas`}
      >
        <div className="h-full rounded-full bg-emerald-600 transition-[width]" style={{ width: `${Math.round(ratio * 100)}%` }} />
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {items.map((item) => (
          <div key={item.label}>
            <dt className="text-xs text-muted-foreground">{item.label}</dt>
            <dd className={cn("text-lg font-semibold tabular-nums", item.className)}>{formatNumber(item.value)}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-xs text-muted-foreground">Ações canceladas não entram na contagem.</p>
    </section>
  );
}
