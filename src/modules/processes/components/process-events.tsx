import { Landmark, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { OriginBadge } from "@/components/ui/origin-badge";
import { Timeline, type TimelineItem } from "@/components/ui/timeline";
import { PROCESS_EVENT_TYPE_LABELS, PROCESS_INSTANCE_LABELS } from "@/domain/enums";
import { formatDateTime, formatNumber, pluralize, todayISO } from "@/lib/format";
import { DATAJUD_SOURCE_LABEL } from "@/modules/court-sync/mapping";
import { addProcessEventAction, removeProcessEventAction } from "../actions";
import type { ProcessDetail, ProcessEventItem } from "../service";
import { PROCESS_SECTION_IDS } from "../tabs";
import { eventsByInstance, isDataJudEvent as isDataJud } from "../timeline";
import { EventForm } from "./event-form";

/** Movements listed before the "ver mais" disclosure. */
export const TIMELINE_VISIBLE_EVENTS = 30;

function sourceLine(e: ProcessEventItem): string {
  if (isDataJud(e)) return `Coletada do ${DATAJUD_SOURCE_LABEL} em ${formatDateTime(e.createdAt)}`;
  if (e.origin === "imported") return `Importada${e.externalSource ? ` de ${e.externalSource}` : ""} em ${formatDateTime(e.createdAt)}`;
  return `Registrada${e.createdByName ? ` por ${e.createdByName}` : ""} em ${formatDateTime(e.createdAt)}`;
}

function toItem(e: ProcessEventItem): TimelineItem {
  return {
    id: e.id,
    date: e.occurredAt,
    title: e.title,
    description: e.description,
    badge: (
      <>
        {e.instance ? (
          <Badge tone="info">{PROCESS_INSTANCE_LABELS[e.instance]}</Badge>
        ) : (
          <Badge tone="neutral" className="text-muted-foreground">
            Instância não informada
          </Badge>
        )}
        <Badge tone="neutral">{PROCESS_EVENT_TYPE_LABELS[e.type]}</Badge>
        {isDataJud(e) ? (
          <Badge tone="primary" icon={<Landmark />} title="Movimentação coletada automaticamente do DataJud (CNJ)">
            DataJud (CNJ)
          </Badge>
        ) : (
          <OriginBadge origin={e.origin} />
        )}
        {e.cnjMovementCode !== null ? (
          <Badge tone="neutral" title="Código da tabela de movimentos do CNJ informado pela fonte (nunca inferido)">
            Código CNJ {e.cnjMovementCode}
          </Badge>
        ) : null}
      </>
    ),
    meta: (
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span>{sourceLine(e)}</span>
        {e.removable ? (
          <ConfirmDialog
            action={removeProcessEventAction}
            hiddenFields={{ eventId: e.id }}
            trigger={
              <Button type="button" variant="ghost" size="sm" aria-label={`Remover a movimentação “${e.title}”`}>
                <Trash2 aria-hidden="true" />
                Remover
              </Button>
            }
            title="Remover movimentação?"
            description="A movimentação manual será removida da linha do tempo. A remoção fica registrada no histórico."
            confirmLabel="Remover"
            pendingLabel="Removendo…"
          />
        ) : null}
      </span>
    ),
  };
}

/**
 * "Andamento" section of the "Partes e andamento" tab (P2.13): ONE timeline for every
 * instance of the same CNJ, most recent first, each movement with its instance badge and
 * its source (DataJud, imported spreadsheet or manual entry). `aside` receives the court
 * sync card (server component rendered by the page).
 */
export function ProcessEvents({ process: p, aside }: { process: ProcessDetail; aside?: ReactNode }) {
  const canEdit = p.permissions.canEdit;
  const head = p.events.slice(0, TIMELINE_VISIBLE_EVENTS);
  const tail = p.events.slice(TIMELINE_VISIBLE_EVENTS);
  const perInstance = eventsByInstance(p.events);
  const fromDataJud = p.events.filter(isDataJud).length;

  return (
    <section id={PROCESS_SECTION_IDS.timeline} aria-labelledby="andamento-titulo" className="scroll-mt-4">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="min-w-0 lg:col-span-2 lg:self-start">
          <CardHeader>
            <CardTitle id="andamento-titulo">Andamento</CardTitle>
            <CardDescription>
              Linha do tempo única de todas as instâncias deste número CNJ, da movimentação mais recente para a mais antiga.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {p.events.length > 0 ? (
              <ul aria-label="Movimentações por instância" className="flex flex-wrap gap-1.5 text-xs">
                <li className="rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-800 tabular-nums">
                  {pluralize(p.events.length, "movimentação", "movimentações")}
                </li>
                {perInstance.map((g) => (
                  <li
                    key={g.instance ?? "none"}
                    className="rounded-full border border-border px-2 py-0.5 text-slate-700 tabular-nums"
                  >
                    {g.instance ? PROCESS_INSTANCE_LABELS[g.instance] : "Instância não informada"}: {formatNumber(g.count)}
                  </li>
                ))}
                {fromDataJud > 0 ? (
                  <li className="rounded-full border border-primary-200 bg-primary-50 px-2 py-0.5 text-primary-800 tabular-nums">
                    DataJud (CNJ): {formatNumber(fromDataJud)}
                  </li>
                ) : null}
              </ul>
            ) : null}
            <Timeline emptyMessage="Nenhuma movimentação registrada." items={head.map(toItem)} />
            {tail.length > 0 ? (
              <details className="group">
                <summary className="cursor-pointer self-start rounded-sm text-sm font-medium text-primary-700 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                  {`Ver mais ${pluralize(tail.length, "movimentação anterior", "movimentações anteriores")}`}
                </summary>
                <Timeline className="mt-5" items={tail.map(toItem)} />
              </details>
            ) : null}
          </CardContent>
        </Card>

        <div className="flex min-w-0 flex-col gap-6">
          {aside}
          {canEdit ? (
            <Card>
              <CardHeader>
                <CardTitle>Registrar movimentação</CardTitle>
                <CardDescription>Entrada manual na linha do tempo do processo.</CardDescription>
              </CardHeader>
              <CardContent>
                <EventForm action={addProcessEventAction} processId={p.id} today={todayISO()} defaultInstance={p.instance} />
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>
    </section>
  );
}
