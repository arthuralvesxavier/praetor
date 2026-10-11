import { Sparkles } from "lucide-react";
import Link from "next/link";
import { AiModeBadge } from "@/components/ui/ai-mode-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DescriptionList } from "@/components/ui/description-list";
import { OriginBadge } from "@/components/ui/origin-badge";
import { RiskBadge } from "@/components/ui/risk-badge";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  LEGAL_AREA_LABELS,
  LOSS_PROBABILITY_LABELS,
  PROCESS_PHASE_LABELS,
  PROCESS_STATUS_LABELS,
} from "@/domain/enums";
import { listAnalyses } from "@/modules/analyses/service";
import { formatDate, formatDateTime, formatMoneyCents, truncate } from "@/lib/format";
import { PROCESS_STATUS_TONES } from "@/lib/tones";
import type { AuthContext } from "@/server/auth/context";
import { can } from "@/server/auth/permissions";
import { logger } from "@/server/lib/logger";
import type { ProcessDetail } from "../service";
import { CnjFormatFlag } from "./process-badges";

export async function ProcessOverview({
  ctx,
  process: p,
  aiTabHref,
}: {
  ctx: AuthContext;
  process: ProcessDetail;
  aiTabHref: string;
}) {
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
      <div className="flex flex-col gap-6 lg:col-span-2">
        <Card>
          <CardHeader actions={<OriginBadge origin={p.dataOrigin} />}>
            <CardTitle>Dados cadastrados</CardTitle>
            <CardDescription>Informações registradas pela equipe jurídica neste sistema.</CardDescription>
          </CardHeader>
          <CardContent>
            <DescriptionList
              columns={2}
              items={[
                {
                  label: "Número",
                  value: (
                    <span className="inline-flex flex-wrap items-center gap-2">
                      <span className="font-mono">{p.number}</span>
                      <CnjFormatFlag isCnjFormat={p.isCnjFormat} />
                    </span>
                  ),
                },
                { label: "Situação", value: <StatusBadge label={PROCESS_STATUS_LABELS[p.status]} tone={PROCESS_STATUS_TONES[p.status]} /> },
                { label: "Tribunal", value: p.court },
                { label: "Vara / órgão julgador", value: p.courtDivision },
                { label: "Comarca / jurisdição", value: p.jurisdiction },
                { label: "Área", value: LEGAL_AREA_LABELS[p.area] },
                { label: "Fase", value: PROCESS_PHASE_LABELS[p.phase] },
                { label: "Data de distribuição", value: p.filedAt ? formatDate(p.filedAt) : null },
                { label: "Data de encerramento", value: p.closedAt ? formatDate(p.closedAt) : null },
                { label: "Unidade", value: p.unitName },
                { label: "Responsável", value: p.responsibleName },
                { label: "Cadastrado por", value: p.createdByName },
                { label: "Cadastrado em", value: formatDateTime(p.createdAt) },
                { label: "Última atualização", value: formatDateTime(p.updatedAt) },
                { label: "Descrição", value: p.description, full: true },
              ]}
            />
          </CardContent>
        </Card>

        {p.dataOrigin === "imported" ? (
          <Card>
            <CardHeader actions={<OriginBadge origin="imported" />}>
              <CardTitle>Dados importados</CardTitle>
              <CardDescription>
                Registro carregado de uma fonte informada. Edições feitas depois da importação ficam registradas no
                histórico como alterações manuais.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <DescriptionList
                columns={3}
                items={[
                  { label: "Fonte", value: p.externalSource },
                  { label: "Identificador na fonte", value: p.externalId },
                  { label: "Importado em", value: p.importedAt ? formatDateTime(p.importedAt) : null },
                ]}
              />
            </CardContent>
          </Card>
        ) : null}
      </div>

      <div className="flex flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Valores</CardTitle>
          </CardHeader>
          <CardContent>
            <DescriptionList
              columns={1}
              items={[
                { label: "Valor da causa", value: formatMoneyCents(p.claimAmountCents, "") },
                { label: "Provisão", value: formatMoneyCents(p.provisionAmountCents, "") },
              ]}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Classificação de risco</CardTitle>
            <CardDescription>
              Avaliação informada pela equipe jurídica (cadastro humano). Não é uma previsão de resultado.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <DescriptionList
              columns={1}
              items={[
                { label: "Risco", value: <RiskBadge level={p.riskLevel} withPrefix /> },
                {
                  label: "Probabilidade de perda",
                  value: p.lossProbability ? LOSS_PROBABILITY_LABELS[p.lossProbability] : "Não avaliada",
                },
                { label: "Justificativa", value: p.riskRationale },
              ]}
            />
          </CardContent>
        </Card>

        {can(ctx, "analysis:read") ? <LatestAnalysisCard ctx={ctx} processId={p.id} aiTabHref={aiTabHref} /> : null}
      </div>
    </div>
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
    logger.warn("process_latest_analysis_failed", { processId, error });
  }

  return (
    <Card className="border-ai-200 bg-ai-50/50">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-ai-900">
          <Sparkles aria-hidden="true" className="size-4 text-ai-600" />
          Análise gerada por IA — requer validação
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
              <span className="text-xs text-muted-foreground">
                {formatDateTime(latest.completedAt ?? latest.createdAt)}
              </span>
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
        <Link
          href={aiTabHref}
          className="self-start rounded-sm text-sm font-medium text-ai-700 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          Ver análises de IA
        </Link>
      </CardContent>
    </Card>
  );
}
