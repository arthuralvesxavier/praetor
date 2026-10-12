import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
  tableLinkClasses,
} from "@/components/ui/table";
import { CLOSURE_REASON_LABELS, PROCESS_INSTANCE_LABELS, PROCESS_PHASE_LABELS, PROCESS_STATUS_LABELS } from "@/domain/enums";
import { formatDate, formatMoneyCents, pluralize } from "@/lib/format";
import { PROCESS_STATUS_TONES } from "@/lib/tones";
import type { ProcessListItem } from "../service";
import { cityWithState } from "../states";
import { CnjFormatFlag, ConfidentialBadge, ImportedBadge, VerificationBadge } from "./process-badges";

function Parties({ p }: { p: ProcessListItem }) {
  if (!p.plaintiffName && !p.defendantName) {
    return <span className="text-muted-foreground">Partes não cadastradas</span>;
  }
  const more = (n: number) => (n > 1 ? <span className="text-muted-foreground"> (+{n - 1})</span> : null);
  return (
    <span className="block">
      <span className="text-slate-900">{p.plaintiffName ?? "Autor não informado"}</span>
      {more(p.plaintiffCount)}
      <span aria-hidden="true" className="px-1 text-muted-foreground">
        ×
      </span>
      <span className="sr-only"> contra </span>
      <span className="text-slate-900">{p.defendantName ?? "Réu não informado"}</span>
      {more(p.defendantCount)}
    </span>
  );
}

/** Portfolio list table. Valor da causa and valor liquidado are separate columns (RN-02); null = "Não apurado" (RN-03). */
export function PortfolioTable({ items, emptyDescription }: { items: ProcessListItem[]; emptyDescription: string }) {
  return (
    <Table aria-label="Carteira de processos">
      <TableHeader>
        <TableRow>
          <TableHead>Processo (CNJ)</TableHead>
          <TableHead>Partes (autor × réu)</TableHead>
          <TableHead>Tribunal / instância</TableHead>
          <TableHead>Órgão / cidade</TableHead>
          <TableHead>Classe</TableHead>
          <TableHead>Fase</TableHead>
          <TableHead className="text-right">Valor da causa</TableHead>
          <TableHead className="text-right">Valor liquidado</TableHead>
          <TableHead>Responsável / escritório</TableHead>
          <TableHead>Sinalizações</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.length === 0 ? (
          <TableEmpty colSpan={10} message="Nenhum processo encontrado." description={emptyDescription} />
        ) : (
          items.map((p) => (
            <TableRow key={p.id} interactive>
              <TableCell className="min-w-52 align-top">
                <Link href={`/processos/${p.id}`} className={`${tableLinkClasses} font-mono text-xs whitespace-nowrap`}>
                  {p.number}
                </Link>
                <span className="mt-0.5 block max-w-64 truncate text-xs text-muted-foreground" title={p.title}>
                  {p.title}
                </span>
                {!p.isCnjFormat ? (
                  <span className="mt-1 block">
                    <CnjFormatFlag isCnjFormat={false} />
                  </span>
                ) : null}
              </TableCell>
              <TableCell className="min-w-60 align-top">
                <Parties p={p} />
                {p.companyName ? <span className="mt-0.5 block text-xs text-muted-foreground">{p.companyName}</span> : null}
              </TableCell>
              <TableCell className="align-top whitespace-nowrap">
                <span className="block">{p.court}</span>
                <span className="block text-xs text-muted-foreground">
                  {p.instance ? PROCESS_INSTANCE_LABELS[p.instance] : "Instância não informada"}
                </span>
              </TableCell>
              <TableCell className="min-w-40 align-top">
                <span className="block">{p.courtDivision ?? "—"}</span>
                <span className="block text-xs text-muted-foreground">{cityWithState(p.city, p.state) ?? "Cidade não informada"}</span>
              </TableCell>
              <TableCell className="align-top whitespace-nowrap">{p.processClass ?? "—"}</TableCell>
              <TableCell className="min-w-44 align-top">
                <span className="block">{PROCESS_PHASE_LABELS[p.phase]}</span>
                {p.phaseDetail ? (
                  <span className="block max-w-72 text-xs text-muted-foreground" title={p.phaseDetail}>
                    {p.phaseDetail.length > 90 ? `${p.phaseDetail.slice(0, 88)}…` : p.phaseDetail}
                  </span>
                ) : null}
              </TableCell>
              <TableCell className="text-right align-top whitespace-nowrap tabular-nums">
                {p.claimAmountCents === null ? (
                  <span className="text-muted-foreground">Não informado</span>
                ) : (
                  formatMoneyCents(p.claimAmountCents)
                )}
              </TableCell>
              <TableCell className="text-right align-top whitespace-nowrap tabular-nums">
                {p.liquidatedAmountCents === null ? (
                  <span className="text-muted-foreground">Não apurado</span>
                ) : (
                  formatMoneyCents(p.liquidatedAmountCents)
                )}
              </TableCell>
              <TableCell className="min-w-40 align-top">
                <span className="block">{p.responsibleName ?? "Sem responsável"}</span>
                {p.lawFirmName ? <span className="block text-xs text-muted-foreground">{p.lawFirmName}</span> : null}
              </TableCell>
              <TableCell className="min-w-40 align-top">
                <span className="flex flex-wrap gap-1">
                  {p.status !== "active" ? (
                    <StatusBadge
                      label={
                        p.closureReason
                          ? `${PROCESS_STATUS_LABELS[p.status]} · ${CLOSURE_REASON_LABELS[p.closureReason]}`
                          : PROCESS_STATUS_LABELS[p.status]
                      }
                      tone={PROCESS_STATUS_TONES[p.status]}
                    />
                  ) : null}
                  {p.isConfidential ? <ConfidentialBadge /> : null}
                  {p.needsVerification ? <VerificationBadge /> : null}
                  {p.dataOrigin === "imported" ? <ImportedBadge /> : null}
                  {p.openDeadlineCount > 0 ? (
                    <Badge tone="info" title={p.nextDeadlineDate ? `Próximo em ${formatDate(p.nextDeadlineDate)}` : undefined}>
                      {pluralize(p.openDeadlineCount, "prazo", "prazos")}
                    </Badge>
                  ) : null}
                </span>
              </TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}
