import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { FilterBar, FilterSelect } from "@/components/ui/filter-bar";
import { Pagination } from "@/components/ui/pagination";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow, tableLinkClasses } from "@/components/ui/table";
import {
  IMPORT_ROW_ACTION_LABELS,
  IMPORT_ROW_ACTIONS,
  ISSUE_LEVEL_LABELS,
  ISSUE_LEVELS,
  PROCESS_INSTANCE_LABELS,
} from "@/domain/enums";
import { formatMoneyCents, truncate } from "@/lib/format";
import { optionsFromLabels } from "@/lib/options";
import { enumParam, hasAnyParam, pageParam, param, type SearchParams } from "@/lib/search-params";
import type { AuthContext } from "@/server/auth/context";
import { listImportRows, type ImportBatchDetail } from "../service";
import { IssueCounts, RowActionBadge } from "./badges";

export async function BatchRows({ ctx, batch, sp }: { ctx: AuthContext; batch: ImportBatchDetail; sp: SearchParams }) {
  const base = `/importacoes/${batch.id}`;
  const sheetParam = param(sp, "planilha");
  const sheet = sheetParam && batch.dataSheets.includes(sheetParam) ? sheetParam : undefined;
  const action = enumParam(sp, "acao", IMPORT_ROW_ACTIONS);
  const level = enumParam(sp, "nivel", ISSUE_LEVELS);
  const result = await listImportRows(ctx, batch.id, { sheet, action, level, page: pageParam(sp) });
  const filtered = hasAnyParam(sp, ["planilha", "acao", "nivel"]);
  const committed = batch.status === "committed";

  return (
    <>
      <FilterBar basePath={base} search={false} hiddenFields={{ aba: "linhas" }} showClear={filtered}>
        <FilterSelect
          name="planilha"
          label="Aba"
          options={batch.dataSheets.map((s) => ({ value: s, label: s }))}
          defaultValue={sheet}
          placeholder="Todas"
        />
        <FilterSelect name="acao" label="Ação" options={optionsFromLabels(IMPORT_ROW_ACTION_LABELS)} defaultValue={action} placeholder="Todas" />
        <FilterSelect name="nivel" label="Ocorrência" options={optionsFromLabels(ISSUE_LEVEL_LABELS)} defaultValue={level} placeholder="Todas" />
      </FilterBar>

      <Card className="py-0">
        <Table aria-label="Linhas da planilha">
          <TableHeader>
            <TableRow>
              <TableHead>Aba · linha</TableHead>
              <TableHead>Nº do processo</TableHead>
              <TableHead>Instância</TableHead>
              <TableHead>Tribunal</TableHead>
              <TableHead>Fase (como na planilha)</TableHead>
              <TableHead className="text-right">Valor da causa</TableHead>
              <TableHead className="text-right">Valor liquidado</TableHead>
              <TableHead>Ação</TableHead>
              <TableHead>Ocorrências</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.items.length === 0 ? (
              <TableEmpty
                colSpan={9}
                message={filtered ? "Nenhuma linha com esses filtros." : "Nenhuma linha lida."}
                description={filtered ? "Ajuste ou limpe os filtros." : undefined}
              />
            ) : (
              result.items.map((r) => {
                const isData = r.kind === "data" && r.action !== "error";
                return (
                  <TableRow key={r.id}>
                    <TableCell className="whitespace-nowrap">
                      <span className="text-slate-600">{r.sheet}</span> · <span className="font-medium">{r.rowNumber}</span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {r.cnj ? (
                        committed && r.processId ? (
                          <Link href={`/processos/${r.processId}`} className={tableLinkClasses}>
                            {r.cnj}
                          </Link>
                        ) : (
                          <span className="font-medium">{r.cnj}</span>
                        )
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                      {r.cnj && !r.cnjValid && r.action !== "error" ? (
                        <Badge tone="warning" className="ml-2">
                          DV não confere
                        </Badge>
                      ) : null}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{r.instance ? PROCESS_INSTANCE_LABELS[r.instance] : "—"}</TableCell>
                    <TableCell>{r.court ?? "—"}</TableCell>
                    <TableCell className="min-w-48 text-sm" title={r.phaseDetail ?? undefined}>
                      {r.phaseDetail ? truncate(r.phaseDetail, 70) : "—"}
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      {isData ? formatMoneyCents(r.claimAmountCents, "Não informado") : "—"}
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      {isData && r.hasLiquidatedColumn ? (
                        formatMoneyCents(r.liquidatedAmountCents, "Não apurado")
                      ) : (
                        <span className="text-muted-foreground" title={isData ? "A aba não tem a coluna de valor liquidado" : undefined}>
                          —
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <RowActionBadge action={r.action} />
                    </TableCell>
                    <TableCell>
                      <IssueCounts issues={r.issues} />
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
