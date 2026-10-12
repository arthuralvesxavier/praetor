import { FlaskConical, Inbox, Plus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Button, ButtonLink } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FilterBar, FilterSelect } from "@/components/ui/filter-bar";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow, tableLinkClasses } from "@/components/ui/table";
import { ASSIGNMENT_METHOD_LABELS, INTAKE_SOURCE_LABELS, INTAKE_SOURCES } from "@/domain/enums";
import { formatDateTime } from "@/lib/format";
import { optionsFromLabels } from "@/lib/options";
import { enumParam, hasAnyParam, pageParam, param } from "@/lib/search-params";
import { simulateIntakeAction } from "@/modules/intake/actions";
import { IntakeSourceBadge, IntakeStatusBadge } from "@/modules/intake/components/intake-badges";
import { PipelineStrip } from "@/modules/intake/components/pipeline-strip";
import { getIntakeStatusCounts, listIntakes } from "@/modules/intake/service";
import { EFFECTIVE_INTAKE_STATUSES } from "@/modules/intake/status";
import { requirePageContext } from "@/server/auth/session";

export const metadata: Metadata = { title: "Entrada de processos" };

const FILTER_KEYS = ["q", "status", "origem"] as const;

export default async function IntakeListPage(props: PageProps<"/entrada">) {
  const ctx = await requirePageContext("intake:manage");
  const sp = await props.searchParams;
  const status = enumParam(sp, "status", EFFECTIVE_INTAKE_STATUSES);
  const source = enumParam(sp, "origem", INTAKE_SOURCES);
  const q = param(sp, "q");

  const [result, counts] = await Promise.all([
    listIntakes(ctx, { status, source, q, page: pageParam(sp) }),
    getIntakeStatusCounts(ctx),
  ]);
  const filtered = hasAnyParam(sp, FILTER_KEYS);

  const simulate = ctx.isDemoOrganization ? (
    <ConfirmDialog
      action={simulateIntakeAction}
      tone="primary"
      trigger={
        <Button type="button">
          <FlaskConical aria-hidden="true" />
          Simular chegada de processo (demonstração)
        </Button>
      }
      title="Simular a chegada de um processo?"
      description="Será criado um processo trabalhista FICTÍCIO (número CNJ, partes e valores inventados, coerentes com a carteira) com documentos fictícios. Em seguida ele é distribuído, os documentos são lidos e a análise preliminar é gerada por simulação, e o advogado recebe um e-mail simulado (nada é enviado)."
      confirmLabel="Simular chegada"
      pendingLabel="Gerando processo fictício…"
    />
  ) : null;

  return (
    <>
      <PageHeader
        title="Entrada de processos"
        description="Chegada de processos novos: distribuição ao responsável, leitura dos documentos e análise preliminar (simulação) e aviso ao advogado por e-mail (simulado)."
        breadcrumbs={[{ label: "Painel executivo", href: "/dashboard" }, { label: "Entrada de processos" }]}
        actions={
          <>
            {simulate}
            <ButtonLink href="/entrada/nova" variant={simulate ? "outline" : "primary"}>
              <Plus aria-hidden="true" />
              Registrar processo recebido
            </ButtonLink>
          </>
        }
      />

      <Callout tone="info" title="Simulação nesta versão" className="mb-4">
        A leitura dos documentos e a análise preliminar são feitas por uma simulação (regras determinísticas, sem
        inteligência artificial real) e o e-mail ao advogado é simulado: nenhuma mensagem é enviada. Não há integração
        com tribunais (DataJud, MNI, PJe): os processos chegam por cadastro, importação ou pela chegada simulada.
      </Callout>

      <PipelineStrip counts={counts} active={status} sp={sp} />

      <FilterBar
        basePath="/entrada"
        defaultQuery={q}
        searchPlaceholder="Número CNJ ou título"
        hiddenFields={{ status }}
        showClear={filtered}
      >
        <FilterSelect name="origem" label="Origem" options={optionsFromLabels(INTAKE_SOURCE_LABELS)} defaultValue={source} />
      </FilterBar>

      <Card className="py-0">
        <Table aria-label="Entradas de processos">
          <TableHeader>
            <TableRow>
              <TableHead>Recebido em</TableHead>
              <TableHead>Processo</TableHead>
              <TableHead>Origem</TableHead>
              <TableHead>Responsável</TableHead>
              <TableHead>Situação</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.items.length === 0 ? (
              <TableEmpty
                colSpan={5}
                message={filtered ? "Nenhuma entrada encontrada com esses filtros." : "Nenhum processo recebido ainda."}
                description={
                  filtered
                    ? "Ajuste ou limpe os filtros para ver outras entradas."
                    : "Registre um processo recebido ou, no ambiente de demonstração, simule uma chegada."
                }
                action={
                  filtered ? undefined : (
                    <ButtonLink href="/entrada/nova" size="sm">
                      <Inbox aria-hidden="true" />
                      Registrar processo recebido
                    </ButtonLink>
                  )
                }
              />
            ) : (
              result.items.map((i) => (
                <TableRow key={i.id} interactive>
                  <TableCell className="whitespace-nowrap text-sm tabular-nums">{formatDateTime(i.receivedAt)}</TableCell>
                  <TableCell className="min-w-64">
                    <Link href={`/entrada/${i.id}`} className={`${tableLinkClasses} font-mono text-[13px]`}>
                      {i.processNumber}
                    </Link>
                    <span className="block text-sm text-slate-700">{i.processTitle}</span>
                    <span className="block text-xs text-muted-foreground">
                      {[i.court, [i.city, i.state].filter(Boolean).join("/")].filter(Boolean).join(" · ")}
                    </span>
                  </TableCell>
                  <TableCell>
                    <IntakeSourceBadge source={i.source} />
                  </TableCell>
                  <TableCell className="min-w-40 text-sm">
                    {i.assignedToName ? (
                      <>
                        <span className="block text-slate-900">{i.assignedToName}</span>
                        {i.assignmentMethod ? (
                          <span className="block text-xs text-muted-foreground">{ASSIGNMENT_METHOD_LABELS[i.assignmentMethod]}</span>
                        ) : null}
                      </>
                    ) : (
                      <span className="text-muted-foreground">Aguardando distribuição</span>
                    )}
                  </TableCell>
                  <TableCell className="min-w-44">
                    <IntakeStatusBadge status={i.effectiveStatus} />
                    {i.effectiveStatus === "failed" && i.errorMessage ? (
                      <span className="mt-1 block max-w-xs text-xs text-red-800">{i.errorMessage}</span>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      <Pagination page={result.page} pageSize={result.pageSize} total={result.total} basePath="/entrada" searchParams={sp} />
    </>
  );
}
