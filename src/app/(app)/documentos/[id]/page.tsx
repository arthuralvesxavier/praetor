import { Download, FileClock, Trash2 } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { buttonVariants } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DescriptionList } from "@/components/ui/description-list";
import { PageHeader } from "@/components/ui/page-header";
import { StatusBadge } from "@/components/ui/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CONFIDENTIALITY_LABELS, DOCUMENT_CATEGORY_LABELS, type TextExtractionStatus } from "@/domain/enums";
import { formatDate, formatDateTime, formatFileSize, formatNumber, pluralize } from "@/lib/format";
import { cn } from "@/lib/utils";
import { EntityHistory } from "@/modules/admin/components/entity-history";
import { AnalysisPanel } from "@/modules/analyses/components/analysis-panel";
import { CommentThread } from "@/modules/comments/components/comment-thread";
import { deleteDocumentAction } from "@/modules/documents/actions";
import { ConfidentialityBadge, ExtractionStatusBadge, LegalHoldBadge } from "@/modules/documents/components/document-badges";
import { DocumentLinks, downloadHref } from "@/modules/documents/components/document-links";
import { DocumentMetadataForm } from "@/modules/documents/components/document-metadata-form";
import { DocumentUploadForm } from "@/modules/documents/components/document-upload-form";
import { loadLinkOptions } from "@/modules/documents/link-options";
import { getDocument, type DocumentDetail } from "@/modules/documents/service";
import { can } from "@/server/auth/permissions";
import { requirePageContext } from "@/server/auth/session";
import { env } from "@/server/env";
import { NotFoundError } from "@/server/lib/errors";

export const metadata: Metadata = { title: "Documento" };

const EXTRACTION_HINTS: Record<Exclude<TextExtractionStatus, "succeeded">, string> = {
  pending: "A extração de texto da versão atual está na fila e será concluída em instantes. Atualize a página mais tarde.",
  failed: "Não foi possível extrair o texto da versão atual. O arquivo pode estar corrompido ou protegido.",
  unsupported:
    "A versão atual não tem texto extraível (imagens e PDFs digitalizados dependem de OCR, ainda não disponível).",
};

