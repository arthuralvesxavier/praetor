import { Activity, AlertTriangle, Landmark, Settings2 } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { ButtonLink } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { StatCard } from "@/components/ui/stat-card";
import { StatusBadge } from "@/components/ui/status-badge";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow, tableLinkClasses } from "@/components/ui/table";
import { COURT_SYNC_RUN_STATUS_LABELS, COURT_SYNC_TRIGGER_LABELS } from "@/domain/enums";
import { formatDateTime, formatNumber } from "@/lib/format";
import { AdminNav } from "@/modules/admin/components/admin-nav";
import { ActionButtonForm } from "@/modules/admin/components/form-utils";
import { requestPortfolioSyncAction, updateCourtIntegrationSettingsAction } from "@/modules/court-sync/actions";
import { CourtSettingsForm } from "@/modules/court-sync/components/court-settings-form";
import { COURT_SYNC_RUN_STATUS_TONES, DATAJUD_LIMITS_NOTICE } from "@/modules/court-sync/labels";
import { ALERT_LOOKBACK_DAYS, FAILED_RUNS_FOR_ALERT, FAILURE_ALERT_MIN_HOURS, getCourtSyncHealth } from "@/modules/court-sync/service";
import { requirePageContext } from "@/server/auth/session";
import { COURT_COLLECTION_INACTIVE } from "@/server/integrations/courts";

export const metadata: Metadata = { title: "DataJud: saúde da coleta" };

function ago(date: Date | null, now: Date): string {
  if (!date) return "Nunca";
  const minutes = Math.max(0, Math.round((now.getTime() - date.getTime()) / 60_000));
  if (minutes < 1) return "agora há pouco";
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `há ${hours} h`;
  return `há ${formatNumber(Math.floor(hours / 24))} dias`;
}

/** "a cada hora", "a cada 6 h", "a cada 2 dias". */
function every(minutes: number): string {
  if (minutes < 60) return `a cada ${formatNumber(minutes)} min`;
  if (minutes === 60) return "a cada hora";
  if (minutes < 2880) return `a cada ${formatNumber(Math.round(minutes / 60))} h`;
  return `a cada ${formatNumber(Math.round(minutes / 1440))} dias`;
}

function duration(ms: number | null): string {
  if (ms === null) return "Não medido";
  if (ms < 1000) return "menos de 1 s";
  const s = Math.round(ms / 1000);
  return s < 120 ? `${s} s` : `${Math.round(s / 60)} min`;
}

