import { Building2, Plus } from "lucide-react";
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
import { listUnits } from "@/modules/admin/service";
import { requirePageContext } from "@/server/auth/session";

export const metadata: Metadata = { title: "Unidades" };

export default async function UnitsPage(props: PageProps<"/admin/unidades">) {
  const ctx = await requirePageContext("admin:users");
  const sp = await props.searchParams;
  const situation = enumParam(sp, "situacao", USER_SITUATIONS);
  const result = await listUnits(ctx, {
    q: param(sp, "q")?.slice(0, 120),
    active: situation === "ativos" ? true : situation === "inativos" ? false : undefined,
    page: pageParam(sp),
  });
  const filtered = hasAnyParam(sp, ["q", "situacao"]);

  return (
    <>
      <PageHeader
        title="Unidades"
        description="Matriz e filiais. Advogados e analistas veem apenas os registros da sua unidade (ou sem unidade)."
        breadcrumbs={[{ label: "Administração", href: "/admin" }, { label: "Unidades" }]}
        actions={
          <ButtonLink href="/admin/unidades/novo">
            <Plus aria-hidden="true" />
            Nova unidade
          </ButtonLink>
        }
      />
      <AdminNav ctx={ctx} active="unidades" />

      <FilterBar basePath="/admin/unidades" defaultQuery={param(sp, "q")} searchPlaceholder="Nome ou código" showClear={filtered}>
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
          icon={<Building2 />}
          title="Nenhuma unidade cadastrada"
          description="Cadastre a matriz e as filiais para organizar usuários e registros por unidade."
          action={<ButtonLink href="/admin/unidades/novo">Nova unidade</ButtonLink>}
        />
      ) : (
        <>
          <Card className="py-0">
            <Table aria-label="Unidades">
              <TableHeader>
                <TableRow>
                  <TableHead>Nome</TableHead>
                  <TableHead>Código</TableHead>
                  <TableHead className="text-right">Usuários</TableHead>
                  <TableHead className="text-right">Equipes</TableHead>
                  <TableHead>Situação</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.items.length === 0 ? (
                  <TableEmpty colSpan={5} message="Nenhuma unidade encontrada com estes filtros." />
                ) : (
                  result.items.map((u) => (
                    <TableRow key={u.id} interactive>
                      <TableCell>
                        <Link href={`/admin/unidades/${u.id}`} className={tableLinkClasses}>
                          {u.name}
                        </Link>
                      </TableCell>
                      <TableCell>{u.code ?? <span className="text-muted-foreground">Não informado</span>}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatNumber(u.userCount)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatNumber(u.teamCount)}</TableCell>
                      <TableCell>
                        <StatusBadge label={u.isActive ? "Ativa" : "Desativada"} tone={u.isActive ? "success" : "neutral"} />
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </Card>
          <Pagination page={result.page} pageSize={result.pageSize} total={result.total} basePath="/admin/unidades" searchParams={sp} />
        </>
      )}
    </>
  );
}
