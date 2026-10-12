import { Bot, CalendarClock, FilePlus2, FlaskConical, Gauge, PencilLine, ShieldCheck, Sparkles } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import {
  ANALYSIS_STATUSES,
  ANALYSIS_STATUS_LABELS,
  ANALYSIS_TYPE_LABELS,
  ANALYSIS_TYPES,
} from "@/domain/enums";
import { AiModeBadge } from "@/components/ui/ai-mode-badge";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { FilterBar, FilterSelect } from "@/components/ui/filter-bar";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { StatCard } from "@/components/ui/stat-card";
import {
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
  tableLinkClasses,
} from "@/components/ui/table";
import { LinkTabs } from "@/components/ui/tabs";
import { formatDateTime, formatMonthYear, formatNumber, formatPercent, truncate } from "@/lib/format";
import { optionsFromLabels, type Option } from "@/lib/options";
import { buildHref, enumParam, flagParam, pageParam, param, type SearchParams } from "@/lib/search-params";
import { requirePageContext } from "@/server/auth/session";
import { can } from "@/server/auth/permissions";
import type { UserContext } from "@/server/auth/context";
import { listDocuments } from "@/modules/documents/service";
import { listContractOptions } from "@/modules/contracts/service";
import { listOccurrenceOptions } from "@/modules/occurrences/service";
import { listProcessOptions } from "@/modules/processes/service";
import { loadOrganization } from "@/modules/analyses/org-settings";
import { getAiRuntimeInfo, getAiUsageSummary, listAnalyses } from "@/modules/analyses/service";
import { AnalysisAutoRefresh } from "@/modules/analyses/components/analysis-auto-refresh";
import {
  AnalysisStatusBadge,
  ReviewStatusBadge,
  StaleBadge,
} from "@/modules/analyses/components/analysis-badges";
import { AnalysisRequestForm, QuestionForm } from "@/modules/analyses/components/analysis-forms";
import {
  COST_VISIBLE_ROLES,
  formatMicroUsd,
  type RecordSubjectType,
} from "@/modules/analyses/components/analysis-labels";

export const metadata: Metadata = { title: "Central de Inteligência Artificial" };

const TABS = ["analises", "perguntas", "solicitar", "uso"] as const;
type TabKey = (typeof TABS)[number];
const TAB_LABELS: Record<TabKey, string> = {
  analises: "Análises",
  perguntas: "Perguntas e respostas",
  solicitar: "Solicitar análise",
  uso: "Uso e limites",
};

const BASE_PATH = "/ia";
const DOCUMENT_OPTIONS_LIMIT = 100;

