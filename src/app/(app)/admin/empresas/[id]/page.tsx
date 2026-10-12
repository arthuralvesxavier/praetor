import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ButtonLink } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DescriptionList } from "@/components/ui/description-list";
import { PageHeader } from "@/components/ui/page-header";
import { StatusBadge } from "@/components/ui/status-badge";
import { formatNumber } from "@/lib/format";
import { param } from "@/lib/search-params";
import { ActionButtonForm } from "@/modules/admin/components/form-utils";
import { RecordActivity } from "@/modules/admin/components/record-activity";
import { deleteCompanyAction, setCompanyActiveAction, updateCompanyAction } from "@/modules/organization/actions";
import { CompanyForm } from "@/modules/organization/components/company-form";
import { getCompany } from "@/modules/organization/service";
import { requirePageContext } from "@/server/auth/session";
import { NotFoundError } from "@/server/lib/errors";

export const metadata: Metadata = { title: "Empresa" };

export default async function CompanyDetailPage(props: PageProps<"/admin/empresas/[id]">) {
  const ctx = await requirePageContext("admin:organization");
  const { id } = await props.params;
  const sp = await props.searchParams;

  let company;
  try {
    company = await getCompany(ctx, id);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
  const refs = company.references;
  const referenced = refs.processes + refs.importBatches + refs.snapshotItems + refs.distributionRules > 0;

  return (
    <>
      <PageHeader
        title={company.name}
        description={company.document ? `CNPJ ${company.document}` : undefined}
        breadcrumbs={[
          { label: "Administração", href: "/admin" },
          { label: "Empresas", href: "/admin/empresas" },
          { label: company.name },
        ]}
        meta={<StatusBadge label={company.isActive ? "Ativa" : "Desativada"} tone={company.isActive ? "success" : "neutral"} />}
        actions={
          <div className="flex flex-wrap items-start gap-2">
            {company.isActive ? (
              <ConfirmDialog
                action={setCompanyActiveAction}
                hiddenFields={{ id: company.id, active: "0" }}
                tone="primary"
                triggerLabel="Desativar"
                triggerVariant="outline"
                title="Desativar empresa?"
                description="A empresa deixa de aparecer para novos cadastros e filtros. Processos, importações e fechamentos já vinculados são mantidos."
                confirmLabel="Desativar"
                pendingLabel="Desativando…"
              />
            ) : (
              <ActionButtonForm
                action={setCompanyActiveAction}
                hiddenFields={{ id: company.id, active: "1" }}
                size="md"
                pendingLabel="Reativando…"
              >
                Reativar
              </ActionButtonForm>
            )}
            <ConfirmDialog
              action={deleteCompanyAction}
              hiddenFields={{ id: company.id }}
              triggerLabel="Excluir"
              title="Excluir empresa?"
              description={
                referenced
                  ? "Esta empresa possui processos, importações, fechamentos mensais ou regras de distribuição vinculados. Ela será desativada em vez de excluída, preservando o histórico."
                  : "A empresa não possui vínculos e será excluída definitivamente."
              }
              confirmLabel={referenced ? "Desativar" : "Excluir"}
              pendingLabel="Processando…"
            />
          </div>
        }
      />

      {param(sp, "criado") ? (
        <Callout tone="success" title="Empresa cadastrada" className="mb-6">
          Vincule a empresa aos processos no cadastro de cada processo ou ao importar a planilha da carteira.
        </Callout>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>Dados da empresa</CardTitle>
          </CardHeader>
          <CardContent>
            <CompanyForm
              mode="edit"
              action={updateCompanyAction}
              defaults={{ id: company.id, name: company.name, document: company.document, isActive: company.isActive }}
            />
          </CardContent>
        </Card>
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader
              actions={
                company.activeProcessCount > 0 ? (
                  <ButtonLink href={`/processos?empresa=${company.id}`} variant="outline" size="sm">
                    Ver carteira
                  </ButtonLink>
                ) : null
              }
            >
              <CardTitle>Vínculos</CardTitle>
              <CardDescription>Empresas com vínculos são desativadas em vez de excluídas.</CardDescription>
            </CardHeader>
            <CardContent>
              <DescriptionList
                columns={1}
                items={[
                  { label: "Processos na carteira ativa", value: formatNumber(company.activeProcessCount) },
                  { label: "Processos vinculados (todas as situações)", value: formatNumber(refs.processes) },
                  { label: "Importações de planilha", value: formatNumber(refs.importBatches) },
                  { label: "Itens de fechamentos mensais", value: formatNumber(refs.snapshotItems) },
                  { label: "Regras de distribuição", value: formatNumber(refs.distributionRules) },
                ]}
              />
            </CardContent>
          </Card>
          <RecordActivity ctx={ctx} entityType="company" entityId={company.id} />
        </div>
      </div>
    </>
  );
}
