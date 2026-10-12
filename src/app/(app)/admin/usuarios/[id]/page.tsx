import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DescriptionList } from "@/components/ui/description-list";
import { PageHeader } from "@/components/ui/page-header";
import { StatusBadge } from "@/components/ui/status-badge";
import { tableLinkClasses } from "@/components/ui/table";
import { ROLE_LABELS } from "@/domain/enums";
import { formatDateTime } from "@/lib/format";
import { param } from "@/lib/search-params";
import { resetUserPasswordAction, setUserActiveAction, updateUserAction } from "@/modules/admin/actions";
import { ActionButtonForm } from "@/modules/admin/components/form-utils";
import { RecordActivity } from "@/modules/admin/components/record-activity";
import { ResetPasswordForm } from "@/modules/admin/components/reset-password-form";
import { UserForm } from "@/modules/admin/components/user-form";
import { getUser, listAllUnitOptions, listTeamOptions } from "@/modules/admin/service";
import { listAllLawFirmOptions } from "@/modules/organization/service";
import { can } from "@/server/auth/permissions";
import { requirePageContext } from "@/server/auth/session";
import { NotFoundError } from "@/server/lib/errors";

export const metadata: Metadata = { title: "Usuário" };

export default async function UserDetailPage(props: PageProps<"/admin/usuarios/[id]">) {
  const ctx = await requirePageContext("admin:users");
  const { id } = await props.params;
  const sp = await props.searchParams;

  let user;
  try {
    user = await getUser(ctx, id);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
  const [units, teams, lawFirms] = await Promise.all([listAllUnitOptions(ctx), listTeamOptions(ctx), listAllLawFirmOptions(ctx)]);
  const canOrg = can(ctx, "admin:organization");
  const unitOptions = units
    .filter((u) => u.isActive || u.id === user.unitId)
    .map((u) => ({ value: u.id, label: u.isActive ? u.name : `${u.name} (desativada)` }));
  const lawFirmOptions = lawFirms
    .filter((f) => f.isActive || f.id === user.lawFirmId)
    .map((f) => ({ value: f.id, label: f.isActive ? f.name : `${f.name} (desativado)` }));

  return (
    <>
      <PageHeader
        title={user.name}
        description={user.jobTitle ?? undefined}
        breadcrumbs={[
          { label: "Administração", href: "/admin" },
          { label: "Usuários", href: "/admin/usuarios" },
          { label: user.name },
        ]}
        meta={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge label={ROLE_LABELS[user.role]} tone="primary" />
            <StatusBadge label={user.isActive ? "Ativo" : "Inativo"} tone={user.isActive ? "success" : "neutral"} />
            {user.isSelf ? <StatusBadge label="Você" tone="info" /> : null}
          </div>
        }
        actions={
          user.isSelf ? null : user.isActive ? (
            <ConfirmDialog
              action={setUserActiveAction}
              hiddenFields={{ id: user.id, active: "0" }}
              triggerLabel="Desativar usuário"
              title="Desativar usuário?"
              description="O usuário não conseguirá mais entrar e as sessões abertas serão encerradas. Os registros e o histórico dele são mantidos."
              confirmLabel="Desativar"
              pendingLabel="Desativando…"
            />
          ) : (
            <ActionButtonForm
              action={setUserActiveAction}
              hiddenFields={{ id: user.id, active: "1" }}
              variant="primary"
              size="md"
              pendingLabel="Reativando…"
            >
              Reativar usuário
            </ActionButtonForm>
          )
        }
      />

      {param(sp, "criado") ? (
        <Callout tone="success" title="Usuário criado" className="mb-6">
          Informe a senha inicial ao usuário por um canal seguro e oriente-o a não compartilhá-la.
        </Callout>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-3">
        <div className="flex flex-col gap-6 xl:col-span-2">
          <UserForm
            mode="edit"
            action={updateUserAction}
            units={unitOptions}
            lawFirms={lawFirmOptions}
            teams={teams.map((t) => ({ value: t.id, label: t.name }))}
            isSelf={user.isSelf}
            defaults={{
              id: user.id,
              name: user.name,
              email: user.email,
              role: user.role,
              unitId: user.unitId,
              lawFirmId: user.lawFirmId,
              jobTitle: user.jobTitle,
              isActive: user.isActive,
              teamIds: user.teamIds,
            }}
          />
          <Card>
            <CardHeader>
              <CardTitle>Redefinir senha</CardTitle>
              <CardDescription>Defina uma nova senha quando o usuário perder o acesso.</CardDescription>
            </CardHeader>
            <CardContent>
              <ResetPasswordForm action={resetUserPasswordAction} userId={user.id} isSelf={user.isSelf} />
            </CardContent>
          </Card>
        </div>
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Acesso</CardTitle>
            </CardHeader>
            <CardContent>
              <DescriptionList
                columns={1}
                items={[
                  { label: "E-mail", value: <span className="break-all">{user.email}</span> },
                  user.role === "external_counsel"
                    ? {
                        label: "Escritório externo",
                        value: user.lawFirmId ? (
                          canOrg ? (
                            <Link href={`/admin/escritorios/${user.lawFirmId}`} className={tableLinkClasses}>
                              {user.lawFirmName}
                            </Link>
                          ) : (
                            user.lawFirmName
                          )
                        ) : (
                          "Não vinculado"
                        ),
                      }
                    : { label: "Unidade", value: user.unitName ?? "Sem unidade" },
                  { label: "Equipes", value: user.teams.length ? user.teams.map((t) => t.name).join(", ") : "Nenhuma" },
                  { label: "Último acesso", value: user.lastLoginAt ? formatDateTime(user.lastLoginAt) : "Nunca acessou" },
                  { label: "Cadastrado em", value: formatDateTime(user.createdAt) },
                ]}
              />
            </CardContent>
          </Card>
          <RecordActivity ctx={ctx} entityType="user" entityId={user.id} />
        </div>
      </div>
    </>
  );
}
