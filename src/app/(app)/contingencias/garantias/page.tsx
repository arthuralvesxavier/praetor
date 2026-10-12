import { Clock, Landmark } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { StatCard } from "@/components/ui/stat-card";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow, tableLinkClasses } from "@/components/ui/table";
import { GUARANTEE_KIND_LABELS, PROCESS_INSTANCE_LABELS } from "@/domain/enums";
import { daysUntil, formatDate, formatMoneyCents, formatNumber, pluralize } from "@/lib/format";
import { pageParam } from "@/lib/search-params";
import { listIdleGuarantees, type IdleGuaranteeItem, type IdleSinceBasis } from "@/modules/dashboard/idle-guarantees";
import { processTabUrl } from "@/modules/processes/tabs";
import { can } from "@/server/auth/permissions";
import { requirePageContext } from "@/server/auth/session";

export const metadata: Metadata = { title: "Garantias sem movimentação" };

const BASIS_LABELS: Record<IdleSinceBasis, string> = {
  status_change: "última mudança de situação",
  deposit: "data do depósito",
  registration: "data de cadastro (sem depósito informado)",
};

/**
 * "TRT6 · 1º grau". `court` is NOT NULL but may be blank (imports, empty form default):
 * a blank court or a missing instance is named as not informed, never left empty.
 */
function courtLine(court: string, instance: IdleGuaranteeItem["instance"]): string {
  const courtLabel = court.trim() !== "" ? court.trim() : "Tribunal não informado";
  return `${courtLabel} · ${instance ? PROCESS_INSTANCE_LABELS[instance] : "Instância não informada"}`;
}

/**
 * Linked guarantees without movement for `settings.contingency.idleGuaranteeDays` days or
 * more: the list behind the "Garantias sem movimentação" block of the dashboard (same
 * rule and visibility, so the counts match). Read-only; each row opens the process'
 * "Valores e acordos" tab, where the guarantee is released, returned or updated.
 */
export default async function IdleGuaranteesPage(props: PageProps<"/contingencias/garantias">) {
  const ctx = await requirePageContext("contingency:read");
  const sp = await props.searchParams;
  const result = await listIdleGuarantees(ctx, { page: pageParam(sp) });
  const { idleDays, today } = result;

  return (
    <>
      <PageHeader
        title="Garantias sem movimentação"
        description={`Garantias vinculadas a processos que você pode acessar, sem movimentação há ${pluralize(idleDays, "dia", "dias")} ou mais. Verifique levantamento, liberação ou substituição.`}
        breadcrumbs={[
          { label: "Painel executivo", href: "/dashboard" },
          { label: "Contingências", href: "/contingencias" },
          { label: "Garantias sem movimentação" },
        ]}
      />

      <section aria-label="Resumo" className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard
          label="Garantias paradas"
          value={formatNumber(result.total)}
          hint={`Sem movimentação há ${pluralize(idleDays, "dia", "dias")} ou mais`}
          icon={<Clock />}
          tone={result.total > 0 ? "warning" : "neutral"}
        />
        <StatCard
          label="Valor vinculado"
          value={result.total > 0 ? formatMoneyCents(result.totalCents) : <span className="text-base font-medium text-muted-foreground">Nenhuma garantia</span>}
          hint="Soma das garantias desta lista"
          icon={<Landmark />}
        />
      </section>

      <Card>
        <CardContent className="px-0">
          {/* Phones: one block per guarantee (value and date visible without scrolling sideways). */}
          {result.items.length === 0 ? (
            <p className="px-5 py-10 text-center font-medium text-slate-700 sm:hidden">
              {`Nenhuma garantia vinculada parada há ${pluralize(idleDays, "dia", "dias")} ou mais.`}
            </p>
          ) : (
            <ul aria-label="Garantias sem movimentação" className="divide-y divide-border sm:hidden">
              {result.items.map((g) => {
                const days = Math.max(0, -daysUntil(g.idleSince, today));
                return (
                  <li key={g.id} className="px-4 py-3">
                    <Link href={processTabUrl(g.processId, "valores-e-acordos")} className={`${tableLinkClasses} tabular-nums`}>
                      {g.processNumber}
                    </Link>
                    <span className="block truncate text-xs text-muted-foreground" title={g.processTitle}>
                      {g.processTitle}
                    </span>
                    <span className="mt-1.5 flex items-baseline justify-between gap-3 text-sm text-slate-800">
                      <span className="min-w-0">{GUARANTEE_KIND_LABELS[g.kind]}</span>
                      <span className="shrink-0 font-medium tabular-nums">{formatMoneyCents(g.amountCents)}</span>
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      Parada desde <span className="tabular-nums">{formatDate(g.idleSince)}</span>
                      {" · "}
                      <span className="text-amber-800">{`há ${pluralize(days, "dia", "dias")}`}</span>
                      {" · "}
                      {BASIS_LABELS[g.idleSinceBasis]}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="hidden sm:block">
            <Table aria-label="Garantias sem movimentação">
              <TableHeader>
                <TableRow>
                  <TableHead>Processo</TableHead>
                  <TableHead>Garantia</TableHead>
                  <TableHead className="text-right">Valor</TableHead>
                  <TableHead>Parada desde</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.items.length === 0 ? (
                  <TableEmpty
                    colSpan={4}
                    message={`Nenhuma garantia vinculada parada há ${pluralize(idleDays, "dia", "dias")} ou mais.`}
                  />
                ) : (
                  result.items.map((g) => {
                    const days = Math.max(0, -daysUntil(g.idleSince, today));
                    return (
                      <TableRow key={g.id} interactive>
                        <TableCell className="min-w-56 align-top">
                          <Link href={processTabUrl(g.processId, "valores-e-acordos")} className={`${tableLinkClasses} tabular-nums`}>
                            {g.processNumber}
                          </Link>
                          <span className="block max-w-80 truncate text-xs text-muted-foreground" title={g.processTitle}>
                            {g.processTitle}
                          </span>
                          <span className="block text-xs text-muted-foreground">{courtLine(g.court, g.instance)}</span>
                        </TableCell>
                        <TableCell className="min-w-40 align-top">
                          {GUARANTEE_KIND_LABELS[g.kind]}
                          {g.description ? (
                            <span className="block max-w-64 truncate text-xs text-muted-foreground" title={g.description}>
                              {g.description}
                            </span>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-right align-top whitespace-nowrap tabular-nums">
                          {formatMoneyCents(g.amountCents)}
                        </TableCell>
                        <TableCell className="min-w-44 align-top">
                          <span className="tabular-nums">{formatDate(g.idleSince)}</span>
                          <span className="block text-xs text-amber-800">{`há ${pluralize(days, "dia", "dias")}`}</span>
                          <span className="block text-xs text-muted-foreground">{BASIS_LABELS[g.idleSinceBasis]}</span>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
      <Pagination
        page={result.page}
        pageSize={result.pageSize}
        total={result.total}
        basePath="/contingencias/garantias"
        searchParams={sp}
        className="mt-4"
      />
      <p className="mt-4 text-xs text-muted-foreground">
        Movimentação: mudança de situação da garantia; sem ela, a data do depósito; sem depósito informado, a data de cadastro.
        {can(ctx, "admin:organization") ? (
          <>
            {" "}
            O prazo de {pluralize(idleDays, "dia", "dias")} é definido em{" "}
            <Link href="/admin/configuracoes#contingencias" className="font-medium text-primary-700 underline-offset-2 hover:underline">
              Configurações da organização
            </Link>
            .
          </>
        ) : null}
      </p>
    </>
  );
}
