import type { Metadata } from "next";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { createTeamAction } from "@/modules/admin/actions";
import { TeamForm } from "@/modules/admin/components/team-form";
import { listAllUserOptions, listUnitOptions } from "@/modules/admin/service";
import { requirePageContext } from "@/server/auth/session";

export const metadata: Metadata = { title: "Nova equipe" };

export default async function NewTeamPage() {
  const ctx = await requirePageContext("admin:users");
  const [units, users] = await Promise.all([listUnitOptions(ctx), listAllUserOptions(ctx)]);

  return (
    <>
      <PageHeader
        title="Nova equipe"
        breadcrumbs={[
          { label: "Administração", href: "/admin" },
          { label: "Equipes", href: "/admin/equipes" },
          { label: "Nova equipe" },
        ]}
      />
      <Card>
        <CardContent>
          <TeamForm
            mode="create"
            action={createTeamAction}
            units={units.map((u) => ({ value: u.id, label: u.name }))}
            users={users.filter((u) => u.isActive)}
          />
        </CardContent>
      </Card>
    </>
  );
}
