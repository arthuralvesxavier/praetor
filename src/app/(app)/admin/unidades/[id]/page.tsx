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
import { deleteUnitAction, setUnitActiveAction, updateUnitAction } from "@/modules/admin/actions";
import { ActionButtonForm } from "@/modules/admin/components/form-utils";
import { RecordActivity } from "@/modules/admin/components/record-activity";
import { UnitForm } from "@/modules/admin/components/unit-form";
import { getUnit } from "@/modules/admin/service";
import { requirePageContext } from "@/server/auth/session";
import { NotFoundError } from "@/server/lib/errors";

export const metadata: Metadata = { title: "Unidade" };

export default async function UnitDetailPage(props: PageProps<"/admin/unidades/[id]">) {
  const ctx = await requirePageContext("admin:users");
  const { id } = await props.params;
  const sp = await props.searchParams;

  let unit;
  try {
    unit = await getUnit(ctx, id);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
  const referenced = unit.references.users + unit.references.teams + unit.references.records > 0;

  return (
    <>
      <PageHeader
        title={unit.name}
        breadcrumbs={[
          { label: "Administração", href: "/admin" },
          { label: "Unidades", href: "/admin/unidades" },
          { label: unit.name },
        ]}
        meta={<StatusBadge label={unit.isActive ? "Ativa" : "Desativada"} tone={unit.isActive ? "success" : "neutral"} />}
        actions={
          <div className="flex flex-wrap items-start gap-2">
            {unit.isActive ? (
              <ConfirmDialog
                action={setUnitActiveAction}
                hiddenFields={{ id: unit.id, active: "0" }}
                tone="primary"
                triggerLabel="Desativar"
                triggerVariant="outline"
                title="Desativar unidade?"
                description="A unidade deixa de aparecer para novos cadastros. Usuários, equipes e registros já vinculados são mantidos."
                confirmLabel="Desativar"
                pendingLabel="Desativando…"
              />
            ) : (
              <ActionButtonForm
                action={setUnitActiveAction}
                hiddenFields={{ id: unit.id, active: "1" }}
                size="md"
                pendingLabel="Reativando…"
              >
                Reativar
              </ActionButtonForm>
            )}
            <ConfirmDialog
              action={deleteUnitAction}
              hiddenFields={{ id: unit.id }}
              triggerLabel="Excluir"
              title="Excluir unidade?"
              description={
                referenced
                  ? "Esta unidade possui usuários, equipes ou registros vinculados. Ela será desativada em vez de excluída, preservando o histórico."
                  : "A unidade não possui vínculos e será excluída definitivamente."
              }
              confirmLabel={referenced ? "Desativar" : "Excluir"}
              pendingLabel="Processando…"
            />
          </div>
        }
      />

      {param(sp, "criado") ? (
        <Callout tone="success" title="Unidade criada" className="mb-6">
          Atribua usuários a esta unidade no cadastro de cada usuário.
        </Callout>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>Dados da unidade</CardTitle>
          </CardHeader>
          <CardContent>
            <UnitForm
              mode="edit"
              action={updateUnitAction}
              defaults={{ id: unit.id, name: unit.name, code: unit.code, isActive: unit.isActive }}
            />
          </CardContent>
        </Card>
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader
              actions={
                unit.references.users > 0 ? (
                  <ButtonLink href={`/admin/usuarios?unidade=${unit.id}`} variant="outline" size="sm">
                    Ver usuários
                  </ButtonLink>
                ) : null
              }
            >
              <CardTitle>Vínculos</CardTitle>
              <CardDescription>Unidades com vínculos são desativadas em vez de excluídas.</CardDescription>
            </CardHeader>
            <CardContent>
              <DescriptionList
                columns={1}
                items={[
                  { label: "Usuários", value: formatNumber(unit.references.users) },
                  { label: "Equipes", value: formatNumber(unit.references.teams) },
                  {
                    label: "Processos, ocorrências, contratos, prazos e tarefas",
                    value: formatNumber(unit.references.records),
                  },
                ]}
              />
            </CardContent>
          </Card>
          <RecordActivity ctx={ctx} entityType="unit" entityId={unit.id} />
        </div>
      </div>
    </>
  );
}
