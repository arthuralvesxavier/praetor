import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PageHeader } from "@/components/ui/page-header";
import { StatusBadge } from "@/components/ui/status-badge";
import { tableLinkClasses } from "@/components/ui/table";
import { ROLE_LABELS } from "@/domain/enums";
import { formatNumber, pluralize } from "@/lib/format";
import { param } from "@/lib/search-params";
import { deleteTeamAction, updateTeamAction } from "@/modules/admin/actions";
import { RecordActivity } from "@/modules/admin/components/record-activity";
import { TeamForm } from "@/modules/admin/components/team-form";
import { getTeam, listAllUnitOptions, listAllUserOptions } from "@/modules/admin/service";
import { requirePageContext } from "@/server/auth/session";
import { NotFoundError } from "@/server/lib/errors";

export const metadata: Metadata = { title: "Equipe" };

export default async function TeamDetailPage(props: PageProps<"/admin/equipes/[id]">) {
  const ctx = await requirePageContext("admin:users");
  const { id } = await props.params;
  const sp = await props.searchParams;

  let team;
  try {
    team = await getTeam(ctx, id);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
  const [units, users] = await Promise.all([listAllUnitOptions(ctx), listAllUserOptions(ctx)]);
  const unitOptions = units
    .filter((u) => u.isActive || u.id === team.unitId)
    .map((u) => ({ value: u.id, label: u.isActive ? u.name : `${u.name} (desativada)` }));
  // Active users + current members (so inactive members are not silently dropped on save).
  const userOptions = users.filter((u) => u.isActive || team.memberIds.includes(u.id) || u.id === team.leaderId);

  return (
    <>
      <PageHeader
        title={team.name}
        description={team.description ?? undefined}
        breadcrumbs={[
          { label: "Administração", href: "/admin" },
          { label: "Equipes", href: "/admin/equipes" },
          { label: team.name },
        ]}
        meta={<StatusBadge label={pluralize(team.memberCount, "membro", "membros", { withCount: true })} tone="neutral" />}
        actions={
          <ConfirmDialog
            action={deleteTeamAction}
            hiddenFields={{ id: team.id }}
            triggerLabel="Excluir equipe"
            title="Excluir equipe?"
            description="Os usuários continuam cadastrados; apenas a equipe e os vínculos de membros são removidos. Esta ação não pode ser desfeita."
            confirmLabel="Excluir"
            pendingLabel="Excluindo…"
          />
        }
      />

      {param(sp, "criado") ? (
        <Callout tone="success" title="Equipe criada" className="mb-6">
          Ajuste os membros e o líder quando precisar.
        </Callout>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>Dados e membros</CardTitle>
          </CardHeader>
          <CardContent>
            <TeamForm
              mode="edit"
              action={updateTeamAction}
              units={unitOptions}
              users={userOptions}
              defaults={{
                id: team.id,
                name: team.name,
                description: team.description,
                unitId: team.unitId,
                leaderId: team.leaderId,
                memberIds: team.memberIds,
              }}
            />
          </CardContent>
        </Card>
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Membros atuais</CardTitle>
              <CardDescription>{formatNumber(team.members.length)} no total.</CardDescription>
            </CardHeader>
            <CardContent>
              {team.members.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nenhum membro nesta equipe.</p>
              ) : (
                <ul className="space-y-2 text-sm">
                  {team.members.map((m) => (
                    <li key={m.id} className="flex flex-wrap items-center gap-x-2">
                      <Link href={`/admin/usuarios/${m.id}`} className={tableLinkClasses}>
                        {m.name}
                      </Link>
                      <span className="text-xs text-muted-foreground">{ROLE_LABELS[m.role]}</span>
                      {m.id === team.leaderId ? <StatusBadge label="Líder" tone="primary" /> : null}
                      {!m.isActive ? <StatusBadge label="Inativo" tone="neutral" /> : null}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
          <RecordActivity ctx={ctx} entityType="team" entityId={team.id} />
        </div>
      </div>
    </>
  );
}
