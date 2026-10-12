import { Briefcase, Plus } from "lucide-react";
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
import { listLawFirms } from "@/modules/organization/service";
import { requirePageContext } from "@/server/auth/session";

export const metadata: Metadata = { title: "Escritórios externos" };

export default async function LawFirmsPage(props: PageProps<"/admin/escritorios">) {
  const ctx = await requirePageContext("admin:organization");
  const sp = await props.searchParams;
  const situation = enumParam(sp, "situacao", USER_SITUATIONS);
  const result = await listLawFirms(ctx, {
    q: param(sp, "q")?.slice(0, 120),
    active: situation === "ativos" ? true : situation === "inativos" ? false : undefined,
    page: pageParam(sp),
  });
  const filtered = hasAnyParam(sp, ["q", "situacao"]);

  return (
    <>
      <PageHeader
        title="Escritórios externos"
        description="Escritórios que patrocinam processos da carteira. Usuários do perfil Escritório externo veem somente os processos atribuídos ao seu escritório."
        breadcrumbs={[{ label: "Administração", href: "/admin" }, { label: "Escritórios externos" }]}
        actions={
          <ButtonLink href="/admin/escritorios/novo">
            <Plus aria-hidden="true" />
            Novo escritório
          </ButtonLink>
        }
      />
      <AdminNav ctx={ctx} active="escritorios" />

      <FilterBar
        basePath="/admin/escritorios"
        defaultQuery={param(sp, "q")}
        searchPlaceholder="Nome, CNPJ ou contato"
        showClear={filtered}
      >
        <FilterSelect
          name="situacao"
          label="Situação"
          options={[
            { value: "ativos", label: "Ativos" },
            { value: "inativos", label: "Desativados" },
          ]}
          defaultValue={param(sp, "situacao")}
        />
      </FilterBar>

      {result.total === 0 && !filtered ? (
        <EmptyState
          icon={<Briefcase />}
          title="Nenhum escritório externo cadastrado"
          description="Cadastre os escritórios que patrocinam processos para atribuir a carteira e dar acesso restrito aos seus advogados."
          action={<ButtonLink href="/admin/escritorios/novo">Novo escritório</ButtonLink>}
        />
      ) : (
        <>
          <Card className="py-0">
            <Table aria-label="Escritórios externos">
              <TableHeader>
                <TableRow>
                  <TableHead>Escritório</TableHead>
                  <TableHead>CNPJ</TableHead>
                  <TableHead>Contato</TableHead>
                  <TableHead className="text-right">Usuários ativos</TableHead>
                  <TableHead className="text-right">Processos na carteira ativa</TableHead>
                  <TableHead>Situação</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.items.length === 0 ? (
                  <TableEmpty colSpan={6} message="Nenhum escritório encontrado com estes filtros." />
                ) : (
                  result.items.map((f) => (
                    <TableRow key={f.id} interactive>
                      <TableCell>
                        <Link href={`/admin/escritorios/${f.id}`} className={tableLinkClasses}>
                          {f.name}
                        </Link>
                      </TableCell>
                      <TableCell className="whitespace-nowrap tabular-nums">
                        {f.document ?? <span className="text-muted-foreground">Não informado</span>}
                      </TableCell>
                      <TableCell>
                        {f.contactName || f.contactEmail ? (
                          <>
                            {f.contactName ? <span className="block">{f.contactName}</span> : null}
                            {f.contactEmail ? (
                              <span className="block break-all text-xs text-muted-foreground">{f.contactEmail}</span>
                            ) : null}
                          </>
                        ) : (
                          <span className="text-muted-foreground">Não informado</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{formatNumber(f.activeUserCount)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {f.activeProcessCount > 0 ? (
                          <Link
                            href={`/processos?escritorio=${f.id}`}
                            className="text-primary-600 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                          >
                            {formatNumber(f.activeProcessCount)}
                          </Link>
                        ) : (
                          formatNumber(0)
                        )}
                      </TableCell>
                      <TableCell>
                        <StatusBadge label={f.isActive ? "Ativo" : "Desativado"} tone={f.isActive ? "success" : "neutral"} />
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </Card>
          <Pagination page={result.page} pageSize={result.pageSize} total={result.total} basePath="/admin/escritorios" searchParams={sp} />
        </>
      )}
    </>
  );
}
