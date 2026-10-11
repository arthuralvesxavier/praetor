import { Sparkles } from "lucide-react";
import Link from "next/link";
import {
  ANALYSIS_TRIGGER_LABELS,
  ANALYSIS_TYPE_LABELS,
  type AnalysisSubjectType,
} from "@/domain/enums";
import { AiModeBadge } from "@/components/ui/ai-mode-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateTime, formatNumber } from "@/lib/format";
import type { AuthContext } from "@/server/auth/context";
import { can } from "@/server/auth/permissions";
import { NotFoundError } from "@/server/lib/errors";
import { getAiRuntimeInfo, getAnalysis, listAnalyses, type AnalysisDetail } from "../service";
import { AnalysisAutoRefresh } from "./analysis-auto-refresh";
import { AnalysisStatusBadge, ReviewStatusBadge, StaleBadge } from "./analysis-badges";
import { AnalysisCompact } from "./analysis-compact";
import { AnalysisRequestForm } from "./analysis-forms";
import { isRecordSubjectType } from "./analysis-labels";

export type AnalysisPanelProps = {
  ctx: AuthContext;
  subject: { type: AnalysisSubjectType; id: string };
  title?: string;
  /** How many analyses to list (default 8). */
  limit?: number;
};

/**
 * AI analyses of a record, embedded in entity pages: request form, history and
 * the latest succeeded analysis in compact form. Renders nothing without
 * `analysis:read`; the request form needs `analysis:request`.
 */
export async function AnalysisPanel({ ctx, subject, title = "Análises de IA", limit = 8 }: AnalysisPanelProps) {
  if (!can(ctx, "analysis:read")) return null;

  const list = await listAnalyses(ctx, { subjectType: subject.type, subjectId: subject.id, pageSize: limit });
  const items = list.items;
  const pending = items.some((a) => a.status === "queued" || a.status === "running");
  const latest = items.find((a) => a.status === "succeeded" && a.reviewStatus !== "dismissed" && a.type !== "question_answer");
  let latestDetail: AnalysisDetail | null = null;
  if (latest) {
    try {
      latestDetail = await getAnalysis(ctx, latest.id);
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err;
    }
  }
  const runtime = getAiRuntimeInfo();
  const canRequest = can(ctx, "analysis:request") && isRecordSubjectType(subject.type);
  const headingId = `painel-ia-${subject.id}`;

  return (
    <Card aria-labelledby={headingId}>
      <CardHeader actions={<AiModeBadge mode={runtime.mode} />}>
        <CardTitle id={headingId} className="flex items-center gap-2">
          <Sparkles aria-hidden="true" className="size-4 text-ai-700" />
          {title}
        </CardTitle>
        <CardDescription>
          Apoio à análise jurídica com base nos dados e documentos deste registro. Os resultados são sugestões e exigem
          validação humana.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <AnalysisAutoRefresh active={pending} />

        {canRequest && isRecordSubjectType(subject.type) ? (
          <div className="rounded-md border border-border bg-surface-muted p-3">
            <AnalysisRequestForm subject={{ type: subject.type, id: subject.id }} />
            {runtime.mode === "demo" ? (
              <p className="mt-2 text-xs text-amber-800">
                Ambiente sem credenciais de IA: os resultados serão demonstrativos, gerados por regras simples.
              </p>
            ) : null}
          </div>
        ) : null}

        {latestDetail ? <AnalysisCompact analysis={latestDetail} canRequest={can(ctx, "analysis:request")} /> : null}

        <section aria-label="Histórico de análises" className="space-y-2">
          <h3 className="text-sm font-semibold text-slate-900">
            Histórico{list.total > 0 ? ` (${formatNumber(list.total)})` : ""}
          </h3>
          {items.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nenhuma análise foi feita para este registro{canRequest ? ". Use o formulário acima para solicitar a primeira." : "."}
            </p>
          ) : (
            <ul className="divide-y divide-border rounded-md border border-border">
              {items.map((a) => (
                <li key={a.id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 space-y-0.5">
                    <Link
                      href={`/ia/analises/${a.id}`}
                      className="text-sm font-medium text-primary-700 underline-offset-2 hover:text-primary-900 hover:underline"
                    >
                      {ANALYSIS_TYPE_LABELS[a.type]}
                    </Link>
                    <p className="text-xs text-muted-foreground">
                      {formatDateTime(a.createdAt)} · {ANALYSIS_TRIGGER_LABELS[a.trigger]}
                      {a.requestedByName ? ` · ${a.requestedByName}` : ""}
                    </p>
                    {a.status === "succeeded" && a.findingCount > 0 ? (
                      <p className="text-xs text-muted-foreground">{formatNumber(a.findingCount)} achado(s)</p>
                    ) : null}
                    {a.errorMessage && (a.status === "failed" || a.status === "cancelled") ? (
                      <p className="text-xs text-red-700">{a.errorMessage}</p>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
                    <AnalysisStatusBadge status={a.status} />
                    <AiModeBadge mode={a.mode} />
                    <ReviewStatusBadge status={a.reviewStatus} analysisStatus={a.status} />
                    <StaleBadge isStale={a.isStale} />
                  </div>
                </li>
              ))}
            </ul>
          )}
          {list.total > items.length ? (
            <p className="text-xs text-muted-foreground">
              Exibindo as {formatNumber(items.length)} análises mais recentes.{" "}
              <Link href="/ia" className="font-medium text-primary-700 underline underline-offset-2">
                Ver todas na Central de IA
              </Link>
            </p>
          ) : null}
        </section>
      </CardContent>
    </Card>
  );
}
