import { AlarmClock, CalendarX, ListTodo, Sparkles } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Callout } from "@/components/ui/callout";
import { Card } from "@/components/ui/card";
import { FilterBar, FilterSelect } from "@/components/ui/filter-bar";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { StatCard } from "@/components/ui/stat-card";
import { LinkTabs } from "@/components/ui/tabs";
import { EmptyState } from "@/components/ui/empty-state";
import {
  DATA_ORIGIN_LABELS,
  TASK_KIND_LABELS,
  TASK_KINDS,
  TASK_STATUS_LABELS,
  TASK_STATUSES,
  DATA_ORIGINS,
} from "@/domain/enums";
import { formatNumber, todayISO } from "@/lib/format";
import { optionsFromLabels } from "@/lib/options";
import { buildHref, enumParam, hasAnyParam, idParam, pageParam, param, type SearchParams } from "@/lib/search-params";
import { currentMonth, parseMonth, shiftMonth } from "@/modules/work/calendar";
import { DeadlineTable } from "@/modules/work/components/deadline-table";
import { SelectedDeadline, SelectedTask } from "@/modules/work/components/selected-items";
import { TaskTable } from "@/modules/work/components/task-table";
import { ValidationList } from "@/modules/work/components/validation-list";
import { NewDeadlineDialog, NewTaskDialog } from "@/modules/work/components/work-dialogs";
import { WorkCalendar } from "@/modules/work/components/work-calendar";
import { SITUATION_PARAM_VALUES } from "@/modules/work/schemas";
import {
  getDeadline,
  getTask,
  getWorkSummary,
  listCalendarItems,
  listDeadlines,
  listTasks,
  listWorkLinkOptions,
  listWorkUserOptions,
  type DeadlineListItem,
  type WorkUserOption,
} from "@/modules/work/service";
import type { AuthContext } from "@/server/auth/context";
import { can } from "@/server/auth/permissions";
import { requirePageContext } from "@/server/auth/session";
import { NotFoundError } from "@/server/lib/errors";

export const metadata: Metadata = { title: "Prazos e tarefas" };

const TABS = ["calendario", "prazos", "tarefas", "validacao"] as const;
type Tab = (typeof TABS)[number];
const SITUATION_KEYS = ["vencidos", "proximos", "abertos"] as const;

const DEADLINE_COUNTING_NOTICE =
  "Prazos sugeridos pela IA ou pela análise preliminar (simulação) dependem de validação humana. O sistema não calcula prazos processuais: confirme as regras de contagem aplicáveis (dias úteis, feriados, suspensões de expediente, forma de intimação).";

async function loadOrNull<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof NotFoundError) return null;
    throw err;
  }
}

