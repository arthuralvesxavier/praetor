import { FileCheck, Settings2 } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { ButtonLink } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FilterBar, FilterSelect } from "@/components/ui/filter-bar";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow, tableLinkClasses } from "@/components/ui/table";
import { LEGAL_REPORT_STATUS_LABELS, LEGAL_REPORT_STATUSES, LEGAL_REPORT_TYPE_LABELS, LEGAL_REPORT_TYPES } from "@/domain/enums";
import { formatDate, formatDateTime } from "@/lib/format";
import { optionsFromLabels } from "@/lib/options";
import { enumParam, hasAnyParam, pageParam } from "@/lib/search-params";
import { LegalReportStatusBadge, SampleBadge } from "@/modules/legal-reports/components/report-badges";
import { canGenerateLegalReport } from "@/modules/legal-reports/approvers";
import { EngineSampleForm } from "@/modules/legal-reports/components/sample-form";
import { listSampleProcessOptions } from "@/modules/legal-reports/sample";
import { listLegalReports } from "@/modules/legal-reports/service";
import { can } from "@/server/auth/permissions";
import { requirePageContext } from "@/server/auth/session";

export const metadata: Metadata = { title: "Relatórios jurídicos" };

const FILTER_KEYS = ["tipo", "situacao"] as const;

export default async function LegalReportsPage(props: PageProps<"/relatorios-juridicos">) {
  const ctx = await requirePageContext("report:read");
  const sp = await props.searchParams;
  const type = enumParam(sp, "tipo", LEGAL_REPORT_TYPES);
  const status = enumParam(sp, "situacao", LEGAL_REPORT_STATUSES);
  // Gerar consome numeração e cria versões: só quem gera relatórios do processo (perfis de leitura não geram).
  const canSample = can(ctx, "process:read") && canGenerateLegalReport(ctx, "process_report");
  const [result, processes] = await Promise.all([
    listLegalReports(ctx, { type, status, page: pageParam(sp) }),
    canSample ? listSampleProcessOptions(ctx) : Promise.resolve([]),
  ]);

  return (
    <>
      <PageHeader
        title="Relatórios jurídicos"
        description="Relatórios em PDF com origem declarada em cada afirmação, conferência automática das fontes, revisão e aprovação por pessoa identificada."
        breadcrumbs={[{ label: "Painel executivo", href: "/dashboard" }, { label: "Relatórios jurídicos" }]}
        actions={
          can(ctx, "admin:organization") ? (
            <ButtonLink href="/relatorios-juridicos/parametros" variant="outline">
              <Settings2 aria-hidden="true" />
              Parâmetros
            </ButtonLink>
          ) : null
        }
      />

      <Callout tone="info" className="mb-6" title="Fundação do módulo">
        Nesta etapa existe o motor de PDF e o modelo de dados. Os relatórios do processo, de provisão, da carteira e por responsável
        (R1 a R4) entram nas próximas etapas. O documento de teste abaixo usa dados reais de um processo para conferir o layout e as regras
        de origem; ele não é um relatório jurídico.
      </Callout>

      {canSample ? (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle as="h2">Documento de teste do motor</CardTitle>
            <CardDescription>
              Gera um PDF com capa, nota metodológica, itens de todas as origens, uma lacuna, pendências e uma tabela longa. Fica pendente
              de revisão, com marca d&apos;água, até a aprovação. Tem numeração própria (TESTE-R1-ano-número), sem consumir a numeração
              oficial dos relatórios. Como lista processos da carteira que você vê, o documento de teste só aparece para você e para
              administradores e gestores jurídicos.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <EngineSampleForm processes={processes} />
          </CardContent>
        </Card>
      ) : null}

      <FilterBar basePath="/relatorios-juridicos" search={false} showClear={hasAnyParam(sp, FILTER_KEYS)}>
        <FilterSelect name="tipo" label="Tipo" options={optionsFromLabels(LEGAL_REPORT_TYPE_LABELS)} defaultValue={type} />
        <FilterSelect name="situacao" label="Situação" options={optionsFromLabels(LEGAL_REPORT_STATUS_LABELS)} defaultValue={status} />
      </FilterBar>

      <Card className="py-0">
        <Table aria-label="Relatórios jurídicos">
          <TableHeader>
            <TableRow>
              <TableHead>Referência</TableHead>
              <TableHead>Tipo</TableHead>
              <TableHead>Escopo</TableHead>
              <TableHead>Situação</TableHead>
              <TableHead className="text-right">Versão</TableHead>
              <TableHead>Data-base</TableHead>
              <TableHead>Gerado em</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.items.length === 0 ? (
              <TableEmpty
                colSpan={7}
                message="Nenhum relatório jurídico encontrado."
                description={
                  hasAnyParam(sp, FILTER_KEYS)
                    ? "Ajuste ou limpe os filtros."
                    : "Gere um documento de teste do motor para ver o formato dos relatórios."
                }
              />
            ) : (
              result.items.map((r) => (
                <TableRow key={r.id} interactive>
                  <TableCell className="min-w-44">
                    <div className="flex flex-col gap-1">
                      <Link href={`/relatorios-juridicos/${r.id}`} className={tableLinkClasses}>
                        {r.reference}
                        <span className="sr-only">, versão {r.version}, abrir relatório</span>
                      </Link>
                      {r.isSample ? <SampleBadge /> : null}
                    </div>
                  </TableCell>
                  <TableCell className="min-w-44">{LEGAL_REPORT_TYPE_LABELS[r.type]}</TableCell>
                  <TableCell className="min-w-56">
                    <span className="block">{r.scopeLabel}</span>
                    <span className="block text-xs text-muted-foreground">{r.title}</span>
                  </TableCell>
                  <TableCell>
                    <LegalReportStatusBadge status={r.status} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{r.version}</TableCell>
                  <TableCell className="whitespace-nowrap">{formatDate(r.baseDate, r.baseDate)}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    {formatDateTime(r.generatedAt, "")}
                    <span className="block text-xs text-muted-foreground">{r.generatedByName ?? "Sistema"}</span>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>
      <Pagination page={result.page} pageSize={result.pageSize} total={result.total} basePath="/relatorios-juridicos" searchParams={sp} />
      <p className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
        <FileCheck aria-hidden="true" className="size-4" />
        Somente relatórios cujos processo e documentos citados você pode acessar aparecem nesta lista. Relatório aprovado não muda:
        uma correção gera nova versão com a mesma referência.
      </p>
    </>
  );
}