export default async function DataJudHealthPage() {
  const ctx = await requirePageContext("admin:organization");
  const h = await getCourtSyncHealth(ctx);
  const s = h.settings;
  const failing = h.tribunals.filter((t) => t.lastRun?.status === "failed").length;

  return (
    <>
      <PageHeader
        title="DataJud (CNJ): saúde da coleta"
        description="Acompanhamento automático da carteira na API pública do DataJud, por tribunal: última execução, resultados, falhas e processos aguardando consulta."
        breadcrumbs={[
          { label: "Administração", href: "/admin" },
          { label: "Integrações", href: "/admin/integracoes" },
          { label: "DataJud" },
        ]}
        meta={
          <p className="text-xs text-muted-foreground">
            Atualizado em <time dateTime={h.generatedAt.toISOString()}>{formatDateTime(h.generatedAt)}</time>
          </p>
        }
      />
      <AdminNav ctx={ctx} active="integracoes" />

      <div className="flex flex-col gap-8">
        {!h.runtime.active ? (
          <Callout tone="warning" title={COURT_COLLECTION_INACTIVE}>
            A chave pública é publicada pelo CNJ em datajud-wiki.cnj.jus.br (página &quot;Acesso&quot;) e pode ser trocada pelo CNJ a
            qualquer momento. Configure DATAJUD_API_KEY no servidor e reinicie a aplicação e o worker. Enquanto isso nada é
            consultado e nada quebra.
          </Callout>
        ) : (
          <Callout tone={s.datajud.enabled ? "success" : "info"} title={s.datajud.enabled ? "Coleta ativa" : "Coleta configurada, rotina desativada"}>
            {DATAJUD_LIMITS_NOTICE} Movimentações novas entram na linha do tempo como importadas. Mudanças de fase só quando
            inequívocas; trânsito em julgado, baixa, arquivamento e extinção viram alerta e pendência de conferência (nada é encerrado
            automaticamente). Alertas consideram movimentações dos últimos {ALERT_LOOKBACK_DAYS} dias; um encerramento que seja a
            movimentação mais recente do processo é apontado qualquer que seja a data.
          </Callout>
        )}

        <section aria-labelledby="resumo-titulo" className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <h2 id="resumo-titulo" className="flex items-center gap-2 text-lg font-semibold tracking-tight text-slate-900">
              <Activity aria-hidden="true" className="size-4 text-muted-foreground" />
              Situação da carteira ativa
            </h2>
            {h.runtime.active ? (
              <ActionButtonForm action={requestPortfolioSyncAction} pendingLabel="Enfileirando…" variant="secondary" messageClassName="max-w-sm">
                Sincronizar a carteira agora
              </ActionButtonForm>
            ) : null}
          </div>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="Processos na carteira ativa" value={formatNumber(h.totals.activeProcesses)} />
            <StatCard
              label="Já consultados"
              value={formatNumber(h.totals.tracked)}
              hint={`${formatNumber(h.totals.byStatus.found)} encontrados, ${formatNumber(h.totals.byStatus.not_found)} não encontrados`}
            />
            <StatCard
              label="Aguardando consulta"
              value={formatNumber(h.totals.due)}
              hint="Nunca consultados ou com a próxima consulta vencida"
              tone={h.totals.due > 0 ? "info" : "neutral"}
            />
            <StatCard
              label="Com falha na última consulta"
              value={formatNumber(h.totals.byStatus.error)}
              hint={h.unsupported ? `${formatNumber(h.unsupported)} sem consulta disponível (dígito verificador inválido, número fora do padrão ou tribunal sem endpoint)` : undefined}
              tone={h.totals.byStatus.error > 0 ? "danger" : "neutral"}
            />
          </div>
        </section>

        <section aria-labelledby="tribunais-titulo">
          <Card className="pb-0">
            <CardHeader>
              <CardTitle id="tribunais-titulo" className="flex items-center gap-2">
                <Landmark aria-hidden="true" className="size-4 text-muted-foreground" />
                Por tribunal
              </CardTitle>
              <CardDescription>
                Cada tribunal tem o próprio limite de {formatNumber(s.datajud.maxRequestsPerMinute)} requisições por minuto, com até{" "}
                {formatNumber(s.datajud.batchSize)} números por consulta. Processos trabalhistas também são consultados no TST.
                {failing > 0 ? ` ${formatNumber(failing)} tribunal(is) com a última execução em falha.` : ""}
              </CardDescription>
            </CardHeader>
            <CardContent className="px-0">
              <Table aria-label="Saúde da coleta por tribunal">
                <TableHeader>
                  <TableRow>
                    <TableHead>Tribunal</TableHead>
                    <TableHead className="text-right">Processos</TableHead>
                    <TableHead className="text-right">Aguardando</TableHead>
                    <TableHead>Última execução</TableHead>
                    <TableHead className="text-right">Consultados</TableHead>
                    <TableHead className="text-right">Encontrados</TableHead>
                    <TableHead className="text-right">Não encontrados</TableHead>
                    <TableHead className="text-right">Falhas</TableHead>
                    <TableHead className="text-right">Movimentações novas</TableHead>
                    <TableHead>Último sucesso</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {h.tribunals.length === 0 ? (
                    <TableEmpty colSpan={10} message="Nenhum processo da carteira ativa com número CNJ consultável." />
                  ) : (
                    h.tribunals.map((t) => (
                      <TableRow key={t.alias} className="align-top">
                        <TableCell className="font-medium text-slate-900">{t.label}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatNumber(t.processes)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatNumber(t.due)}</TableCell>
                        <TableCell className="min-w-44">
                          {t.lastRun ? (
                            <>
                              <StatusBadge label={COURT_SYNC_RUN_STATUS_LABELS[t.lastRun.status]} tone={COURT_SYNC_RUN_STATUS_TONES[t.lastRun.status]} />
                              <span className="mt-1 block text-xs text-muted-foreground">
                                {formatDateTime(t.lastRun.startedAt)} · {COURT_SYNC_TRIGGER_LABELS[t.lastRun.trigger]} · {duration(t.lastRun.durationMs)}
                              </span>
                            </>
                          ) : (
                            <span className="text-muted-foreground">Nunca executada</span>
                          )}
                        </TableCell>
                        {t.lastRun ? (
                          <>
                            <TableCell className="text-right tabular-nums">{formatNumber(t.lastRun.checked)}</TableCell>
                            <TableCell className="text-right tabular-nums">{formatNumber(t.lastRun.found)}</TableCell>
                            <TableCell className="text-right tabular-nums">{formatNumber(t.lastRun.notFound)}</TableCell>
                            <TableCell className="text-right tabular-nums">{formatNumber(t.lastRun.errors)}</TableCell>
                            <TableCell className="text-right tabular-nums">{formatNumber(t.lastRun.newMovements)}</TableCell>
                          </>
                        ) : (
                          // Never ran: there is no result yet (not zero).
                          <TableCell colSpan={5} className="text-center text-muted-foreground">
                            Sem execução
                          </TableCell>
                        )}
                        <TableCell className="whitespace-nowrap">{ago(t.lastSuccessAt, h.generatedAt)}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </section>

        <div className="grid gap-6 xl:grid-cols-2">
          <Card className="pb-0">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <AlertTriangle aria-hidden="true" className="size-4 text-muted-foreground" />
                Erros recentes
              </CardTitle>
              <CardDescription>
                Mensagens saneadas (sem conteúdo de processos). Após {FAILED_RUNS_FOR_ALERT} execuções seguidas com falha num
                tribunal, ao longo de pelo menos {FAILURE_ALERT_MIN_HOURS} horas, um alerta crítico é aberto.
              </CardDescription>
            </CardHeader>
            <CardContent className="px-0">
              <Table aria-label="Erros recentes da coleta">
                <TableHeader>
                  <TableRow>
                    <TableHead>Quando</TableHead>
                    <TableHead>Tribunal</TableHead>
                    <TableHead>Erro</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {h.recentErrors.length === 0 ? (
                    <TableEmpty colSpan={3} message="Nenhum erro nos últimos 90 dias." />
                  ) : (
                    h.recentErrors.map((e, i) => (
                      <TableRow key={`${e.alias}-${i}`} className="align-top">
                        <TableCell className="whitespace-nowrap">
                          {formatDateTime(e.at)}
                          <span className="block text-xs text-muted-foreground">{COURT_SYNC_TRIGGER_LABELS[e.trigger]}</span>
                        </TableCell>
                        <TableCell>{e.label}</TableCell>
                        <TableCell className="min-w-56 text-sm text-slate-700">{e.message}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card className="pb-0">
            <CardHeader>
              <CardTitle>Processos com falha</CardTitle>
              <CardDescription>
                A coleta tenta de novo sozinha, com intervalos crescentes (1 h, 2 h, 4 h... até o intervalo entre consultas), na
                primeira execução da rotina depois de cada espera.
              </CardDescription>
            </CardHeader>
            <CardContent className="px-0">
              <Table aria-label="Processos com falha na coleta">
                <TableHeader>
                  <TableRow>
                    <TableHead>Processo</TableHead>
                    <TableHead className="text-right">Falhas seguidas</TableHead>
                    <TableHead>Erro</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {h.processErrors.length === 0 ? (
                    <TableEmpty colSpan={3} message="Nenhum processo com falha." />
                  ) : (
                    h.processErrors.map((p) => (
                      <TableRow key={p.processId} className="align-top">
                        <TableCell className="whitespace-nowrap">
                          <Link href={`/processos/${p.processId}`} className={tableLinkClasses}>
                            {p.number}
                          </Link>
                          <span className="block text-xs text-muted-foreground">
                            {p.lastCheckedAt ? formatDateTime(p.lastCheckedAt) : "Sem data"}
                          </span>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{formatNumber(p.consecutiveErrors)}</TableCell>
                        <TableCell className="min-w-48 text-sm text-slate-700">{p.lastError ?? "Falha na consulta"}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader
            actions={
              <ButtonLink href="/consulta-datajud" variant="outline" size="sm">
                Consulta avulsa
              </ButtonLink>
            }
          >
            <CardTitle className="flex items-center gap-2">
              <Settings2 aria-hidden="true" className="size-4 text-muted-foreground" />
              Parâmetros
            </CardTitle>
            <CardDescription>
              Rotina de acompanhamento:{" "}
              {h.routine
                ? `${h.routine.enabled ? `ativa, ${every(h.routine.intervalMinutes)}` : "pausada"}; última execução ${
                    h.routine.lastRunAt ? formatDateTime(h.routine.lastRunAt) : "nunca"
                  }${h.routine.lastStatus ? ` (${h.routine.lastStatus})` : ""}; próxima ${formatDateTime(h.routine.nextRunAt)}.`
                : "ainda não criada (o worker cria as rotinas padrão ao iniciar)."}{" "}
              Cada execução consulta só os processos cujo intervalo entre consultas já passou. O intervalo da rotina é
              ajustado em Administração, Configurações, Rotinas.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <CourtSettingsForm
              action={updateCourtIntegrationSettingsAction}
              isDemo={ctx.isDemoOrganization}
              routineIntervals={{ courtSync: h.routine?.enabled ? h.routine.intervalMinutes : null, simulatedFeed: h.simulatedFeedRoutineMinutes }}
              defaults={{
                enabled: s.datajud.enabled,
                syncIntervalHours: s.datajud.syncIntervalHours,
                maxRequestsPerMinute: s.datajud.maxRequestsPerMinute,
                batchSize: s.datajud.batchSize,
                autoApplyPhase: s.datajud.autoApplyPhase,
                enrichOnIntake: s.datajud.enrichOnIntake,
                simulatedFeedEnabled: s.simulatedFeed.enabled,
                simulatedFeedIntervalMinutes: s.simulatedFeed.intervalMinutes,
              }}
            />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
