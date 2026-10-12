import { CalendarClock, CalendarDays, CalendarRange, ClipboardX, UserRound } from "lucide-react";
import type { Metadata } from "next";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { FilterBar, FilterSelect } from "@/components/ui/filter-bar";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { StatCard } from "@/components/ui/stat-card";
import { HEARING_STATUS_LABELS, HEARING_STATUSES } from "@/domain/enums";
import { addDaysISO, formatDate, formatNumber, pluralize, toISODate, todayISO } from "@/lib/format";
import { optionsFromLabels } from "@/lib/options";
import { enumParam, hasAnyParam, idParam, pageParam, type SearchParams } from "@/lib/search-params";
import { HearingFormDialog } from "@/modules/hearings/components/hearing-form-dialog";
import { HearingRow } from "@/modules/hearings/components/hearing-row";
import {
  HEARING_PERIOD_LABELS,
  HEARING_PERIOD_PARAMS,
  type HearingPeriod,
  type HearingPeriodParam,
} from "@/modules/hearings/schemas";
import {
  getHearingCounts,
  listHearingUserOptions,
  listHearings,
  type HearingListItem,
} from "@/modules/hearings/service";
import { weekdayName } from "@/modules/hearings/time";
import { can } from "@/server/auth/permissions";
import { requirePageContext } from "@/server/auth/session";

export const metadata: Metadata = { title: "Audiências" };

const PERIOD_BY_PARAM: Record<HearingPeriodParam, HearingPeriod> = { "7d": "7d", "30d": "30d", "90d": "90d", passadas: "past" };

function groupByDay(items: HearingListItem[]): { date: string; items: HearingListItem[] }[] {
  const groups: { date: string; items: HearingListItem[] }[] = [];
  for (const item of items) {
    const date = toISODate(item.scheduledAt);
    const last = groups[groups.length - 1];
    if (last && last.date === date) last.items.push(item);
    else groups.push({ date, items: [item] });
  }
  return groups;
}

function dayHeading(date: string, today: string): string {
  const base = `${weekdayName(date)}, ${formatDate(date)}`;
  const label = base.charAt(0).toUpperCase() + base.slice(1);
  if (date === today) return `Hoje · ${label}`;
  if (date === addDaysISO(today, 1)) return `Amanhã · ${label}`;
  return label;
}

