import { Plus, Users } from "lucide-react";
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
import { ROLE_LABELS, ROLES } from "@/domain/enums";
import { formatDateTime } from "@/lib/format";
import { optionsFromLabels } from "@/lib/options";
import { enumParam, hasAnyParam, idParam, pageParam, param } from "@/lib/search-params";
import { AdminNav } from "@/modules/admin/components/admin-nav";
import { USER_SITUATIONS } from "@/modules/admin/schemas";
import { listAllUnitOptions, listUsers } from "@/modules/admin/service";
import { listAllLawFirmOptions } from "@/modules/organization/service";
import { requirePageContext } from "@/server/auth/session";

export const metadata: Metadata = { title: "Usuários" };

const FILTER_KEYS = ["q", "perfil", "unidade", "escritorio", "situacao"] as const;

export default async function UsersPage(props: PageProps<"/admin/usuarios">) {
  const ctx = await requirePageContext("admin:users");
  const sp = await props.searchParams;
  const situation = enumParam(sp, "situacao", USER_SITUATIONS);
  const [result, unitOptions, lawFirmOptions] = await Promise.all([
    listUsers(ctx, {
      q: param(sp, "q")?.slice(0, 120),
      role: enumParam(sp, "perfil", ROLES),
      unitId: idParam(sp, "unidade"),
      lawFirmId: idParam(sp, "escritorio"),
      active: situation === "ativos" ? true : situation === "inativos" ? false : undefined,
      page: pageParam(sp),
    }),
    listAllUnitOptions(ctx),
    listAllLawFirmOptions(ctx),
  ]);
  const filtered = hasAnyParam(sp, FILTER_KEYS);

  return (
    <>
      <PageHeader
        title="Usuários"
        description="Pessoas com acesso ao Praetor, seus perfis e unidades."
        breadcrumbs={[{ label: "Administração", href: "/admin" }, { label: "Usuários" }]}
        actions={
          <ButtonLink href="/admin/usuarios/novo">
            <Plus aria-hidden="true" />
            Novo usuário
          </ButtonLink>
        }
      />
      <AdminNav ctx={ctx} active="usuarios" />

      <FilterBar
        basePath="/admin/usuarios"
        defaultQuery={param(sp, "q")}
        searchPlaceholder="Nome, e-mail ou cargo"
        showClear={filtered}
      >
        <FilterSelect name="perfil" label="Perfil" options={optionsFromLabels(ROLE_LABELS)} defaultValue={param(sp, "perfil")} />
        <FilterSelect
          name="unidade"
          label="Unidade"
          options={unitOptions.map((u) => ({ value: u.id, label: u.isActive ? u.name : `${u.name} (desativada)` }))}
          defaultValue={param(sp, "unidade")}
        />
        {lawFirmOptions.length > 0 ? (
          <FilterSelect
            name="escritorio"
            label="Escritório externo"
            options={lawFirmOptions.map((f) => ({ value: f.id, label: f.isActive ? f.name : `${f.name} (desativado)` }))}
            defaultValue={param(sp, "escritorio")}
          />
        ) : null}
        <FilterSelect
          name="situacao"
          label="Situação"
          options={[
            { value: "ativos", label: "Ativos" },
            { value: "inativos", label: "Inativos" },
          ]}
          defaultValue={param(sp, "situacao")}
        />
      </FilterBar>

      {result.total === 0 && !filtered ? (
        <EmptyState
          icon={<Users />}
          title="Nenhum usuário cadastrado"
          description="Cadastre as pessoas do departamento jurídico e defina o perfil de cada uma."
          action={<ButtonLink href="/admin/usuarios/novo">Novo usuário</ButtonLink>}
        />
      ) : (
        <>
          <Card className="py-0">
            <Table aria-label="Usuários">
              <TableHeader>
                <TableRow>
                  <TableHead>Nome</TableHead>
                  <TableHead>E-mail</TableHead>
                  <TableHead>Perfil</TableHead>
                  <TableHead>Unidade / escritório</TableHead>
                  <TableHead>Equipes</TableHead>
                  <TableHead>Situação</TableHead>
                  <TableHead>Último acesso</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.items.length === 0 ? (
                  <TableEmpty colSpan={7} message="Nenhum usuário encontrado com estes filtros." />
                ) : (
                  result.items.map((u) => (
                    <TableRow key={u.id} interactive>
                      <TableCell>
                        <Link href={`/admin/usuarios/${u.id}`} className={tableLinkClasses}>
                          {u.name}
                        </Link>
                        {u.jobTitle ? <span className="block text-xs text-muted-foreground">{u.jobTitle}</span> : null}
                        {u.id === ctx.userId ? <span className="block text-xs text-muted-foreground">(você)</span> : null}
                      </TableCell>
                      <TableCell className="break-all">{u.email}</TableCell>
                      <TableCell>{ROLE_LABELS[u.role]}</TableCell>
                      <TableCell>
                        {u.role === "external_counsel" ? (
                          <span>
                            <span className="block text-xs text-muted-foreground">Escritório</span>
                            {u.lawFirmName ?? <span className="text-muted-foreground">Não vinculado</span>}
                          </span>
                        ) : (
                          u.unitName ?? <span className="text-muted-foreground">Sem unidade</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {u.teams.length > 0 ? (
                          u.teams.map((t) => t.name).join(", ")
                        ) : (
                          <span className="text-muted-foreground">Sem equipe</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <StatusBadge label={u.isActive ? "Ativo" : "Inativo"} tone={u.isActive ? "success" : "neutral"} />
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {u.lastLoginAt ? formatDateTime(u.lastLoginAt) : <span className="text-muted-foreground">Nunca acessou</span>}
                      </TableCell>
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
            basePath="/admin/usuarios"
            searchParams={sp}
          />
        </>
      )}
    </>
  );
}
