import { Calculator } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, tableLinkClasses } from "@/components/ui/table";
import type { MoneyBucket } from "@/domain/contingency";
import { formatMoneyCents, formatNumber, pluralize } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Workload, WorkloadPending, WorkloadRow } from "../service";

/** Sum of known values + how many are unknown (RN-03: null is not zero). */
function KnownSum({ cents, unknown, count, unknownLabel }: { cents: number; unknown: number; count: number; unknownLabel: string }) {
  if (count === 0) return <span className="text-muted-foreground">Sem processos</span>;
  if (unknown === count) return <span className="text-muted-foreground">{unknownLabel}</span>;
  return (
    <>
      <span className="block font-medium text-slate-900">{formatMoneyCents(cents)}</span>
      {unknown > 0 ? (
        <span className="block text-xs text-muted-foreground">
          + {formatNumber(unknown)} {unknownLabel.toLowerCase()}
        </span>
      ) : null}
    </>
  );
}

function Exposure({ money }: { money: MoneyBucket }) {
  if (money.count === 0) return <span className="text-muted-foreground">Sem processos</span>;
  if (money.exposureUnknown === money.count) return <span className="text-muted-foreground">Sem base de cálculo</span>;
  return (
    <>
      <span className="block font-medium text-slate-900">{formatMoneyCents(money.exposureCents)}</span>
      {money.exposureEstimateCents > 0 ? (
        <span className="block text-xs text-amber-800">+ {formatMoneyCents(money.exposureEstimateCents)} estimada</span>
      ) : null}
      {money.exposureUnknown > 0 ? (
        <span className="block text-xs text-muted-foreground">
          {pluralize(money.exposureUnknown, "processo sem base de cálculo", "processos sem base de cálculo")}
        </span>
      ) : null}
    </>
  );
}

const PENDING_LABELS: { key: keyof WorkloadPending; singular: string; plural: string }[] = [
  { key: "openDeadlines", singular: "prazo em aberto", plural: "prazos em aberto" },
  { key: "briefsAwaitingReview", singular: "análise preliminar a revisar", plural: "análises preliminares a revisar" },
  { key: "valuationsPendingReview", singular: "valor a conferir", plural: "valores a conferir" },
  { key: "needsVerification", singular: "processo pendente de conferência", plural: "processos pendentes de conferência" },
  { key: "openIntakes", singular: "entrada em andamento", plural: "entradas em andamento" },
];

function Pending({ pending }: { pending: WorkloadPending }) {
  const items = PENDING_LABELS.filter((p) => pending[p.key] > 0);
  if (items.length === 0) return <span className="text-xs text-muted-foreground">Nenhuma</span>;
  return (
    <ul className="grid gap-0.5 text-xs text-slate-700">
      {items.map((p) => (
        <li key={p.key}>{pluralize(pending[p.key], p.singular, p.plural)}</li>
      ))}
    </ul>
  );
}

function WorkloadTable({
  title,
  label,
  firstColumn,
  rows,
}: {
  title: string;
  label: string;
  firstColumn: string;
  rows: WorkloadRow[];
}) {
  return (
    <Card className="pb-0">
      <CardHeader>
        <CardTitle as="h2">{title}</CardTitle>
      </CardHeader>
      <CardContent className="px-0">
        <Table aria-label={label}>
          <TableHeader>
            <TableRow>
              <TableHead>{firstColumn}</TableHead>
              <TableHead className="text-right">Processos ativos</TableHead>
              <TableHead className="text-right">Valor da causa</TableHead>
              <TableHead className="text-right">Valor liquidado</TableHead>
              <TableHead className="text-right">Exposição líquida</TableHead>
              <TableHead>Pendências</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-6 text-center text-sm text-muted-foreground">
                  Nada para mostrar.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((r) => (
                <TableRow key={r.key}>
                  <TableCell className="min-w-48 align-top">
                    {r.href ? (
                      <Link href={r.href} className={tableLinkClasses}>
                        {r.name}
                      </Link>
                    ) : (
                      <span className="font-medium text-slate-900">{r.name}</span>
                    )}
                    {r.detail ? <span className="block text-xs text-muted-foreground">{r.detail}</span> : null}
                    {!r.isActive ? <Badge tone="neutral" className="mt-1">Inativo</Badge> : null}
                  </TableCell>
                  <TableCell className={cn("text-right align-top tabular-nums", r.activeProcesses === 0 && "text-muted-foreground")}>
                    {formatNumber(r.activeProcesses)}
                  </TableCell>
                  <TableCell className="text-right align-top whitespace-nowrap tabular-nums">
                    <KnownSum cents={r.money.claimCents} unknown={r.money.claimUnknown} count={r.money.count} unknownLabel="Sem valor" />
                  </TableCell>
                  <TableCell className="text-right align-top whitespace-nowrap tabular-nums">
                    <KnownSum
                      cents={r.money.liquidatedCents}
                      unknown={r.money.liquidatedUnknown}
                      count={r.money.count}
                      unknownLabel="Não apurado"
                    />
                  </TableCell>
                  <TableCell className="text-right align-top whitespace-nowrap tabular-nums">
                    <Exposure money={r.money} />
                  </TableCell>
                  <TableCell className="min-w-52 align-top">
                    <Pending pending={r.pending} />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

/** Carga de trabalho por advogado e por escritório (TE-08). Only data from the portfolio — no estimates of people's time. */
export function WorkloadPanel({ workload }: { workload: Workload }) {
  const t = workload.totals;
  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle as="h2" className="flex flex-wrap items-center gap-2">
            Carteira ativa visível para você
            <Badge tone="info" icon={<Calculator />}>
              Calculado a partir da carteira
            </Badge>
          </CardTitle>
          <CardDescription>
            Processos com situação ativa ou suspensa. Valor da causa e valor liquidado são grandezas diferentes e nunca são
            somados entre si; valores ausentes aparecem como “sem valor” / “não apurado”, nunca como zero. A exposição
            líquida segue a regra de contingência: liquidado − garantias vinculadas; sem liquidado, causa × percentual de
            risco, sinalizada como estimada.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <dt className="text-xs font-medium text-muted-foreground">Processos ativos</dt>
              <dd className="text-xl font-semibold text-slate-900 tabular-nums">{formatNumber(t.activeProcesses)}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-muted-foreground">Valor da causa (declarado)</dt>
              <dd className="tabular-nums">
                <KnownSum cents={t.money.claimCents} unknown={t.money.claimUnknown} count={t.money.count} unknownLabel="Sem valor" />
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-muted-foreground">Valor liquidado (apurado)</dt>
              <dd className="tabular-nums">
                <KnownSum
                  cents={t.money.liquidatedCents}
                  unknown={t.money.liquidatedUnknown}
                  count={t.money.count}
                  unknownLabel="Não apurado"
                />
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-muted-foreground">Exposição líquida</dt>
              <dd className="tabular-nums">
                <Exposure money={t.money} />
              </dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      <WorkloadTable
        title="Por advogado / responsável"
        label="Carga de trabalho por responsável"
        firstColumn="Responsável"
        rows={workload.byLawyer}
      />
      <WorkloadTable
        title="Por escritório externo"
        label="Carga de trabalho por escritório externo"
        firstColumn="Escritório"
        rows={workload.byLawFirm}
      />
    </div>
  );
}
