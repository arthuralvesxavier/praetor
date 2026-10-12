import { FileSpreadsheet, Plus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow, tableLinkClasses } from "@/components/ui/table";
import { formatDateTime, formatNumber } from "@/lib/format";
import { pageParam } from "@/lib/search-params";
import { BatchStatusBadge } from "@/modules/imports/components/badges";
import { listImportBatches } from "@/modules/imports/service";
import { requirePageContext } from "@/server/auth/session";

export const metadata: Metadata = { title: "Importação de planilhas" };

export default async function ImportBatchesPage(props: PageProps<"/importacoes">) {
  const ctx = await requirePageContext("import:run");
  const sp = await props.searchParams;
  const result = await listImportBatches(ctx, { page: pageParam(sp) });

  return (
    <>
      <PageHeader
        title="Importação de planilhas"
        description="Carga e atualização da carteira a partir da planilha de passivo (aba consolidada e abas por instância). Nada é gravado antes da sua confirmação, e cada importação confirmada pode ser desfeita enquanto os processos não forem alterados."
        breadcrumbs={[{ label: "Painel executivo", href: "/dashboard" }, { label: "Importação de planilhas" }]}
        actions={
          <ButtonLink href="/importacoes/nova">
            <Plus aria-hidden="true" />
            Nova importação
          </ButtonLink>
        }
      />

      <Card className="py-0">
        <Table aria-label="Importações de planilha">
          <TableHeader>
            <TableRow>
              <TableHead>Arquivo</TableHead>
              <TableHead>Empresa</TableHead>
              <TableHead>Situação</TableHead>
              <TableHead className="text-right">Processos</TableHead>
              <TableHead className="text-right">Novos</TableHead>
              <TableHead className="text-right">Atualizações</TableHead>
              <TableHead className="text-right">Erros</TableHead>
              <TableHead className="text-right">Divergências</TableHead>
              <TableHead>Enviada por</TableHead>
              <TableHead>Data</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.items.length === 0 ? (
              <TableEmpty
                colSpan={10}
                message="Nenhuma planilha importada."
                description="Envie a planilha da carteira para conferir o relatório de inconsistências antes de gravar."
                action={
                  <ButtonLink href="/importacoes/nova" size="sm">
                    <FileSpreadsheet aria-hidden="true" />
                    Importar planilha
                  </ButtonLink>
                }
              />
            ) : (
              result.items.map((b) => (
                <TableRow key={b.id} interactive>
                  <TableCell className="max-w-72">
                    <Link href={`/importacoes/${b.id}`} className={`${tableLinkClasses} break-all`}>
                      {b.fileName}
                    </Link>
                  </TableCell>
                  <TableCell>{b.companyName ?? "—"}</TableCell>
                  <TableCell>
                    <BatchStatusBadge status={b.status} />
                  </TableCell>
                  <TableCell className="text-right">{formatNumber(b.stats?.processesDetected)}</TableCell>
                  <TableCell className="text-right">{formatNumber(b.stats?.toCreate)}</TableCell>
                  <TableCell className="text-right">{formatNumber(b.stats?.toUpdate)}</TableCell>
                  <TableCell className="text-right">{formatNumber(b.stats?.errors)}</TableCell>
                  <TableCell className="text-right">{formatNumber(b.stats?.divergences)}</TableCell>
                  <TableCell>{b.createdByName ?? "—"}</TableCell>
                  <TableCell className="whitespace-nowrap">{formatDateTime(b.createdAt)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>
      <Pagination page={result.page} pageSize={result.pageSize} total={result.total} basePath="/importacoes" searchParams={sp} />
    </>
  );
}
