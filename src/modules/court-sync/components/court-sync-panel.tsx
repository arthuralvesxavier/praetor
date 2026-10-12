import { Landmark } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DescriptionList } from "@/components/ui/description-list";
import { StatusBadge } from "@/components/ui/status-badge";
import { COURT_SYNC_STATUS_LABELS } from "@/domain/enums";
import { formatDate, formatDateTime, formatNumber, pluralize } from "@/lib/format";
import { ActionButtonForm } from "@/modules/admin/components/form-utils";
import type { AuthContext } from "@/server/auth/context";
import { AppError } from "@/server/lib/errors";
import { aliasLabel } from "@/server/integrations/courts/aliases";
import { COURT_COLLECTION_INACTIVE } from "@/server/integrations/courts";
import { syncProcessNowAction } from "../actions";
import { COURT_SYNC_STATUS_TONES, DATAJUD_LIMITS_NOTICE, grauText } from "../labels";
import { getProcessCourtSyncPanel } from "../service";

/**
 * "Acompanhamento no DataJud (CNJ)" card of a process (server component).
 * Usage (process page, integrator): `<CourtSyncPanel ctx={ctx} processId={id} />`.
 * Requires process:read (renders nothing otherwise); the "Sincronizar agora"
 * button requires court_sync:run.
 */
export async function CourtSyncPanel({ ctx, processId }: { ctx: AuthContext; processId: string }) {
  let data: Awaited<ReturnType<typeof getProcessCourtSyncPanel>>;
  try {
    data = await getProcessCourtSyncPanel(ctx, processId);
  } catch (err) {
    if (err instanceof AppError) return null;
    throw err;
  }
  const state = data.state;
  const canSync = data.canRun && data.active && data.supported;

  return (
    <Card aria-labelledby="datajud-titulo">
      <CardHeader
        actions={
          canSync ? (
            <ActionButtonForm
              action={syncProcessNowAction}
              hiddenFields={{ processId }}
              pendingLabel="Consultando o DataJud…"
              variant="outline"
              messageClassName="max-w-xs"
            >
              Sincronizar agora
            </ActionButtonForm>
          ) : null
        }
      >
        <CardTitle id="datajud-titulo" className="flex items-center gap-2">
          <Landmark aria-hidden="true" className="size-4 text-muted-foreground" />
          Acompanhamento no DataJud (CNJ)
        </CardTitle>
        <CardDescription>{DATAJUD_LIMITS_NOTICE}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!data.active ? (
          <Callout tone="warning" title={COURT_COLLECTION_INACTIVE}>
            Sem a chave pública do CNJ nenhuma consulta é feita. As movimentações continuam por cadastro manual e importação de
            planilha.
          </Callout>
        ) : !data.supported ? (
          <Callout tone="info" title="Sem consulta automática para este número">
            {data.unsupportedReason}
          </Callout>
        ) : !data.enabled ? (
          <Callout tone="info" title="Acompanhamento automático desativado">
            O acompanhamento automático está desativado nas configurações da organização. A consulta manual continua disponível.
          </Callout>
        ) : null}

        {data.supported ? (
          <DescriptionList
            columns={2}
            items={[
              {
                label: "Situação",
                value: (
                  <StatusBadge
                    label={state ? COURT_SYNC_STATUS_LABELS[state.status] : COURT_SYNC_STATUS_LABELS.pending}
                    tone={state ? COURT_SYNC_STATUS_TONES[state.status] : "neutral"}
                  />
                ),
              },
              { label: "Tribunais consultados", value: data.aliases.map(aliasLabel).join(" e ") },
              { label: "Última consulta", value: state?.lastCheckedAt ? formatDateTime(state.lastCheckedAt) : "Nunca consultado" },
              {
                label: "Última atualização informada pelo tribunal",
                value: state?.remoteUpdatedAt ? formatDateTime(state.remoteUpdatedAt) : "Não informada",
              },
              {
                label: "Graus encontrados",
                value:
                  state && state.instancesFound.length > 0
                    ? state.instancesFound
                        .map((i) =>
                          i.notReturnedSince
                            ? `${grauText(i.grau)} (${i.tribunal}, não devolvido desde ${formatDate(i.notReturnedSince)})`
                            : `${grauText(i.grau)} (${i.tribunal})`,
                        )
                        .join(", ")
                    : "Nenhum até agora",
              },
              {
                label: "Movimentações importadas do DataJud",
                value: formatNumber(data.importedMovements),
              },
              {
                label: "Próxima consulta automática",
                value: state?.nextCheckAt ? formatDateTime(state.nextCheckAt) : "Na próxima execução da rotina",
              },
              state?.status === "error" && {
                label: "Último erro",
                value: `${state.lastError ?? "Falha na consulta"} (${pluralize(state.consecutiveErrors, "falha seguida", "falhas seguidas")})`,
              },
              data.subjects.length > 0 && {
                label: "Assuntos (tabela do CNJ)",
                value: data.subjects.map((s) => s.name).join("; "),
                full: true,
              },
            ]}
          />
        ) : null}

        {data.canRun ? (
          <div>
            <ButtonLink href={`/consulta-datajud?numero=${encodeURIComponent(data.number)}`} variant="link" size="sm" className="px-0">
              Abrir a consulta avulsa ao DataJud
            </ButtonLink>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
