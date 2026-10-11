import { ExternalLink, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DescriptionList } from "@/components/ui/description-list";
import { EmptyState } from "@/components/ui/empty-state";
import { OriginBadge } from "@/components/ui/origin-badge";
import { formatDate, formatDateTime, formatRelativeDays } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { DeadlineListItem } from "../service";
import type { WorkUserOption } from "../types";
import { ValidationForm } from "./validation-form";
import { DeadlineKindBadge, WorkLinks } from "./work-badges";

/** Quoted passage of the source (plain text, whitespace preserved). */
export function SourceExcerpt({ item }: { item: DeadlineListItem }) {
  if (item.sourceExcerpt) {
    return (
      <figure className="flex flex-col gap-1">
        <blockquote className="rounded-md border-l-4 border-ai-400 bg-ai-50 px-3 py-2 text-sm whitespace-pre-wrap text-slate-800">
          {item.sourceExcerpt}
        </blockquote>
        <figcaption className="text-xs text-muted-foreground">Trecho da fonte citado pela IA (texto literal do documento).</figcaption>
      </figure>
    );
  }
  if (item.sourceAnalysisId) {
    return (
      <p className="text-sm text-muted-foreground italic">
        O trecho da fonte só é exibido para quem tem acesso à análise de origem e aos documentos usados nela.
      </p>
    );
  }
  return null;
}

export function SourceAnalysisLink({ item }: { item: DeadlineListItem }) {
  if (!item.sourceAnalysisId) return null;
  if (!item.sourceAnalysisVisible) return <span className="text-muted-foreground">Análise de origem sem acesso</span>;
  return (
    <Link
      href={`/ia/analises/${item.sourceAnalysisId}`}
      className="inline-flex items-center gap-1 font-medium text-ai-700 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
    >
      Abrir análise de origem
      <ExternalLink aria-hidden="true" className="size-3.5" />
    </Link>
  );
}

export function ValidationList({
  items,
  today,
  canValidate,
  userOptions,
  highlightId,
}: {
  items: DeadlineListItem[];
  today: string;
  canValidate: boolean;
  userOptions: WorkUserOption[];
  highlightId?: string;
}) {
  return (
    <div className="flex flex-col gap-4">
      {canValidate ? (
        <Callout tone="ai" title="Validação humana obrigatória">
          Confira a data no documento de origem e as regras de contagem aplicáveis antes de validar. Ao validar, o
          prazo passa a contar nos indicadores, alertas e no calendário como prazo real; ao rejeitar, a sugestão é
          cancelada e o motivo fica registrado na auditoria.
        </Callout>
      ) : (
        <Callout tone="info" title="Somente consulta">
          Seu perfil pode consultar as sugestões, mas a validação de prazos sugeridos pela IA é feita por advogados,
          gestores jurídicos e administradores.
        </Callout>
      )}

      {items.length === 0 ? (
        <EmptyState
          icon={<ShieldCheck />}
          title="Nenhum prazo aguardando validação"
          description="Quando uma análise de IA identificar uma data em um documento e alguém registrá-la como sugestão, ela aparecerá aqui."
        />
      ) : (
        <ul className="flex flex-col gap-4" aria-label="Prazos sugeridos pela IA aguardando validação">
          {items.map((d) => {
            const highlighted = d.id === highlightId;
            return (
              <li key={d.id} id={`prazo-${d.id}`}>
                <Card
                  className={cn("border-dashed border-ai-300", highlighted && "outline-2 outline-offset-2 outline-amber-400")}
                  aria-current={highlighted ? "true" : undefined}
                  aria-labelledby={`prazo-${d.id}-titulo`}
                >
                  <CardHeader>
                    <CardTitle as="h3" id={`prazo-${d.id}-titulo`}>
                      {d.title}
                    </CardTitle>
                    <div className="flex flex-wrap items-center gap-2">
                      <OriginBadge origin={d.origin} validationStatus={d.validationStatus} />
                      <DeadlineKindBadge kind={d.kind} />
                    </div>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-4">
                    <DescriptionList
                      columns={3}
                      items={[
                        {
                          label: "Data sugerida",
                          value: (
                            <span>
                              <time dateTime={d.dueDate} className="font-medium">
                                {formatDate(d.dueDate)}
                              </time>{" "}
                              <span className="text-xs text-muted-foreground">({formatRelativeDays(d.dueDate, today)})</span>
                            </span>
                          ),
                        },
                        { label: "Vínculo", value: <WorkLinks links={d.links} /> },
                        { label: "Origem", value: <SourceAnalysisLink item={d} /> },
                        { label: "Registrada em", value: formatDateTime(d.createdAt) },
                        d.description ? { label: "Contexto", value: <span className="whitespace-pre-wrap">{d.description}</span>, full: true } : null,
                      ]}
                    />
                    <SourceExcerpt item={d} />
                    {canValidate ? (
                      <div className="rounded-md border border-border bg-surface-muted p-4">
                        <ValidationForm
                          deadlineId={d.id}
                          suggestedDate={d.dueDate}
                          userOptions={userOptions}
                          defaultResponsibleId={d.responsibleId}
                        />
                      </div>
                    ) : null}
                  </CardContent>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
