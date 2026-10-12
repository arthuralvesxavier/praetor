import { FileUp, FolderOpen } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { FilterBar, FilterSelect } from "@/components/ui/filter-bar";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow, tableLinkClasses } from "@/components/ui/table";
import { DOCUMENT_CATEGORIES, DOCUMENT_CATEGORY_LABELS } from "@/domain/enums";
import { formatDateTime, formatFileSize } from "@/lib/format";
import { optionsFromLabels } from "@/lib/options";
import { enumParam, hasAnyParam, pageParam, param } from "@/lib/search-params";
import { ConfidentialityBadge, ExtractionStatusBadge, LegalHoldBadge } from "@/modules/documents/components/document-badges";
import { DocumentLinks } from "@/modules/documents/components/document-links";
import { listDocuments } from "@/modules/documents/service";
import { can } from "@/server/auth/permissions";
import { requirePageContext } from "@/server/auth/session";

export const metadata: Metadata = { title: "Documentos" };

export default async function DocumentsPage(props: PageProps<"/documentos">) {
  const ctx = await requirePageContext("document:read");
  const sp = await props.searchParams;
  const q = param(sp, "q");
  const category = enumParam(sp, "categoria", DOCUMENT_CATEGORIES);
  const result = await listDocuments(ctx, { q, category, page: pageParam(sp) });
  const canUpload = can(ctx, "document:upload");
  const filtered = hasAnyParam(sp, ["q", "categoria"]);

  return (
    <>
      <PageHeader
        title="Documentos"
        description="Arquivos da organização com versões, extração de texto e vínculos com processos, ocorrências e contratos."
        breadcrumbs={[{ label: "Painel executivo", href: "/dashboard" }, { label: "Documentos" }]}
        actions={
          canUpload ? (
            <ButtonLink href="/documentos/novo">
              <FileUp aria-hidden="true" />
              Novo documento
            </ButtonLink>
          ) : null
        }
      />

      <FilterBar basePath="/documentos" defaultQuery={q} searchPlaceholder="Título, descrição ou nome do arquivo">
        <FilterSelect
          name="categoria"
          label="Categoria"
          options={optionsFromLabels(DOCUMENT_CATEGORY_LABELS)}
          defaultValue={category}
        />
      </FilterBar>

      {result.total === 0 && !filtered ? (
        <EmptyState
          icon={<FolderOpen aria-hidden="true" />}
          title="Nenhum documento enviado"
          description="Os documentos enviados aparecem aqui, com suas versões e o status da extração de texto."
          action={
            canUpload ? (
              <ButtonLink href="/documentos/novo">
                <FileUp aria-hidden="true" />
                Enviar o primeiro documento
              </ButtonLink>
            ) : undefined
          }
        />
      ) : (
        <>
          <Card className="py-0">
            <Table aria-label="Documentos">
              <TableHeader>
                <TableRow>
                  <TableHead>Título</TableHead>
                  <TableHead>Categoria</TableHead>
                  <TableHead>Vínculo</TableHead>
                  <TableHead>Versão atual</TableHead>
                  <TableHead>Extração</TableHead>
                  <TableHead>Confidencialidade</TableHead>
                  <TableHead>Atualizado em</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.items.length === 0 ? (
                  <TableEmpty
                    colSpan={7}
                    message="Nenhum documento encontrado."
                    description="Ajuste a busca ou os filtros."
                  />
                ) : (
                  result.items.map((d) => (
                    <TableRow key={d.id} interactive>
                      <TableCell className="min-w-56">
                        <div className="flex flex-col gap-0.5">
                          <Link href={`/documentos/${d.id}`} className={tableLinkClasses}>
                            {d.title}
                          </Link>
                          {d.fileName ? (
                            <span className="text-xs break-all text-muted-foreground">
                              {d.fileName}
                              {d.sizeBytes != null ? ` · ${formatFileSize(d.sizeBytes)}` : ""}
                            </span>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{DOCUMENT_CATEGORY_LABELS[d.category]}</TableCell>
                      <TableCell className="min-w-48 max-w-72">
                        <DocumentLinks links={d.links} />
                      </TableCell>
                      <TableCell>{d.currentVersionNumber > 0 ? `v${d.currentVersionNumber}` : <span className="text-muted-foreground">Sem versão</span>}</TableCell>
                      <TableCell>
                        <ExtractionStatusBadge status={d.extractionStatus} />
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          <ConfidentialityBadge level={d.confidentiality} />
                          {d.legalHold ? <LegalHoldBadge /> : null}
                        </div>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{formatDateTime(d.updatedAt)}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </Card>
          <Pagination
            page={result.page}
            pageSize={result.pageSize}
            total={result.total}
            basePath="/documentos"
            searchParams={sp}
          />
        </>
      )}
    </>
  );
}
