import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ANALYSIS_TYPE_LABELS } from "@/domain/enums";
import { AiModeBadge } from "@/components/ui/ai-mode-badge";
import { PageHeader } from "@/components/ui/page-header";
import { formatDateTime } from "@/lib/format";
import { requirePageContext } from "@/server/auth/session";
import { NotFoundError } from "@/server/lib/errors";
import { getAnalysis, type AnalysisDetail } from "@/modules/analyses/service";
import { AnalysisAutoRefresh } from "@/modules/analyses/components/analysis-auto-refresh";
import { AnalysisStatusBadge, StaleBadge } from "@/modules/analyses/components/analysis-badges";
import { AnalysisResultView } from "@/modules/analyses/components/analysis-result-view";

export const metadata: Metadata = { title: "Análise de IA" };

export default async function AnalysisPage(props: PageProps<"/ia/analises/[id]">) {
  const ctx = await requirePageContext("analysis:read");
  const { id } = await props.params;

  let analysis: AnalysisDetail;
  try {
    analysis = await getAnalysis(ctx, id);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }

  const pending = analysis.status === "queued" || analysis.status === "running";
  const title =
    analysis.mode === "demo"
      ? `${ANALYSIS_TYPE_LABELS[analysis.type]} (demonstrativa)`
      : ANALYSIS_TYPE_LABELS[analysis.type];

  return (
    <div className="space-y-6">
      <PageHeader
        title={title}
        description={
          analysis.subjectType === "organization"
            ? `Consulta à base da organização · solicitada em ${formatDateTime(analysis.createdAt)}`
            : `${analysis.subjectLabel} · solicitada em ${formatDateTime(analysis.createdAt)}`
        }
        breadcrumbs={[
          { label: "Central de IA", href: "/ia" },
          ...(analysis.subjectHref ? [{ label: analysis.subjectLabel, href: analysis.subjectHref }] : []),
          { label: "Análise" },
        ]}
        meta={
          <>
            <AnalysisStatusBadge status={analysis.status} />
            <AiModeBadge mode={analysis.mode} />
            <StaleBadge isStale={analysis.isStale} />
          </>
        }
      />
      <AnalysisAutoRefresh active={pending} />
      <AnalysisResultView ctx={ctx} analysis={analysis} />
    </div>
  );
}
