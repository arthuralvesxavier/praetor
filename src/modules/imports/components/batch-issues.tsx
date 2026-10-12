import { Download } from "lucide-react";
import Link from "next/link";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FilterBar, FilterSelect } from "@/components/ui/filter-bar";
import { Pagination } from "@/components/ui/pagination";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow, tableLinkClasses } from "@/components/ui/table";
import { ISSUE_LEVEL_LABELS, ISSUE_LEVELS } from "@/domain/enums";
import { optionsFromLabels } from "@/lib/options";
import { buildHref, enumParam, hasAnyParam, pageParam, param, type SearchParams } from "@/lib/search-params";
import type { AuthContext } from "@/server/auth/context";
import { issueCodeLabel } from "../labels";
import { listImportIssues, type ImportBatchDetail } from "../service";
import { IssueLevelBadge } from "./badges";

export async function BatchIssues({ ctx, batch, sp }: { ctx: AuthContext; batch: ImportBatchDetail; sp: SearchParams }) {
  const base = `/importacoes/${batch.id}`;
  const sheetParam = param(sp, "planilha");
  const sheet = sheetParam && batch.dataSheets.includes(sheetParam) ? sheetParam : undefined;
  const level = enumParam(sp, "nivel", ISSUE_LEVELS);
  const codes = [...new Set(batch.issueSummary.map((i) => i.code))];
  const codeParam = param(sp, "codigo");
  const code = codeParam && codes.includes(codeParam) ? codeParam : undefined;
  const result = await listImportIssues(ctx, batch.id, { sheet, level, code, page: pageParam(sp) });
  const filtered = hasAnyParam(sp, ["planilha", "nivel", "codigo"]);
  const csvHref = buildHref(`/api/imports/${batch.id}/issues`, {}, { planilha: sheet, nivel: level, codigo: code });
  const committed = batch.status === "committed";

  return (
    <>
      <FilterBar basePath={base} search={false} hiddenFields={{ aba: "inconsistencias" }} showClear={filtered}>
        <FilterSelect
          name="planilha"
          label="Aba"
          options={batch.dataSheets.map((s) => ({ value: s, label: s }))}
          defaultValue={sheet}
          placeholder="Todas"
        />
        <FilterSelect name="nivel" label="Nível" options={optionsFromLabels(ISSUE_LEVEL_LABELS)} defaultValue={level} placeholder="Todos" />
        <FilterSelect
          name="codigo"
          label="Tipo"
          options={codes.map((c) => ({ value: c, label: issueCodeLabel(c) })).sort((a, b) => a.label.localeCompare(b.label, "pt-BR"))}
          defaultValue={code}
          placeholder="Todos"
        />
      </FilterBar>

      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Uma linha por ocorrência. Erros impedem a importação da linha; alertas pedem conferência; informações registram decisões automáticas.
        </p>
        {/* `download`: a plain browser download (next/link would fetch the route twice and audit the export twice). */}
        <ButtonLink href={csvHref} variant="outline" size="sm" prefetch={false} download>
          <Download aria-hidden="true" />
          Exportar CSV
        </ButtonLink>
      </div>

      <Card className="py-0">
        <Table aria-label="Inconsistências da importação">
          <TableHeader>
            <TableRow>
              <TableHead>Aba · linha</TableHead>
              <TableHead>Nº do processo</TableHead>
              <TableHead>Nível</TableHead>
              <TableHead>Tipo</TableHead>
              <TableHead>Campo</TableHead>
              <TableHead>Descrição</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.items.length === 0 ? (
              <TableEmpty
                colSpan={6}
                message={filtered ? "Nenhuma ocorrência com esses filtros." : "Nenhuma inconsistência encontrada."}
                description={filtered ? "Ajuste ou limpe os filtros." : "Todas as linhas foram lidas sem ressalvas."}
              />
            ) : (
              result.items.map((i, idx) => (
                <TableRow key={`${i.rowId}-${idx}`}>
                  <TableCell className="whitespace-nowrap">
                    <span className="text-slate-600">{i.sheet}</span> · <span className="font-medium">{i.rowNumber}</span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {i.cnj ? (
                      committed && i.processId ? (
                        <Link href={`/processos/${i.processId}`} className={tableLinkClasses}>
                          {i.cnj}
                        </Link>
                      ) : (
                        i.cnj
                      )
                    ) : (
                      <span className="text-muted-foreground">Sem número</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <IssueLevelBadge level={i.level} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{issueCodeLabel(i.code)}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{i.field ?? "Não se aplica"}</TableCell>
                  <TableCell className="min-w-72 text-sm">{i.message}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>
      <Pagination page={result.page} pageSize={result.pageSize} total={result.total} basePath={base} searchParams={sp} />
    </>
  );
}
