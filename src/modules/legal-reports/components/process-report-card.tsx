import { Download, FileText } from "lucide-react";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DescriptionList } from "@/components/ui/description-list";
import { formatDate } from "@/lib/format";
import type { AuthContext } from "@/server/auth/context";
import { can } from "@/server/auth/permissions";
import { AppError } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";
import { getProcessReportPanel, type ProcessReportPanel } from "../service";
import { dateTimeLabel } from "../view";
import { GenerateProcessReportButton } from "./report-actions";
import { LegalReportStatusBadge } from "./report-badges";

/**
 * Relatório de Processo (R1) na ficha do processo, aba "Documentos e análises".
 * Server component: confere a própria permissão (legal_report:read) e mostra o botão
 * "Gerar R1" só a quem gera o tipo e, com R1 aprovado, só a quem poderia aprová-lo.
 *
 *   <ProcessReportCard ctx={ctx} processId={id} />
 */
export async function ProcessReportCard({ ctx, processId }: { ctx: AuthContext; processId: string }) {
  if (!can(ctx, "legal_report:read")) return null;
  let panel: ProcessReportPanel;
  try {
    panel = await getProcessReportPanel(ctx, processId);
  } catch (error) {
    if (error instanceof AppError) return null;
    logger.error("process_report_panel_failed", { processId, errorName: error instanceof Error ? error.name : typeof error });
    return <p className="text-sm text-muted-foreground">Não foi possível carregar o Relatório de Processo.</p>;
  }
  const current = panel.current;
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h3">Relatório de Processo (R1)</CardTitle>
        <CardDescription>
          PDF com capa de identificação, síntese, linha do tempo, pedidos e valores, garantias e exposição, cenários, pontos de atenção e
          auditoria de fontes. Cada afirmação tem origem declarada; o que não está na base aparece como dado não localizado. É gerado
          automaticamente quando a análise preliminar é aprovada e fica pendente de revisão até a aprovação.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {panel.outdated ? (
          <Callout tone="warning" title="R1 aprovado desatualizado">
            O processo tem dados novos desde a geração do R1 aprovado. O sistema não substitui uma versão aprovada: gere a nova versão.
          </Callout>
        ) : null}
        {current ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Link href={`/relatorios-juridicos/${current.id}`} className="font-medium underline underline-offset-2">
                {current.reference} · versão {current.version}
              </Link>
              <LegalReportStatusBadge status={current.status} />
            </div>
            <DescriptionList
              columns={3}
              items={[
                { label: "Data-base", value: formatDate(current.baseDate, current.baseDate) },
                { label: "Gerado", value: `${dateTimeLabel(current.generatedAt)} por ${current.generatedByName ?? "Sistema"}` },
                { label: "Aprovação", value: current.approvedAt ? dateTimeLabel(current.approvedAt) : "Pendente de revisão" },
              ]}
            />
            {panel.previousVersions > 0 ? (
              <p className="text-xs text-muted-foreground">
                {panel.previousVersions === 1 ? "1 versão anterior substituída" : `${panel.previousVersions} versões anteriores substituídas`}, com
                PDF e hash preservados (ver no relatório).
              </p>
            ) : null}
          </div>
        ) : panel.hiddenCurrent ? (
          <p className="text-sm text-muted-foreground">
            Há um Relatório de Processo vigente, mas ele cita documentos ou traz conteúdo (análise preliminar, prazos ou valores) que seu
            perfil não pode ver.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">Nenhum Relatório de Processo gerado para este processo.</p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {current?.hasPdf ? (
            <a href={`/api/legal-reports/${current.id}/pdf`} className={buttonVariants({ variant: "outline" })}>
              <Download aria-hidden="true" />
              Baixar PDF
            </a>
          ) : null}
          {current ? (
            <Link href={`/relatorios-juridicos/${current.id}`} className={buttonVariants({ variant: "ghost" })}>
              <FileText aria-hidden="true" />
              Abrir relatório
            </Link>
          ) : null}
          {panel.canGenerate ? <GenerateProcessReportButton processId={processId} hasCurrent={!!current} /> : null}
        </div>
        {panel.blockedReason ? <p className="text-xs text-muted-foreground">{panel.blockedReason}</p> : null}
      </CardContent>
    </Card>
  );
}
