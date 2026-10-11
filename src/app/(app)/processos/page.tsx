import { Gavel, Lock, Plus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { FilterBar, FilterSelect } from "@/components/ui/filter-bar";
import { OriginBadge } from "@/components/ui/origin-badge";
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
  LEGAL_AREA_LABELS,
  LEGAL_AREAS,
  PROCESS_PHASE_LABELS,
  PROCESS_PHASES,
  PROCESS_STATUS_LABELS,
  PROCESS_STATUSES,
  RISK_LEVEL_LABELS,
  RISK_LEVELS,
} from "@/domain/enums";
import { formatDate, formatDateTime, formatMoneyCents, formatNumber, pluralize } from "@/lib/format";
import { optionsFromLabels } from "@/lib/options";
import { enumParam, hasAnyParam, idParam, pageParam, param } from "@/lib/search-params";
import { PROCESS_STATUS_TONES } from "@/lib/tones";
import { listUnitOptions, listUserOptions } from "@/modules/admin/service";
import { CnjFormatFlag } from "@/modules/processes/components/process-badges";
import { getProcessSummary, listProcesses } from "@/modules/processes/service";
import { can } from "@/server/auth/permissions";
import { requirePageContext } from "@/server/auth/session";

export const metadata: Metadata = { title: "Processos" };

const FILTER_KEYS = ["q", "status", "area", "phase", "risco", "unidade", "responsavel"] as const;

