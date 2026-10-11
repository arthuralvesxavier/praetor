import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AiModeBadge } from "@/components/ui/ai-mode-badge";
import { Callout } from "@/components/ui/callout";
import type { AiMode } from "@/domain/enums";
import type { DashboardData } from "../service";
import { MetricList } from "./metric-list";

export function ContractsCard({ contracts, expirationDays }: { contracts: DashboardData["contracts"]; expirationDays: number }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Contratos</CardTitle>
        <CardDescription>Vigência conforme as datas de término cadastradas.</CardDescription>
      </CardHeader>
      <CardContent>
        <MetricList
          label="Indicadores de contratos"
          items={[
            { key: "active", label: "Vigentes", value: contracts.active, href: "/contratos?status=active" },
            {
              key: "expiring",
              label: "Vencendo",
              hint: `Término nos próximos ${expirationDays} dias`,
              value: contracts.expiring,
              href: "/contratos?vencendo=1",
              tone: "warning",
            },
            {
              key: "expired",
              label: "Vencidos ainda vigentes",
              hint: "Término já passou; revise a situação",
              value: contracts.expiredStillActive,
              href: "/contratos?status=active",
              tone: "danger",
            },
            {
              key: "review",
              label: "Em revisão",
              value: contracts.byStatus.under_review,
              href: "/contratos?status=under_review",
              tone: "info",
            },
          ]}
        />
      </CardContent>
    </Card>
  );
}

export function AiCard({ analyses, mode }: { analyses: DashboardData["analyses"]; mode: AiMode | null }) {
  return (
    <Card>
      <CardHeader actions={mode ? <AiModeBadge mode={mode} /> : null}>
        <CardTitle>Análises de IA</CardTitle>
        <CardDescription>Apoio à equipe jurídica; toda saída exige revisão humana.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <MetricList
          label="Indicadores de análises de IA"
          items={[
            {
              key: "review",
              label: "A revisar",
              hint: "Concluídas aguardando revisão humana",
              value: analyses.pendingReview,
              href: "/ia?status=succeeded",
              tone: "ai",
            },
            {
              key: "stale",
              label: "Desatualizadas",
              hint: "As fontes mudaram após a análise",
              value: analyses.stale,
              href: "/ia?desatualizadas=1",
              tone: "warning",
            },
            {
              key: "failed",
              label: "Falhas nos últimos 7 dias",
              value: analyses.failedLast7Days,
              href: "/ia?status=failed",
              tone: "danger",
            },
          ]}
        />
        {mode === "demo" ? (
          <Callout tone="warning" title="Modo demonstrativo">
            As análises deste ambiente são geradas sem IA real, apenas para demonstração.
          </Callout>
        ) : null}
        <p className="text-xs text-muted-foreground">
          A IA não prevê resultados de processos nem substitui a avaliação de um advogado.
        </p>
      </CardContent>
    </Card>
  );
}
