import {
  AlertOctagon,
  AlertTriangle,
  ArrowRight,
  BellOff,
  BellRing,
  CheckCircle2,
} from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { FilterBar, FilterSelect } from "@/components/ui/filter-bar";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { StatCard } from "@/components/ui/stat-card";
import { LinkTabs } from "@/components/ui/tabs";
import {
  ALERT_SEVERITIES,
  ALERT_SEVERITY_LABELS,
  ALERT_TYPE_LABELS,
  ALERT_TYPES,
  type AlertType,
} from "@/domain/enums";
import { formatNumber, pluralize } from "@/lib/format";
import { buildHref, enumParam, hasAnyParam, pageParam, param, type SearchParams } from "@/lib/search-params";
import {
  ALERT_AREA_DESCRIPTIONS,
  ALERT_AREA_LABELS,
  ALERT_AREA_PARAMS,
  ALERT_AREAS,
  ALERT_SITUATION_PARAMS,
  ALERT_TYPES_BY_AREA,
  ALERT_TYPES_IN_AREA_ORDER,
  alertAreaFromParam,
  alertAreaOf,
  type AlertArea,
} from "@/modules/alerts/areas";
import { AlertRows } from "@/modules/alerts/components/alert-list";
import {
  countAlertsByArea,
  listAlertGroups,
  listAlertsPaged,
  type AlertAreaCount,
  type AlertCenterFilters,
} from "@/modules/alerts/service";
import type { AuthContext } from "@/server/auth/context";
import { can } from "@/server/auth/permissions";
import { requirePageContext } from "@/server/auth/session";

export const metadata: Metadata = { title: "Alertas e pendências" };

const PER_GROUP = 5;

