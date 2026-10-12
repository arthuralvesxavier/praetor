import { Database, KeyRound, RefreshCw, Users } from "lucide-react";
import type { Metadata } from "next";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { StatCard } from "@/components/ui/stat-card";
import { StatusBadge } from "@/components/ui/status-badge";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { BI_REFRESH_STATUS_LABELS, BI_REFRESH_TRIGGER_LABELS, type BiRefreshStatus } from "@/domain/enums";
import { formatDateTime, formatNumber } from "@/lib/format";
import type { Tone } from "@/lib/tones";
import { AdminNav } from "@/modules/admin/components/admin-nav";
import { ActionButtonForm } from "@/modules/admin/components/form-utils";
import { requestBiRefreshAction, testPowerBiConnectionAction, updateBiSettingsAction } from "@/modules/bi/actions";
import { BiConnectionTest } from "@/modules/bi/components/bi-connection-test";
import { BiSettingsForm } from "@/modules/bi/components/bi-settings-form";
import { getBiAdminOverview } from "@/modules/bi/service";
import { requirePageContext } from "@/server/auth/session";

export const metadata: Metadata = { title: "Power BI" };

const RUN_TONES: Record<BiRefreshStatus, Tone> = {
  requested: "info",
  succeeded: "success",
  failed: "danger",
  skipped: "neutral",
};

const BI_VIEWS: { name: string; description: string }[] = [
  {
    name: "bi.processos",
    description:
      "um registro por processo: valores, exposição e provisão apuradas e estimadas em colunas separadas; em_carteira_ativa marca a carteira dos totais do Praetor",
  },
  {
    name: "bi.competencias",
    description: "posição de cada processo nas competências mensais fechadas, como foi gravada (inclusive processos excluídos depois)",
  },
  { name: "bi.valoracoes", description: "histórico de valores (causa, apurado, acordo, depósito), com origem e conferência" },
  { name: "bi.pendencias", description: "quantidade de alertas abertos, prazos aguardando validação e valores aguardando conferência" },
  { name: "bi.acesso", description: "quais processos cada usuário pode ver (base do papel de segurança)" },
  { name: "bi.rotulos", description: "nomes em português dos códigos (fase, instância, situação)" },
  { name: "bi.atualizacao", description: "quando a tabela de acessos foi recalculada e quando mudou pela última vez" },
];

