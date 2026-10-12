import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { OriginBadge } from "@/components/ui/origin-badge";
import { Timeline } from "@/components/ui/timeline";
import { PROCESS_EVENT_TYPE_LABELS, PROCESS_INSTANCE_LABELS } from "@/domain/enums";
import { formatDateTime, todayISO } from "@/lib/format";
import { addProcessEventAction, removeProcessEventAction } from "../actions";
import type { ProcessDetail } from "../service";
import { EventForm } from "./event-form";

export function ProcessEvents({ process: p }: { process: ProcessDetail }) {
  const canEdit = p.permissions.canEdit;
  return (
    <div className="flex flex-col gap-6">
      <Callout tone="info" title="Sem integração com tribunais">
        As movimentações são cadastradas manualmente ou importadas de fonte informada. Integrações com tribunais
        (DataJud, MNI, PJe): não integrado nesta versão.
      </Callout>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className={canEdit ? "lg:col-span-2" : "lg:col-span-3"}>
          <CardHeader>
            <CardTitle>Linha do tempo</CardTitle>
            <CardDescription>Da mais recente para a mais antiga.</CardDescription>
          </CardHeader>
          <CardContent>
            <Timeline
              emptyMessage="Nenhuma movimentação registrada."
              items={p.events.map((e) => ({
                id: e.id,
                date: e.occurredAt,
                title: e.title,
                description: e.description,
                badge: (
                  <>
                    <Badge tone="neutral">{PROCESS_EVENT_TYPE_LABELS[e.type]}</Badge>
                    {e.instance ? <Badge tone="info">{PROCESS_INSTANCE_LABELS[e.instance]}</Badge> : null}
                    {e.cnjMovementCode !== null ? (
                      <Badge tone="neutral" title="Código informado por uma pessoa ou pela fonte importada">
                        Código CNJ {e.cnjMovementCode}
                      </Badge>
                    ) : null}
                    <OriginBadge origin={e.origin} />
                  </>
                ),
                meta: (
                  <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span>
                      {e.origin === "imported"
                        ? `Importada${e.externalSource ? ` de ${e.externalSource}` : ""} em ${formatDateTime(e.createdAt)}`
                        : `Registrada${e.createdByName ? ` por ${e.createdByName}` : ""} em ${formatDateTime(e.createdAt)}`}
                    </span>
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
              }))}
            />
          </CardContent>
        </Card>

        {canEdit ? (
          <Card>
            <CardHeader>
              <CardTitle>Registrar movimentação</CardTitle>
              <CardDescription>Entrada manual na linha do tempo do processo.</CardDescription>
            </CardHeader>
            <CardContent>
              <EventForm
                action={addProcessEventAction}
                processId={p.id}
                today={todayISO()}
                defaultInstance={p.instance}
              />
            </CardContent>
          </Card>
        ) : null}
      </div>
    </div>
  );
}
