import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  LEGAL_AREA_LABELS,
  LEGAL_AREAS,
  OCCURRENCE_STATUS_LABELS,
  PROCESS_PHASE_LABELS,
  PROCESS_PHASES,
  PROCESS_STATUS_LABELS,
  PROCESS_STATUSES,
  RISK_LEVEL_LABELS,
  RISK_LEVELS,
} from "@/domain/enums";
import { formatNumber } from "@/lib/format";
import { OCCURRENCE_STATUS_TONES, PROCESS_STATUS_TONES, RISK_TONES } from "@/lib/tones";
import { OPEN_OCCURRENCE_STATUSES, type DashboardData } from "../service";
import { DistributionBars } from "./distribution-bars";
import { MetricList } from "./metric-list";

const RISK_DESC = [...RISK_LEVELS].reverse();

export function LitigationPanel({ processes }: { processes: DashboardData["processes"] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Contencioso</CardTitle>
        <CardDescription>
          {formatNumber(processes.total)} {processes.total === 1 ? "processo cadastrado" : "processos cadastrados"},{" "}
          {formatNumber(processes.active)} {processes.active === 1 ? "ativo" : "ativos"}.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <DistributionBars
          title="Processos ativos por risco"
          total={processes.active}
          emptyMessage="Nenhum processo ativo."
          items={RISK_DESC.map((r) => ({
            key: r,
            label: RISK_LEVEL_LABELS[r],
            count: processes.byRisk[r],
            href: `/processos?status=active&risco=${r}`,
            tone: RISK_TONES[r],
          }))}
        />
        <DistributionBars
          title="Processos por situação"
          total={processes.total}
          emptyMessage="Nenhum processo cadastrado."
          items={PROCESS_STATUSES.map((s) => ({
            key: s,
            label: PROCESS_STATUS_LABELS[s],
            count: processes.byStatus[s],
            href: `/processos?status=${s}`,
            tone: PROCESS_STATUS_TONES[s],
          }))}
        />
      </CardContent>
    </Card>
  );
}

export function AreaPhasePanel({ processes }: { processes: DashboardData["processes"] }) {
  const areas = LEGAL_AREAS.map((a) => ({
    key: a,
    label: LEGAL_AREA_LABELS[a],
    count: processes.byArea[a],
    href: `/processos?status=active&area=${a}`,
  })).sort((x, y) => y.count - x.count);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Processos ativos por área e fase</CardTitle>
        <CardDescription>Áreas e fases sem processos ativos não são exibidas.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <DistributionBars title="Por área" total={processes.active} hideZero emptyMessage="Nenhum processo ativo." items={areas} />
        <DistributionBars
          title="Por fase"
          total={processes.active}
          hideZero
          emptyMessage="Nenhum processo ativo."
          items={PROCESS_PHASES.map((p) => ({
            key: p,
            label: PROCESS_PHASE_LABELS[p],
            count: processes.byPhase[p],
            href: `/processos?status=active&phase=${p}`,
          }))}
        />
      </CardContent>
    </Card>
  );
}

export function PreventivePanel({ occurrences }: { occurrences: DashboardData["occurrences"] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Jurídico preventivo</CardTitle>
        <CardDescription>
          {formatNumber(occurrences.inProgress)}{" "}
          {occurrences.inProgress === 1 ? "ocorrência em andamento" : "ocorrências em andamento"} (não resolvidas nem
          convertidas em processo).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <DistributionBars
          title="Em andamento por situação"
          total={occurrences.inProgress}
          emptyMessage="Nenhuma ocorrência em andamento."
          items={OPEN_OCCURRENCE_STATUSES.map((s) => ({
            key: s,
            label: OCCURRENCE_STATUS_LABELS[s],
            count: occurrences.byStatus[s],
            href: `/preventivo?status=${s}`,
            tone: OCCURRENCE_STATUS_TONES[s],
          }))}
        />
        <DistributionBars
          title="Em andamento por risco"
          total={occurrences.inProgress}
          emptyMessage="Nenhuma ocorrência em andamento."
          items={RISK_DESC.map((r) => ({
            key: r,
            label: RISK_LEVEL_LABELS[r],
            count: occurrences.byRisk[r],
            href: `/preventivo?risco=${r}`,
            tone: RISK_TONES[r],
          }))}
        />
        <MetricList
          label="Ocorrências encerradas"
          items={[
            {
              key: "converted",
              label: "Convertidas em processo",
              value: occurrences.convertedToProcess,
              href: "/preventivo?status=converted_to_process",
            },
            {
              key: "resolved",
              label: "Resolvidas",
              value: occurrences.byStatus.resolved,
              href: "/preventivo?status=resolved",
              tone: "success",
            },
          ]}
        />
      </CardContent>
    </Card>
  );
}
