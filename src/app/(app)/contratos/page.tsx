import { BellRing, CalendarClock, CalendarX, ClipboardX, FileSignature, Lock, Plus, Repeat } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FilterBar, FilterSelect } from "@/components/ui/filter-bar";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { StatCard } from "@/components/ui/stat-card";
import { StatusBadge } from "@/components/ui/status-badge";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow, tableLinkClasses } from "@/components/ui/table";
import {
  CONTRACT_STATUSES,
  CONTRACT_STATUS_LABELS,
  CONTRACT_TYPES,
  CONTRACT_TYPE_LABELS,
  OBLIGATION_STATUS_LABELS,
  RENEWAL_TYPE_LABELS,
} from "@/domain/enums";
import { formatDate, formatMoneyCents, formatNumber, formatRelativeDays, pluralize, truncate } from "@/lib/format";
import { optionsFromLabels } from "@/lib/options";
import { enumParam, flagParam, hasAnyParam, idParam, pageParam, param } from "@/lib/search-params";
import { CONTRACT_STATUS_TONES } from "@/lib/tones";
import { cn } from "@/lib/utils";
import { listUserOptions } from "@/modules/admin/service";
import { NoticeBadge } from "@/modules/contracts/components/notice-badge";
import { VigencyBadge } from "@/modules/contracts/components/vigency-badge";
import { getContractKpis, listContracts, type ContractListItem } from "@/modules/contracts/service";
import { can } from "@/server/auth/permissions";
import { requirePageContext } from "@/server/auth/session";

export const metadata: Metadata = { title: "Contratos" };

/**
 * `acompanhamento` groups the follow-up views in one select. The documented
 * flags `vencendo=1` / `vencidos=1` (dashboard deep links) keep working.
 */
const FOLLOW_UPS = ["vencendo", "vencidos", "aviso", "obrigacoes_atrasadas"] as const;
type FollowUp = (typeof FOLLOW_UPS)[number];

const FILTER_KEYS = ["q", "status", "tipo", "acompanhamento", "vencendo", "vencidos", "responsavel"] as const;

