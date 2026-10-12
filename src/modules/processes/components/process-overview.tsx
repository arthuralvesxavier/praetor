import { FileSearch, Sparkles } from "lucide-react";
import Link from "next/link";
import { AiModeBadge } from "@/components/ui/ai-mode-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DescriptionList } from "@/components/ui/description-list";
import { OriginBadge } from "@/components/ui/origin-badge";
import { RiskBadge } from "@/components/ui/risk-badge";
import { StatusBadge } from "@/components/ui/status-badge";
import { CASE_BRIEF_DEMO_NOTICE } from "@/domain/case-brief";
import {
  CASE_BRIEF_STATUS_LABELS,
  CLOSURE_REASON_LABELS,
  LEGAL_AREA_LABELS,
  LIABILITY_NATURE_LABELS,
  LOSS_PROBABILITY_LABELS,
  PROCESS_INSTANCE_LABELS,
  PROCESS_PHASE_LABELS,
  PROCESS_STATUS_LABELS,
  type CaseBriefStatus,
  type PartyRole,
} from "@/domain/enums";
import { formatDate, formatDateTime, formatMoneyCents, truncate } from "@/lib/format";
import type { Tone } from "@/lib/tones";
import { PROCESS_STATUS_TONES } from "@/lib/tones";
import { listAnalyses } from "@/modules/analyses/service";
import { getLatestCaseBriefSummary, type CaseBriefSummary } from "@/modules/briefs/service";
import { ProcessValuesSummary } from "@/modules/contingency/components/process-tabs";
import type { AuthContext } from "@/server/auth/context";
import { can } from "@/server/auth/permissions";
import { logger } from "@/server/lib/logger";
import type { ProcessDetail } from "../service";
import { cityWithState } from "../states";
import { CnjCheckFlag } from "./process-badges";

const BRIEF_STATUS_TONES: Record<CaseBriefStatus, Tone> = {
  generating: "info",
  ready_for_review: "warning",
  in_review: "info",
  approved: "success",
  rejected: "neutral",
  failed: "danger",
};

