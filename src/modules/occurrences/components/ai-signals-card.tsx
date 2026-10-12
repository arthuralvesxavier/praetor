import { ArrowRight, Sparkles } from "lucide-react";
import Link from "next/link";
import { AiModeBadge } from "@/components/ui/ai-mode-badge";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ANALYSIS_DISCLAIMER, DEMO_MODE_NOTICE, FINDING_KIND_LABELS, SEVERITIES, type AnalysisFinding } from "@/domain/analysis";
import { entityHref } from "@/domain/entities";
import { ANALYSIS_TYPE_LABELS } from "@/domain/enums";
import { formatDateTime } from "@/lib/format";
import { RISK_TONES } from "@/lib/tones";
import type { AuthContext } from "@/server/auth/context";
import { can } from "@/server/auth/permissions";
import { getAnalysis, listAnalyses, type AnalysisListItem } from "@/modules/analyses/service";

/** Finding kinds shown next to the manual "informações faltantes" list. */
const SIGNAL_KINDS = new Set<AnalysisFinding["kind"]>(["risk_signal", "missing_information", "missing_document"]);
const MAX_FINDINGS = 8;

type Severity = (typeof SEVERITIES)[number];
const SEVERITY_LABELS: Record<Severity, string> = { low: "Baixa", medium: "Média", high: "Alta", critical: "Crítica" };
const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

function SeverityBadge({ severity }: { severity: Severity | null }) {
  if (!severity) return null;
  return (
    <Badge tone={RISK_TONES[severity]} dot>
      <span className="sr-only">Relevância </span>
      {SEVERITY_LABELS[severity]}
    </Badge>
  );
}

/** Latest succeeded, non-dismissed risk_signals / inconsistencies analysis of the occurrence. */
async function latestSignalsAnalysis(ctx: AuthContext, occurrenceId: string): Promise<AnalysisListItem | null> {
  const lists = await Promise.all(
    (["risk_signals", "inconsistencies"] as const).map((type) =>
      listAnalyses(ctx, { subjectType: "occurrence", subjectId: occurrenceId, status: "succeeded", type, pageSize: 5 }),
    ),
  );
  const candidates = lists
    .flatMap((l) => l.items)
    .filter((a) => a.reviewStatus !== "dismissed")
    .sort((a, b) => (b.completedAt ?? b.createdAt).getTime() - (a.completedAt ?? a.createdAt).getTime());
  return candidates[0] ?? null;
}

/**
 * "Sinais e lacunas apontados pela IA": shown beside the human-maintained list
 * of missing information, always labeled as AI output that needs validation.
 * Never merged into the occurrence's own fields.
 */
export async function AiSignalsCard({
  ctx,
  occurrenceId,
  aiTabHref,
}: {
  ctx: AuthContext;
  occurrenceId: string;
  aiTabHref: string;
}) {
  const canRead = can(ctx, "analysis:read");
  const latest = canRead ? await latestSignalsAnalysis(ctx, occurrenceId) : null;
  const detail = latest ? await getAnalysis(ctx, latest.id) : null;
  const findings = (detail?.result?.findings ?? [])
    .filter((f) => SIGNAL_KINDS.has(f.kind))
    .sort((a, b) => (a.severity ? SEVERITY_RANK[a.severity] : 9) - (b.severity ? SEVERITY_RANK[b.severity] : 9));
  const shown = findings.slice(0, MAX_FINDINGS);
  const analysisHref = detail ? entityHref({ type: "analysis", id: detail.id }) : null;

  return (
    <Card className="border-ai-200 bg-ai-50/40">
      <CardHeader actions={detail ? <AiModeBadge mode={detail.mode} /> : null}>
        <CardTitle as="h3" className="flex items-center gap-2 text-ai-900">
          <Sparkles aria-hidden="true" className="size-4 text-ai-600" />
          Sinais e lacunas apontados pela IA
        </CardTitle>
        <CardDescription className="text-ai-800">Gerado por IA, requer validação humana</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {!canRead ? (
          <p className="text-sm text-muted-foreground">Seu perfil não tem acesso às análises de IA.</p>
        ) : !detail ? (
          <div className="grid gap-3">
            <p className="text-sm text-slate-700">
              Ainda não há análise concluída de sinais de risco ou de lacunas para esta ocorrência.
            </p>
            {can(ctx, "analysis:request") ? (
              <div>
                <ButtonLink href={aiTabHref} variant="outline" size="sm">
                  <Sparkles aria-hidden="true" />
                  Solicitar análise na aba “Análises de IA”
                </ButtonLink>
              </div>
            ) : null}
          </div>
        ) : (
          <>
            <p className="text-xs text-slate-600">
              {ANALYSIS_TYPE_LABELS[detail.type]} · concluída em {formatDateTime(detail.completedAt ?? detail.createdAt)}
              {detail.isStale ? (
                <>
                  {" · "}
                  <span className="font-medium text-amber-800">desatualizada (a ocorrência mudou depois da análise)</span>
                </>
              ) : null}
            </p>
            {detail.mode === "demo" ? (
              <p className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs font-medium text-amber-900">
                {DEMO_MODE_NOTICE}
              </p>
            ) : null}
            {shown.length === 0 ? (
              <p className="text-sm text-slate-700">A análise não apontou sinais de risco nem informações ou documentos faltantes.</p>
            ) : (
              <ul className="grid gap-2" aria-label="Apontamentos da IA">
                {shown.map((f, i) => (
                  <li key={`${f.kind}-${i}`} className="rounded-md border border-ai-100 bg-white p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone="ai">{FINDING_KIND_LABELS[f.kind]}</Badge>
                      <SeverityBadge severity={f.severity} />
                    </div>
                    <p className="mt-1.5 text-sm font-medium text-slate-900">{f.title}</p>
                    {f.detail ? <p className="mt-0.5 text-sm text-slate-700">{f.detail}</p> : null}
                  </li>
                ))}
              </ul>
            )}
            {findings.length > shown.length ? (
              <p className="text-xs text-slate-600">
                Mais {findings.length - shown.length} apontamento(s) na análise completa.
              </p>
            ) : null}
            <p className="text-xs text-slate-600">{ANALYSIS_DISCLAIMER}</p>
            {analysisHref ? (
              <Link
                href={analysisHref}
                className="inline-flex items-center gap-1 text-sm font-medium text-ai-700 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
              >
                Ver análise completa com fontes
                <ArrowRight aria-hidden="true" className="size-4" />
              </Link>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