export default async function AudienciasPage(props: PageProps<"/audiencias">) {
  const ctx = await requirePageContext("process:read");
  const sp: SearchParams = await props.searchParams;
  const today = todayISO();

  const periodParam = enumParam(sp, "periodo", HEARING_PERIOD_PARAMS);
  const period: HearingPeriod = periodParam ? PERIOD_BY_PARAM[periodParam] : "upcoming";
  const status = enumParam(sp, "status", HEARING_STATUSES);
  const responsibleId = idParam(sp, "responsavel");
  const canWrite = can(ctx, "process:write");

  const [result, counts, users] = await Promise.all([
    listHearings(ctx, { period, status, responsibleId, page: pageParam(sp) }),
    getHearingCounts(ctx),
    listHearingUserOptions(ctx),
  ]);
  const userOptions = users.map((u) => ({ value: u.id, label: u.name }));
  const filtered = hasAnyParam(sp, ["periodo", "status", "responsavel"]);
  const groups = groupByDay(result.items);

  return (
    <>
      <PageHeader
        title="Audiências e pauta"
        description="Agenda das audiências e sessões de julgamento dos processos que você pode acessar. As audiências são cadastradas por pessoas: não há integração com tribunais nesta versão."
        breadcrumbs={[{ label: "Painel executivo", href: "/dashboard" }, { label: "Audiências" }]}
        actions={
          canWrite ? (
            <HearingFormDialog askProcessNumber users={userOptions} defaultResponsibleId={ctx.userId} />
          ) : null
        }
      />

      <div className="flex flex-col gap-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="Próximos 7 dias"
            value={formatNumber(counts.next7Days)}
            hint={counts.today > 0 ? pluralize(counts.today, "audiência hoje", "audiências hoje") : "Nenhuma audiência hoje"}
            tone={counts.today > 0 ? "warning" : "neutral"}
            icon={<CalendarClock />}
            href="/audiencias?periodo=7d"
          />
          <StatCard
            label="Próximos 30 dias"
            value={formatNumber(counts.next30Days)}
            tone="primary"
            icon={<CalendarRange />}
            href="/audiencias?periodo=30d"
          />
          {ctx.userId ? (
            <StatCard
              label="Sob minha responsabilidade"
              value={formatNumber(counts.mine)}
              hint="A partir de hoje"
              icon={<UserRound />}
              href={`/audiencias?responsavel=${ctx.userId}`}
            />
          ) : null}
          <StatCard
            label="Aguardando registro"
            value={formatNumber(counts.awaitingRecord)}
            hint="Data passada sem resultado registrado"
            tone={counts.awaitingRecord > 0 ? "alert" : "neutral"}
            icon={<ClipboardX />}
            href="/audiencias?periodo=passadas&status=scheduled"
          />
        </div>

        <div className="flex flex-col">
          <FilterBar basePath="/audiencias" search={false} showClear={filtered}>
            <FilterSelect
              name="periodo"
              label="Período"
              defaultValue={periodParam}
              options={optionsFromLabels(HEARING_PERIOD_LABELS)}
              placeholder="Todas as próximas"
            />
            <FilterSelect
              name="status"
              label="Situação"
              defaultValue={status}
              options={optionsFromLabels(HEARING_STATUS_LABELS)}
              placeholder="Designadas e realizadas"
            />
            <FilterSelect
              name="responsavel"
              label="Responsável"
              defaultValue={responsibleId}
              options={userOptions}
              className="sm:w-56"
            />
          </FilterBar>
          <p className="mb-3 text-xs text-muted-foreground">
            {period === "past"
              ? "Audiências passadas, da mais recente para a mais antiga."
              : "Audiências de hoje em diante, em ordem cronológica."}{" "}
            Sem filtro de situação, a agenda mostra as designadas e as realizadas; redesignadas e canceladas aparecem ao
            filtrar pela situação. Horários de Brasília.
          </p>

          {groups.length === 0 ? (
            <EmptyState
              icon={<CalendarDays />}
              title={filtered ? "Nenhuma audiência encontrada com esses filtros" : "Nenhuma audiência designada a partir de hoje"}
              description={
                filtered
                  ? "Ajuste ou limpe os filtros para ver outras audiências."
                  : canWrite
                    ? "Use “Nova audiência” ou a aba Audiências do processo para cadastrar a próxima designação."
                    : "Quando houver audiências designadas nos processos que você acompanha, elas aparecerão aqui."
              }
            />
          ) : (
            <ol className="flex flex-col gap-4" aria-label="Agenda de audiências por dia">
              {groups.map((g) => (
                <li key={g.date}>
                  <Card aria-labelledby={`dia-${g.date}`} className="gap-3 py-4">
                    <h2
                      id={`dia-${g.date}`}
                      className="flex flex-wrap items-baseline gap-x-2 px-5 text-sm font-semibold text-slate-900"
                    >
                      <time dateTime={g.date}>{dayHeading(g.date, today)}</time>
                      <span className="text-xs font-normal text-muted-foreground">
                        {pluralize(g.items.length, "audiência", "audiências")}
                      </span>
                    </h2>
                    <CardContent>
                      <ul className="divide-y divide-border">
                        {g.items.map((h) => (
                          <li key={h.id} className="py-4 first:pt-1 last:pb-0">
                            <HearingRow item={h} users={userOptions} today={today} showProcess />
                          </li>
                        ))}
                      </ul>
                    </CardContent>
                  </Card>
                </li>
              ))}
            </ol>
          )}
          <Pagination
            page={result.page}
            pageSize={result.pageSize}
            total={result.total}
            basePath="/audiencias"
            searchParams={sp}
            className="mt-4"
          />
        </div>

        <Callout tone="info" title="Lembretes e alertas">
          Audiências designadas dentro da janela configurada pela organização geram alertas em “Alertas e pendências” e um
          lembrete por e-mail ao responsável. Nesta versão o e-mail é simulado: nenhuma mensagem é enviada.
        </Callout>
      </div>
    </>
  );
}