export default async function PowerBiSettingsPage() {
  const ctx = await requirePageContext("admin:organization");
  const data = await getBiAdminOverview(ctx);
  const { config, credentials } = data;

  return (
    <>
      <PageHeader
        title="Power BI"
        description="Painéis da carteira no Power BI com as mesmas regras de acesso do Praetor. As credenciais do aplicativo ficam somente no servidor."
        breadcrumbs={[
          { label: "Administração", href: "/admin" },
          { label: "Integrações", href: "/admin/integracoes" },
          { label: "Power BI" },
        ]}
      />
      <AdminNav ctx={ctx} active="integracoes" />

      <div className="flex flex-col gap-8">
        <section aria-labelledby="bi-situacao" className="flex flex-col gap-4">
          <h2 id="bi-situacao" className="text-lg font-semibold tracking-tight text-slate-900">
            Situação
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label="Credenciais no servidor"
              value={credentials.configured ? "Configuradas" : "Pendentes"}
              hint={credentials.configured ? "Aplicativo do Entra ID informado" : `Faltam: ${credentials.missing.join(", ")}`}
              tone={credentials.configured ? "success" : "warning"}
              icon={<KeyRound />}
            />
            <StatCard
              label="Painéis cadastrados"
              value={formatNumber(config.reports.length)}
              hint={config.workspaceId ? "Workspace cadastrado" : "Workspace não cadastrado"}
              tone={config.reports.length > 0 && config.workspaceId ? "success" : "neutral"}
              icon={<Database />}
            />
            <StatCard
              label="Acessos recalculados"
              value={config.accessRefreshedAt ? formatDateTime(config.accessRefreshedAt) : "Ainda não"}
              hint={
                config.accessRefreshedAt
                  ? `${formatNumber(config.accessUserCount ?? 0)} usuário(s), ${formatNumber(config.accessRowCount ?? 0)} vínculo(s)` +
                    (config.accessChangedAt ? `. Última mudança: ${formatDateTime(config.accessChangedAt)}` : "")
                  : "A rotina recalcula a cada execução"
              }
              tone="neutral"
              icon={<Users />}
            />
            <StatCard
              label="Atualização automática"
              value={data.refreshBlocker ? "Inativa" : config.autoRefresh ? "Ligada" : "Desligada"}
              hint={
                data.refreshBlocker ??
                (data.pendingJob ? "Há uma atualização na fila" : "Após importações, fechamentos, coletas e mudanças de acesso")
              }
              tone={data.refreshBlocker ? "warning" : config.autoRefresh ? "success" : "neutral"}
              icon={<RefreshCw />}
            />
          </div>
          {!credentials.configured ? (
            <Callout tone="warning" title="Credenciais do aplicativo pendentes">
              Defina no servidor as variáveis {credentials.missing.join(", ")} (veja o arquivo .env.example e o guia
              docs/POWER_BI.md) e reinicie o Praetor. O segredo nunca é digitado nesta tela nem gravado no banco. Até lá, a
              tabela de acessos continua sendo recalculada e nenhuma chamada ao Power BI é feita.
            </Callout>
          ) : null}
        </section>

        <section aria-label="Configuração dos painéis">
          <BiSettingsForm
            action={updateBiSettingsAction}
            defaults={{
              workspaceId: config.workspaceId,
              rlsRole: config.rlsRole,
              autoRefresh: config.autoRefresh,
              reports: config.reports,
            }}
          />
        </section>

        <section aria-labelledby="bi-conexao">
          <Card>
            <CardHeader>
              <CardTitle id="bi-conexao">Conexão e atualização</CardTitle>
              <CardDescription>
                O teste lista os relatórios do workspace (nomes e ids) usando as credenciais do servidor. &quot;Atualizar
                agora&quot; recalcula os acessos e pede ao Power BI a atualização de cada conjunto de dados cadastrado.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-6">
              <BiConnectionTest action={testPowerBiConnectionAction} />
              <ActionButtonForm action={requestBiRefreshAction} pendingLabel="Enfileirando…" messageClassName="max-w-xl">
                <RefreshCw aria-hidden="true" />
                Atualizar agora
              </ActionButtonForm>
              <div className="text-sm text-slate-700">
                <p className="font-medium text-slate-900">Rotina de acessos e atualização</p>
                {data.routine ? (
                  <>
                    <p>
                      {data.routine.enabled ? `Ativa, a cada ${formatNumber(data.routine.intervalMinutes)} minutos.` : "Pausada."}{" "}
                      Última execução: {data.routine.lastRunAt ? formatDateTime(data.routine.lastRunAt) : "nunca"}.
                    </p>
                    {data.routine.lastStatus ? <p className="text-muted-foreground">{data.routine.lastStatus}</p> : null}
                    {data.routine.lastError ? <p className="text-red-700">Erro: {data.routine.lastError}</p> : null}
                  </>
                ) : (
                  <p className="text-muted-foreground">A rotina será criada pelo processamento em segundo plano.</p>
                )}
              </div>
            </CardContent>
          </Card>
        </section>

        <section aria-labelledby="bi-historico">
          <Card className="pb-0">
            <CardHeader>
              <CardTitle id="bi-historico">Histórico de atualizações do Power BI</CardTitle>
              <CardDescription>As dez solicitações mais recentes. As mensagens não contêm dados da carteira.</CardDescription>
            </CardHeader>
            <CardContent className="px-0">
              <Table aria-label="Histórico de atualizações do Power BI">
                <TableHeader>
                  <TableRow>
                    <TableHead>Quando</TableHead>
                    <TableHead>Motivo</TableHead>
                    <TableHead>Situação</TableHead>
                    <TableHead>Painel</TableHead>
                    <TableHead>Detalhe</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.runs.length === 0 ? (
                    <TableEmpty colSpan={5} message="Nenhuma atualização solicitada ainda." />
                  ) : (
                    data.runs.map((r) => (
                      <TableRow key={r.id} className="align-top">
                        <TableCell className="whitespace-nowrap">
                          {formatDateTime(r.createdAt)}
                          {r.finishedAt && r.status !== "skipped" ? (
                            <span className="block text-xs text-muted-foreground">Concluída em {formatDateTime(r.finishedAt)}</span>
                          ) : null}
                        </TableCell>
                        <TableCell className="min-w-40">
                          {BI_REFRESH_TRIGGER_LABELS[r.trigger] ?? r.trigger}
                          {r.requestedByName ? <span className="block text-xs text-muted-foreground">Por {r.requestedByName}</span> : null}
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          <StatusBadge label={BI_REFRESH_STATUS_LABELS[r.status] ?? r.status} tone={RUN_TONES[r.status] ?? "neutral"} />
                        </TableCell>
                        <TableCell className="min-w-32">{r.datasetName ?? (r.datasetId ? <code className="text-xs">{r.datasetId}</code> : "Todos")}</TableCell>
                        <TableCell className="min-w-64 text-sm text-slate-700">{r.message ?? ""}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </section>

        <section aria-labelledby="bi-desktop">
          <Card>
            <CardHeader>
              <CardTitle id="bi-desktop">Para montar o relatório no Power BI Desktop</CardTitle>
              <CardDescription>
                Conecte o Power BI Desktop ao banco do Praetor (PostgreSQL) com o usuário somente leitura desta organização,
                criado pelo script bi-setup. Ele enxerga apenas as visões do schema bi, e só as linhas desta organização.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4 text-sm text-slate-700">
              <ul className="list-disc space-y-1 pl-5">
                {BI_VIEWS.map((v) => (
                  <li key={v.name}>
                    <code className="text-xs">{v.name}</code>: {v.description}
                  </li>
                ))}
              </ul>
              <dl className="grid gap-3 sm:grid-cols-2">
                <div>
                  <dt className="font-medium text-slate-900">Id desta organização</dt>
                  <dd>
                    <code className="text-xs break-all">{data.organizationId}</code>
                    <span className="block text-xs text-muted-foreground">
                      Informe este id ao script bi-setup (--org=) quando o banco tiver mais de uma organização.
                    </span>
                  </dd>
                </div>
                <div>
                  <dt className="font-medium text-slate-900">Usuário de leitura do banco</dt>
                  <dd>
                    {data.readerRoles.length > 0 ? (
                      <code className="text-xs break-all">{data.readerRoles.join(", ")}</code>
                    ) : (
                      <span>Nenhum registrado.</span>
                    )}
                    <span className="block text-xs text-muted-foreground">
                      {data.readerRoles.length > 0
                        ? "Lê somente as linhas desta organização. Cada usuário de leitura serve a uma única organização."
                        : "Peça a quem mantém o servidor para rodar o script bi-setup (docs/POWER_BI.md, passo 5)."}
                    </span>
                  </dd>
                </div>
                <div>
                  <dt className="font-medium text-slate-900">Sua chave de usuário (user_key)</dt>
                  <dd>
                    <code className="text-xs break-all">{data.userKey ?? "Indisponível"}</code>
                    <span className="block text-xs text-muted-foreground">
                      Use em &quot;Exibir como&quot;, no Power BI Desktop, para conferir o papel de segurança.
                    </span>
                  </dd>
                </div>
              </dl>
              <Callout tone="info" title="Regras que o relatório deve respeitar">
                Não some valor da causa com valor apurado; trate vazio como não apurado (nunca zero); mantenha exposição e
                provisão apuradas separadas das estimadas; filtre os totais da posição atual por em_carteira_ativa (a mesma
                carteira dos totais do Praetor). As medidas recomendadas estão no guia docs/POWER_BI.md.
              </Callout>
            </CardContent>
          </Card>
        </section>
      </div>
    </>
  );
}