export default async function AiCenterPage(props: PageProps<"/ia">) {
  const ctx = await requirePageContext("analysis:read");
  const sp = await props.searchParams;
  const tab = enumParam(sp, "aba", TABS) ?? "analises";
  const runtime = getAiRuntimeInfo();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Central de Inteligência Artificial"
        description="Análises automáticas de processos, ocorrências, contratos e documentos, sempre com fontes, limitações e validação humana."
        breadcrumbs={[{ label: "Painel executivo", href: "/dashboard" }, { label: "Inteligência Artificial" }]}
        meta={<AiModeBadge mode={runtime.mode} />}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <RuntimeCard mode={runtime.mode} provider={runtime.provider} model={runtime.model} />
        <MonitoringCard />
      </div>

      <LinkTabs
        label="Seções da Central de IA"
        active={tab}
        tabs={TABS.map((key) => ({ key, label: TAB_LABELS[key], href: buildHref(BASE_PATH, {}, { aba: key === "analises" ? null : key }) }))}
      />

      {tab === "analises" ? <AnalysesTab ctx={ctx} sp={sp} /> : null}
      {tab === "perguntas" ? <QuestionsTab ctx={ctx} sp={sp} /> : null}
      {tab === "solicitar" ? <RequestTab ctx={ctx} /> : null}
      {tab === "uso" ? <UsageTab ctx={ctx} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header cards
// ---------------------------------------------------------------------------

function RuntimeCard({ mode, provider, model }: { mode: "live" | "demo"; provider: string; model: string }) {
  return (
    <Card className={mode === "demo" ? "border-amber-200" : "border-ai-200"}>
      <CardHeader actions={<AiModeBadge mode={mode} />}>
        <CardTitle as="h2" className="flex items-center gap-2">
          {mode === "demo" ? (
            <FlaskConical aria-hidden="true" className="size-4 text-amber-700" />
          ) : (
            <Bot aria-hidden="true" className="size-4 text-ai-700" />
          )}
          Motor de análise
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm text-slate-700">
        {mode === "demo" ? (
          <>
            <p>
              <strong>Nenhuma credencial de IA está configurada neste ambiente.</strong> As análises são geradas por regras
              simples de demonstração (provedor “{provider}”), sem uso de inteligência artificial, e servem apenas para
              conhecer o fluxo do sistema.
            </p>
            <p>Todo resultado demonstrativo é identificado como tal e não deve ser usado para decisões.</p>
          </>
        ) : (
          <>
            <p>
              As análises são feitas pelo modelo <strong>{model}</strong> (provedor “{provider}”), usando apenas as fontes que
              você pode acessar, enviadas como dados. Instruções contidas nos documentos são ignoradas.
            </p>
            <p>
              Os resultados não substituem a avaliação de um advogado, não preveem resultados e exigem revisão jurídica
              antes de qualquer uso.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function MonitoringCard() {
  const items = [
    {
      icon: <FilePlus2 aria-hidden="true" className="size-4" />,
      title: "Novos documentos",
      text: "Quando o texto de um documento ou de uma nova versão é extraído, as análises que o usaram (ou que usaram o registro vinculado) são marcadas como desatualizadas e, se a organização permitir, um resumo do documento é solicitado automaticamente.",
    },
    {
      icon: <PencilLine aria-hidden="true" className="size-4" />,
      title: "Alterações relevantes",
      text: "Ao editar um processo, uma ocorrência ou um contrato, as análises baseadas nele passam a exibir o aviso de desatualização e geram um alerta.",
    },
    {
      icon: <CalendarClock aria-hidden="true" className="size-4" />,
      title: "Rotinas agendadas",
      text: "Rotinas periódicas geram alertas de prazos e de vigência contratual e contabilizam as análises desatualizadas. A reanálise automática fica desativada por padrão, para controlar custos: solicite uma nova análise quando necessário.",
    },
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2" className="flex items-center gap-2">
          <ShieldCheck aria-hidden="true" className="size-4 text-primary-700" />
          Como funciona o monitoramento contínuo
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="space-y-3">
          {items.map((i) => (
            <li key={i.title} className="flex gap-3 text-sm">
              <span className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-primary-50 text-primary-700">
                {i.icon}
              </span>
              <span>
                <span className="font-medium text-slate-900">{i.title}. </span>
                <span className="text-slate-700">{i.text}</span>
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-muted-foreground">
          A IA nunca altera registros: achados e sugestões só viram tarefas ou prazos por ação explícita de um usuário, e
          prazos sugeridos exigem validação humana.
        </p>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Tab: Análises
// ---------------------------------------------------------------------------

async function AnalysesTab({ ctx, sp }: { ctx: UserContext; sp: SearchParams }) {
  const status = enumParam(sp, "status", ANALYSIS_STATUSES);
  const type = enumParam(sp, "tipo", ANALYSIS_TYPES);
  const staleOnly = flagParam(sp, "desatualizadas");
  const result = await listAnalyses(ctx, { status, type, staleOnly, page: pageParam(sp) });
  const pending = result.items.some((a) => a.status === "queued" || a.status === "running");
  const hasFilters = Boolean(status || type || staleOnly);

  return (
    <div className="space-y-4">
      <FilterBar basePath={BASE_PATH} search={false} hiddenFields={{ aba: param(sp, "aba") }}>
        <FilterSelect
          name="status"
          label="Situação"
          options={optionsFromLabels(ANALYSIS_STATUS_LABELS)}
          defaultValue={status}
          placeholder="Todas"
        />
        <FilterSelect name="tipo" label="Tipo" options={optionsFromLabels(ANALYSIS_TYPE_LABELS)} defaultValue={type} />
        <FilterSelect
          name="desatualizadas"
          label="Atualização"
          options={[{ value: "1", label: "Somente desatualizadas" }]}
          defaultValue={staleOnly ? "1" : undefined}
          placeholder="Todas"
        />
      </FilterBar>

      <AnalysisAutoRefresh active={pending} />

      <Card className="py-0">
        <Table aria-label="Análises de IA">
          <TableHeader>
            <TableRow>
              <TableHead>Análise</TableHead>
              <TableHead>Objeto</TableHead>
              <TableHead>Situação</TableHead>
              <TableHead>Modo</TableHead>
              <TableHead>Revisão</TableHead>
              <TableHead>Solicitada em</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.items.length === 0 ? (
              <TableEmpty
                colSpan={6}
                message={hasFilters ? "Nenhuma análise encontrada com esses filtros." : "Nenhuma análise de IA ainda."}
                description={
                  hasFilters
                    ? "Ajuste ou limpe os filtros para ver outras análises."
                    : can(ctx, "analysis:request")
                      ? "Solicite uma análise na aba “Solicitar análise” ou na página de um registro."
                      : undefined
                }
              />
            ) : (
              result.items.map((a) => (
                <TableRow key={a.id} interactive>
                  <TableCell>
                    <Link href={`/ia/analises/${a.id}`} className={tableLinkClasses}>
                      {ANALYSIS_TYPE_LABELS[a.type]}
                    </Link>
                    {a.question ? (
                      <p className="mt-0.5 max-w-xs text-xs text-muted-foreground">“{truncate(a.question, 90)}”</p>
                    ) : null}
                  </TableCell>
                  <TableCell className="max-w-xs">
                    {a.subjectHref ? (
                      <Link href={a.subjectHref} className="text-sm text-slate-800 underline-offset-2 hover:underline">
                        {truncate(a.subjectLabel, 80)}
                      </Link>
                    ) : (
                      <span className="text-sm text-slate-800">{truncate(a.subjectLabel, 80)}</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      <AnalysisStatusBadge status={a.status} />
                      <StaleBadge isStale={a.isStale} />
                    </div>
                  </TableCell>
                  <TableCell>
                    <AiModeBadge mode={a.mode} />
                  </TableCell>
                  <TableCell>
                    <ReviewStatusBadge status={a.reviewStatus} analysisStatus={a.status} />
                    {a.status !== "succeeded" ? <span className="text-sm text-muted-foreground">Não se aplica</span> : null}
                  </TableCell>
                  <TableCell className="text-sm whitespace-nowrap text-slate-700">{formatDateTime(a.createdAt)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>
      <Pagination page={result.page} pageSize={result.pageSize} total={result.total} basePath={BASE_PATH} searchParams={sp} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab: Perguntas e respostas
// ---------------------------------------------------------------------------

async function QuestionsTab({ ctx, sp }: { ctx: UserContext; sp: SearchParams }) {
  // question_answer analyses are private: the visibility scope only returns the requester's own questions.
  const result = await listAnalyses(ctx, { type: "question_answer", page: pageParam(sp), pageSize: 15 });
  const pending = result.items.some((a) => a.status === "queued" || a.status === "running");
  const canAsk = can(ctx, "analysis:request");

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <Card className="h-fit">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles aria-hidden="true" className="size-4 text-ai-700" />
            Fazer uma pergunta
          </CardTitle>
          <CardDescription>
            A resposta usa apenas registros e documentos que você pode acessar e cita as fontes consultadas. Suas perguntas e
            respostas ficam visíveis somente para você.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {canAsk ? (
            <QuestionForm />
          ) : (
            <p className="text-sm text-muted-foreground">Seu perfil permite consultar análises, mas não fazer perguntas à IA.</p>
          )}
        </CardContent>
      </Card>

      <section aria-labelledby="minhas-perguntas" className="space-y-3">
        <h2 id="minhas-perguntas" className="text-base font-semibold text-slate-900">
          Minhas perguntas{result.total ? ` (${formatNumber(result.total)})` : ""}
        </h2>
        <AnalysisAutoRefresh active={pending} />
        {result.items.length === 0 ? (
          <EmptyState
            title="Você ainda não fez perguntas"
            description="Pergunte, por exemplo, quais contratos vencem nos próximos meses ou quais processos tratam de determinado tema."
          />
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border bg-surface">
            {result.items.map((a) => (
              <li key={a.id} className="space-y-1.5 p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <Link href={`/ia/analises/${a.id}`} className={`${tableLinkClasses} min-w-0 flex-1 break-words`}>
                    {a.question ? truncate(a.question, 200) : "Pergunta"}
                  </Link>
                  <div className="flex flex-wrap gap-1">
                    <AnalysisStatusBadge status={a.status} />
                    <AiModeBadge mode={a.mode} />
                  </div>
                </div>
                {a.summaryPreview && a.status === "succeeded" ? (
                  <p className="text-sm text-slate-700">{truncate(a.summaryPreview, 220)}</p>
                ) : null}
                <p className="text-xs text-muted-foreground">Perguntada em {formatDateTime(a.createdAt)}</p>
              </li>
            ))}
          </ul>
        )}
        <Pagination page={result.page} pageSize={result.pageSize} total={result.total} basePath={BASE_PATH} searchParams={sp} />
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab: Solicitar análise
// ---------------------------------------------------------------------------

async function RequestTab({ ctx }: { ctx: UserContext }) {
  if (!can(ctx, "analysis:request")) {
    return (
      <EmptyState
        title="Solicitação de análises indisponível"
        description="Seu perfil permite consultar análises de IA, mas não solicitar novas análises."
      />
    );
  }

  const [processes, occurrences, contracts, documents] = await Promise.all([
    can(ctx, "process:read") ? listProcessOptions(ctx) : Promise.resolve([]),
    can(ctx, "occurrence:read") ? listOccurrenceOptions(ctx) : Promise.resolve([]),
    can(ctx, "contract:read") ? listContractOptions(ctx) : Promise.resolve([]),
    can(ctx, "document:read")
      ? listDocuments(ctx, { page: 1, pageSize: DOCUMENT_OPTIONS_LIMIT })
      : Promise.resolve({ items: [], total: 0, page: 1, pageSize: DOCUMENT_OPTIONS_LIMIT }),
  ]);

  const subjectOptions: Partial<Record<RecordSubjectType, Option[]>> = {
    legal_process: processes.map((p) => ({ value: p.id, label: truncate(`${p.number} · ${p.title}`, 120) })),
    occurrence: occurrences.map((o) => ({ value: o.id, label: truncate(o.title, 120) })),
    contract: contracts.map((c) => ({ value: c.id, label: truncate(`${c.title} (${c.counterparty})`, 120) })),
    document: documents.items.map((d) => ({ value: d.id, label: truncate(d.title, 120) })),
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <Card>
        <CardHeader>
          <CardTitle>Nova análise</CardTitle>
          <CardDescription>
            Escolha o tipo de registro, o registro e o tipo de análise. A análise usa os dados cadastrados e os documentos
            vinculados que você pode acessar.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AnalysisRequestForm subjectOptions={subjectOptions} redirectToResult />
          {documents.total > documents.items.length ? (
            <p className="mt-3 text-xs text-muted-foreground">
              A lista de documentos mostra os {formatNumber(documents.items.length)} mais recentes. Para analisar outro
              documento, use o painel de IA na página do documento ou do registro vinculado.
            </p>
          ) : null}
        </CardContent>
      </Card>
      <Card className="h-fit">
        <CardHeader>
          <CardTitle as="h2">Tipos de análise</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="space-y-2 text-sm">
            {(
              [
                ["summary", "Visão geral objetiva do registro e de seus documentos."],
                ["extraction", "Partes, datas, valores e obrigações mencionados nas fontes."],
                ["risk_signals", "Sinais de risco e informações que parecem faltar."],
                ["inconsistencies", "Contradições entre fontes, documentos faltantes e obrigações pendentes."],
                ["preventive_actions", "Ações preventivas sugeridas para reduzir riscos."],
              ] as const
            ).map(([t, text]) => (
              <div key={t}>
                <dt className="font-medium text-slate-900">{ANALYSIS_TYPE_LABELS[t]}</dt>
                <dd className="text-slate-700">{text}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-xs text-muted-foreground">
            Nenhum tipo de análise prevê resultado de processos ou substitui a avaliação de um advogado.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab: Uso e limites
// ---------------------------------------------------------------------------

async function UsageTab({ ctx }: { ctx: UserContext }) {
  const [usage, org] = await Promise.all([getAiUsageSummary(ctx), loadOrganization(ctx.organizationId)]);
  const used = usage.inputTokens + usage.outputTokens;
  const budget = usage.monthlyTokenBudget;
  const ratio = budget > 0 ? Math.min(1, used / budget) : 1;
  const showCosts = (COST_VISIBLE_ROLES as readonly string[]).includes(ctx.role);
  const barTone = ratio >= 0.9 ? "bg-red-600" : ratio >= 0.7 ? "bg-amber-500" : "bg-ai-600";

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Gauge aria-hidden="true" className="size-4 text-ai-700" />
            Consumo de {formatMonthYear(usage.period)}
          </CardTitle>
          <CardDescription>Uso de IA de toda a organização no mês corrente (análises em modo real).</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {budget > 0 ? (
            <>
              <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                <span className="text-slate-700">
                  <strong className="text-slate-900">{formatNumber(used)}</strong> de {formatNumber(budget)} tokens
                </span>
                <span className="font-medium text-slate-900">{formatPercent(ratio, 1)} do limite mensal</span>
              </div>
              <div
                role="progressbar"
                aria-label="Tokens usados no mês em relação ao limite mensal"
                aria-valuemin={0}
                aria-valuemax={budget}
                aria-valuenow={Math.min(used, budget)}
                aria-valuetext={`${formatNumber(used)} de ${formatNumber(budget)} tokens (${formatPercent(ratio, 1)})`}
                className="h-3 w-full overflow-hidden rounded-full bg-slate-100"
              >
                <div className={`h-full rounded-full ${barTone}`} style={{ width: `${(ratio * 100).toFixed(2)}%` }} />
              </div>
              {ratio >= 0.9 ? (
                <Callout tone="warning">
                  O consumo está próximo do limite mensal. Ao atingi-lo, novas análises em modo real serão recusadas até o
                  próximo mês ou até um administrador ajustar o limite.
                </Callout>
              ) : null}
            </>
          ) : (
            <Callout tone="warning">
              O limite mensal de tokens está zerado: o uso de IA real está desativado para esta organização.
            </Callout>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Chamadas ao provedor no mês" value={formatNumber(usage.requests)} tone="ai" />
        <StatCard label="Tokens de entrada" value={formatNumber(usage.inputTokens)} tone="ai" />
        <StatCard label="Tokens de saída" value={formatNumber(usage.outputTokens)} tone="ai" />
        {showCosts ? (
          <StatCard label="Custo estimado no mês" value={formatMicroUsd(usage.costMicroUsd)} hint="Estimativa pela tabela de preços do provedor" tone="ai" />
        ) : (
          <StatCard label="Limite por análise" value={`${formatNumber(org.settings.ai.maxInputChars)} caracteres`} tone="ai" />
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Como o custo é controlado</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2 text-sm text-slate-700">
            <li>
              <strong className="text-slate-900">Reaproveitamento por conteúdo:</strong> cada solicitação é identificada pelo
              hash das fontes, do tipo de análise e do modelo. Se já existir uma análise idêntica concluída e atualizada (ou em
              andamento), ela é reaproveitada sem nova chamada ao provedor.
            </li>
            <li>
              <strong className="text-slate-900">Limite mensal de tokens:</strong> {formatNumber(budget)} tokens por mês para a
              organização. Solicitações que ultrapassariam o limite são recusadas.
            </li>
            <li>
              <strong className="text-slate-900">Tamanho máximo da entrada:</strong> até{" "}
              {formatNumber(org.settings.ai.maxInputChars)} caracteres de fontes por análise; o excedente é cortado e a análise
              informa a limitação.
            </li>
            <li>
              <strong className="text-slate-900">Novas tentativas com espera crescente:</strong> falhas temporárias do provedor
              são repetidas algumas vezes com intervalos crescentes; erros definitivos não são repetidos.
            </li>
            <li>
              <strong className="text-slate-900">Modo demonstrativo:</strong> sem credenciais de IA, nenhuma chamada paga é feita
              e os resultados são apenas demonstrativos.
            </li>
          </ul>
          {can(ctx, "admin:organization") ? (
            <p className="mt-3 text-xs text-muted-foreground">
              Os limites podem ser ajustados em{" "}
              <Link href="/admin" className="font-medium text-primary-700 underline underline-offset-2">
                Administração
              </Link>
              .
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
