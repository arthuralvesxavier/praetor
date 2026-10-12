import type { ReactNode } from "react";
import { formatMoneyCents } from "@/lib/format";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { BucketRow } from "../types";
import { CountCell, EstimateMoneyCell, MoneyGroupCell, NumCell, NumHead } from "./report-cells";

export type ExtraColumn<R extends BucketRow> = { header: string; cell: (row: R) => ReactNode };

/**
 * Money buckets per group. Valor da causa and valor liquidado sit side by side
 * and are never added (RN-02); unknown values are counted below the sum
 * (RN-03); estimates have their own columns (RN-07).
 */
export function BucketTable<R extends BucketRow>({
  label,
  groupHeader,
  rows,
  totals,
  extra = [],
  emptyMessage = "Nenhum processo com estes filtros.",
}: {
  label: string;
  groupHeader: string;
  rows: R[];
  totals?: R;
  extra?: ExtraColumn<R>[];
  emptyMessage?: string;
}) {
  const colSpan = 9 + extra.length;
  const line = (r: R, isTotal = false) => (
    <TableRow key={r.key} className={isTotal ? "bg-slate-50 font-semibold" : undefined}>
      <TableCell className="min-w-44 max-w-72">
        {isTotal ? <span>{r.label}</span> : <span className="text-slate-900">{r.label}</span>}
      </TableCell>
      <CountCell value={r.processCount} />
      <MoneyGroupCell
        cents={r.bucket.claimCents}
        count={r.bucket.count}
        unknown={r.bucket.claimUnknown}
        unknownLabel="Não informado"
        unknownSingular="sem valor da causa"
        unknownPlural="sem valor da causa"
      />
      <MoneyGroupCell
        cents={r.bucket.liquidatedCents}
        count={r.bucket.count}
        unknown={r.bucket.liquidatedUnknown}
        unknownLabel="Não apurado"
        unknownSingular="não apurado"
        unknownPlural="não apurados"
      />
      <NumCell>{r.bucket.guaranteesCents ? formatMoneyCents(r.bucket.guaranteesCents) : <span className="text-muted-foreground">—</span>}</NumCell>
      <MoneyGroupCell
        cents={r.bucket.exposureCents}
        count={r.bucket.count}
        unknown={r.bucket.exposureUnknown}
        unknownLabel="Não calculável"
        unknownSingular="não calculável"
        unknownPlural="não calculáveis"
      />
      <EstimateMoneyCell cents={r.bucket.exposureEstimateCents} />
      <NumCell>{formatMoneyCents(r.bucket.provisionCents)}</NumCell>
      <EstimateMoneyCell cents={r.bucket.provisionEstimateCents} />
      {extra.map((c) => (
        <NumCell key={c.header}>{c.cell(r)}</NumCell>
      ))}
    </TableRow>
  );

  return (
    <Table aria-label={label}>
      <TableHeader>
        <TableRow>
          <TableHead>{groupHeader}</TableHead>
          <NumHead>Processos</NumHead>
          <NumHead>Valor da causa</NumHead>
          <NumHead>Valor liquidado</NumHead>
          <NumHead>Garantias</NumHead>
          <NumHead>Exposição oficial</NumHead>
          <NumHead>
            Exposição estimada <span className="font-normal">(RN-07)</span>
          </NumHead>
          <NumHead>Provisão</NumHead>
          <NumHead>
            Provisão estimada <span className="font-normal">(RN-07)</span>
          </NumHead>
          {extra.map((c) => (
            <NumHead key={c.header}>{c.header}</NumHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 ? <TableEmpty colSpan={colSpan} message={emptyMessage} /> : rows.map((r) => line(r))}
        {totals && rows.length > 0 ? line(totals, true) : null}
      </TableBody>
    </Table>
  );
}