export default async function AlertasPage(props: PageProps<"/alertas">) {
  const ctx = await requirePageContext("dashboard:read");
  const sp: SearchParams = await props.searchParams;

  const type = enumParam(sp, "tipo", ALERT_TYPES);
  const severity = enumParam(sp, "severidade", ALERT_SEVERITIES);
  const situationParam = enumParam(sp, "situacao", ALERT_SITUATION_PARAMS);
  const situation = situationParam === "resolvidos" ? "resolved" : "open";
  const requestedArea = alertAreaFromParam(param(sp, "area"));
  // A type filter implies its area.
  const area: AlertArea | undefined = type ? alertAreaOf(type) : requestedArea;

  const filters: AlertCenterFilters = { type, severity, situation };
  const [openTotals, resolvedTotals, filteredCounts] = await Promise.all([
    countAlertsByArea(ctx, {}),
    countAlertsByArea(ctx, { situation: "resolved" }),
    countAlertsByArea(ctx, filters),
  ]);
  const filteredTotal = sumCounts(Object.values(filteredCounts)).total;
  const totals = sumCounts(Object.values(openTotals));
  const filtered = hasAnyParam(sp, ["tipo", "severidade", "situacao", "area"]);
  const canResolve = can(ctx, "alert:resolve");

  const areaHref = (a: AlertArea | null) =>
    buildHref("/alertas", sp, { area: a ? ALERT_AREA_PARAMS[a] : null, tipo: null, pagina: null });

  const typeOptions = (area ? [...ALERT_TYPES_BY_AREA[area]] : ALERT_TYPES_IN_AREA_ORDER).map((t: AlertType) => ({
    value: t,
    label: area ? ALERT_TYPE_LABELS[t] : `${ALERT_AREA_LABELS[alertAreaOf(t)]} — ${ALERT_TYPE_LABELS[t]}`,
  }));

  return (
    <>
      <PageHeader
        title="Alertas e pendências"
        description="Painel de pendências da carteira, agrupado por área. Os alertas são gerados pelas rotinas e pelos módulos; resolva-os quando a pendência for tratada."
        breadcrumbs={[{ label: "Dashboard", href: "/dashboard" }, { label: "Alertas e pendências" }]}
      />

      <div className="flex flex-col gap-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="Em aberto"
            value={formatNumber(totals.total)}
            tone={totals.total > 0 ? "primary" : "neutral"}
            icon={<BellRing />}
            href="/alertas"
          />
          <StatCard
            label="Críticos"
            value={formatNumber(totals.critical)}
            hint="Exigem ação imediata"
            tone={totals.critical > 0 ? "danger" : "neutral"}
            icon={<AlertOctagon />}
            href="/alertas?severidade=critical"
          />
          <StatCard
            label="Atenção"
            value={formatNumber(totals.warning)}
            tone={totals.warning > 0 ? "warning" : "neutral"}
            icon={<AlertTriangle />}
            href="/alertas?severidade=warning"
          />
          <StatCard
            label="Resolvidos"
            value={formatNumber(sumCounts(Object.values(resolvedTotals)).total)}
            hint={`${formatNumber(ALERT_AREAS.filter((a) => openTotals[a].total > 0).length)} de ${ALERT_AREAS.length} áreas com pendências`}
            tone="success"
            icon={<CheckCircle2 />}
            href="/alertas?situacao=resolvidos"
          />
        </div>

        <div className="flex flex-col gap-4">
          <LinkTabs
            label="Áreas de pendências"
            active={area ?? "all"}
            tabs={[
              { key: "all", label: "Todas", href: areaHref(null), count: filteredTotal || null },
              ...ALERT_AREAS.map((a) => ({
                key: a,
                label: ALERT_AREA_LABELS[a],
                href: areaHref(a),
                count: filteredCounts[a].total || null,
              })),
            ]}
          />

          <FilterBar
            basePath="/alertas"
            search={false}
            hiddenFields={{ area: area ? ALERT_AREA_PARAMS[area] : undefined }}
            showClear={filtered}
          >
            <FilterSelect name="tipo" label="Tipo" defaultValue={type} options={typeOptions} className="sm:w-72" />
            <FilterSelect
              name="severidade"
              label="Severidade"
              defaultValue={severity}
              options={ALERT_SEVERITIES.map((s) => ({ value: s, label: ALERT_SEVERITY_LABELS[s] }))}
              placeholder="Todas"
            />
            <FilterSelect
              name="situacao"
              label="Situação"
              defaultValue={situationParam === "resolvidos" ? "resolvidos" : undefined}
              options={[{ value: "resolvidos", label: "Resolvidos" }]}
              placeholder="Em aberto"
            />
          </FilterBar>

          {situation === "resolved" ? (
            <p className="-mt-2 text-xs text-muted-foreground">
              Exibindo alertas resolvidos, do mais recente para o mais antigo. Alertas resolvidos automaticamente tiveram a
              condição encerrada (por exemplo, prazo cumprido ou audiência realizada).
            </p>
          ) : null}

          {area ? (
            <AreaList ctx={ctx} sp={sp} area={area} filters={filters} canResolve={canResolve} count={filteredCounts[area]} />
          ) : (
            <Groups ctx={ctx} sp={sp} filters={filters} counts={filteredCounts} canResolve={canResolve} filtered={filtered} />
          )}
        </div>

        <Callout tone="info" title="Como os alertas funcionam">
          Os alertas são criados pelas rotinas agendadas (prazos, audiências, contratos, valores e acordos) e pelos módulos
          de entrada de processos e análise preliminar. Resolver um alerta registra quem resolveu, mas não altera o registro
          de origem: se a condição persistir, a rotina cria um novo alerta. Não há integração com tribunais nesta versão.
        </Callout>
      </div>
    </>
  );
}

function sumCounts(list: AlertAreaCount[]): AlertAreaCount {
  return list.reduce((acc, c) => ({ total: acc.total + c.total, critical: acc.critical + c.critical, warning: acc.warning + c.warning }), {
    total: 0,
    critical: 0,
    warning: 0,
  });
}

function CountBadges({ count, situation }: { count: AlertAreaCount; situation: "open" | "resolved" }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Badge tone="neutral">{pluralize(count.total, situation === "open" ? "em aberto" : "resolvido", situation === "open" ? "em aberto" : "resolvidos")}</Badge>
      {count.critical > 0 ? <Badge tone="danger">{pluralize(count.critical, "crítico", "críticos")}</Badge> : null}
      {count.warning > 0 ? <Badge tone="warning">{pluralize(count.warning, "de atenção", "de atenção")}</Badge> : null}
    </div>
  );
}

