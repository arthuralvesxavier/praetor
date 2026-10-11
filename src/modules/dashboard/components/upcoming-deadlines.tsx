import { CalendarClock } from "lucide-react";
import Link from "next/link";
import { ButtonLink } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { OriginBadge } from "@/components/ui/origin-badge";
import { ENTITY_TYPE_LABELS } from "@/domain/enums";
import { daysUntil, formatDate, formatNumber, formatRelativeDays, pluralize } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { DashboardData } from "../service";

export function UpcomingDeadlines({
  deadlines,
  today,
  upcomingDays,
}: {
  deadlines: DashboardData["deadlines"];
  today: string;
  upcomingDays: number;
}) {
  return (
    <Card>
      <CardHeader
        actions={
          <ButtonLink href="/prazos?aba=prazos&situacao=proximos" variant="outline" size="sm">
            Ver prazos
          </ButtonLink>
        }
      >
        <CardTitle>Próximos prazos</CardTitle>
        <CardDescription>
          Prazos em aberto a partir de hoje. Sugestões da IA só aparecem depois de validadas por uma pessoa.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {deadlines.pendingValidation > 0 ? (
          <Callout tone="ai" title="Prazos sugeridos pela IA aguardando validação">
            {pluralize(deadlines.pendingValidation, "prazo sugerido", "prazos sugeridos")} não{" "}
            {deadlines.pendingValidation === 1 ? "entra" : "entram"} nas contagens deste painel até a validação humana.{" "}
            <Link href="/prazos?aba=validacao">Revisar sugestões</Link>
          </Callout>
        ) : null}
        {deadlines.next.length === 0 ? (
          <EmptyState
            icon={<CalendarClock />}
            title="Nenhum prazo futuro em aberto"
            description={`Não há prazos cadastrados ou validados a partir de hoje. Os próximos ${upcomingDays} dias contam como janela de atenção.`}
          />
        ) : (
          <ol className="divide-y divide-border" aria-label="Próximos prazos em ordem de vencimento">
            {deadlines.next.map((d) => {
              const diff = daysUntil(d.dueDate, today);
              const urgent = diff <= upcomingDays;
              return (
                <li key={d.id} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:gap-4">
                  <div className="flex shrink-0 flex-row items-baseline gap-2 sm:w-28 sm:flex-col sm:gap-0">
                    <time dateTime={d.dueDate} className="text-sm font-semibold text-slate-900 tabular-nums">
                      {formatDate(d.dueDate)}
                    </time>
                    <span className={cn("text-xs", urgent ? "font-medium text-amber-800" : "text-muted-foreground")}>
                      {formatRelativeDays(d.dueDate, today)}
                    </span>
                  </div>
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="text-sm font-medium text-slate-900 break-words">
                      <Link href={d.href} className="hover:underline underline-offset-2">
                        {d.title}
                      </Link>
                    </p>
                    <p className="text-xs text-muted-foreground break-words">
                      {d.linked ? (
                        <>
                          {ENTITY_TYPE_LABELS[d.linked.type]}:{" "}
                          <Link href={d.linked.href} className="text-primary-700 hover:underline underline-offset-2">
                            {d.linked.label}
                          </Link>
                          {" · "}
                        </>
                      ) : null}
                      Responsável: {d.responsibleName ?? "não definido"}
                    </p>
                  </div>
                  <div className="shrink-0">
                    <OriginBadge origin={d.origin} validationStatus={d.validationStatus} />
                  </div>
                </li>
              );
            })}
          </ol>
        )}
        {deadlines.next.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            {formatNumber(deadlines.upcoming)} {deadlines.upcoming === 1 ? "prazo vence" : "prazos vencem"} nos próximos{" "}
            {upcomingDays} dias.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