const linkClasses =
  "self-start rounded-sm text-sm font-medium text-primary-700 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export async function ProcessOverview({
  ctx,
  process: p,
  tabHref,
}: {
  ctx: AuthContext;
  process: ProcessDetail;
  tabHref: (tab: "partes" | "valores" | "analise-preliminar" | "ia" | "instancias") => string;
}) {
  const closure = p.closureReason ? CLOSURE_REASON_LABELS[p.closureReason] : null;
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
      <div className="flex min-w-0 flex-col gap-6 lg:col-span-2">
        <Card>
          <CardHeader actions={<OriginBadge origin={p.dataOrigin} />}>
            <CardTitle>Capa do processo</CardTitle>
            <CardDescription>Dados cadastrados ou importados — sem consulta automática a tribunais.</CardDescription>
          </CardHeader>
          <CardContent>
            <DescriptionList
              columns={2}
              items={[
                {
                  label: "Número (CNJ)",
                  value: (
                    <span className="inline-flex flex-wrap items-center gap-2">
                      <span className="font-mono">{p.number}</span>
                      <CnjCheckFlag check={p.cnjCheck} />
                    </span>
                  ),
                },
                {
                  label: "Situação",
                  value: (
                    <span className="inline-flex flex-wrap items-center gap-2">
                      <StatusBadge label={PROCESS_STATUS_LABELS[p.status]} tone={PROCESS_STATUS_TONES[p.status]} />
                      {closure ? <span className="text-sm text-slate-700">{closure}</span> : null}
                    </span>
                  ),
                },
                { label: "Tribunal", value: p.court },
                { label: "Órgão julgador / vara / turma", value: p.courtDivision },
                { label: "Cidade/UF", value: cityWithState(p.city, p.state) },
                { label: "Comarca / jurisdição", value: p.jurisdiction },
                { label: "Classe", value: p.processClass },
                { label: "Área", value: LEGAL_AREA_LABELS[p.area] },
                {
                  label: "Instância atual",
                  value: p.instance ? (
                    <span>
                      {PROCESS_INSTANCE_LABELS[p.instance]}
                      {p.instances.length > 1 ? (
                        <Link href={tabHref("instancias")} className="ml-2 text-xs font-medium text-primary-700 underline-offset-2 hover:underline">
                          {p.instances.length} instâncias vinculadas
                        </Link>
                      ) : null}
                    </span>
                  ) : null,
                },
                {
                  label: "Fase",
                  value: (
                    <span>
                      {PROCESS_PHASE_LABELS[p.phase]}
                      {p.phaseDetail ? <span className="block text-xs text-muted-foreground">{p.phaseDetail}</span> : null}
                    </span>
                  ),
                },
                { label: "Empresa", value: p.companyName },
                { label: "Unidade", value: p.unitName },
                { label: "Responsável", value: p.responsibleName },
                { label: "Escritório externo", value: p.lawFirmName },
                { label: "Ajuizamento / distribuição", value: p.filedAt ? formatDate(p.filedAt) : null },
                { label: "Última movimentação", value: p.lastMovementAt ? formatDate(p.lastMovementAt) : null },
                Boolean(closure || p.closedAt) && {
                  label: "Saída da carteira ativa",
                  value: [closure, p.closedAt ? `em ${formatDate(p.closedAt)}` : null].filter(Boolean).join(" "),
                },
                p.needsVerification && { label: "Pendência de verificação", value: p.verificationNote ?? "Sem nota", full: true },
                { label: "Cadastrado por", value: p.createdByName },
                { label: "Cadastrado em", value: formatDateTime(p.createdAt) },
                { label: "Última atualização", value: formatDateTime(p.updatedAt) },
                { label: "Descrição", value: p.description, full: true },
              ]}
            />
          </CardContent>
        </Card>

        <PartiesSummary process={p} href={tabHref("partes")} />

        {p.dataOrigin === "imported" ? (
          <Card>
            <CardHeader actions={<OriginBadge origin="imported" />}>
              <CardTitle>Dados importados</CardTitle>
              <CardDescription>
                Registro carregado de uma fonte informada. Edições feitas depois da importação ficam registradas no
                histórico como alterações manuais.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <DescriptionList
                columns={3}
                items={[
                  { label: "Fonte", value: p.externalSource },
                  { label: "Identificador na fonte", value: p.externalId },
                  { label: "Importado em", value: p.importedAt ? formatDateTime(p.importedAt) : null },
                ]}
              />
              {p.importBatchId && can(ctx, "import:run") ? (
                <Link href={`/importacoes/${p.importBatchId}`} className={linkClasses}>
                  Ver lote de importação
                </Link>
              ) : null}
            </CardContent>
          </Card>
        ) : null}
      </div>

      <div className="flex min-w-0 flex-col gap-6">
        {can(ctx, "contingency:read") ? (
          <ProcessValuesSummary ctx={ctx} processId={p.id} />
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>Valores</CardTitle>
              <CardDescription>Grandezas diferentes, nunca somadas.</CardDescription>
            </CardHeader>
            <CardContent>
              <DescriptionList
                columns={1}
                items={[
                  { label: "Valor da causa", value: formatMoneyCents(p.claimAmountCents, "Não informado") },
                  { label: "Valor liquidado / apurado", value: formatMoneyCents(p.liquidatedAmountCents, "Não apurado") },
                ]}
              />
            </CardContent>
          </Card>
        )}

        {can(ctx, "brief:read") ? <LatestBriefCard ctx={ctx} processId={p.id} href={tabHref("analise-preliminar")} /> : null}

        <Card>
          <CardHeader>
            <CardTitle>Classificação de risco</CardTitle>
            <CardDescription>Avaliação informada pela equipe jurídica (cadastro humano). Não é previsão de resultado.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <DescriptionList
              columns={1}
              items={[
                { label: "Risco interno", value: <RiskBadge level={p.riskLevel} withPrefix /> },
                {
                  label: "Probabilidade de perda (oficial)",
                  value: p.lossProbability ? LOSS_PROBABILITY_LABELS[p.lossProbability] : "Não classificada",
                },
                { label: "Justificativa", value: p.riskRationale },
              ]}
            />
            {can(ctx, "contingency:read") ? (
              <Link href={tabHref("valores")} className={linkClasses}>
                Valores, risco e provisão
              </Link>
            ) : null}
          </CardContent>
        </Card>

        {can(ctx, "analysis:read") ? <LatestAnalysisCard ctx={ctx} processId={p.id} aiTabHref={tabHref("ia")} /> : null}
      </div>
    </div>
  );
}

const PARTY_GROUPS: { role: PartyRole; label: string }[] = [
  { role: "plaintiff", label: "Polo ativo (autor)" },
  { role: "defendant", label: "Polo passivo (réu)" },
  { role: "public_prosecutor", label: "Ministério Público" },
  { role: "third_party", label: "Terceiros" },
  { role: "other", label: "Outros" },
];

