import { Activity, Cable, ChartPie, Clock, FileSpreadsheet, FileSearch, KeyRound, Landmark, Mail } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { ButtonLink } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { StatCard } from "@/components/ui/stat-card";
import { StatusBadge } from "@/components/ui/status-badge";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow, tableLinkClasses } from "@/components/ui/table";
import {
  CASE_BRIEF_STATUS_LABELS,
  CASE_BRIEF_STATUSES,
  EMAIL_TEMPLATE_LABELS,
  IMPORT_BATCH_STATUS_LABELS,
  JOB_STATUSES,
  ROUTINE_TYPE_LABELS,
  type ImportBatchStatus,
  type JobStatus,
} from "@/domain/enums";
import { formatDateTime, formatNumber } from "@/lib/format";
import type { Tone } from "@/lib/tones";
import { processQueueNowAction } from "@/modules/admin/actions";
import { AdminNav } from "@/modules/admin/components/admin-nav";
import { ActionButtonForm } from "@/modules/admin/components/form-utils";
import { getIntegrationsOverview, type IntegrationStatus } from "@/modules/admin/integrations";
import { describeDataJudIntegration } from "@/modules/court-sync/service";
import { IndexSeriesCard } from "@/modules/indices/components/index-series-card";
import { can } from "@/server/auth/permissions";
import { requirePageContext } from "@/server/auth/session";

export const metadata: Metadata = { title: "Integrações" };

const STATUS_TONES: Record<IntegrationStatus, Tone> = {
  operational: "success",
  simulated: "warning",
  demo: "warning",
  not_integrated: "neutral",
  unknown: "danger",
};

const JOB_TYPE_LABELS: Record<string, string> = {
  "analysis.run": "Análise de IA",
  "document.extract_text": "Extração de texto de documento",
  "routine.run": "Execução de rotina",
  "intake.process": "Processamento de entrada de processo",
  "case_brief.generate": "Geração de análise preliminar (simulada)",
  "bi.refresh": "Atualização dos painéis Power BI",
  "court_sync.run": "Consulta ao DataJud (CNJ)",
};

const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  queued: "Na fila",
  running: "Em execução",
  succeeded: "Concluídas",
  failed: "Com falha",
  dead: "Esgotaram as tentativas",
};

const IMPORT_TONES: Record<ImportBatchStatus, Tone> = {
  analyzed: "info",
  committed: "success",
  rolled_back: "neutral",
  failed: "danger",
};

function formatAge(minutes: number): string {
  if (minutes < 1) return "menos de 1 minuto";
  if (minutes < 60) return minutes === 1 ? "1 minuto" : `${formatNumber(minutes)} minutos`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return hours === 1 ? "1 hora" : `${formatNumber(hours)} horas`;
  return `${formatNumber(Math.floor(hours / 24))} dias`;
}

