import { Calculator, FlaskConical, Lightbulb } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatMoneyCents, formatNumber, formatPercent, pluralize } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { GroupStat, IndicatorBasis } from "../types";

/** Label of every computed indicator (MODULE_CONTRACTS "Simulation labeling"). */
export function ComputedBadge() {
  return (
    <Badge tone="primary" icon={<Calculator />}>
      Calculado a partir da carteira
    </Badge>
  );
}

export function DemoDocumentsBadge() {
  return (
    <Badge tone="warning" icon={<FlaskConical />}>
      Documentos fictícios de demonstração
    </Badge>
  );
}

export function IllustrativeBadge() {
  return (
    <Badge tone="warning" icon={<Lightbulb />}>
      Sugestão ilustrativa — avaliar com a área responsável
    </Badge>
  );
}

export function BasisNote({ basis }: { basis: IndicatorBasis }) {
  return (
    <p className="mt-3 border-t border-border pt-2 text-xs text-muted-foreground">
      <span className="font-medium text-slate-600">Base:</span> {basis.formula}{" "}
      <span className="whitespace-nowrap">
        · {basis.population}: {pluralize(basis.processCount, "processo considerado", "processos considerados")}.
      </span>
    </p>
  );
}

export function IndicatorCard({
  title,
  basis,
  children,
  className,
  headline,
}: {
  title: string;
  basis: IndicatorBasis;
  children: ReactNode;
  className?: string;
  /** Main computed value shown under the title. */
  headline?: ReactNode;
}) {
  return (
    <Card className={cn("py-4", className)}>
      <CardHeader actions={<ComputedBadge />}>
        <CardTitle as="h3">{title}</CardTitle>
        {headline ? <p className="text-2xl font-semibold tracking-tight text-slate-900 tabular-nums">{headline}</p> : null}
      </CardHeader>
      <CardContent>
        {children}
        <BasisNote basis={basis} />
      </CardContent>
    </Card>
  );
}

/** Horizontal share bar with the percentage written next to it (never color alone). */
export function ShareBar({ share, label }: { share: number; label: string }) {
  const width = Math.max(0, Math.min(100, share * 100));
  return (
    <span className="flex items-center gap-2" title={`${label}: ${formatPercent(share, 1)}`}>
      <span aria-hidden="true" className="h-2 w-20 shrink-0 overflow-hidden rounded-full bg-slate-100 sm:w-28">
        <span className="block h-full rounded-full bg-primary-600" style={{ width: `${width}%` }} />
      </span>
      <span className="w-12 text-right text-xs tabular-nums text-slate-700">{formatPercent(share, 1)}</span>
    </span>
  );
}

function MoneySummary({ cents, count, unknown, unknownLabel }: { cents: number; count: number; unknown: number; unknownLabel: string }) {
  if (count > 0 && unknown >= count) return <span className="text-muted-foreground">{unknownLabel}</span>;
  return (
    <>
      {formatMoneyCents(cents)}
      {unknown > 0 ? <span className="block text-xs text-muted-foreground">+ {formatNumber(unknown)} {unknownLabel.toLowerCase()}</span> : null}
    </>
  );
}

/** Groups with count, share and causa × liquidado side by side (RN-02 / RN-03). */
export function GroupStatTable({
  label,
  header,
  rows,
  showMoney = true,
  emptyMessage = "Nenhum processo considerado.",
}: {
  label: string;
  header: string;
  rows: GroupStat[];
  showMoney?: boolean;
  emptyMessage?: string;
}) {
  return (
    <div className="-mx-5">
      <Table aria-label={label}>
        <TableHeader>
          <TableRow>
            <TableHead>{header}</TableHead>
            <TableHead className="text-right">Processos</TableHead>
            <TableHead>Participação</TableHead>
            {showMoney ? <TableHead className="text-right">Valor da causa</TableHead> : null}
            {showMoney ? <TableHead className="text-right">Valor liquidado</TableHead> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableEmpty colSpan={showMoney ? 5 : 3} message={emptyMessage} />
          ) : (
            rows.map((r) => (
              <TableRow key={r.key}>
                <TableCell className="max-w-64 min-w-36">
                  <span className="line-clamp-2" title={r.label}>
                    {r.label}
                  </span>
                </TableCell>
                <TableCell className="text-right tabular-nums">{formatNumber(r.count)}</TableCell>
                <TableCell>
                  <ShareBar share={r.share} label={r.label} />
                </TableCell>
                {showMoney ? (
                  <TableCell className="whitespace-nowrap text-right tabular-nums">
                    <MoneySummary cents={r.claimCents} count={r.count} unknown={r.claimUnknown} unknownLabel="Sem valor da causa" />
                  </TableCell>
                ) : null}
                {showMoney ? (
                  <TableCell className="whitespace-nowrap text-right tabular-nums">
                    <MoneySummary cents={r.liquidatedCents} count={r.count} unknown={r.liquidatedUnknown} unknownLabel="Não apurado" />
                  </TableCell>
                ) : null}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}

export function SectionHeading({
  id,
  badge,
  title,
  description,
}: {
  id: string;
  badge: ReactNode;
  title: string;
  description: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div>{badge}</div>
      <h2 id={id} className="text-lg font-semibold text-slate-900">
        {title}
      </h2>
      <p className="max-w-4xl text-sm text-muted-foreground">{description}</p>
    </div>
  );
}
