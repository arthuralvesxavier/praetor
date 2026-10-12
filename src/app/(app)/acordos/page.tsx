import { CalendarClock, CircleAlert, Handshake, Wallet } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { FilterBar, FilterSelect } from "@/components/ui/filter-bar";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { StatCard } from "@/components/ui/stat-card";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SETTLEMENT_STATUS_LABELS, SETTLEMENT_STATUSES } from "@/domain/enums";
import { formatDate, formatMoneyCents, formatNumber, formatRelativeDays, todayISO } from "@/lib/format";
import { optionsFromLabels } from "@/lib/options";
import { enumParam, flagParam, hasAnyParam, pageParam, type SearchParams } from "@/lib/search-params";
import { listUserOptions } from "@/modules/admin/service";
import { InstallmentStatusBadge } from "@/modules/contingency/components/badges";
import { SettlementCard } from "@/modules/contingency/components/process-tabs";
import { InstallmentPayment, SettlementCreateDialog } from "@/modules/contingency/components/settlement-forms";
import {
  getSettlementKpis,
  listSettlementProcessOptions,
  listSettlements,
  listUpcomingInstallments,
} from "@/modules/contingency/settlement-service";
import { can } from "@/server/auth/permissions";
import { requirePageContext } from "@/server/auth/session";

export const metadata: Metadata = { title: "Acordos" };

const FILTER_KEYS = ["status", "vencendo"] as const;

export default async function SettlementsPage(props: { searchParams: Promise<SearchParams> }) {
  const ctx = await requirePageContext("contingency:read");
  const sp = await props.searchParams;
  const status = enumParam(sp, "status", SETTLEMENT_STATUSES);
  const dueSoon = flagParam(sp, "vencendo");
  const canWrite = can(ctx, "contingency:write");
  const canApprove = can(ctx, "contingency:approve");

  const [result, kpis, upcoming, processes, users] = await Promise.all([
    listSettlements(ctx, { status, dueSoon, page: pageParam(sp) }),
    getSettlementKpis(ctx),
    listUpcomingInstallments(ctx, { limit: 15 }),
    canWrite ? listSettlementProcessOptions(ctx) : Promise.resolve([]),
    canWrite ? listUserOptions(ctx) : Promise.resolve([]),
  ]);
  const filtered = hasAnyParam(sp, FILTER_KEYS);
  const today = todayISO();

  return (
    <>
      <PageHeader
        title="Acordos"
        description="Propostas, negociações e acordos firmados ou homologados, com o controle das parcelas. Valores de acordo nunca se somam ao valor da causa nem ao liquidado."
        breadcrumbs={[{ label: "Contingências", href: "/contingencias" }, { label: "Acordos" }]}
        actions={
          canWrite ? (
            <SettlementCreateDialog
              processes={processes.map((p) => ({ value: p.id, label: `${p.number} — ${p.title}` }))}
              users={users.map((u) => ({ value: u.id, label: u.name }))}
            />
          ) : null
        }
      />

      <section aria-label="Indicadores de acordos" className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Em proposta ou negociação"
          value={formatNumber(kpis.open)}
          icon={<Handshake />}
          tone="info"
        />
        <StatCard label="Firmados ou homologados" value={formatNumber(kpis.binding)} icon={<Wallet />} tone="primary" />
        <StatCard
          label="Saldo a pagar"
          value={formatMoneyCents(kpis.pendingCents)}
          hint={`${formatNumber(kpis.overdueInstallments)} parcela(s) vencida(s)`}
          icon={<CalendarClock />}
          tone={kpis.overdueInstallments > 0 ? "danger" : "warning"}
        />
        <StatCard label="Descumpridos" value={formatNumber(kpis.breached)} icon={<CircleAlert />} tone="danger" href="/acordos?status=breached" />
      </section>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Próximas parcelas</CardTitle>
          <CardDescription>
            Parcelas a pagar de acordos firmados, homologados ou descumpridos com vencimento em até {upcoming.days} dia(s), incluindo
            as vencidas.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <Table aria-label="Próximas parcelas">
            <TableHeader>
              <TableRow>
                <TableHead>Vencimento</TableHead>
                <TableHead>Processo</TableHead>
                <TableHead>Parcela</TableHead>
                <TableHead className="text-right">Valor</TableHead>
                <TableHead>Situação</TableHead>
                {canWrite ? <TableHead className="text-right">Ação</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {upcoming.items.length === 0 ? (
                <TableEmpty colSpan={canWrite ? 6 : 5} message="Nenhuma parcela a vencer na janela." />
              ) : (
                upcoming.items.map((i) => (
                  <TableRow key={i.id}>
                    <TableCell className="whitespace-nowrap tabular-nums">
                      {formatDate(i.dueDate)}
                      <span className="block text-xs text-muted-foreground">{formatRelativeDays(i.dueDate, today)}</span>
                    </TableCell>
                    <TableCell className="min-w-48">
                      <Link href={`/processos/${i.processId}?aba=acordos`} className="font-medium tabular-nums text-primary-700 hover:underline">
                        {i.processNumber}
                      </Link>
                      <span className="block truncate text-xs text-muted-foreground" title={i.processTitle}>
                        {i.processTitle}
                      </span>
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {i.number}
                      {i.installmentsCount ? `/${i.installmentsCount}` : ""}
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap tabular-nums">{formatMoneyCents(i.amountCents)}</TableCell>
                    <TableCell>
                      <InstallmentStatusBadge status={i.status} overdue={i.dueDate < today} />
                    </TableCell>
                    {canWrite ? (
                      <TableCell className="text-right">
                        <InstallmentPayment id={i.id} number={i.number} amountCents={i.amountCents} paid={false} />
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <FilterBar basePath="/acordos" search={false} showClear={filtered}>
        <FilterSelect name="status" label="Situação" options={optionsFromLabels(SETTLEMENT_STATUS_LABELS)} defaultValue={status} placeholder="Todas" />
        <FilterSelect
          name="vencendo"
          label="Parcelas"
          options={[{ value: "1", label: `Com parcela a vencer em até ${result.dueDays} dias` }]}
          defaultValue={dueSoon ? "1" : undefined}
          placeholder="Todas"
        />
      </FilterBar>

      <section aria-label="Acordos" className="space-y-4">
        {result.items.length === 0 ? (
          <EmptyState
            icon={<Handshake />}
            title={filtered ? "Nenhum acordo com esses filtros" : "Nenhum acordo registrado"}
            description={
              filtered
                ? "Ajuste ou limpe os filtros."
                : canWrite
                  ? "Use “Novo acordo” para registrar uma proposta a partir de um processo."
                  : "Os acordos registrados nos processos aparecerão aqui."
            }
          />
        ) : (
          result.items.map((s) => <SettlementCard key={s.id} s={s} canWrite={canWrite} canApprove={canApprove} documents={[]} showProcess />)
        )}
      </section>
      <Pagination page={result.page} pageSize={result.pageSize} total={result.total} basePath="/acordos" searchParams={sp} />
    </>
  );
}
