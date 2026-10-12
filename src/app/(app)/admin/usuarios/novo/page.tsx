import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/page-header";
import { idParam } from "@/lib/search-params";
import { createUserAction } from "@/modules/admin/actions";
import { UserForm } from "@/modules/admin/components/user-form";
import { listTeamOptions, listUnitOptions } from "@/modules/admin/service";
import { listLawFirmOptions } from "@/modules/organization/service";
import { requirePageContext } from "@/server/auth/session";

export const metadata: Metadata = { title: "Novo usuário" };

export default async function NewUserPage(props: PageProps<"/admin/usuarios/novo">) {
  const ctx = await requirePageContext("admin:users");
  const sp = await props.searchParams;
  const [units, teams, lawFirms] = await Promise.all([listUnitOptions(ctx), listTeamOptions(ctx), listLawFirmOptions(ctx)]);
  // `?escritorio=<id>` (from the law firm page) pre-selects the external-counsel role and the firm.
  const firmParam = idParam(sp, "escritorio");
  const presetFirm = firmParam && lawFirms.some((f) => f.id === firmParam) ? firmParam : null;

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
        lawFirms={lawFirms.map((f) => ({ value: f.id, label: f.name }))}
        teams={teams.map((t) => ({ value: t.id, label: t.name }))}
        defaults={
          presetFirm
            ? {
                name: "",
                email: "",
                role: "external_counsel",
                unitId: null,
                lawFirmId: presetFirm,
                jobTitle: null,
                isActive: true,
                teamIds: [],
              }
            : undefined
        }
      />
    </>
  );
}
