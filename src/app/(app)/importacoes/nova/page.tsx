import type { Metadata } from "next";
import Link from "next/link";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { todayISO } from "@/lib/format";
import { listUnitOptions } from "@/modules/admin/service";
import { ImportForm } from "@/modules/imports/components/import-form";
import { listCompanyOptions } from "@/modules/organization/service";
import { can } from "@/server/auth/permissions";
import { requirePageContext } from "@/server/auth/session";

export const metadata: Metadata = { title: "Nova importação" };

const STEPS = [
  { title: "Envie a planilha", text: "Arquivo .xlsx com a aba consolidada e, se houver, as abas por instância." },
  { title: "Confira o relatório", text: "Processos novos e atualizados, vínculos de instância, erros, alertas e divergências entre abas." },
  { title: "Confirme ou descarte", text: "Só a confirmação grava na carteira. Uma importação confirmada pode ser desfeita." },
];

export default async function NewImportPage() {
  const ctx = await requirePageContext("import:run");
  const [companies, units] = await Promise.all([listCompanyOptions(ctx), listUnitOptions(ctx)]);

  return (
    <>
      <PageHeader
        title="Nova importação"
        description="Leitura da planilha de passivo com relatório de inconsistências antes de qualquer gravação."
        breadcrumbs={[
          { label: "Painel executivo", href: "/dashboard" },
          { label: "Importação de planilhas", href: "/importacoes" },
          { label: "Nova importação" },
        ]}
      />

      <ol className="mb-6 grid gap-3 sm:grid-cols-3" aria-label="Etapas da importação">
        {STEPS.map((s, i) => (
          <li key={s.title} className="flex gap-3 rounded-lg border border-border bg-surface p-4 shadow-xs">
            <span
              aria-hidden="true"
              className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground"
            >
              {i + 1}
            </span>
            <div>
              <p className="text-sm font-semibold text-slate-900">
                <span className="sr-only">Etapa {i + 1}: </span>
                {s.title}
              </p>
              <p className="text-sm text-muted-foreground">{s.text}</p>
            </div>
          </li>
        ))}
      </ol>

      {companies.length === 0 ? (
        <Callout tone="warning" title="Cadastre a empresa da carteira antes de importar">
          A importação vincula cada processo a uma empresa do grupo e marca como cliente a parte com o mesmo nome.{" "}
          {can(ctx, "admin:organization") ? (
            <Link href="/admin/empresas">Cadastrar empresa</Link>
          ) : (
            "Peça a um administrador para cadastrar a empresa."
          )}
        </Callout>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Planilha e parâmetros</CardTitle>
            <CardDescription>
              Os números de processo (CNJ) são a chave: um processo por número, com um vínculo para cada instância. Valores vazios ficam
              como “não informado”, nunca zero.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ImportForm
              companies={companies.map((c) => ({ value: c.id, label: c.name }))}
              units={units.map((u) => ({ value: u.id, label: u.name }))}
              today={todayISO()}
            />
          </CardContent>
        </Card>
      )}
    </>
  );
}
