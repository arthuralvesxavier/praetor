import { ArrowRight, CircleDot, ClipboardList, Lightbulb, Lock, Plus, Scale, TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { FilterBar, FilterSelect } from "@/components/ui/filter-bar";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { RiskBadge } from "@/components/ui/risk-badge";
import { StatCard } from "@/components/ui/stat-card";
import { StatusBadge } from "@/components/ui/status-badge";
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
import {
  OCCURRENCE_CATEGORIES,
  OCCURRENCE_CATEGORY_LABELS,
  OCCURRENCE_STATUSES,
  OCCURRENCE_STATUS_LABELS,
  RISK_LEVEL_LABELS,
  RISK_LEVELS,
  type RiskLevel,
} from "@/domain/enums";
import { formatDate, formatMoneyCents, formatNumber, pluralize, truncate } from "@/lib/format";
import { optionsFromLabels } from "@/lib/options";
import { enumParam, hasAnyParam, idParam, pageParam, param, paramList } from "@/lib/search-params";
import { OCCURRENCE_STATUS_TONES } from "@/lib/tones";
import { can } from "@/server/auth/permissions";
import { requirePageContext } from "@/server/auth/session";
import { listUnitOptions, listUserOptions } from "@/modules/admin/service";
import { PREVENTIVE_ORIGIN_LABEL } from "@/modules/occurrences/preventive-origin";
import { getOccurrenceStats, listOccurrences, type OccurrenceListItem } from "@/modules/occurrences/service";

export const metadata: Metadata = { title: "Jurídico preventivo" };

const BASE_PATH = "/preventivo";
const FILTER_KEYS = ["q", "status", "categoria", "risco", "unidade", "responsavel", "origem"] as const;
/** `origem=inteligencia-preventiva`: occurrences created from a preventive-intelligence indicator. */
const ORIGIN_PARAM_VALUE = "inteligencia-preventiva";

function LinkedProcessCell({ linked }: { linked: OccurrenceListItem["linkedProcess"] }) {
  if (!linked) return <span className="text-muted-foreground">—</span>;
  if (!linked.visible) return <span className="text-muted-foreground">Vinculada (sem acesso ao processo)</span>;
  return (
    <Link
      href={`/processos/${linked.id}`}
      className="inline-flex items-center gap-1 font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
    >
      <Scale aria-hidden="true" className="size-3.5" />
      {linked.number}
    </Link>
  );
}

export default async function PreventivoPage(props: PageProps<"/preventivo">) {
  const ctx = await requirePageContext("occurrence:read");
  const sp = await props.searchParams;

  const risk = [...new Set(paramList(sp, "risco"))].filter((r): r is RiskLevel =>
    (RISK_LEVELS as readonly string[]).includes(r),
  );
  const filters = {
    q: param(sp, "q")?.slice(0, 200),
    status: enumParam(sp, "status", OCCURRENCE_STATUSES),
    category: enumParam(sp, "categoria", OCCURRENCE_CATEGORIES),
    riskLevel: risk.length > 0 ? risk : undefined,
    unitId: idParam(sp, "unidade"),
    responsibleId: idParam(sp, "responsavel"),
    origin: param(sp, "origem") === ORIGIN_PARAM_VALUE ? ("preventive_intel" as const) : undefined,
    page: pageParam(sp),
  };

  const [result, stats, unitOptions, userOptions] = await Promise.all([
    listOccurrences(ctx, filters),
    getOccurrenceStats(ctx),
    listUnitOptions(ctx),
    listUserOptions(ctx),
  ]);
  const filtered = hasAnyParam(sp, FILTER_KEYS);
  const canWrite = can(ctx, "occurrence:write");
  const canSeeIntel = can(ctx, "preventive_intel:read");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Jurídico preventivo"
        description="Ocorrências que ainda não se tornaram processos judiciais. Registre fatos, identifique sinais de risco e acompanhe o plano de ação."
        breadcrumbs={[{ label: "Dashboard", href: "/dashboard" }, { label: "Jurídico preventivo" }]}
        actions={
          canWrite ? (
            <ButtonLink href="/preventivo/nova">
              <Plus aria-hidden="true" />
              Nova ocorrência
            </ButtonLink>
          ) : null
        }
      />

      <section aria-label="Indicadores do jurídico preventivo" className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Abertas"
          value={formatNumber(stats.open)}
          tone="info"
          icon={<CircleDot />}
          href="/preventivo?status=open"
        />
        <StatCard
          label="Em plano de ação"
          value={formatNumber(stats.actionPlan)}
          tone="primary"
          icon={<ClipboardList />}
          href="/preventivo?status=action_plan"
        />
        <StatCard
          label="Risco alto ou crítico"
          value={formatNumber(stats.highRisk)}
          tone="danger"
          icon={<TriangleAlert />}
          hint="Classificação feita pela equipe"
          href="/preventivo?risco=high&risco=critical"
        />
        <StatCard
          label="Convertidas em processo"
          value={formatNumber(stats.converted)}
          tone="neutral"
          icon={<Scale />}
          href="/preventivo?status=converted_to_process"
        />
      </section>

      {canSeeIntel ? (
        <section
          aria-label="Inteligência preventiva"
          className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 shadow-xs sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="flex min-w-0 gap-3">
            <span
              aria-hidden="true"
              className="inline-flex size-9 shrink-0 items-center justify-center rounded-md bg-primary-50 text-primary [&_svg]:size-4"
            >
              <Lightbulb />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-slate-900">Inteligência preventiva</p>
              <p className="text-sm text-muted-foreground">
                Indicadores calculados a partir da carteira de processos (recorrência, concentração, fases) e sugestões
                ilustrativas que podem virar ocorrências e planos de ação.
                {stats.fromPreventiveIntel > 0
                  ? ` ${pluralize(stats.fromPreventiveIntel, "ocorrência originada", "ocorrências originadas")} de indicadores.`
                  : ""}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            {stats.fromPreventiveIntel > 0 ? (
              <ButtonLink href={`/preventivo?origem=${ORIGIN_PARAM_VALUE}`} variant="ghost">
                Ver originadas
              </ButtonLink>
            ) : null}
            <ButtonLink href="/inteligencia-preventiva" variant="outline">
              Abrir indicadores
              <ArrowRight aria-hidden="true" />
            </ButtonLink>
          </div>
        </section>
      ) : null}

      <FilterBar
        basePath={BASE_PATH}
        defaultQuery={param(sp, "q")}
        searchPlaceholder="Título, fatos, partes ou áreas"
        showClear={filtered}
      >
        <FilterSelect
          name="status"
          label="Situação"
          options={optionsFromLabels(OCCURRENCE_STATUS_LABELS)}
          defaultValue={filters.status}
        />
        <FilterSelect
          name="categoria"
          label="Categoria"
          options={optionsFromLabels(OCCURRENCE_CATEGORY_LABELS)}
          defaultValue={filters.category}
        />
        <FilterSelect
          name="risco"
          label="Risco"
          options={optionsFromLabels(RISK_LEVEL_LABELS)}
          defaultValue={risk.length === 1 ? risk[0] : undefined}
        />
        <FilterSelect
          name="unidade"
          label="Unidade"
          options={unitOptions.map((u) => ({ value: u.id, label: u.name }))}
          defaultValue={filters.unitId}
          placeholder="Todas"
        />
        <FilterSelect
          name="responsavel"
          label="Responsável"
          options={userOptions.map((u) => ({ value: u.id, label: u.name }))}
          defaultValue={filters.responsibleId}
        />
        <FilterSelect
          name="origem"
          label="Origem"
          options={[{ value: ORIGIN_PARAM_VALUE, label: "Inteligência preventiva" }]}
          defaultValue={filters.origin ? ORIGIN_PARAM_VALUE : undefined}
          placeholder="Todas"
        />
      </FilterBar>

      {risk.length > 1 ? (
        <p className="text-sm text-muted-foreground">
          Exibindo ocorrências com risco {risk.map((r) => RISK_LEVEL_LABELS[r].toLowerCase()).join(" ou ")}.
        </p>
      ) : null}

      {result.total === 0 && !filtered ? (
        <EmptyState
          icon={<ClipboardList />}
          title="Nenhuma ocorrência registrada"
          description="Registre fatos que podem gerar risco jurídico antes que se tornem processos: reclamações, incidentes, notificações e situações internas."
          action={
            canWrite ? (
              <ButtonLink href="/preventivo/nova">
                <Plus aria-hidden="true" />
                Registrar ocorrência
              </ButtonLink>
            ) : null
          }
        />
      ) : (
        <Card className="py-0">
          <Table aria-label="Ocorrências do jurídico preventivo">
            <TableHeader>
              <TableRow>
                <TableHead>Título</TableHead>
                <TableHead>Categoria</TableHead>
                <TableHead>Situação</TableHead>
                <TableHead>Risco</TableHead>
                <TableHead>Áreas</TableHead>
                <TableHead>Responsável</TableHead>
                <TableHead className="text-right">Exposição estimada</TableHead>
                <TableHead>Reportada em</TableHead>
                <TableHead>Processo</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.items.length === 0 ? (
                <TableEmpty
                  colSpan={9}
                  message="Nenhuma ocorrência encontrada com esses filtros."
                  description="Ajuste a busca ou limpe os filtros."
                />
              ) : (
                result.items.map((o) => (
                  <TableRow key={o.id} interactive>
                    <TableCell className="min-w-56 max-w-80">
                      <Link href={`/preventivo/${o.id}`} className={tableLinkClasses}>
                        {o.isConfidential ? (
                          <Lock aria-label="Confidencial" className="mr-1 inline size-3.5 align-[-2px] text-amber-700" />
                        ) : null}
                        {o.title}
                      </Link>
                      {o.unitName ? <span className="block text-xs text-muted-foreground">{o.unitName}</span> : null}
                      {o.preventiveOrigin ? (
                        <span className="mt-1 block">
                          <Badge tone="primary" icon={<Lightbulb />}>
                            {PREVENTIVE_ORIGIN_LABEL}
                          </Badge>
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{OCCURRENCE_CATEGORY_LABELS[o.category]}</TableCell>
                    <TableCell>
                      <StatusBadge label={OCCURRENCE_STATUS_LABELS[o.status]} tone={OCCURRENCE_STATUS_TONES[o.status]} />
                    </TableCell>
                    <TableCell>
                      <RiskBadge level={o.riskLevel} />
                    </TableCell>
                    <TableCell className="min-w-32 text-sm">
                      {o.areasInvolved.length > 0 ? (
                        truncate(o.areasInvolved.join(", "), 60)
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {o.responsibleName ?? <span className="text-muted-foreground">Sem responsável</span>}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right tabular-nums">
                      {formatMoneyCents(o.estimatedExposureCents)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums">{formatDate(o.reportedOn)}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      <LinkedProcessCell linked={o.linkedProcess} />
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </Card>
      )}

      <Pagination page={result.page} pageSize={result.pageSize} total={result.total} basePath={BASE_PATH} searchParams={sp} />
    </div>
  );
}
