import { CalendarDays, Gavel } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { todayISO } from "@/lib/format";
import type { AuthContext } from "@/server/auth/context";
import { can } from "@/server/auth/permissions";
import { NotFoundError } from "@/server/lib/errors";
import { listHearingUserOptions, listProcessHearings, type HearingListItem } from "../service";
import { startOfZonedDay } from "../time";
import { HearingFormDialog } from "./hearing-form-dialog";
import { HearingRow } from "./hearing-row";

/**
 * Hearings section of the "Prazos e audiências" tab of the process page
 * (`/processos/<id>?aba=prazos-e-audiencias#audiencias`).
 */
export async function ProcessHearingsTab({ ctx, processId }: { ctx: AuthContext; processId: string }) {
  if (!can(ctx, "process:read")) {
    return <p className="text-sm text-muted-foreground">Seu perfil não permite consultar as audiências deste processo.</p>;
  }
  let items: HearingListItem[];
  try {
    items = await listProcessHearings(ctx, processId);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return <p className="text-sm text-muted-foreground">Processo não encontrado ou sem permissão de acesso.</p>;
    }
    throw err;
  }
  const canWrite = can(ctx, "process:write");
  const userOptions = canWrite ? (await listHearingUserOptions(ctx)).map((u) => ({ value: u.id, label: u.name })) : [];
  const today = todayISO();
  const startToday = startOfZonedDay(today).getTime();
  const upcoming = items.filter((h) => h.scheduledAt.getTime() >= startToday);
  const previous = items.filter((h) => h.scheduledAt.getTime() < startToday);

  return (
    <div className="flex flex-col gap-4">
      <Card aria-labelledby="audiencias-proximas">
        <CardHeader
          actions={
            canWrite ? <HearingFormDialog processId={processId} users={userOptions} defaultResponsibleId={ctx.userId} /> : null
          }
        >
          <CardTitle id="audiencias-proximas">Próximas audiências</CardTitle>
          <CardDescription>
            Cadastro manual a partir da intimação ou da pauta publicada. A coleta do DataJud, quando ativa, avisa que uma
            audiência foi designada, mas não informa a data. PJe e MNI não estão integrados nesta versão.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {upcoming.length === 0 ? (
            <EmptyState
              icon={<CalendarDays />}
              title="Nenhuma audiência a partir de hoje"
              description={
                canWrite
                  ? "Cadastre a próxima audiência quando houver designação. Ela aparecerá na agenda, no calendário de prazos e nos alertas."
                  : "Quando houver audiência designada, ela aparecerá aqui."
              }
            />
          ) : (
            <ul className="divide-y divide-border" aria-label="Próximas audiências do processo">
              {upcoming.map((h) => (
                <li key={h.id} className="py-4 first:pt-0 last:pb-0">
                  <HearingRow item={h} users={userOptions} today={today} />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card aria-labelledby="audiencias-anteriores">
        <CardHeader>
          <CardTitle id="audiencias-anteriores">Audiências anteriores</CardTitle>
          <CardDescription>Realizadas, redesignadas, canceladas e as que aguardam o registro do resultado.</CardDescription>
        </CardHeader>
        <CardContent>
          {previous.length === 0 ? (
            <EmptyState icon={<Gavel />} title="Nenhuma audiência anterior registrada" />
          ) : (
            <ul className="divide-y divide-border" aria-label="Audiências anteriores do processo">
              {previous.map((h) => (
                <li key={h.id} className="py-4 first:pt-0 last:pb-0">
                  <HearingRow item={h} users={userOptions} today={today} />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
