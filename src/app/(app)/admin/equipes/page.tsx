import { Plus, UsersRound } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { FilterBar } from "@/components/ui/filter-bar";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
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
import { hasAnyParam, pageParam, param } from "@/lib/search-params";
import { AdminNav } from "@/modules/admin/components/admin-nav";
import { listTeams } from "@/modules/admin/service";
import { requirePageContext } from "@/server/auth/session";

export const metadata: Metadata = { title: "Equipes" };

export default async function TeamsPage(props: PageProps<"/admin/equipes">) {
  const ctx = await requirePageContext("admin:users");
  const sp = await props.searchParams;
  const result = await listTeams(ctx, { q: param(sp, "q")?.slice(0, 120), page: pageParam(sp) });
  const filtered = hasAnyParam(sp, ["q"]);

  return (
    <>
      <PageHeader
        title="Equipes"
        description="Grupos de trabalho do departamento jurídico. Equipes organizam o trabalho e não alteram a visibilidade dos registros."
        breadcrumbs={[{ label: "Administração", href: "/admin" }, { label: "Equipes" }]}
        actions={
          <ButtonLink href="/admin/equipes/novo">
            <Plus aria-hidden="true" />
            Nova equipe
          </ButtonLink>
        }
      />
      <AdminNav ctx={ctx} active="equipes" />

      <FilterBar basePath="/admin/equipes" defaultQuery={param(sp, "q")} searchPlaceholder="Nome ou descrição" showClear={filtered} />

      {result.total === 0 && !filtered ? (
        <EmptyState
          icon={<UsersRound />}
          title="Nenhuma equipe cadastrada"
          description="Crie equipes para agrupar advogados e analistas por área ou frente de trabalho."
          action={<ButtonLink href="/admin/equipes/novo">Nova equipe</ButtonLink>}
        />
      ) : (
        <>
          <Card className="py-0">
            <Table aria-label="Equipes">
              <TableHeader>
                <TableRow>
                  <TableHead>Nome</TableHead>
                  <TableHead>Unidade</TableHead>
                  <TableHead>Líder</TableHead>
                  <TableHead className="text-right">Membros</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.items.length === 0 ? (
                  <TableEmpty colSpan={4} message="Nenhuma equipe encontrada com estes filtros." />
                ) : (
                  result.items.map((t) => (
                    <TableRow key={t.id} interactive>
                      <TableCell>
                        <Link href={`/admin/equipes/${t.id}`} className={tableLinkClasses}>
                          {t.name}
                        </Link>
                        {t.description ? (
                          <span className="block max-w-md truncate text-xs text-muted-foreground">{t.description}</span>
                        ) : null}
                      </TableCell>
                      <TableCell>{t.unitName ?? <span className="text-muted-foreground">Sem unidade</span>}</TableCell>
                      <TableCell>{t.leaderName ?? <span className="text-muted-foreground">Sem líder</span>}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatNumber(t.memberCount)}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </Card>
          <Pagination page={result.page} pageSize={result.pageSize} total={result.total} basePath="/admin/equipes" searchParams={sp} />
        </>
      )}
    </>
  );
}