function PartiesSummary({ process: p, href }: { process: ProcessDetail; href: string }) {
  const groups = PARTY_GROUPS.map((g) => ({ ...g, parties: p.parties.filter((x) => x.role === g.role) })).filter(
    (g) => g.parties.length > 0 || g.role === "plaintiff" || g.role === "defendant",
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>Partes</CardTitle>
        <CardDescription>Resumo dos polos. Documentos (CPF/CNPJ) ficam na aba “Partes”, mascarados.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {groups.map((g) => (
            <div key={g.role} className="min-w-0">
              <dt className="text-xs font-medium text-muted-foreground">{g.label}</dt>
              <dd className="mt-1 text-sm text-slate-900">
                {g.parties.length === 0 ? (
                  <span className="text-muted-foreground">Não cadastrado</span>
                ) : (
                  <ul className="flex flex-col gap-1">
                    {g.parties.map((x) => (
                      <li key={x.id} className="flex flex-wrap items-center gap-1.5">
                        <span>{x.name}</span>
                        {x.isClient ? <Badge tone="primary">Cliente</Badge> : null}
                        {x.liabilityNature ? (
                          <Badge tone="neutral">Resp. {LIABILITY_NATURE_LABELS[x.liabilityNature].toLowerCase()}</Badge>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </dd>
            </div>
          ))}
        </dl>
        <Link href={href} className={linkClasses}>
          {p.permissions.canEdit ? "Gerenciar partes" : "Ver partes"} ({p.parties.length})
        </Link>
      </CardContent>
    </Card>
  );
}

async function LatestBriefCard({ ctx, processId, href }: { ctx: AuthContext; processId: string; href: string }) {
  let brief: CaseBriefSummary | null = null;
  let failed = false;
  try {
    brief = await getLatestCaseBriefSummary(ctx, processId);
  } catch (error) {
    failed = true;
    logger.warn("process_latest_brief_failed", { processId, errorName: error instanceof Error ? error.name : "unknown" });
  }

  return (
    <Card className="border-ai-200 bg-ai-50/50">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-ai-900">
          <FileSearch aria-hidden="true" className="size-4 text-ai-600" />
          Análise preliminar
        </CardTitle>
        <CardDescription>Leitura inicial do caso para apoiar o advogado responsável. Requer revisão humana.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {failed ? (
          <p className="text-muted-foreground">Não foi possível carregar a análise preliminar mais recente.</p>
        ) : brief ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge label={CASE_BRIEF_STATUS_LABELS[brief.status]} tone={BRIEF_STATUS_TONES[brief.status]} />
              <Badge tone="neutral">Versão {brief.version}</Badge>
              {brief.mode === "demo" ? <Badge tone="warning">Simulação</Badge> : null}
              {brief.isStale ? <Badge tone="warning">Desatualizada</Badge> : null}
            </div>
            {brief.headline ? (
              <p className="whitespace-pre-line text-slate-800">{truncate(brief.headline, 320)}</p>
            ) : (
              <p className="text-muted-foreground">Resumo ainda não disponível.</p>
            )}
            <p className="text-xs text-muted-foreground">
              {brief.approvedAt
                ? `Aprovada${brief.approvedByName ? ` por ${brief.approvedByName}` : ""} em ${formatDateTime(brief.approvedAt)}`
                : brief.generatedAt
                  ? `Gerada em ${formatDateTime(brief.generatedAt)}`
                  : "Em processamento"}
            </p>
            {brief.mode === "demo" ? (
              <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                {CASE_BRIEF_DEMO_NOTICE}
              </p>
            ) : null}
          </>
        ) : (
          <p className="text-muted-foreground">Nenhuma análise preliminar gerada para este processo.</p>
        )}
        <Link href={href} className={linkClasses}>
          {brief ? "Abrir análise preliminar" : "Ver aba de análise preliminar"}
        </Link>
      </CardContent>
    </Card>
  );
}

async function LatestAnalysisCard({ ctx, processId, aiTabHref }: { ctx: AuthContext; processId: string; aiTabHref: string }) {
  let latest: Awaited<ReturnType<typeof listAnalyses>>["items"][number] | null = null;
  let failed = false;
  try {
    const result = await listAnalyses(ctx, {
      subjectType: "legal_process",
      subjectId: processId,
      status: "succeeded",
      pageSize: 1,
    });
    latest = result.items[0] ?? null;
  } catch (error) {
    failed = true;
    logger.warn("process_latest_analysis_failed", { processId, errorName: error instanceof Error ? error.name : "unknown" });
  }

  return (
    <Card className="border-ai-200 bg-ai-50/50">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-ai-900">
          <Sparkles aria-hidden="true" className="size-4 text-ai-600" />
          Análise de IA — requer validação
        </CardTitle>
        <CardDescription>
          Apoio à equipe jurídica. Não substitui a avaliação de um advogado nem prevê o resultado do processo.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {failed ? (
          <p className="text-muted-foreground">Não foi possível carregar a análise mais recente.</p>
        ) : latest ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <AiModeBadge mode={latest.mode} />
              {latest.isStale ? <Badge tone="warning">Desatualizada</Badge> : null}
              <span className="text-xs text-muted-foreground">{formatDateTime(latest.completedAt ?? latest.createdAt)}</span>
            </div>
            {latest.summaryPreview ? (
              <p className="whitespace-pre-line text-slate-800">{truncate(latest.summaryPreview, 400)}</p>
            ) : (
              <p className="text-muted-foreground">Análise concluída sem resumo disponível.</p>
            )}
            {latest.isStale && latest.staleReason ? (
              <p className="text-xs text-amber-800">Motivo: {latest.staleReason}</p>
            ) : null}
          </>
        ) : (
          <p className="text-muted-foreground">Nenhuma análise concluída para este processo.</p>
        )}
        <Link href={aiTabHref} className={linkClasses}>
          Ver análises de IA
        </Link>
      </CardContent>
    </Card>
  );
}