async function Groups({
  ctx,
  sp,
  filters,
  counts,
  canResolve,
  filtered,
}: {
  ctx: AuthContext;
  sp: SearchParams;
  filters: AlertCenterFilters;
  counts: Record<AlertArea, AlertAreaCount>;
  canResolve: boolean;
  filtered: boolean;
}) {
  const groups = await listAlertGroups(ctx, filters, PER_GROUP, counts);
  const situation = filters.situation ?? "open";
  if (groups.length === 0) {
    return (
      <EmptyState
        icon={<BellOff />}
        title={
          filtered
            ? "Nenhum alerta encontrado com esses filtros"
            : situation === "open"
              ? "Nenhuma pendência em aberto"
              : "Nenhum alerta resolvido"
        }
        description={
          filtered
            ? "Ajuste ou limpe os filtros para ver outros alertas."
            : "Quando houver prazos, audiências, valores ou análises que exijam atenção, eles aparecerão aqui."
        }
      />
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {groups.map((g) => {
        const href = buildHref("/alertas", sp, { area: ALERT_AREA_PARAMS[g.area], tipo: null, pagina: null });
        return (
          <Card key={g.area} aria-labelledby={`area-${g.area}`}>
            <CardHeader actions={<CountBadges count={g.count} situation={situation} />}>
              <CardTitle id={`area-${g.area}`}>
                <Link href={href} className="hover:underline focus-visible:underline">
                  {ALERT_AREA_LABELS[g.area]}
                </Link>
              </CardTitle>
              <CardDescription>{ALERT_AREA_DESCRIPTIONS[g.area]}</CardDescription>
            </CardHeader>
            <CardContent>
              <AlertRows items={g.items} canResolve={canResolve} label={ALERT_AREA_LABELS[g.area]} showOpenLink />
            </CardContent>
            {g.count.total > g.items.length ? (
              <CardFooter>
                <Link
                  href={href}
                  className="inline-flex items-center gap-1 text-sm font-medium text-primary-700 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  Ver todos os {formatNumber(g.count.total)} alertas de {ALERT_AREA_LABELS[g.area]}
                  <ArrowRight aria-hidden="true" className="size-3.5" />
                </Link>
              </CardFooter>
            ) : null}
          </Card>
        );
      })}
    </div>
  );
}

async function AreaList({
  ctx,
  sp,
  area,
  filters,
  canResolve,
  count,
}: {
  ctx: AuthContext;
  sp: SearchParams;
  area: AlertArea;
  filters: AlertCenterFilters;
  canResolve: boolean;
  count: AlertAreaCount;
}) {
  const situation = filters.situation ?? "open";
  const result = await listAlertsPaged(ctx, { ...filters, area, page: pageParam(sp) });
  return (
    <div className="flex flex-col">
      <Card aria-labelledby="area-atual">
        <CardHeader actions={<CountBadges count={count} situation={situation} />}>
          <CardTitle id="area-atual">
            {ALERT_AREA_LABELS[area]}
            {filters.type ? <span className="font-normal text-muted-foreground"> · {ALERT_TYPE_LABELS[filters.type]}</span> : null}
          </CardTitle>
          <CardDescription>{ALERT_AREA_DESCRIPTIONS[area]}</CardDescription>
        </CardHeader>
        <CardContent>
          {result.items.length === 0 ? (
            <EmptyState
              icon={<BellOff />}
              title={situation === "open" ? "Nenhuma pendência em aberto nesta área" : "Nenhum alerta resolvido nesta área"}
              description="Ajuste os filtros ou volte para todas as áreas."
              action={
                <Link href="/alertas" className="text-sm font-medium text-primary-700 underline-offset-2 hover:underline">
                  Ver todas as áreas
                </Link>
              }
            />
          ) : (
            <AlertRows items={result.items} canResolve={canResolve} label={ALERT_AREA_LABELS[area]} showOpenLink />
          )}
        </CardContent>
      </Card>
      <Pagination
        page={result.page}
        pageSize={result.pageSize}
        total={result.total}
        basePath="/alertas"
        searchParams={sp}
        className="mt-4"
      />
    </div>
  );
}
