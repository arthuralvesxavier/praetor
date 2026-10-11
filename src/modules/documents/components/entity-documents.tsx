import { Download, FileText } from "lucide-react";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow, tableLinkClasses } from "@/components/ui/table";
import { DOCUMENT_CATEGORY_LABELS } from "@/domain/enums";
import type { LinkableEntityType } from "@/domain/entities";
import { formatDate, formatFileSize, pluralize } from "@/lib/format";
import type { AuthContext } from "@/server/auth/context";
import { can } from "@/server/auth/permissions";
import { env } from "@/server/env";
import { listDocuments } from "../service";
import { ConfidentialityBadge, ExtractionStatusBadge } from "./document-badges";
import { downloadHref } from "./document-links";
import { DocumentUploadForm, type UploadLinkField } from "./document-upload-form";

const LINK_FIELD: Record<LinkableEntityType, UploadLinkField> = {
  legal_process: "processId",
  occurrence: "occurrenceId",
  contract: "contractId",
};

const MAX_ITEMS = 50;

export type EntityDocumentsProps = {
  ctx: AuthContext;
  entity: { type: LinkableEntityType; id: string };
  title?: string;
};

/**
 * Documents linked to a process, occurrence or contract (server component),
 * with download of the current version and the upload form when allowed.
 */
export async function EntityDocuments({ ctx, entity, title = "Documentos" }: EntityDocumentsProps) {
  if (!can(ctx, "document:read")) return null;
  const field = LINK_FIELD[entity.type];
  const result = await listDocuments(ctx, { [field]: entity.id, pageSize: MAX_ITEMS });
  const canUpload = can(ctx, "document:upload");
  const headingId = `documentos-${entity.id}`;

  return (
    <Card aria-labelledby={headingId}>
      <CardHeader>
        <CardTitle id={headingId}>{title}</CardTitle>
        <CardDescription>
          {result.total === 0
            ? "Nenhum documento vinculado."
            : `${pluralize(result.total, "documento vinculado", "documentos vinculados")}${
                result.total > result.items.length ? ` (exibindo os ${result.items.length} mais recentes)` : ""
              }.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        <Table aria-label={title}>
          <TableHeader>
            <TableRow>
              <TableHead>Título</TableHead>
              <TableHead>Categoria</TableHead>
              <TableHead>Versão</TableHead>
              <TableHead>Extração</TableHead>
              <TableHead>Atualizado em</TableHead>
              <TableHead>
                <span className="sr-only">Ações</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.items.length === 0 ? (
              <TableEmpty
                colSpan={6}
                message="Nenhum documento vinculado."
                description={canUpload ? "Envie o primeiro documento pelo formulário abaixo." : undefined}
              />
            ) : (
              result.items.map((d) => (
                <TableRow key={d.id} interactive>
                  <TableCell className="min-w-48">
                    <div className="flex flex-col gap-1">
                      <Link href={`/documentos/${d.id}`} className={tableLinkClasses}>
                        {d.title}
                      </Link>
                      <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                        {d.fileName ? <span className="break-all">{d.fileName}</span> : null}
                        {d.sizeBytes != null ? <span>· {formatFileSize(d.sizeBytes)}</span> : null}
                        {d.confidentiality !== "internal" ? <ConfidentialityBadge level={d.confidentiality} /> : null}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>{DOCUMENT_CATEGORY_LABELS[d.category]}</TableCell>
                  <TableCell>{d.currentVersionNumber > 0 ? `v${d.currentVersionNumber}` : "—"}</TableCell>
                  <TableCell>
                    <ExtractionStatusBadge status={d.extractionStatus} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{formatDate(d.updatedAt)}</TableCell>
                  <TableCell className="text-right">
                    {d.currentVersionId ? (
                      <a
                        href={downloadHref(d.id, d.currentVersionId)}
                        className="inline-flex items-center gap-1 text-sm font-medium text-primary-700 hover:underline"
                      >
                        <Download aria-hidden="true" className="size-4" />
                        Baixar<span className="sr-only"> {d.title}</span>
                      </a>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </CardContent>
      {canUpload ? (
        <CardContent className="border-t border-border pt-4">
          <details className="group">
            <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium text-primary-700 hover:underline">
              <FileText aria-hidden="true" className="size-4" />
              Enviar documento
            </summary>
            <div className="mt-4">
              <DocumentUploadForm
                mode="document"
                maxUploadMb={env().MAX_UPLOAD_MB}
                fixedLink={{ field, id: entity.id }}
                afterUpload="refresh"
              />
            </div>
          </details>
        </CardContent>
      ) : null}
    </Card>
  );
}
