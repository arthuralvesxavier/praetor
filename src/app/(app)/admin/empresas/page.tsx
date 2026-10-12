import { Factory, Plus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { FilterBar, FilterSelect } from "@/components/ui/filter-bar";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
  tableLinkClasses,
} from "@/components/ui/table";
import { formatNumber } from "@/lib/format";
import { enumParam, hasAnyParam, pageParam, param } from "@/lib/search-params";
import { AdminNav } from "@/modules/admin/components/admin-nav";
import { USER_SITUATIONS } from "@/modules/admin/schemas";
import { listCompanies } from "@/modules/organization/service";
import { requirePageContext } from "@/server/auth/session";

export const metadata: Metadata = { title: "Empresas" };

export default async function CompaniesPage(props: PageProps<"/admin/empresas">) {
  const ctx = await requirePageContext("admin:organization");
  const sp = await props.searchParams;
  const situation = enumParam(sp, "situacao", USER_SITUATIONS);
  const result = await listCompanies(ctx, {
    q: param(sp, "q")?.slice(0, 120),
    active: situation === "ativos" ? true : situation === "inativos" ? false : undefined,
    page: pageParam(sp),
  });
  const filtered = hasAnyParam(sp, ["q", "situacao"]);

  return (
    <>
      <PageHeader
        title="Empresas"
        description="Empresas do grupo atendidas pelo jurídico. A carteira, os relatórios e o painel executivo podem ser filtrados por empresa."
        breadcrumbs={[{ label: "Administração", href: "/admin" }, { label: "Empresas" }]}
        actions={
          <ButtonLink href="/admin/empresas/novo">
            <Plus aria-hidden="true" />
            Nova empresa
          </ButtonLink>
        }
      />
      <AdminNav ctx={ctx} active="empresas" />

      <FilterBar basePath="/admin/empresas" defaultQuery={param(sp, "q")} searchPlaceholder="Nome ou CNPJ" showClear={filtered}>
        <FilterSelect
          name="situacao"
          label="Situação"
          options={[
            { value: "ativos", label: "Ativas" },
            { value: "inativos", label: "Desativadas" },
          ]}
          defaultValue={param(sp, "situacao")}
        />
      </FilterBar>

      {result.total === 0 && !filtered ? (
        <EmptyState
          icon={<Factory />}
          title="Nenhuma empresa cadastrada"
          description="Cadastre as empresas do grupo para filtrar a carteira, os relatórios e os indicadores por empresa."
          action={<ButtonLink href="/admin/empresas/novo">Nova empresa</ButtonLink>}
        />
      ) : (
        <>
          <Card className="py-0">
            <Table aria-label="Empresas">
              <TableHeader>
                <TableRow>
                  <TableHead>Nome</TableHead>
                  <TableHead>CNPJ</TableHead>
                  <TableHead className="text-right">Processos na carteira ativa</TableHead>
                  <TableHead>Situação</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.items.length === 0 ? (
                  <TableEmpty colSpan={4} message="Nenhuma empresa encontrada com estes filtros." />
                ) : (
                  result.items.map((c) => (
                    <TableRow key={c.id} interactive>
                      <TableCell>
                        <Link href={`/admin/empresas/${c.id}`} className={tableLinkClasses}>
                          {c.name}
                        </Link>
                      </TableCell>
                      <TableCell className="whitespace-nowrap tabular-nums">
                        {c.document ?? <span className="text-muted-foreground">Não informado</span>}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {c.activeProcessCount > 0 ? (
                          <Link
                            href={`/processos?empresa=${c.id}`}
                            className="text-primary-600 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                          >
                            {formatNumber(c.activeProcessCount)}
                          </Link>
                        ) : (
                          formatNumber(0)
                        )}
                      </TableCell>
                      <TableCell>
                        <StatusBadge label={c.isActive ? "Ativa" : "Desativada"} tone={c.isActive ? "success" : "neutral"} />
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </Card>
          <Pagination page={result.page} pageSize={result.pageSize} total={result.total} basePath="/admin/empresas" searchParams={sp} />
        </>
      )}
    </>
  );
}
