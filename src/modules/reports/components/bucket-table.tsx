import type { ReactNode } from "react";
import { formatMoneyCents, pluralize } from "@/lib/format";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { BucketRow } from "../types";
import { CountCell, EstimateMoneyCell, ExposureEstimateCell, MoneyGroupCell, NumCell, NumHead, ProvisionAmountCell } from "./report-cells";

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
      <TableCell className="min-w-36 max-w-72">
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
      <NumCell>{r.bucket.guaranteesCents ? formatMoneyCents(r.bucket.guaranteesCents) : <span className="text-muted-foreground">Sem garantias</span>}</NumCell>
      <MoneyGroupCell
        cents={r.bucket.exposureCents}
        count={r.bucket.count}
        unknown={r.bucket.liquidatedUnknown}
        unknownLabel="Não apurada"
        unknownSingular="sem valor apurado"
        unknownPlural="sem valor apurado"
        showUnknownCount={false}
      />
      <ExposureEstimateCell bucket={r.bucket} />
      <ProvisionAmountCell
        cents={r.bucket.provisionCents}
        basis={r.provisionBasis}
        liquidatedCount={r.bucket.count - r.bucket.liquidatedUnknown}
        emptyLabel={r.provisionBasis && r.provisionBasis.estimate === 0 ? "Não calculada" : undefined}
      />
      <EstimateMoneyCell
        cents={r.bucket.provisionEstimateCents}
        count={r.provisionBasis?.estimate}
        note={r.provisionBasis && r.provisionBasis.none > 0 ? pluralize(r.provisionBasis.none, "sem provisão", "sem provisão") : null}
      />
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
          <NumHead>Exposição apurada</NumHead>
          <NumHead>Exposição estimada</NumHead>
          <NumHead>Provisão</NumHead>
          <NumHead>Provisão estimada</NumHead>
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
