import { Plus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ButtonLink } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DescriptionList } from "@/components/ui/description-list";
import { PageHeader } from "@/components/ui/page-header";
import { StatusBadge } from "@/components/ui/status-badge";
import { tableLinkClasses } from "@/components/ui/table";
import { formatNumber } from "@/lib/format";
import { param } from "@/lib/search-params";
import { ActionButtonForm } from "@/modules/admin/components/form-utils";
import { RecordActivity } from "@/modules/admin/components/record-activity";
import { deleteLawFirmAction, setLawFirmActiveAction, updateLawFirmAction } from "@/modules/organization/actions";
import { LawFirmForm } from "@/modules/organization/components/law-firm-form";
import { getLawFirm } from "@/modules/organization/service";
import { can } from "@/server/auth/permissions";
import { requirePageContext } from "@/server/auth/session";
import { NotFoundError } from "@/server/lib/errors";

export const metadata: Metadata = { title: "Escritório externo" };

export default async function LawFirmDetailPage(props: PageProps<"/admin/escritorios/[id]">) {
  const ctx = await requirePageContext("admin:organization");
  const { id } = await props.params;
  const sp = await props.searchParams;

  let firm;
  try {
    firm = await getLawFirm(ctx, id);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
  const refs = firm.references;
  const referenced = refs.processes + refs.users + refs.intakes + refs.distributionRules > 0;
  const canUsers = can(ctx, "admin:users");

  return (
    <>
      <PageHeader
        title={firm.name}
        description={firm.document ? `CNPJ ${firm.document}` : undefined}
        breadcrumbs={[
          { label: "Administração", href: "/admin" },
          { label: "Escritórios externos", href: "/admin/escritorios" },
          { label: firm.name },
        ]}
        meta={<StatusBadge label={firm.isActive ? "Ativo" : "Desativado"} tone={firm.isActive ? "success" : "neutral"} />}
        actions={
          <div className="flex flex-wrap items-start gap-2">
            {firm.isActive ? (
              <ConfirmDialog
                action={setLawFirmActiveAction}
                hiddenFields={{ id: firm.id, active: "0" }}
                tone="primary"
                triggerLabel="Desativar"
                triggerVariant="outline"
                title="Desativar escritório?"
                description="O escritório deixa de aparecer para novas atribuições e regras. Usuários e processos já vinculados não são alterados. Para retirar o acesso, desative os usuários do escritório."
                confirmLabel="Desativar"
                pendingLabel="Desativando…"
              />
            ) : (
              <ActionButtonForm
                action={setLawFirmActiveAction}
                hiddenFields={{ id: firm.id, active: "1" }}
                size="md"
                pendingLabel="Reativando…"
              >
                Reativar
              </ActionButtonForm>
            )}
            <ConfirmDialog
              action={deleteLawFirmAction}
              hiddenFields={{ id: firm.id }}
              triggerLabel="Excluir"
              title="Excluir escritório?"
              description={
                referenced
                  ? "Este escritório possui usuários, processos, entradas ou regras de distribuição vinculados. Ele será desativado em vez de excluído, preservando o histórico."
                  : "O escritório não possui vínculos e será excluído definitivamente."
              }
              confirmLabel={referenced ? "Desativar" : "Excluir"}
              pendingLabel="Processando…"
            />
          </div>
        }
      />

      {param(sp, "criado") ? (
        <Callout tone="success" title="Escritório cadastrado" className="mb-6">
          Crie os usuários do escritório com o perfil Escritório externo e atribua os processos patrocinados por ele.
        </Callout>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-3">
        <div className="flex flex-col gap-6 xl:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Dados do escritório</CardTitle>
            </CardHeader>
            <CardContent>
              <LawFirmForm
                mode="edit"
                action={updateLawFirmAction}
                defaults={{
                  id: firm.id,
                  name: firm.name,
                  document: firm.document,
                  contactName: firm.contactName,
                  contactEmail: firm.contactEmail,
                  isActive: firm.isActive,
                }}
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader
              actions={
                canUsers && firm.isActive ? (
                  <ButtonLink href={`/admin/usuarios/novo?escritorio=${firm.id}`} variant="outline" size="sm">
                    <Plus aria-hidden="true" />
                    Novo usuário do escritório
                  </ButtonLink>
                ) : null
              }
            >
              <CardTitle>Usuários do escritório</CardTitle>
              <CardDescription>
                Perfil Escritório externo: acesso somente aos processos atribuídos a este escritório, sem unidade.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {firm.users.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nenhum usuário vinculado a este escritório.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {firm.users.map((u) => (
                    <li key={u.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                      <span className="min-w-0">
                        {canUsers ? (
                          <Link href={`/admin/usuarios/${u.id}`} className={tableLinkClasses}>
                            {u.name}
                          </Link>
                        ) : (
                          <span className="font-medium text-slate-900">{u.name}</span>
                        )}
                        <span className="block break-all text-xs text-muted-foreground">{u.email}</span>
                      </span>
                      <StatusBadge label={u.isActive ? "Ativo" : "Inativo"} tone={u.isActive ? "success" : "neutral"} />
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader
              actions={
                firm.activeProcessCount > 0 ? (
                  <ButtonLink href={`/processos?escritorio=${firm.id}`} variant="outline" size="sm">
                    Ver carteira
                  </ButtonLink>
                ) : null
              }
            >
              <CardTitle>Vínculos</CardTitle>
              <CardDescription>Escritórios com vínculos são desativados em vez de excluídos.</CardDescription>
            </CardHeader>
            <CardContent>
              <DescriptionList
                columns={1}
                items={[
                  { label: "Processos na carteira ativa", value: formatNumber(firm.activeProcessCount) },
                  { label: "Processos vinculados (todas as situações)", value: formatNumber(refs.processes) },
                  { label: "Usuários (ativos e inativos)", value: formatNumber(refs.users) },
                  { label: "Entradas de processo atribuídas", value: formatNumber(refs.intakes) },
                  { label: "Regras de distribuição", value: formatNumber(refs.distributionRules) },
                ]}
              />
            </CardContent>
          </Card>
          <RecordActivity ctx={ctx} entityType="law_firm" entityId={firm.id} />
        </div>
      </div>
    </>
  );
}
