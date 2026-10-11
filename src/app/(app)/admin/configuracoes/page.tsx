import { Archive, Clock, Sparkles } from "lucide-react";
import type { Metadata } from "next";
import { AiModeBadge } from "@/components/ui/ai-mode-badge";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DescriptionList } from "@/components/ui/description-list";
import { PageHeader } from "@/components/ui/page-header";
import { StatusBadge } from "@/components/ui/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ROUTINE_TYPE_LABELS, type AiMode, type RoutineType } from "@/domain/enums";
import { formatDateTime, formatMonthYear, formatNumber, formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  processQueueNowAction,
  runRoutineNowAction,
  updateOrganizationSettingsAction,
  updateRoutineAction,
} from "@/modules/admin/actions";
import { AdminNav } from "@/modules/admin/components/admin-nav";
import { ActionButtonForm } from "@/modules/admin/components/form-utils";
import { OrganizationSettingsForm } from "@/modules/admin/components/org-settings-form";
import { RoutineForm } from "@/modules/admin/components/routine-form";
import { getOrganizationSettings, listRoutines } from "@/modules/admin/service";
import { getAiRuntimeInfo, getAiUsageSummary } from "@/modules/analyses/service";
import { requirePageContext } from "@/server/auth/session";
import { logger } from "@/server/lib/logger";

export const metadata: Metadata = { title: "Configurações" };

const ROUTINE_DESCRIPTIONS: Record<RoutineType, string> = {
  deadline_alerts: "Gera alertas de prazos próximos, vencidos e de prazos sugeridos pela IA aguardando validação.",
  contract_expiration_alerts: "Gera alertas de contratos próximos do fim da vigência e de obrigações contratuais próximas.",
  stale_analysis_refresh:
    "Identifica análises de IA desatualizadas (fontes alteradas). Pode solicitar novas análises automaticamente, se configurado.",
  retention_review:
    "Relata registros encerrados elegíveis para revisão de exclusão. Não exclui nada; registros com retenção legal (legal hold) não são considerados.",
};

const usd = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 });

function formatInterval(minutes: number): string {
  if (minutes % 1440 === 0) return minutes === 1440 ? "1 dia" : `${formatNumber(minutes / 1440)} dias`;
  if (minutes % 60 === 0) return minutes === 60 ? "1 hora" : `${formatNumber(minutes / 60)} horas`;
  return `${formatNumber(minutes)} min`;
}