export default async function IntegrationsPage() {
  const ctx = await requirePageContext("admin:organization");
  const overview = await getIntegrationsOverview(ctx);
  // DataJud: real status from the court-sync module (replaces the static "não integrado").
  const datajud = await describeDataJudIntegration(ctx);
  // P1.7: collection of the correction index series (resolved here, like the other data of the page).
  const indexSeriesCard = await IndexSeriesCard({ ctx });
  const data = {
    ...overview,
    integrations: overview.integrations.map((i) =>
      i.key === "datajud"
        ? {
            ...i,
            status: (datajud.operational ? "operational" : "not_integrated") as IntegrationStatus,
            statusText: datajud.statusText,
            detail: datajud.detail,
          }
        : i,
    ),
  };
  const q = data.queue;
  const groups = [...new Set(data.integrations.map((i) => i.group))];
  const problems = q.byStatus.dead + q.byStatus.failed;
  const routinesWithError = data.routines.filter((r) => r.lastError).length;
  const canImports = can(ctx, "import:run");
  const canBriefs = can(ctx, "brief:read");
  const canEmails = can(ctx, "email:read");

  return (
    <>
      <PageHeader
        title="Integrações e saúde da coleta"
        description="O que está realmente integrado nesta versão, o que é simulado e como estão a fila de tarefas, as rotinas e as importações."
        breadcrumbs={[{ label: "Administração", href: "/admin" }, { label: "Integrações" }]}
        meta={
          <p className="text-xs text-muted-foreground">
            Atualizado em <time dateTime={data.generatedAt.toISOString()}>{formatDateTime(data.generatedAt)}</time>
          </p>
        }
      />
      <AdminNav ctx={ctx} active="integracoes" />

      <div className="flex flex-col gap-8">
        {datajud.operational ? (
          <Callout tone="info" title="Coleta automática: somente o DataJud (CNJ)">
            A carteira é alimentada por cadastro manual, importação de planilhas, API de entrada e pela consulta periódica à API
            pública do DataJud (classe, órgão, assuntos e movimentações). Diários oficiais, MNI e consultas aos sites dos
            tribunais não são integrados, e nenhuma movimentação é inventada pelo sistema.
          </Callout>
        ) : (
          <Callout tone="warning" title="Sem coleta automática nos tribunais no momento">
            A carteira é alimentada por cadastro manual, importação de planilhas e API de entrada. {datajud.statusText}: nenhum
            dado é coletado do CNJ ou dos tribunais, e nenhuma movimentação é inventada pelo sistema.
          </Callout>
        )}

        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader
              actions={
                <ButtonLink href="/admin/integracoes/datajud" variant="outline" size="sm">
                  Abrir
                </ButtonLink>
              }
            >
              <CardTitle className="flex items-center gap-2">
                <Landmark aria-hidden="true" className="size-4 text-muted-foreground" />
                DataJud (CNJ): saúde da coleta
              </CardTitle>
              <CardDescription>
                {datajud.statusText}. Por tribunal: última execução, encontrados, falhas, processos aguardando consulta e
                parâmetros.
              </CardDescription>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader
              actions={
                <ButtonLink href="/admin/integracoes/api" variant="outline" size="sm">
                  Abrir
                </ButtonLink>
              }
            >
              <CardTitle className="flex items-center gap-2">
                <KeyRound aria-hidden="true" className="size-4 text-muted-foreground" />
                API de entrada de processos
              </CardTitle>
              <CardDescription>
                Chaves para sistemas externos enviarem processos novos, com registro das últimas requisições.
              </CardDescription>
            </CardHeader>
          </Card>
        </div>

        {/* P1.7: correction index series collected from the Banco Central (SGS). */}
        {indexSeriesCard}

        {/* Power BI */}
        <Card>
          <CardHeader
            actions={
              <ButtonLink href="/admin/integracoes/power-bi" variant="outline" size="sm">
                Configurar Power BI
              </ButtonLink>
            }
          >
            <CardTitle className="flex items-center gap-2">
              <ChartPie aria-hidden="true" className="size-4 text-muted-foreground" />
              Painéis Power BI
            </CardTitle>
            <CardDescription>
              Credenciais, workspace, relatórios, papel de segurança (RLS) e histórico das atualizações automáticas dos
              painéis exibidos em Painéis Power BI.
            </CardDescription>
          </CardHeader>
        </Card>

        {/* Integrations */}
        <section aria-labelledby="integracoes-titulo">
          <Card className="pb-0">
            <CardHeader>
              <CardTitle id="integracoes-titulo" className="flex items-center gap-2">
                <Cable aria-hidden="true" className="size-4 text-muted-foreground" />
                Integrações
              </CardTitle>
              <CardDescription>Situação de cada ponto de integração, sem exageros: real, simulado ou não integrado.</CardDescription>
            </CardHeader>
            <CardContent className="px-0">
              <Table aria-label="Integrações e situação">
                <TableHeader>
                  <TableRow>
                    <TableHead>Integração</TableHead>
                    <TableHead>Situação</TableHead>
                    <TableHead>Como funciona nesta versão</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {groups.map((group) => (
                    <IntegrationGroup key={group} label={group}>
                      {data.integrations
                        .filter((i) => i.group === group)
                        .map((i) => (
                          <TableRow key={i.key} className="align-top">
                            <TableCell className="min-w-56 font-medium text-slate-900">{i.name}</TableCell>
                            <TableCell className="whitespace-nowrap">
                              <StatusBadge label={i.statusText} tone={STATUS_TONES[i.status]} />
                            </TableCell>
                            <TableCell className="min-w-72 text-sm text-slate-700">{i.detail}</TableCell>
                          </TableRow>
                        ))}
                    </IntegrationGroup>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </section>

        {/* Queue health */}
        <section aria-labelledby="fila-titulo" className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 id="fila-titulo" className="flex items-center gap-2 text-lg font-semibold tracking-tight text-slate-900">
                <Activity aria-hidden="true" className="size-4 text-muted-foreground" />
                Fila de tarefas em segundo plano
              </h2>
              <p className="text-sm text-muted-foreground">
                Extração de texto, análises, rotinas, entradas e análises preliminares da organização.
              </p>
            </div>
            <ActionButtonForm action={processQueueNowAction} pendingLabel="Processando…" variant="secondary" messageClassName="max-w-xs">
              Processar fila agora
            </ActionButtonForm>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label="Na fila"
              value={formatNumber(q.byStatus.queued)}
              hint={q.oldestQueued ? `Mais antiga há ${formatAge(q.oldestQueued.ageMinutes)}` : "Nenhuma tarefa aguardando"}
              tone={q.oldestQueued && q.oldestQueued.ageMinutes > 60 ? "warning" : "neutral"}
            />
            <StatCard label="Em execução" value={formatNumber(q.byStatus.running)} tone={q.byStatus.running > 0 ? "info" : "neutral"} />
            <StatCard label="Concluídas" value={formatNumber(q.byStatus.succeeded)} hint="Desde o início" tone="neutral" />
            <StatCard
              label="Com falha definitiva"
              value={formatNumber(problems)}
              hint="Esgotaram as tentativas ou falharam sem nova tentativa"
              tone={problems > 0 ? "danger" : "neutral"}
            />
          </div>

          <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
            <Card className="min-w-0 pb-0">
              <CardHeader>
                <CardTitle>Tarefas por tipo</CardTitle>
              </CardHeader>
              <CardContent className="px-0">
                <Table aria-label="Tarefas por tipo e situação">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Tipo</TableHead>
                      {JOB_STATUSES.map((s) => (
                        <TableHead key={s} className="text-right whitespace-normal">
                          {JOB_STATUS_LABELS[s]}
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {q.byType.length === 0 ? (
                      <TableEmpty colSpan={JOB_STATUSES.length + 1} message="Nenhuma tarefa registrada ainda." />
                    ) : (
                      q.byType.map((t) => (
                        <TableRow key={t.type}>
                          <TableCell>
                            <span className="block">{JOB_TYPE_LABELS[t.type] ?? t.type}</span>
                            <code className="text-xs text-muted-foreground">{t.type}</code>
                          </TableCell>
                          {JOB_STATUSES.map((s) => (
                            <TableCell key={s} className="text-right tabular-nums">
                              {formatNumber(t.byStatus[s])}
                            </TableCell>
                          ))}
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            <Card className="min-w-0 pb-0">
              <CardHeader>
                <CardTitle>Falhas recentes</CardTitle>
                <CardDescription>
                  Tarefas que esgotaram as tentativas ou aguardam nova tentativa após um erro. As mensagens não contêm
                  conteúdo de documentos.
                </CardDescription>
              </CardHeader>
              <CardContent className="px-0">
                <Table aria-label="Falhas recentes da fila">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Tarefa</TableHead>
                      <TableHead>Situação</TableHead>
                      <TableHead className="text-right">Tentativas</TableHead>
                      <TableHead>Erro</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {q.issues.length === 0 ? (
                      <TableEmpty colSpan={4} message="Nenhuma falha registrada." />
                    ) : (
                      q.issues.map((j) => (
                        <TableRow key={j.id} className="align-top">
                          <TableCell>
                            <span className="block">{JOB_TYPE_LABELS[j.type] ?? j.type}</span>
                            <span className="text-xs text-muted-foreground">{formatDateTime(j.completedAt ?? j.createdAt)}</span>
                          </TableCell>
                          <TableCell className="whitespace-nowrap">
                            {j.status === "queued" ? (
                              <StatusBadge label={`Nova tentativa ${formatDateTime(j.runAt)}`} tone="warning" />
                            ) : (
                              <StatusBadge label={JOB_STATUS_LABELS[j.status]} tone="danger" />
                            )}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatNumber(j.attempts)}/{formatNumber(j.maxAttempts)}
                          </TableCell>
                          <TableCell className="min-w-48 text-xs text-slate-700">{j.lastError ?? <span className="text-muted-foreground">Nenhum</span>}</TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </div>
        </section>

        {/* Routines */}
        <section aria-labelledby="rotinas-saude-titulo">
          <Card className="pb-0">
            <CardHeader
              actions={
                <ButtonLink href="/admin/configuracoes#rotinas" variant="outline" size="sm">
                  Configurar rotinas
                </ButtonLink>
              }
            >
              <CardTitle id="rotinas-saude-titulo" className="flex items-center gap-2">
                <Clock aria-hidden="true" className="size-4 text-muted-foreground" />
                Rotinas agendadas
              </CardTitle>
              <CardDescription>
                Última execução e resultado de cada rotina.
                {routinesWithError > 0 ? ` ${formatNumber(routinesWithError)} com erro na última execução.` : ""}
              </CardDescription>
            </CardHeader>
            <CardContent className="px-0">
              <Table aria-label="Rotinas agendadas">
                <TableHeader>
                  <TableRow>
                    <TableHead>Rotina</TableHead>
                    <TableHead>Situação</TableHead>
                    <TableHead>Última execução</TableHead>
                    <TableHead>Último resultado</TableHead>
                    <TableHead>Próxima execução</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.routines.map((r) => (
                    <TableRow key={r.id} className="align-top">
                      <TableCell className="min-w-56 font-medium text-slate-900">{ROUTINE_TYPE_LABELS[r.type]}</TableCell>
                      <TableCell className="whitespace-nowrap">
                        {r.lastError ? (
                          <StatusBadge label="Erro na última execução" tone="danger" />
                        ) : (
                          <StatusBadge label={r.enabled ? "Ativa" : "Pausada"} tone={r.enabled ? "success" : "neutral"} />
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {r.lastRunAt ? formatDateTime(r.lastRunAt) : <span className="text-muted-foreground">Nunca</span>}
                      </TableCell>
                      <TableCell className="min-w-56 text-sm">
                        {r.lastStatus ?? <span className="text-muted-foreground">Sem resultado</span>}
                        {r.lastError ? <span className="mt-1 block text-xs text-red-700">Erro: {r.lastError}</span> : null}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {r.enabled ? formatDateTime(r.nextRunAt) : <span className="text-muted-foreground">Pausada</span>}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </section>

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
          {/* Import batches */}
          <Card className="min-w-0 pb-0 xl:col-span-2">
            <CardHeader
              actions={
                canImports ? (
                  <ButtonLink href="/importacoes" variant="outline" size="sm">
                    Ver importações
                  </ButtonLink>
                ) : null
              }
            >
              <CardTitle className="flex items-center gap-2">
                <FileSpreadsheet aria-hidden="true" className="size-4 text-muted-foreground" />
                Últimas importações de planilha
              </CardTitle>
              <CardDescription>Situação e resumo dos cinco lotes mais recentes.</CardDescription>
            </CardHeader>
            <CardContent className="px-0">
              <Table aria-label="Últimas importações de planilha">
                <TableHeader>
                  <TableRow>
                    <TableHead>Arquivo</TableHead>
                    <TableHead>Situação</TableHead>
                    <TableHead className="text-right">Linhas</TableHead>
                    <TableHead className="text-right">Processos</TableHead>
                    <TableHead className="text-right">Erros</TableHead>
                    <TableHead className="text-right">Divergências</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.importBatches.length === 0 ? (
                    <TableEmpty colSpan={6} message="Nenhuma planilha importada ainda." />
                  ) : (
                    data.importBatches.map((b) => (
                      <TableRow key={b.id} className="align-top">
                        <TableCell className="min-w-48">
                          {canImports ? (
                            <Link href={`/importacoes/${b.id}`} className={tableLinkClasses}>
                              {b.fileName}
                            </Link>
                          ) : (
                            <span className="font-medium text-slate-900">{b.fileName}</span>
                          )}
                          <span className="block text-xs text-muted-foreground">{formatDateTime(b.createdAt)}</span>
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          <StatusBadge label={IMPORT_BATCH_STATUS_LABELS[b.status] ?? b.status} tone={IMPORT_TONES[b.status] ?? "neutral"} />
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{b.stats ? formatNumber(b.stats.rowsRead) : <span className="text-muted-foreground">Sem dados</span>}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {b.stats ? formatNumber(b.stats.processesDetected) : <span className="text-muted-foreground">Sem dados</span>}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{b.stats ? formatNumber(b.stats.errors) : <span className="text-muted-foreground">Sem dados</span>}</TableCell>
                        <TableCell className="text-right tabular-nums">{b.stats ? formatNumber(b.stats.divergences) : <span className="text-muted-foreground">Sem dados</span>}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <div className="flex min-w-0 flex-col gap-6">
            {/* Case briefs */}
            <Card>
              <CardHeader
                actions={
                  canBriefs ? (
                    <ButtonLink href="/analises-preliminares" variant="outline" size="sm">
                      Abrir
                    </ButtonLink>
                  ) : null
                }
              >
                <CardTitle className="flex items-center gap-2">
                  <FileSearch aria-hidden="true" className="size-4 text-muted-foreground" />
                  Análises preliminares
                </CardTitle>
                <CardDescription>Simulação demonstrativa · {formatNumber(data.briefs.total)} no total.</CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="divide-y divide-border text-sm" aria-label="Análises preliminares por situação">
                  {CASE_BRIEF_STATUSES.map((s) => (
                    <li key={s} className="flex items-center justify-between gap-3 py-2">
                      <span className="text-slate-700">{CASE_BRIEF_STATUS_LABELS[s]}</span>
                      <span className="font-semibold text-slate-900 tabular-nums">{formatNumber(data.briefs.byStatus[s])}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>

            {/* Simulated e-mails */}
            <Card>
              <CardHeader
                actions={
                  canEmails ? (
                    <ButtonLink href="/emails" variant="outline" size="sm">
                      Abrir
                    </ButtonLink>
                  ) : null
                }
              >
                <CardTitle className="flex items-center gap-2">
                  <Mail aria-hidden="true" className="size-4 text-muted-foreground" />
                  E-mails simulados nos últimos 7 dias
                </CardTitle>
                <CardDescription>
                  Envio simulado: nenhuma mensagem foi enviada. {formatNumber(data.emails.last7Days)} gerados
                  {data.emails.failedLast7Days > 0 ? `, ${formatNumber(data.emails.failedLast7Days)} com falha` : ""}.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {data.emails.byTemplate.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Nenhum e-mail simulado nos últimos 7 dias.</p>
                ) : (
                  <ul className="divide-y divide-border text-sm" aria-label="E-mails simulados por modelo">
                    {data.emails.byTemplate.map((t) => (
                      <li key={t.template} className="flex items-center justify-between gap-3 py-2">
                        <span className="text-slate-700">{EMAIL_TEMPLATE_LABELS[t.template] ?? t.template}</span>
                        <span className="font-semibold text-slate-900 tabular-nums">{formatNumber(t.count)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </>
  );
}

function IntegrationGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <TableRow className="bg-surface-muted">
        <TableHead scope="colgroup" colSpan={3} className="text-xs font-semibold tracking-wide text-slate-700 uppercase">
          {label}
        </TableHead>
      </TableRow>
      {children}
    </>
  );
}
