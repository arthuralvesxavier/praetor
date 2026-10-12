import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Callout } from "@/components/ui/callout";
import { Card } from "@/components/ui/card";
import { Pagination } from "@/components/ui/pagination";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow, tableLinkClasses } from "@/components/ui/table";
import { PROCESS_INSTANCE_LABELS } from "@/domain/enums";
import { formatMoneyCents, truncate } from "@/lib/format";
import { pageParam, type SearchParams } from "@/lib/search-params";
import type { AuthContext } from "@/server/auth/context";
import { can } from "@/server/auth/permissions";
import { DIVERGENCE_FIELD_LABELS } from "../labels";
import { listImportDivergences, type ImportBatchDetail } from "../service";

function sideValue(field: string, value: string | number | null): string {
  if (field === "claimAmount") return formatMoneyCents(typeof value === "number" ? value : null, "Não informado");
  if (field === "liquidatedAmount") return formatMoneyCents(typeof value === "number" ? value : null, "Não apurado");
  return value === null || value === "" ? "Vazio" : truncate(String(value), 80);
}

export async function BatchDivergences({ ctx, batch, sp }: { ctx: AuthContext; batch: ImportBatchDetail; sp: SearchParams }) {
  const base = `/importacoes/${batch.id}`;
  const result = await listImportDivergences(ctx, batch.id, { page: pageParam(sp) });
  const committed = batch.status === "committed";
  const canReview = can(ctx, "contingency:read");

  return (
    <>
      <Callout tone="info" title="A aba consolidada é a base oficial" className="mb-4">
        Para o mesmo número e instância, os valores da aba consolidada são os oficiais. Valores monetários diferentes informados em
        outras abas {committed ? "foram registrados" : "serão registrados"} como <strong>valores propostos</strong>, aguardando conferência
        humana — nunca sobrescrevem o valor oficial. Divergências de fase, tribunal e órgão ficam neste relatório para conferência.
        {committed && canReview ? (
          <>
            {" "}
            <Link href="/contingencias/revisao?origem=spreadsheet">Ir para a conferência de valores</Link>.
          </>
        ) : null}
      </Callout>

      <Card className="py-0">
        <Table aria-label="Divergências entre abas">
          <TableHeader>
            <TableRow>
              <TableHead>Nº do processo</TableHead>
              <TableHead>Instância</TableHead>
              <TableHead>Campo</TableHead>
              <TableHead>Base oficial</TableHead>
              <TableHead>Outra aba</TableHead>
              <TableHead>Registro</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.items.length === 0 ? (
              <TableEmpty colSpan={6} message="Nenhuma divergência entre abas." description="As abas por instância conferem com a aba consolidada." />
            ) : (
              result.items.map((d, idx) => {
                const money = d.field === "claimAmount" || d.field === "liquidatedAmount";
                return (
                  <TableRow key={`${d.rowId}-${idx}`}>
                    <TableCell className="whitespace-nowrap">
                      {committed && d.processId ? (
                        <Link href={`/processos/${d.processId}`} className={tableLinkClasses}>
                          {d.cnj}
                        </Link>
                      ) : (
                        <span className="font-medium">{d.cnj}</span>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{PROCESS_INSTANCE_LABELS[d.instance]}</TableCell>
                    <TableCell className="whitespace-nowrap">{DIVERGENCE_FIELD_LABELS[d.field] ?? d.field}</TableCell>
                    <TableCell className={money ? "text-right whitespace-nowrap" : "min-w-40 text-sm"}>
                      <span className="block font-medium">{sideValue(d.field, d.base.value)}</span>
                      <span className="block text-xs text-muted-foreground">
                        {d.base.sheet} · linha {d.base.row}
                      </span>
                    </TableCell>
                    <TableCell className={money ? "text-right whitespace-nowrap" : "min-w-40 text-sm"}>
                      <span className="block font-medium">{sideValue(d.field, d.other.value)}</span>
                      <span className="block text-xs text-muted-foreground">
                        {d.other.sheet} · linha {d.other.row}
                      </span>
                    </TableCell>
                    <TableCell>
                      {d.valuation === "proposed" ? (
                        <Badge tone="warning" dot>
                          {committed ? "Valor proposto para conferência" : "Será proposto para conferência"}
                        </Badge>
                      ) : d.valuation === "existing" ? (
                        <Badge tone="info" dot>
                          Já registrado no processo
                        </Badge>
                      ) : (
                        <Badge tone="neutral" dot>
                          Somente no relatório
                        </Badge>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </Card>
      <Pagination page={result.page} pageSize={result.pageSize} total={result.total} basePath={base} searchParams={sp} />
    </>
  );
}
