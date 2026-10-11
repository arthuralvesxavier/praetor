import { CalendarClock, CalendarX, ClipboardList, FileSignature, Lock, Plus } from "lucide-react";
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
  RENEWAL_TYPE_LABELS,
} from "@/domain/enums";
import { formatDate, formatMoneyCents, formatNumber, pluralize } from "@/lib/format";
import { optionsFromLabels } from "@/lib/options";
import { enumParam, flagParam, hasAnyParam, idParam, pageParam, param } from "@/lib/search-params";
import { CONTRACT_STATUS_TONES } from "@/lib/tones";
import { listUserOptions } from "@/modules/admin/service";
import { VigencyBadge } from "@/modules/contracts/components/vigency-badge";
import { getContractKpis, listContracts } from "@/modules/contracts/service";
import { can } from "@/server/auth/permissions";
import { requirePageContext } from "@/server/auth/session";

export const metadata: Metadata = { title: "Contratos" };

const FILTER_KEYS = ["q", "status", "tipo", "vencendo", "vencidos", "responsavel"] as const;

export default async function ContractsPage(props: PageProps<"/contratos">) {
  const ctx = await requirePageContext("contract:read");
  const sp = await props.searchParams;

  const q = param(sp, "q");
  const status = enumParam(sp, "status", CONTRACT_STATUSES);
  const type = enumParam(sp, "tipo", CONTRACT_TYPES);
  const expiring = flagParam(sp, "vencendo");
  const overdue = flagParam(sp, "vencidos");
  const responsibleId = idParam(sp, "responsavel");

  const [result, kpis, users] = await Promise.all([
    listContracts(ctx, { q, status, type, expiring, overdue, responsibleId, page: pageParam(sp) }),
    getContractKpis(ctx),
    listUserOptions(ctx),
  ]);

  const canWrite = can(ctx, "contract:write");
  const filtered = hasAnyParam(sp, FILTER_KEYS);
  const situationValue = expiring ? "vencendo" : overdue ? "vencidos" : undefined;

  return (
    <>
      <PageHeader
        title="Contratos"
        description="Vigência, renovação, obrigações e responsáveis pelos contratos da organização."
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

      <section aria-label="Indicadores de contratos" className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Vigentes"
          value={formatNumber(kpis.active)}
          tone="success"
          icon={<FileSignature />}
          href="/contratos?status=active"
        />
        <StatCard
          label={`Vencendo em até ${kpis.expirationDays} dias`}
          value={formatNumber(kpis.expiring)}
          tone="warning"
          icon={<CalendarClock />}
          href="/contratos?vencendo=1"
        />
        <StatCard
          label="Vencidos"
          value={formatNumber(kpis.expired)}
          hint="Situação “Expirado” ou término já ultrapassado"
          tone="danger"
          icon={<CalendarX />}
          href="/contratos?vencidos=1"
        />
        <StatCard
          label="Obrigações pendentes"
          value={formatNumber(kpis.pendingObligations)}
          hint="Pendentes ou em atraso"
          tone="info"
          icon={<ClipboardList />}
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
        <VigencyFilter value={situationValue} days={kpis.expirationDays} />
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
              <TableHead>Título</TableHead>
              <TableHead>Contraparte</TableHead>
              <TableHead>Tipo</TableHead>
              <TableHead>Situação</TableHead>
              <TableHead>Vigência</TableHead>
              <TableHead>Renovação</TableHead>
              <TableHead className="text-right">Valor</TableHead>
              <TableHead>Responsável</TableHead>
              <TableHead className="text-right">Obrigações pendentes</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.items.length === 0 ? (
              <TableEmpty
                colSpan={9}
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
                  <TableCell className="min-w-56">
                    <Link href={`/contratos/${c.id}`} className={tableLinkClasses}>
                      {c.title}
                    </Link>
                    {c.isConfidential ? (
                      <span className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                        <Lock aria-hidden="true" className="size-3" />
                        Confidencial
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="min-w-44">
                    <span className="block text-slate-900">{c.counterparty}</span>
                    {c.counterpartyDocumentMasked ? (
                      <span className="block font-mono text-xs text-muted-foreground">{c.counterpartyDocumentMasked}</span>
                    ) : null}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{CONTRACT_TYPE_LABELS[c.type]}</TableCell>
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
                  <TableCell className="min-w-36 text-sm">
                    {RENEWAL_TYPE_LABELS[c.renewalType]}
                    {c.renewalNoticeDays !== null ? (
                      <span className="block text-xs text-muted-foreground">
                        Aviso: {pluralize(c.renewalNoticeDays, "dia", "dias")} antes
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap tabular-nums">{formatMoneyCents(c.valueCents)}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    {c.responsibleName ?? <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {c.pendingObligations > 0 ? (
                      <span className="font-medium text-amber-800">{formatNumber(c.pendingObligations)}</span>
                    ) : (
                      <span className="text-muted-foreground">0</span>
                    )}
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
    </>
  );
}

/** Vigency filters: the documented flag `vencendo=1` plus the module's own `vencidos=1`. */
function VigencyFilter({ value, days }: { value: "vencendo" | "vencidos" | undefined; days: number }) {
  return (
    <>
      <FilterSelect
        name="vencendo"
        label="Vencimento"
        options={[{ value: "1", label: `Vencendo em até ${days} dias` }]}
        defaultValue={value === "vencendo" ? "1" : undefined}
      />
      <FilterSelect
        name="vencidos"
        label="Vencidos"
        options={[{ value: "1", label: "Somente vencidos" }]}
        defaultValue={value === "vencidos" ? "1" : undefined}
      />
    </>
  );
}