async function loadDocument(ctx: Parameters<typeof getDocument>[0], id: string): Promise<DocumentDetail> {
  try {
    return await getDocument(ctx, id);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
}

export default async function DocumentPage(props: PageProps<"/documentos/[id]">) {
  const ctx = await requirePageContext("document:read");
  const { id } = await props.params;
  const doc = await loadDocument(ctx, id);

  const canUpload = can(ctx, "document:upload");
  const canDelete = can(ctx, "document:delete");
  const linkOptions = canUpload ? await loadLinkOptions(ctx) : null;
  const current = doc.versions.find((v) => v.isCurrent) ?? null;

  return (
    <>
      <PageHeader
        title={doc.title}
        breadcrumbs={[
          { label: "Dashboard", href: "/dashboard" },
          { label: "Documentos", href: "/documentos" },
          { label: doc.title },
        ]}
        meta={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge label={DOCUMENT_CATEGORY_LABELS[doc.category]} tone="info" />
            <ConfidentialityBadge level={doc.confidentiality} />
            {doc.legalHold ? <LegalHoldBadge /> : null}
            {current ? <ExtractionStatusBadge status={current.extractionStatus} /> : null}
          </div>
        }
        actions={
          <div className="flex flex-wrap gap-2">
            {current ? (
              <a href={downloadHref(doc.id, current.id)} className={buttonVariants({ variant: "primary" })}>
                <Download aria-hidden="true" />
                Baixar versão atual
              </a>
            ) : null}
            {canDelete && !doc.legalHold ? (
              <ConfirmDialog
                action={deleteDocumentAction}
                hiddenFields={{ id: doc.id }}
                trigger={
                  <button type="button" className={buttonVariants({ variant: "outline" })}>
                    <Trash2 aria-hidden="true" />
                    Excluir
                  </button>
                }
                title="Excluir documento?"
                description="O documento e suas versões deixarão de aparecer para todos os usuários. A exclusão fica registrada na auditoria."
                confirmLabel="Excluir documento"
                pendingLabel="Excluindo…"
              />
            ) : null}
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Informações</CardTitle>
            </CardHeader>
            <CardContent>
              <DescriptionList
                columns={2}
                items={[
                  { label: "Categoria", value: DOCUMENT_CATEGORY_LABELS[doc.category] },
                  {
                    label: "Confidencialidade",
                    value:
                      doc.category === "sensitive_health"
                        ? `${CONFIDENTIALITY_LABELS[doc.confidentiality]} — dado sensível de saúde, sempre restrito`
                        : CONFIDENTIALITY_LABELS[doc.confidentiality],
                  },
                  { label: "Vínculos", value: <DocumentLinks links={doc.links} />, full: true },
                  { label: "Versão atual", value: doc.currentVersionNumber > 0 ? `v${doc.currentVersionNumber}` : null },
                  {
                    label: "Páginas (versão atual)",
                    value: current?.pageCount
                      ? pluralize(current.pageCount, "página", "páginas")
                      : current?.extractionStatus === "pending"
                        ? "Aguardando extração"
                        : "Não se aplica ao formato",
                  },
                  { label: "Enviado por", value: doc.uploadedByName },
                  { label: "Criado em", value: formatDateTime(doc.createdAt) },
                  { label: "Atualizado em", value: formatDateTime(doc.updatedAt) },
                  { label: "Reter até", value: doc.retentionUntil ? formatDate(doc.retentionUntil) : "Sem data definida" },
                  {
                    label: "Preservação legal (legal hold)",
                    value: doc.legalHold ? "Ativa — exclusão bloqueada" : "Inativa",
                  },
                  { label: "Descrição", value: doc.description, full: true },
                ]}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Versões</CardTitle>
              <CardDescription>
                Cada envio gera uma nova versão imutável. O tipo do arquivo é identificado pelo conteúdo.
              </CardDescription>
            </CardHeader>
            <CardContent className="px-0">
              <Table aria-label="Versões do documento">
                <TableHeader>
                  <TableRow>
                    <TableHead>Versão</TableHead>
                    <TableHead>Arquivo</TableHead>
                    <TableHead>Tamanho</TableHead>
                    <TableHead className="text-right">Páginas</TableHead>
                    <TableHead>SHA-256</TableHead>
                    <TableHead>Enviada por</TableHead>
                    <TableHead>Extração</TableHead>
                    <TableHead>
                      <span className="sr-only">Download</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {doc.versions.map((v) => (
                    <TableRow key={v.id}>
                      <TableCell className="whitespace-nowrap">
                        <span className="font-medium">v{v.versionNumber}</span>
                        {v.isCurrent ? <span className="ml-1.5 text-xs text-muted-foreground">(atual)</span> : null}
                      </TableCell>
                      <TableCell className="min-w-48">
                        <div className="flex flex-col gap-0.5">
                          <span className="break-all">{v.fileName}</span>
                          {v.changeNote ? (
                            <span className="text-xs text-muted-foreground">Nota: {v.changeNote}</span>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{formatFileSize(v.sizeBytes)}</TableCell>
                      <TableCell className="text-right tabular-nums">{v.pageCount ?? "—"}</TableCell>
                      <TableCell>
                        <code className="text-xs" title={`SHA-256 completo: ${v.sha256}`}>
                          {v.sha256.slice(0, 12)}…
                        </code>
                      </TableCell>
                      <TableCell className="min-w-36">
                        <div className="flex flex-col gap-0.5">
                          <span>{v.uploadedByName ?? "—"}</span>
                          <span className="text-xs text-muted-foreground">{formatDateTime(v.createdAt)}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <ExtractionStatusBadge status={v.extractionStatus} />
                      </TableCell>
                      <TableCell className="text-right">
                        <a
                          href={downloadHref(doc.id, v.id)}
                          className="inline-flex items-center gap-1 text-sm font-medium whitespace-nowrap text-primary-700 hover:underline"
                        >
                          <Download aria-hidden="true" className="size-4" />
                          Baixar<span className="sr-only"> versão {v.versionNumber}</span>
                        </a>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Texto extraído</CardTitle>
              <CardDescription>Texto extraído automaticamente (prévia).</CardDescription>
            </CardHeader>
            <CardContent>
              {doc.textPreview ? (
                <div className="flex flex-col gap-2">
                  <pre
                    tabIndex={0}
                    aria-label={`Prévia do texto extraído da versão ${doc.textPreview.versionNumber}`}
                    className={cn(
                      "max-h-96 overflow-auto rounded-md border border-border bg-surface-muted p-3",
                      "font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-slate-800",
                    )}
                  >
                    {doc.textPreview.text}
                    {doc.textPreview.truncated ? "…" : ""}
                  </pre>
                  <p className="text-xs text-muted-foreground">
                    Versão {doc.textPreview.versionNumber} · {formatNumber(doc.textPreview.totalChars)} caracteres
                    {doc.textPreview.truncated ? " (prévia limitada aos primeiros 3.000)" : ""}. O conteúdo do arquivo é
                    tratado como dado não confiável pelas análises de IA.
                  </p>
                </div>
              ) : current && current.extractionStatus !== "succeeded" ? (
                <Callout tone={current.extractionStatus === "failed" ? "warning" : "info"} icon={<FileClock aria-hidden="true" />}>
                  {EXTRACTION_HINTS[current.extractionStatus]}
                </Callout>
              ) : (
                <p className="text-sm text-muted-foreground">Nenhum texto foi extraído da versão atual.</p>
              )}
            </CardContent>
          </Card>

          <AnalysisPanel ctx={ctx} subject={{ type: "document", id: doc.id }} />
          <CommentThread ctx={ctx} entity={{ type: "document", id: doc.id }} />
        </div>

        <div className="flex min-w-0 flex-col gap-6">
          {canUpload ? (
            <Card>
              <CardHeader>
                <CardTitle>Enviar nova versão</CardTitle>
                <CardDescription>
                  A versão atual continua disponível no histórico. Arquivos idênticos à versão atual são recusados.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <DocumentUploadForm mode="version" documentId={doc.id} maxUploadMb={env().MAX_UPLOAD_MB} />
              </CardContent>
            </Card>
          ) : null}

          {canUpload && linkOptions ? (
            <Card>
              <CardHeader>
                <CardTitle>Editar dados</CardTitle>
              </CardHeader>
              <CardContent>
                <details>
                  <summary className="cursor-pointer text-sm font-medium text-primary-700 hover:underline">
                    Editar título, categoria, vínculos e retenção
                  </summary>
                  <div className="mt-4">
                    <DocumentMetadataForm
                      document={{
                        id: doc.id,
                        title: doc.title,
                        description: doc.description,
                        category: doc.category,
                        confidentiality: doc.confidentiality,
                        processId: doc.processId,
                        occurrenceId: doc.occurrenceId,
                        contractId: doc.contractId,
                        retentionUntil: doc.retentionUntil,
                        legalHold: doc.legalHold,
                      }}
                      processOptions={linkOptions.processes}
                      occurrenceOptions={linkOptions.occurrences}
                      contractOptions={linkOptions.contracts}
                      canSetLegalHold={canDelete}
                    />
                  </div>
                </details>
              </CardContent>
            </Card>
          ) : null}

          {doc.legalHold && canDelete ? (
            <Callout tone="info" title="Exclusão bloqueada">
              Este documento está sob preservação legal. Desative a preservação em &ldquo;Editar dados&rdquo; para
              permitir a exclusão.
            </Callout>
          ) : null}

          <EntityHistory ctx={ctx} entity={{ type: "document", id: doc.id }} />
        </div>
      </div>
    </>
  );
}
