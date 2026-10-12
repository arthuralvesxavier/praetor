import type { Metadata } from "next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { LegalReportSettingsForm } from "@/modules/legal-reports/components/settings-form";
import { getLegalReportSettings } from "@/modules/legal-reports/settings-service";
import { requirePageContext } from "@/server/auth/session";

export const metadata: Metadata = { title: "Parâmetros dos relatórios jurídicos" };

export default async function LegalReportSettingsPage() {
  const ctx = await requirePageContext("admin:organization");
  const settings = await getLegalReportSettings(ctx);
  return (
    <>
      <PageHeader
        title="Parâmetros dos relatórios jurídicos"
        description="Limite de confiança para afirmar um item, faixas de probabilidade dos cenários e base legal citada na capa."
        breadcrumbs={[
          { label: "Painel executivo", href: "/dashboard" },
          { label: "Relatórios jurídicos", href: "/relatorios-juridicos" },
          { label: "Parâmetros" },
        ]}
      />
      <Card>
        <CardHeader>
          <CardTitle as="h2">Parâmetros</CardTitle>
          <CardDescription>
            Valem para os próximos relatórios. Cada relatório emitido guarda os parâmetros usados e não muda depois de aprovado.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <LegalReportSettingsForm values={settings} />
        </CardContent>
      </Card>
    </>
  );
}
