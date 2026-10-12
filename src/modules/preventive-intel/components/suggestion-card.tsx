import { ClipboardList, ExternalLink, ShieldPlus } from "lucide-react";
import Link from "next/link";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { StatusBadge } from "@/components/ui/status-badge";
import { OCCURRENCE_STATUS_LABELS, type OccurrenceStatus } from "@/domain/enums";
import { formatDate, pluralize } from "@/lib/format";
import { OCCURRENCE_STATUS_TONES } from "@/lib/tones";
import { createActionPlanFromSuggestionAction, createOccurrenceFromSuggestionAction } from "../actions";
import type { PreventiveIntelFilters, PreventiveIntelligence } from "../types";
import { ComputedBadge, IllustrativeBadge } from "./indicator-parts";

type Suggestion = PreventiveIntelligence["suggestions"][number];

export function SuggestionCard({
  suggestion: s,
  filters,
  canCreateOccurrence,
  canCreateTasks,
}: {
  suggestion: Suggestion;
  filters: PreventiveIntelFilters;
  canCreateOccurrence: boolean;
  canCreateTasks: boolean;
}) {
  const hidden: Record<string, string> = { key: s.key };
  if (filters.companyId) hidden.empresa = filters.companyId;
  if (filters.court) hidden.tribunal = filters.court;
  const existing = s.existingOccurrence;
  const canPlan = canCreateTasks && (existing !== null || canCreateOccurrence);

  return (
    <Card className="border-dashed border-amber-300 bg-amber-50/30">
      <CardHeader actions={<IllustrativeBadge />}>
        <CardTitle as="h3">{s.title}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 text-sm">
        <div className="rounded-md border border-border bg-surface p-3">
          <div className="mb-1.5 flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-slate-600">Indicador que motivou a sugestão</span>
            <ComputedBadge />
          </div>
          <p className="text-slate-900">{s.trigger}</p>
          <p className="mt-1 text-xs text-muted-foreground">{s.basis}</p>
        </div>
        <div>
          <p className="text-xs font-semibold text-slate-600">Medida sugerida (ilustrativa)</p>
          <p className="mt-1 text-slate-800">{s.measure}</p>
        </div>
        <div>
          <p className="text-xs font-semibold text-slate-600">Plano de ação ilustrativo</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-slate-800">
            {s.planItems.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
        {existing ? (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface px-3 py-2">
            <span className="text-slate-700">Ocorrência em aberto criada a partir deste indicador:</span>
            <Link
              href={`/preventivo/${existing.id}`}
              className="font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
            >
              {existing.title}
            </Link>
            <StatusBadge
              label={OCCURRENCE_STATUS_LABELS[existing.status as OccurrenceStatus] ?? existing.status}
              tone={OCCURRENCE_STATUS_TONES[existing.status as OccurrenceStatus] ?? "neutral"}
            />
            <span className="text-xs text-muted-foreground">em {formatDate(existing.createdAt)}</span>
          </div>
        ) : null}
      </CardContent>
      <CardFooter>
        {existing ? (
          <ButtonLink href={`/preventivo/${existing.id}`} variant="outline">
            <ExternalLink aria-hidden="true" />
            Abrir ocorrência
          </ButtonLink>
        ) : canCreateOccurrence ? (
          <ConfirmDialog
            action={createOccurrenceFromSuggestionAction}
            hiddenFields={hidden}
            tone="primary"
            title="Criar ocorrência preventiva?"
            description="Será criada uma ocorrência preventiva (categoria Trabalhista) descrevendo o indicador e a medida sugerida, com a origem “inteligência preventiva”. Nenhum processo é alterado."
            confirmLabel="Criar ocorrência"
            pendingLabel="Criando…"
            trigger={
              <Button type="button">
                <ShieldPlus aria-hidden="true" />
                Criar ocorrência preventiva
              </Button>
            }
          />
        ) : null}
        {canPlan ? (
          <ConfirmDialog
            action={createActionPlanFromSuggestionAction}
            hiddenFields={hidden}
            tone="primary"
            title="Criar plano de ação?"
            description={
              existing
                ? `${pluralize(s.planItems.length, "tarefa", "tarefas")} do plano ilustrativo serão adicionadas ao plano de ação da ocorrência existente (itens já presentes não são duplicados). Ajuste responsáveis e prazos depois.`
                : `Uma ocorrência preventiva será criada e ${pluralize(s.planItems.length, "tarefa", "tarefas")} do plano ilustrativo serão vinculadas a ela como plano de ação. Ajuste responsáveis e prazos depois.`
            }
            confirmLabel="Criar plano de ação"
            pendingLabel="Criando…"
            trigger={
              <Button type="button" variant="outline">
                <ClipboardList aria-hidden="true" />
                Criar plano de ação
              </Button>
            }
          />
        ) : null}
        {!canCreateOccurrence && !canPlan && !existing ? (
          <p className="text-xs text-muted-foreground">Seu perfil consulta os indicadores, mas não cria ocorrências nem tarefas.</p>
        ) : null}
      </CardFooter>
    </Card>
  );
}
