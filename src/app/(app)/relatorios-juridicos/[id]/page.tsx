import { Download } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { buttonVariants } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DescriptionList } from "@/components/ui/description-list";
import { PageHeader } from "@/components/ui/page-header";
import { LEGAL_REPORT_STATUS_LABELS, LEGAL_REPORT_TYPE_LABELS, ROLE_LABELS } from "@/domain/enums";
import { formatDate, formatFileSize } from "@/lib/format";
import { flagParam } from "@/lib/search-params";
import { LegalReportStatusBadge, SampleBadge } from "@/modules/legal-reports/components/report-badges";
import { ApproveReportButton, RegenerateReportButton } from "@/modules/legal-reports/components/report-actions";
import { LegalReportContent } from "@/modules/legal-reports/components/report-content";
import { getLegalReport } from "@/modules/legal-reports/service";
import { dateTimeLabel, preparedByLabel, reportLayout, reviewedByLabel } from "@/modules/legal-reports/view";
import { requirePageContext } from "@/server/auth/session";
import { NotFoundError } from "@/server/lib/errors";

export const metadata: Metadata = { title: "Relatório jurídico" };

export default async function LegalReportPage(props: PageProps<"/relatorios-juridicos/[id]">) {
  const ctx = await requirePageContext("legal_report:read");
  const { id } = await props.params;
  const sp = await props.searchParams;
  let detail;
  try {
    detail = await getLegalReport(ctx, id);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
  const { view, permissions, versions } = detail;
  const approved = view.status === "approved" || (view.status === "superseded" && !!view.approvedAt);
  const processReport = reportLayout(view) === "process_report";

  return (
    <>
      <PageHeader
        title={`${view.reference} · versão ${view.version}`}
        description={view.title}
        breadcrumbs={[
          { label: "Painel executivo", href: "/dashboard" },
          { label: "Relatórios jurídicos", href: "/relatorios-juridicos" },
          { label: `${view.reference} v${view.version}` },
        ]}
        meta={
          <div className="flex flex-wrap items-center gap-2">
            <LegalReportStatusBadge status={view.status} />
            {view.isSample ? <SampleBadge /> : null}
          </div>
        }
        actions={
          <div className="flex flex-wrap gap-2">
            {permissions.canDownload ? (
              <a href={`/api/legal-reports/${view.id}/pdf`} className={buttonVariants({ variant: "outline" })}>
                <Download aria-hidden="true" />
                Baixar PDF
              </a>
            ) : null}
            {permissions.canRegenerate ? <RegenerateReportButton id={view.id} reference={view.reference} /> : null}
            {permissions.canApprove ? <ApproveReportButton id={view.id} reference={view.reference} version={view.version} /> : null}
          </div>
        }
      />

      {flagParam(sp, "gerado") ? (
        <Callout tone="success" className="mb-4" title="Relatório gerado">
          O PDF foi gerado e armazenado com o hash registrado. Ele fica pendente de revisão, com marca d&apos;água, até a aprovação.
        </Callout>
      ) : null}
      {view.isSample ? (
        <Callout tone="info" className="mb-4" title="Documento de teste do motor">
          Gerado para conferir o layout e as regras de origem com dados de um processo. Não é um relatório jurídico e não deve ser usado como
          posição sobre o processo.
        </Callout>
      ) : null}
      {view.status === "superseded" ? (
        <Callout tone="warning" className="mb-4" title="Versão substituída">
          Esta versão foi substituída por uma mais recente; o PDF e o hash desta versão continuam disponíveis.
          {view.supersededById ? (
            <>
              {" "}
              <Link href={`/relatorios-juridicos/${view.supersededById}`} className="font-medium underline underline-offset-2">
                Abrir a versão seguinte
              </Link>
              .
            </>
          ) : null}
        </Callout>
      ) : view.status === "pending_review" ? (
        <Callout tone="warning" className="mb-4" title="Pendente de revisão">
          Não utilizar como posição oficial antes da aprovação ({detail.approverDescription}).
          {!permissions.canApprove ? " Seu perfil não aprova este tipo de relatório." : ""}
        </Callout>
      ) : null}

      <Card className="mb-6">
        <CardHeader>
          <CardTitle as="h2">Identificação</CardTitle>
        </CardHeader>
        <CardContent>
          <DescriptionList
            columns={3}
            items={[
              { label: "Tipo", value: LEGAL_REPORT_TYPE_LABELS[view.type] },
              { label: "Referência e versão", value: `${view.reference} · versão ${view.version}` },
              { label: "Situação", value: LEGAL_REPORT_STATUS_LABELS[view.status] },
              {
                label: "Escopo",
                value: view.processId && detail.processNumber ? (
                  <Link href={`/processos/${view.processId}`} className="underline underline-offset-2">
                    {view.parameters.scopeLabel}
                  </Link>
                ) : (
                  view.parameters.scopeLabel
                ),
              },
              { label: "Data-base", value: formatDate(view.baseDate, view.baseDate) },
              { label: "Gerado", value: `${dateTimeLabel(view.generatedAt)} por ${view.generatedByName ?? "Sistema"}` },
              {
                label: "Aprovação",
                value: approved
                  ? `${view.approvedByName ?? "Pessoa identificada"}${view.approvedByRole ? ` (${ROLE_LABELS[view.approvedByRole]})` : ""} em ${dateTimeLabel(view.approvedAt)}`
                  : `Pendente: ${detail.approverDescription}`,
              },
              { label: "Limite de confiança", value: `${view.parameters.confidenceThreshold} de 100` },
              ...(processReport
                ? [
                    { label: "Elaborado por", value: preparedByLabel(view) },
                    { label: "Revisado por", value: reviewedByLabel(view) },
                    {
                      label: "Finalidade",
                      value: view.parameters.purpose ?? "Relatório interno de acompanhamento do processo",
                      full: true,
                    },
                  ]
                : []),
              {
                label: "PDF armazenado",
                value: view.pdfSha256 ? `${formatFileSize(view.pdfSizeBytes, "tamanho não informado")} · SHA-256 ${view.pdfSha256}` : "Não disponível",
                full: true,
              },
              { label: "Base legal do tratamento de dados", value: view.parameters.legalBasisText, full: true },
            ]}
          />
          {versions.length > 1 ? (
            <div className="mt-4 border-t border-border pt-4">
              <p className="mb-2 text-xs font-medium text-muted-foreground">Versões desta referência</p>
              <ul className="flex flex-wrap gap-2 text-sm">
                {versions.map((v) => (
                  <li key={v.id}>
                    {v.id === view.id ? (
                      <span className="rounded-md bg-surface-muted px-2 py-1 font-medium">
                        Versão {v.version} (esta) · {LEGAL_REPORT_STATUS_LABELS[v.status]}
                      </span>
                    ) : (
                      <Link href={`/relatorios-juridicos/${v.id}`} className="rounded-md px-2 py-1 underline underline-offset-2">
                        Versão {v.version} · {LEGAL_REPORT_STATUS_LABELS[v.status]}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <LegalReportContent view={view} />
    </>
  );
}
