import type { Metadata } from "next";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { createCompanyAction } from "@/modules/organization/actions";
import { CompanyForm } from "@/modules/organization/components/company-form";
import { requirePageContext } from "@/server/auth/session";

export const metadata: Metadata = { title: "Nova empresa" };

export default async function NewCompanyPage() {
  await requirePageContext("admin:organization");
  return (
    <>
      <PageHeader
        title="Nova empresa"
        description="Empresa do grupo que figura nos processos da carteira."
        breadcrumbs={[
          { label: "Administração", href: "/admin" },
          { label: "Empresas", href: "/admin/empresas" },
          { label: "Nova empresa" },
        ]}
      />
      <Card>
        <CardContent>
          <CompanyForm mode="create" action={createCompanyAction} />
        </CardContent>
      </Card>
    </>
  );
}
