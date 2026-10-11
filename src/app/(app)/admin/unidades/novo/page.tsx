import type { Metadata } from "next";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { createUnitAction } from "@/modules/admin/actions";
import { UnitForm } from "@/modules/admin/components/unit-form";
import { requirePageContext } from "@/server/auth/session";

export const metadata: Metadata = { title: "Nova unidade" };

export default async function NewUnitPage() {
  await requirePageContext("admin:users");
  return (
    <>
      <PageHeader
        title="Nova unidade"
        breadcrumbs={[
          { label: "Administração", href: "/admin" },
          { label: "Unidades", href: "/admin/unidades" },
          { label: "Nova unidade" },
        ]}
      />
      <Card>
        <CardContent>
          <UnitForm mode="create" action={createUnitAction} />
        </CardContent>
      </Card>
    </>
  );
}
