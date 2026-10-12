import type { Metadata } from "next";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { createLawFirmAction } from "@/modules/organization/actions";
import { LawFirmForm } from "@/modules/organization/components/law-firm-form";
import { requirePageContext } from "@/server/auth/session";

export const metadata: Metadata = { title: "Novo escritório externo" };

export default async function NewLawFirmPage() {
  await requirePageContext("admin:organization");
  return (
    <>
      <PageHeader
        title="Novo escritório externo"
        description="Depois de cadastrar, crie os usuários do escritório com o perfil Escritório externo."
        breadcrumbs={[
          { label: "Administração", href: "/admin" },
          { label: "Escritórios externos", href: "/admin/escritorios" },
          { label: "Novo escritório" },
        ]}
      />
      <Card>
        <CardContent>
          <LawFirmForm mode="create" action={createLawFirmAction} />
        </CardContent>
      </Card>
    </>
  );
}