export default async function PrazosPage(props: PageProps<"/prazos">) {
  const ctx = await requirePageContext("deadline:read");
  const sp: SearchParams = await props.searchParams;
  const tab: Tab = enumParam(sp, "aba", TABS) ?? "calendario";
  const today = todayISO();

  const canReadTasks = can(ctx, "task:read");
  const canWriteDeadlines = can(ctx, "deadline:write");
  const canWriteTasks = can(ctx, "task:write");
  const canValidate = can(ctx, "deadline:validate");

  const selectedDeadlineId = idParam(sp, "prazo");
  const selectedTaskId = canReadTasks ? idParam(sp, "tarefa") : undefined;

  const [summary, userOptions, linkOptions, selectedDeadline, selectedTask] = await Promise.all([
    getWorkSummary(ctx),
    listWorkUserOptions(ctx),
    canWriteDeadlines || canWriteTasks ? listWorkLinkOptions(ctx) : Promise.resolve(undefined),
    selectedDeadlineId ? loadOrNull(() => getDeadline(ctx, selectedDeadlineId)) : Promise.resolve(null),
    selectedTaskId ? loadOrNull(() => getTask(ctx, selectedTaskId)) : Promise.resolve(null),
  ]);

  const tabHref = (key: Tab) => buildHref("/prazos", {}, { aba: key === "calendario" ? null : key });

  return (
    <>
      <PageHeader
        title="Prazos e tarefas"
        description="Calendário com audiências, prazos e tarefas, controle de prazos e validação humana de prazos sugeridos pela IA ou pela análise preliminar (simulação)."
        breadcrumbs={[{ label: "Painel executivo", href: "/dashboard" }, { label: "Prazos e tarefas" }]}
        actions={
          <>
            {canWriteTasks ? <NewTaskDialog userOptions={userOptions} linkOptions={linkOptions} defaultAssigneeId={ctx.userId} /> : null}
            {canWriteDeadlines ? (
              <NewDeadlineDialog userOptions={userOptions} linkOptions={linkOptions} defaultResponsibleId={ctx.userId} />
            ) : null}
          </>
        }
      />

      <div className="flex flex-col gap-6">
        <Callout tone="warning" title="Atenção à contagem de prazos">
          {DEADLINE_COUNTING_NOTICE}
        </Callout>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="Prazos vencidos"
            value={formatNumber(summary.overdueDeadlines)}
            tone={summary.overdueDeadlines > 0 ? "danger" : "neutral"}
            icon={<CalendarX />}
            href="/prazos?aba=prazos&situacao=vencidos"
          />
          <StatCard
            label={`Próximos ${summary.upcomingDeadlineDays} dias`}
            value={formatNumber(summary.upcomingDeadlines)}
            tone={summary.upcomingDeadlines > 0 ? "warning" : "neutral"}
            icon={<AlarmClock />}
            href="/prazos?aba=prazos&situacao=proximos"
          />
          <StatCard
            label="Aguardando validação"
            value={formatNumber(summary.pendingValidation)}
            hint="Sugestões da IA, ainda não contam como prazo"
            tone={summary.pendingValidation > 0 ? "ai" : "neutral"}
            icon={<Sparkles />}
            href="/prazos?aba=validacao"
          />
          {canReadTasks ? (
            <StatCard
              label="Tarefas atrasadas"
              value={formatNumber(summary.overdueTasks)}
              hint={`${formatNumber(summary.openTasks)} em aberto`}
              tone={summary.overdueTasks > 0 ? "alert" : "neutral"}
              icon={<ListTodo />}
              href="/prazos?aba=tarefas&situacao=vencidos"
            />
          ) : null}
        </div>

        {selectedDeadlineId && !selectedDeadline ? (
          <Callout tone="warning" role="alert">
            O prazo indicado no link não foi encontrado ou você não tem permissão para acessá-lo.
          </Callout>
        ) : null}
        {selectedTaskId && !selectedTask ? (
          <Callout tone="warning" role="alert">
            A tarefa indicada no link não foi encontrada ou você não tem permissão para acessá-la.
          </Callout>
        ) : null}
        {selectedDeadline && tab !== "validacao" ? <SelectedDeadline ctx={ctx} item={selectedDeadline} today={today} /> : null}
        {selectedTask ? <SelectedTask ctx={ctx} item={selectedTask} today={today} /> : null}

        <div className="flex flex-col gap-4">
          <LinkTabs
            label="Visões de prazos e tarefas"
            active={tab}
            tabs={[
              { key: "calendario", label: "Calendário", href: tabHref("calendario") },
              { key: "prazos", label: "Prazos", href: tabHref("prazos"), count: summary.overdueDeadlines || null },
              ...(canReadTasks
                ? [{ key: "tarefas", label: "Tarefas", href: tabHref("tarefas"), count: summary.overdueTasks || null }]
                : []),
              { key: "validacao", label: "Validação", href: tabHref("validacao"), count: summary.pendingValidation || null },
            ]}
          />
          {summary.overdueDeadlines > 0 || summary.pendingValidation > 0 || summary.overdueTasks > 0 ? (
            <p className="sr-only">
              Indicadores nas abas: Prazos mostra os vencidos; Tarefas, as atrasadas; Validação, as sugestões aguardando
              validação.
            </p>
          ) : null}

          {tab === "calendario" ? <CalendarTab ctx={ctx} sp={sp} /> : null}
          {tab === "prazos" ? (
            <DeadlinesTab ctx={ctx} sp={sp} today={today} userOptions={userOptions} highlightId={selectedDeadline?.id} />
          ) : null}
          {tab === "tarefas" ? (
            canReadTasks ? (
              <TasksTab ctx={ctx} sp={sp} today={today} userOptions={userOptions} highlightId={selectedTask?.id} />
            ) : (
              <EmptyState title="Sem acesso às tarefas" description="Seu perfil não permite consultar tarefas." />
            )
          ) : null}
          {tab === "validacao" ? (
            <ValidationTab
              ctx={ctx}
              sp={sp}
              today={today}
              userOptions={userOptions}
              canValidate={canValidate}
              selected={selectedDeadline}
            />
          ) : null}
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

async function CalendarTab({ ctx, sp }: { ctx: AuthContext; sp: SearchParams }) {
  const month = parseMonth(param(sp, "mes")) ?? currentMonth();
  const data = await listCalendarItems(ctx, month);
  const href = (m: string | null) => buildHref("/prazos", {}, { mes: m });
  return (
    <WorkCalendar
      data={data}
      prevHref={href(shiftMonth(month, -1))}
      nextHref={href(shiftMonth(month, 1))}
      todayHref={href(null)}
    />
  );
}

async function DeadlinesTab({
  ctx,
  sp,
  today,
  userOptions,
  highlightId,
}: {
  ctx: AuthContext;
  sp: SearchParams;
  today: string;
  userOptions: WorkUserOption[];
  highlightId?: string;
}) {
  const situationKey = enumParam(sp, "situacao", SITUATION_KEYS);
  const result = await listDeadlines(ctx, {
    q: param(sp, "q"),
    situation: situationKey ? SITUATION_PARAM_VALUES[situationKey] : undefined,
    responsibleId: idParam(sp, "responsavel"),
    origin: enumParam(sp, "origem", DATA_ORIGINS),
    realOnly: true,
    page: pageParam(sp),
  });
  const filtered = hasAnyParam(sp, ["q", "situacao", "responsavel", "origem"]);

  return (
    <div className="flex flex-col gap-0">
      <FilterBar
        basePath="/prazos"
        hiddenFields={{ aba: "prazos" }}
        defaultQuery={param(sp, "q")}
        searchPlaceholder="Título do prazo"
        showClear={filtered}
      >
        <FilterSelect
          name="situacao"
          label="Situação"
          defaultValue={situationKey}
          options={[
            { value: "vencidos", label: "Vencidos" },
            { value: "proximos", label: "Próximos" },
            { value: "abertos", label: "Em aberto" },
          ]}
        />
        <FilterSelect
          name="responsavel"
          label="Responsável"
          defaultValue={idParam(sp, "responsavel")}
          options={userOptions.map((u) => ({ value: u.id, label: u.name }))}
        />
        <FilterSelect
          name="origem"
          label="Origem"
          defaultValue={enumParam(sp, "origem", DATA_ORIGINS)}
          options={optionsFromLabels(DATA_ORIGIN_LABELS, ["manual", "imported", "ai_suggested"])}
        />
      </FilterBar>
      <p className="mb-3 text-xs text-muted-foreground">
        Esta lista mostra prazos cadastrados manualmente e sugestões da IA já validadas. Sugestões pendentes ficam na aba
        Validação.
      </p>
      <Card className="py-0">
        <DeadlineTable
          items={result.items}
          today={today}
          canWrite={can(ctx, "deadline:write")}
          highlightId={highlightId}
          emptyMessage={filtered ? "Nenhum prazo encontrado com esses filtros." : "Nenhum prazo cadastrado."}
          emptyDescription={filtered ? "Ajuste ou limpe os filtros para ver outros prazos." : undefined}
        />
      </Card>
      <Pagination page={result.page} pageSize={result.pageSize} total={result.total} basePath="/prazos" searchParams={sp} />
    </div>
  );
}

async function TasksTab({
  ctx,
  sp,
  today,
  userOptions,
  highlightId,
}: {
  ctx: AuthContext;
  sp: SearchParams;
  today: string;
  userOptions: WorkUserOption[];
  highlightId?: string;
}) {
  const status = enumParam(sp, "status", TASK_STATUSES);
  const kind = enumParam(sp, "tipo", TASK_KINDS);
  const overdue = param(sp, "situacao") === "vencidos";
  const result = await listTasks(ctx, {
    q: param(sp, "q"),
    status,
    kind,
    assigneeId: idParam(sp, "responsavel"),
    overdue,
    page: pageParam(sp),
  });
  const filtered = hasAnyParam(sp, ["q", "status", "tipo", "responsavel", "situacao"]);

  return (
    <div className="flex flex-col">
      <FilterBar
        basePath="/prazos"
        hiddenFields={{ aba: "tarefas" }}
        defaultQuery={param(sp, "q")}
        searchPlaceholder="Título da tarefa"
        showClear={filtered}
      >
        <FilterSelect name="status" label="Status" defaultValue={status} options={optionsFromLabels(TASK_STATUS_LABELS)} />
        <FilterSelect
          name="responsavel"
          label="Responsável"
          defaultValue={idParam(sp, "responsavel")}
          options={userOptions.map((u) => ({ value: u.id, label: u.name }))}
        />
        <FilterSelect name="tipo" label="Tipo" defaultValue={kind} options={optionsFromLabels(TASK_KIND_LABELS)} />
        <FilterSelect
          name="situacao"
          label="Prazo"
          defaultValue={overdue ? "vencidos" : undefined}
          options={[{ value: "vencidos", label: "Atrasadas" }]}
        />
      </FilterBar>
      <Card className="py-0">
        <TaskTable
          items={result.items}
          today={today}
          canWrite={can(ctx, "task:write")}
          highlightId={highlightId}
          emptyMessage={filtered ? "Nenhuma tarefa encontrada com esses filtros." : "Nenhuma tarefa cadastrada."}
          emptyDescription={filtered ? "Ajuste ou limpe os filtros para ver outras tarefas." : undefined}
        />
      </Card>
      <Pagination page={result.page} pageSize={result.pageSize} total={result.total} basePath="/prazos" searchParams={sp} />
    </div>
  );
}

async function ValidationTab({
  ctx,
  sp,
  today,
  userOptions,
  canValidate,
  selected,
}: {
  ctx: AuthContext;
  sp: SearchParams;
  today: string;
  userOptions: WorkUserOption[];
  canValidate: boolean;
  selected: DeadlineListItem | null;
}) {
  const result = await listDeadlines(ctx, {
    validationStatus: "pending_validation",
    status: "open",
    page: pageParam(sp),
  });
  // A deep-linked suggestion that is not on this page (or no longer pending) is shown first.
  const items =
    selected && selected.isPendingValidation && !result.items.some((i) => i.id === selected.id)
      ? [selected, ...result.items]
      : result.items;
  const notPendingSelected = selected && !selected.isPendingValidation;

  return (
    <div className="flex flex-col gap-4">
      {notPendingSelected ? (
        <Callout tone="info">
          O prazo selecionado não está mais aguardando validação.{" "}
          <Link href={`/prazos?aba=prazos&prazo=${selected.id}`}>Ver o prazo na lista de prazos</Link>.
        </Callout>
      ) : null}
      <ValidationList
        items={items}
        today={today}
        canValidate={canValidate}
        userOptions={userOptions}
        highlightId={selected?.id}
      />
      <Pagination page={result.page} pageSize={result.pageSize} total={result.total} basePath="/prazos" searchParams={sp} />
    </div>
  );
}
