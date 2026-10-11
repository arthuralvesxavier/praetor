import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/page-header";
import { createUserAction } from "@/modules/admin/actions";
import { UserForm } from "@/modules/admin/components/user-form";
import { listTeamOptions, listUnitOptions } from "@/modules/admin/service";
import { requirePageContext } from "@/server/auth/session";

export const metadata: Metadata = { title: "Novo usuário" };

export default async function NewUserPage() {
  const ctx = await requirePageContext("admin:users");
  const [units, teams] = await Promise.all([listUnitOptions(ctx), listTeamOptions(ctx)]);

  return (
    <>
      <PageHeader
        title="Novo usuário"
        description="O usuário entra com o e-mail e a senha inicial definidos aqui."
        breadcrumbs={[
          { label: "Administração", href: "/admin" },
          { label: "Usuários", href: "/admin/usuarios" },
          { label: "Novo usuário" },
        ]}
      />
      <UserForm
        mode="create"
        action={createUserAction}
        units={units.map((u) => ({ value: u.id, label: u.name }))}
        teams={teams.map((t) => ({ value: t.id, label: t.name }))}
      />
    </>
  );
}