export default async function SettingsPage() {
  const ctx = await requirePageContext("admin:organization");
  const [org, routines] = await Promise.all([getOrganizationSettings(ctx), listRoutines(ctx)]);

  let runtime: { mode: AiMode; provider: string; model: string } | null = null;
  let usage: Awaited<ReturnType<typeof getAiUsageSummary>> | null = null;
  try {
    runtime = getAiRuntimeInfo();
    usage = await getAiUsageSummary(ctx);
  } catch (error) {
    logger.error("admin_ai_settings_failed", { error });
  }
  const usedTokens = usage ? usage.inputTokens + usage.outputTokens : 0;
  const budget = usage?.monthlyTokenBudget ?? org.settings.ai.monthlyTokenBudget;
  const ratio = budget > 0 ? Math.min(1, usedTokens / budget) : 1;
  const s = org.settings;

  return (
    <>
      <PageHeader
        title="Configurações"
        description="Dados da organização, uso de IA, alertas, rotinas automáticas e retenção de dados."
        breadcrumbs={[{ label: "Administração", href: "/admin" }, { label: "Configurações" }]}
      />
      <AdminNav ctx={ctx} active="configuracoes" />

      <div className="flex flex-col gap-8">
        {/* AI runtime & usage */}
        <section aria-labelledby="ia-titulo" id="ia" className="scroll-mt-24">
          <Card>
            <CardHeader actions={runtime ? <AiModeBadge mode={runtime.mode} /> : null}>
              <CardTitle id="ia-titulo" className="flex items-center gap-2">
                <Sparkles aria-hidden="true" className="size-4 text-ai-600" />
                Inteligência artificial
              </CardTitle>
              <CardDescription>
                A IA apoia a análise de documentos e registros. Ela não prevê resultados de processos nem substitui a avaliação
                de um advogado; toda sugestão exige revisão humana.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {runtime?.mode === "demo" ? (
                <Callout tone="warning" title="Modo demonstrativo ativo">
                  Nenhum provedor de IA está configurado (ou o modo demonstrativo foi forçado). As análises são geradas por um
                  mecanismo determinístico, sem IA real, e aparecem sempre identificadas como demonstrativas. Para usar IA real,
                  configure a chave do provedor nas variáveis de ambiente do servidor.
                </Callout>
              ) : null}
              {!runtime ? (
                <Callout tone="danger">Não foi possível obter as informações de IA no momento.</Callout>
              ) : null}
              <DescriptionList
                columns={3}
                items={[
                  runtime && { label: "Modo", value: runtime.mode === "demo" ? "Demonstrativo (sem IA real)" : "IA real" },
                  runtime && { label: "Provedor", value: runtime.provider },
                  runtime && { label: "Modelo", value: <code className="text-xs">{runtime.model}</code> },
                ]}
              />
              {usage ? (
                <div className="grid gap-2">
                  <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                    <span className="font-medium text-slate-800">
                      Uso em {formatMonthYear(usage.period)}
                    </span>
                    <span className="text-muted-foreground tabular-nums">
                      {formatNumber(usedTokens)} de {formatNumber(budget)} tokens
                      {budget > 0 ? ` (${formatPercent(usedTokens / budget)})` : ""}
                    </span>
                  </div>
                  <div
                    role="progressbar"
                    aria-label="Uso do limite mensal de tokens de IA"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(ratio * 100)}
                    aria-valuetext={budget > 0 ? `${formatPercent(usedTokens / budget)} do limite mensal` : "IA bloqueada (limite 0)"}
                    className="h-2.5 w-full overflow-hidden rounded-full bg-slate-100"
                  >
                    <div
                      className={cn(
                        "h-full rounded-full",
                        ratio >= 1 ? "bg-red-600" : ratio >= 0.8 ? "bg-amber-500" : "bg-ai-500",
                      )}
                      style={{ width: `${Math.round(ratio * 100)}%` }}
                    />
                  </div>
                  <DescriptionList
                    columns={3}
                    items={[
                      { label: "Requisições ao provedor", value: formatNumber(usage.requests) },
                      {
                        label: "Tokens (entrada / saída)",
                        value: `${formatNumber(usage.inputTokens)} / ${formatNumber(usage.outputTokens)}`,
                      },
                      { label: "Custo estimado", value: usd.format(usage.costMicroUsd / 1_000_000) },
                    ]}
                  />
                  {budget === 0 ? (
                    <p className="text-sm text-red-700">O limite mensal está em 0: novas análises por IA estão bloqueadas.</p>
                  ) : ratio >= 1 ? (
                    <p className="text-sm text-red-700">O limite mensal foi atingido: novas análises ficam bloqueadas até o próximo mês.</p>
                  ) : null}
                  <p className="text-xs text-muted-foreground">
                    O custo é uma estimativa calculada pelo Praetor a partir dos tokens; a cobrança oficial é a do provedor.
                    Análises em modo demonstrativo não consomem tokens.
                  </p>
                </div>
              ) : null}
            </CardContent>
          </Card>
        </section>

        {/* Organization, AI limits, alerts, retention */}
        <section aria-label="Configurações da organização">
          <OrganizationSettingsForm
            action={updateOrganizationSettingsAction}
            defaults={{
              name: org.name,
              monthlyTokenBudget: s.ai.monthlyTokenBudget,
              maxInputChars: s.ai.maxInputChars,
              autoAnalyzeOnUpload: s.ai.autoAnalyzeOnUpload,
              upcomingDeadlineDays: s.alerts.upcomingDeadlineDays,
              contractExpirationDays: s.alerts.contractExpirationDays,
              closedRecordRetentionDays: s.retention.closedRecordRetentionDays,
              auditLogRetentionDays: s.retention.auditLogRetentionDays,
            }}
          />
        </section>

        {/* Routines */}
        <section aria-labelledby="rotinas-titulo" id="rotinas" className="scroll-mt-24">
          <Card className="pb-0">
            <CardHeader
              actions={
                <ActionButtonForm action={processQueueNowAction} pendingLabel="Processando…" variant="secondary" messageClassName="max-w-xs">
                  Processar fila agora
                </ActionButtonForm>
              }
            >
              <CardTitle id="rotinas-titulo" className="flex items-center gap-2">
                <Clock aria-hidden="true" className="size-4 text-muted-foreground" />
                Rotinas automáticas
              </CardTitle>
              <CardDescription>
                Executadas periodicamente pelo processo de segundo plano (worker). “Executar agora” coloca a rotina na fila;
                “Processar fila agora” executa até 20 tarefas pendentes imediatamente — útil quando não há worker em execução,
                como em demonstrações.
              </CardDescription>
            </CardHeader>
            <CardContent className="px-0">
              <Table aria-label="Rotinas automáticas">
                <TableHeader>
                  <TableRow>
                    <TableHead>Rotina</TableHead>
                    <TableHead>Situação</TableHead>
                    <TableHead>Intervalo</TableHead>
                    <TableHead>Última execução</TableHead>
                    <TableHead>Último resultado</TableHead>
                    <TableHead>Próxima execução</TableHead>
                    <TableHead>
                      <span className="sr-only">Ações</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {routines.map((r) => {
                    const label = ROUTINE_TYPE_LABELS[r.type];
                    return (
                      <TableRow key={r.id} className="align-top">
                        <TableCell className="min-w-56">
                          <span className="block font-medium text-slate-900">{label}</span>
                          <span className="block text-xs text-muted-foreground">{ROUTINE_DESCRIPTIONS[r.type]}</span>
                          {r.type === "stale_analysis_refresh" ? (
                            <span className="mt-1 block text-xs text-slate-700">
                              Reanálise automática: {r.config.autoRefresh ? "ativada" : "desativada"}
                              {r.config.autoRefresh ? ` · até ${formatNumber(r.config.maxPerRun ?? 5)} por execução` : ""}
                            </span>
                          ) : null}
                        </TableCell>
                        <TableCell>
                          <StatusBadge label={r.enabled ? "Ativa" : "Pausada"} tone={r.enabled ? "success" : "neutral"} />
                        </TableCell>
                        <TableCell className="whitespace-nowrap">{formatInterval(r.intervalMinutes)}</TableCell>
                        <TableCell className="whitespace-nowrap">
                          {r.lastRunAt ? formatDateTime(r.lastRunAt) : <span className="text-muted-foreground">Nunca</span>}
                        </TableCell>
                        <TableCell className="min-w-56 text-sm">
                          {r.lastStatus ? <span className="block">{r.lastStatus}</span> : <span className="text-muted-foreground">—</span>}
                          {r.lastError ? <span className="mt-1 block text-xs text-red-700">Erro: {r.lastError}</span> : null}
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          {r.enabled ? formatDateTime(r.nextRunAt) : <span className="text-muted-foreground">Pausada</span>}
                        </TableCell>
                        <TableCell className="min-w-52">
                          <div className="flex flex-col gap-2">
                            {r.enabled ? (
                              <ActionButtonForm action={runRoutineNowAction} hiddenFields={{ id: r.id }} pendingLabel="Enfileirando…">
                                Executar agora
                              </ActionButtonForm>
                            ) : null}
                            <details className="group">
                              <summary className="cursor-pointer text-sm font-medium text-primary-700 hover:underline">
                                Configurar
                              </summary>
                              <div className="mt-3">
                                <RoutineForm
                                  action={updateRoutineAction}
                                  routine={{
                                    id: r.id,
                                    label,
                                    enabled: r.enabled,
                                    intervalMinutes: r.intervalMinutes,
                                    staleConfig:
                                      r.type === "stale_analysis_refresh"
                                        ? { autoRefresh: r.config.autoRefresh ?? false, maxPerRun: r.config.maxPerRun ?? 5 }
                                        : undefined,
                                  }}
                                />
                              </div>
                            </details>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </section>

        {/* Retention */}
        <section aria-labelledby="retencao-titulo">
          <Card>
            <CardHeader>
              <CardTitle id="retencao-titulo" className="flex items-center gap-2">
                <Archive aria-hidden="true" className="size-4 text-muted-foreground" />
                Política de retenção
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 text-sm text-slate-700">
              <Callout tone="warning" title="Nenhuma exclusão automática nesta versão">
                O Praetor não exclui dados automaticamente. A rotina “{ROUTINE_TYPE_LABELS.retention_review}” apenas relata
                quantos processos, ocorrências e documentos já ultrapassaram o prazo de retenção e estão elegíveis para revisão
                — a decisão de excluir é sempre humana.
              </Callout>
              <ul className="list-disc space-y-1 pl-5">
                <li>
                  Registros encerrados ficam elegíveis para revisão após{" "}
                  <strong>{formatNumber(s.retention.closedRecordRetentionDays)} dias</strong> do encerramento.
                </li>
                <li>
                  Registros e documentos marcados com <strong>retenção legal (legal hold)</strong> nunca são considerados
                  elegíveis e não podem ser excluídos enquanto a marcação existir.
                </li>
                <li>
                  O prazo de retenção da auditoria ({formatNumber(s.retention.auditLogRetentionDays)} dias) é informativo: a
                  trilha de auditoria também não é apagada automaticamente nesta versão.
                </li>
              </ul>
            </CardContent>
          </Card>
        </section>
      </div>
    </>
  );
}