export default async function ContractsPage(props: PageProps<"/contratos">) {
  const ctx = await requirePageContext("contract:read");
  const sp = await props.searchParams;

  const q = param(sp, "q");
  const status = enumParam(sp, "status", CONTRACT_STATUSES);
  const type = enumParam(sp, "tipo", CONTRACT_TYPES);
  const followUp: FollowUp | undefined =
    enumParam(sp, "acompanhamento", FOLLOW_UPS) ??
    (flagParam(sp, "vencendo") ? "vencendo" : flagParam(sp, "vencidos") ? "vencidos" : undefined);
  const responsibleId = idParam(sp, "responsavel");

  const [result, kpis, users] = await Promise.all([
    listContracts(ctx, {
      q,
      status,
      type,
      expiring: followUp === "vencendo" || flagParam(sp, "vencendo"),
      overdue: followUp === "vencidos" || flagParam(sp, "vencidos"),
      noticeSoon: followUp === "aviso",
      overdueObligations: followUp === "obrigacoes_atrasadas",
      responsibleId,
      page: pageParam(sp),
    }),
    getContractKpis(ctx),
    listUserOptions(ctx),
  ]);

  const canWrite = can(ctx, "contract:write");
  const filtered = hasAnyParam(sp, FILTER_KEYS);
  const days = kpis.expirationDays;
  const followUpOptions: { value: FollowUp; label: string }[] = [
    { value: "vencendo", label: `Vencendo em até ${days} dias` },
    { value: "vencidos", label: "Vencidos" },
    { value: "aviso", label: `Aviso de renovação/rescisão em até ${days} dias ou já atingido` },
    { value: "obrigacoes_atrasadas", label: "Com obrigações em atraso" },
  ];

  return (
    <>
      <PageHeader
        title="Contratos"
        description="Vigência, avisos de renovação ou rescisão, obrigações e responsáveis pelos contratos da organização."
        breadcrumbs={[{ label: "Dashboard", href: "/dashboard" }, { label: "Contratos" }]}
        actions={
          canWrite ? (
            <ButtonLink href="/contratos/novo">
              <Plus aria-hidden="true" />
              Novo contrato
            </ButtonLink>
          ) : null
        }
      />

      <section aria-label="Indicadores de contratos" className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <StatCard
          label="Vigentes"
          value={formatNumber(kpis.active)}
          tone="success"
          icon={<FileSignature />}
          href="/contratos?status=active"
        />
        <StatCard
          label={`Vencendo em até ${days} dias`}
          value={formatNumber(kpis.expiring)}
          tone="warning"
          icon={<CalendarClock />}
          href="/contratos?acompanhamento=vencendo"
        />
        <StatCard
          label="Vencidos"
          value={formatNumber(kpis.expired)}
          hint="Situação “Expirado” ou término já ultrapassado"
          tone="danger"
          icon={<CalendarX />}
          href="/contratos?acompanhamento=vencidos"
        />
        <StatCard
          label="Aviso de renovação/rescisão"
          value={formatNumber(kpis.noticeSoon)}
          hint={`Data-limite em até ${days} dias ou já atingida`}
          tone="alert"
          icon={<BellRing />}
          href="/contratos?acompanhamento=aviso"
        />
        <StatCard
          label="Obrigações em atraso"
          value={formatNumber(kpis.overdueObligations)}
          hint={`${formatNumber(kpis.pendingObligations)} em aberto no total`}
          tone="danger"
          icon={<ClipboardX />}
          href="/contratos?acompanhamento=obrigacoes_atrasadas"
        />
      </section>

      <FilterBar
        basePath="/contratos"
        defaultQuery={q}
        searchPlaceholder="Título, contraparte ou descrição"
        showClear={filtered}
      >
        <FilterSelect
          name="status"
          label="Situação"
          options={optionsFromLabels(CONTRACT_STATUS_LABELS)}
          defaultValue={status}
        />
        <FilterSelect name="tipo" label="Tipo" options={optionsFromLabels(CONTRACT_TYPE_LABELS)} defaultValue={type} />
        <FilterSelect name="acompanhamento" label="Acompanhamento" options={followUpOptions} defaultValue={followUp} />
        <FilterSelect
          name="responsavel"
          label="Responsável"
          options={users.map((u) => ({ value: u.id, label: u.name }))}
          defaultValue={responsibleId}
        />
      </FilterBar>

      <Card className="py-0">
        <Table aria-label="Contratos">
          <TableHeader>
            <TableRow>
              <TableHead>Contrato</TableHead>
              <TableHead>Tipo</TableHead>
              <TableHead>Situação</TableHead>
              <TableHead>Vigência</TableHead>
              <TableHead>Aviso de renovação/rescisão</TableHead>
              <TableHead className="text-right">Valor</TableHead>
              <TableHead>Responsável</TableHead>
              <TableHead>Próxima obrigação</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.items.length === 0 ? (
              <TableEmpty
                colSpan={8}
                message={filtered ? "Nenhum contrato encontrado com esses filtros." : "Nenhum contrato cadastrado."}
                description={
                  filtered
                    ? "Ajuste ou limpe os filtros para ver outros contratos."
                    : "Cadastre o primeiro contrato para acompanhar vigência, renovação e obrigações."
                }
                action={
                  !filtered && canWrite ? (
                    <ButtonLink href="/contratos/novo" size="sm">
                      <Plus aria-hidden="true" />
                      Novo contrato
                    </ButtonLink>
                  ) : undefined
                }
              />
            ) : (
              result.items.map((c) => (
                <TableRow key={c.id} interactive>
                  <TableCell className="min-w-60">
                    <Link href={`/contratos/${c.id}`} className={tableLinkClasses}>
                      {c.title}
                    </Link>
                    <span className="mt-0.5 block text-sm text-slate-700">{c.counterparty}</span>
                    {c.counterpartyDocumentMasked ? (
                      <span className="block font-mono text-xs text-muted-foreground">{c.counterpartyDocumentMasked}</span>
                    ) : null}
                    {c.isConfidential ? (
                      <span className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                        <Lock aria-hidden="true" className="size-3" />
                        Confidencial
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="min-w-32 text-sm">{CONTRACT_TYPE_LABELS[c.type]}</TableCell>
                  <TableCell>
                    <StatusBadge label={CONTRACT_STATUS_LABELS[c.status]} tone={CONTRACT_STATUS_TONES[c.status]} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    <span className="block text-sm tabular-nums text-slate-800">
                      {c.startDate || c.endDate ? (
                        <>
                          {formatDate(c.startDate)} – {c.endDate ? formatDate(c.endDate) : "indeterminado"}
                        </>
                      ) : (
                        <span className="text-muted-foreground">Datas não informadas</span>
                      )}
                    </span>
                    <VigencyBadge vigency={c.vigency} daysToEnd={c.daysToEnd} className="mt-1" />
                  </TableCell>
                  <TableCell className="min-w-44">
                    <NoticeCell contract={c} />
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap tabular-nums">{formatMoneyCents(c.valueCents)}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    {c.responsibleName ?? <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell className="min-w-52">
                    <NextObligationCell contract={c} />
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
        basePath="/contratos"
        searchParams={sp}
      />
      <p className="mt-4 text-xs text-muted-foreground">
        A data-limite para aviso é calculada como término − antecedência de aviso, conforme a cláusula informada no
        cadastro. Confira sempre o texto do contrato e dos aditivos.
      </p>
    </>
  );
}

function NoticeCell({ contract: c }: { contract: ContractListItem }) {
  return (
    <div className="text-sm">
      {c.notice.date ? (
        <span className="block tabular-nums text-slate-800">{formatDate(c.notice.date)}</span>
      ) : (
        <span className="block text-muted-foreground">{c.renewalNoticeDays ? "—" : "Antecedência não informada"}</span>
      )}
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        <Repeat aria-hidden="true" className="size-3" />
        {RENEWAL_TYPE_LABELS[c.renewalType]}
        {c.renewalNoticeDays ? ` · ${pluralize(c.renewalNoticeDays, "dia", "dias", { withCount: true })} antes` : ""}
      </span>
      <NoticeBadge notice={c.notice} className="mt-1" />
    </div>
  );
}

function NextObligationCell({ contract: c }: { contract: ContractListItem }) {
  const next = c.nextObligation;
  if (!next) return <span className="text-sm text-muted-foreground">Nenhuma em aberto</span>;
  const late = next.status === "overdue";
  return (
    <div className="text-sm">
      <Link
        href={`/contratos/${c.id}?aba=obrigacoes`}
        className="text-slate-900 underline-offset-2 hover:text-primary-800 hover:underline"
        title={next.description}
      >
        {truncate(next.description, 60)}
      </Link>
      <span className={cn("block text-xs tabular-nums", late ? "font-medium text-red-700" : "text-muted-foreground")}>
        {next.dueDate ? `${formatDate(next.dueDate)} · ${formatRelativeDays(next.dueDate)}` : "Sem data"}
        {late ? <span className="sr-only"> ({OBLIGATION_STATUS_LABELS.overdue})</span> : null}
      </span>
      {c.pendingObligations > 1 || c.overdueObligations > 0 ? (
        <span className="block text-xs text-muted-foreground">
          {pluralize(c.pendingObligations, "em aberto", "em aberto", { withCount: true })}
          {c.overdueObligations > 0 ? (
            <span className="font-medium text-red-700"> · {c.overdueObligations} em atraso</span>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}