export default async function ProcessesPage(props: PageProps<"/processos">) {
  const ctx = await requirePageContext("process:read");
  const sp = await props.searchParams;

  const q = param(sp, "q");
  const status = enumParam(sp, "status", PROCESS_STATUSES);
  const area = enumParam(sp, "area", LEGAL_AREAS);
  const phase = enumParam(sp, "phase", PROCESS_PHASES);
  const riskLevel = enumParam(sp, "risco", RISK_LEVELS);
  const unitId = idParam(sp, "unidade");
  const responsibleId = idParam(sp, "responsavel");
  const filtered = hasAnyParam(sp, FILTER_KEYS);

  const [result, summary, unitOptions, userOptions] = await Promise.all([
    listProcesses(ctx, {
      q: q?.slice(0, 200),
      status,
      area,
      phase,
      riskLevel,
      unitId,
      responsibleId,
      page: pageParam(sp),
    }),
    getProcessSummary(ctx),
    listUnitOptions(ctx),
    listUserOptions(ctx),
  ]);
  const canWrite = can(ctx, "process:write");

  return (
    <>
      <PageHeader
        title="Processos"
        description="Gestão do contencioso: processos judiciais e administrativos acompanhados pelo jurídico."
        actions={
          canWrite ? (
            <ButtonLink href="/processos/novo">
              <Plus aria-hidden="true" />
              Novo processo
            </ButtonLink>
          ) : null
        }
      />

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="Processos visíveis" value={formatNumber(summary.total)} icon={<Gavel />} />
        <StatCard
          label="Ativos"
          value={formatNumber(summary.active)}
          tone="info"
          href="/processos?status=active"
        />
        <StatCard
          label="Risco alto ou crítico"
          value={formatNumber(summary.highRisk)}
          hint="Processos ativos ou suspensos. Classificação informada pela equipe."
          tone={summary.highRisk > 0 ? "alert" : "neutral"}
        />
      </div>

      <FilterBar
        basePath="/processos"
        defaultQuery={q}
        searchPlaceholder="Número, título, tribunal ou parte"
        showClear={filtered}
      >
        <FilterSelect name="status" label="Situação" options={optionsFromLabels(PROCESS_STATUS_LABELS)} defaultValue={status} />
        <FilterSelect name="area" label="Área" options={optionsFromLabels(LEGAL_AREA_LABELS)} defaultValue={area} />
        <FilterSelect name="phase" label="Fase" options={optionsFromLabels(PROCESS_PHASE_LABELS)} defaultValue={phase} />
        <FilterSelect name="risco" label="Risco" options={optionsFromLabels(RISK_LEVEL_LABELS)} defaultValue={riskLevel} />
        <FilterSelect
          name="unidade"
          label="Unidade"
          options={unitOptions.map((u) => ({ value: u.id, label: u.name }))}
          defaultValue={unitId}
          placeholder="Todas"
        />
        <FilterSelect
          name="responsavel"
          label="Responsável"
          options={userOptions.map((u) => ({ value: u.id, label: u.name }))}
          defaultValue={responsibleId}
        />
      </FilterBar>

      {result.total === 0 && !filtered ? (
        <EmptyState
          icon={<Gavel />}
          title="Nenhum processo cadastrado"
          description={
            canWrite
              ? "Cadastre o primeiro processo para acompanhar prazos, documentos, movimentações e análises."
              : "Ainda não há processos visíveis para o seu perfil."
          }
          action={
            canWrite ? (
              <ButtonLink href="/processos/novo">
                <Plus aria-hidden="true" />
                Novo processo
              </ButtonLink>
            ) : null
          }
        />
      ) : (
        <>
          <p className="mb-2 text-sm text-muted-foreground" aria-live="polite">
            {pluralize(result.total, "processo encontrado", "processos encontrados")}
          </p>
          <Card className="py-0">
            <Table aria-label="Processos">
              <TableHeader>
                <TableRow>
                  <TableHead>Número</TableHead>
                  <TableHead>Título</TableHead>
                  <TableHead>Tribunal / vara</TableHead>
                  <TableHead>Área</TableHead>
                  <TableHead>Fase</TableHead>
                  <TableHead>Situação</TableHead>
                  <TableHead>Risco</TableHead>
                  <TableHead className="text-right">Valor da causa</TableHead>
                  <TableHead>Responsável</TableHead>
                  <TableHead>Origem</TableHead>
                  <TableHead>Atualizado</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.items.length === 0 ? (
                  <TableEmpty
                    colSpan={11}
                    message="Nenhum processo encontrado."
                    description="Revise os filtros ou limpe a busca."
                  />
                ) : (
                  result.items.map((p) => (
                    <TableRow key={p.id} interactive>
                      <TableCell className="whitespace-nowrap">
                        <Link href={`/processos/${p.id}`} className={`${tableLinkClasses} font-mono text-xs`}>
                          {p.number}
                        </Link>
                        {!p.isCnjFormat ? (
                          <div className="mt-1">
                            <CnjFormatFlag isCnjFormat={false} />
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell className="min-w-56">
                        <span className="flex items-center gap-1.5 text-slate-900">
                          {p.isConfidential ? (
                            <Lock aria-label="Confidencial" className="size-3.5 shrink-0 text-primary-700" />
                          ) : null}
                          {p.title}
                        </span>
                        {p.openDeadlineCount > 0 ? (
                          <span className="mt-0.5 block text-xs text-muted-foreground">
                            {pluralize(p.openDeadlineCount, "prazo em aberto", "prazos em aberto")}
                            {p.nextDeadlineDate ? ` · próximo em ${formatDate(p.nextDeadlineDate)}` : ""}
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell className="min-w-40">
                        <span className="block">{p.court}</span>
                        {p.courtDivision ? (
                          <span className="block text-xs text-muted-foreground">{p.courtDivision}</span>
                        ) : null}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{LEGAL_AREA_LABELS[p.area]}</TableCell>
                      <TableCell className="whitespace-nowrap">{PROCESS_PHASE_LABELS[p.phase]}</TableCell>
                      <TableCell>
                        <StatusBadge label={PROCESS_STATUS_LABELS[p.status]} tone={PROCESS_STATUS_TONES[p.status]} />
                      </TableCell>
                      <TableCell>
                        <RiskBadge level={p.riskLevel} />
                      </TableCell>
                      <TableCell className="text-right whitespace-nowrap tabular-nums">
                        {formatMoneyCents(p.claimAmountCents)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{p.responsibleName ?? "—"}</TableCell>
                      <TableCell>
                        <OriginBadge origin={p.dataOrigin} />
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground tabular-nums">
                        {formatDateTime(p.updatedAt)}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </Card>
          <Pagination
            page={result.page}
            pageSize={result.pageSize}
            total={result.total}
            basePath="/processos"
            searchParams={sp}
          />
        </>
      )}
    </>
  );
}
