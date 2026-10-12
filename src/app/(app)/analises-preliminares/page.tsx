import { CircleAlert, ClipboardCheck, FileSearch, LoaderCircle, PenLine } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Callout } from "@/components/ui/callout";
import { Card } from "@/components/ui/card";
import { FilterBar, FilterSelect } from "@/components/ui/filter-bar";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { StatCard } from "@/components/ui/stat-card";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow, tableLinkClasses } from "@/components/ui/table";
import { CASE_BRIEF_STATUSES, CASE_BRIEF_STATUS_LABELS } from "@/domain/enums";
import { formatDateTime, formatNumber, truncate } from "@/lib/format";
import { optionsFromLabels } from "@/lib/options";
import { buildHref, enumParam, hasAnyParam, idParam, pageParam } from "@/lib/search-params";
import { listUserOptions } from "@/modules/admin/service";
import { BriefStatusBadge, SimulationBadge } from "@/modules/briefs/components/brief-badges";
import { countCaseBriefsByStatus, listCaseBriefs } from "@/modules/briefs/service";
import { requirePageContext } from "@/server/auth/session";

export const metadata: Metadata = { title: "Análises preliminares" };

const FILTER_KEYS = ["status", "responsavel"] as const;

export default async function CaseBriefQueuePage(props: PageProps<"/analises-preliminares">) {
  const ctx = await requirePageContext("brief:read");
  const sp = await props.searchParams;
  const status = enumParam(sp, "status", CASE_BRIEF_STATUSES);
  const responsibleId = idParam(sp, "responsavel");

  const [result, counts, users] = await Promise.all([
    listCaseBriefs(ctx, { status, responsibleId, page: pageParam(sp) }),
    countCaseBriefsByStatus(ctx),
    listUserOptions(ctx),
  ]);
  const userOptions = users.map((u) => ({ value: u.id, label: u.name }));
  const statusHref = (s: string) => buildHref("/analises-preliminares", sp, { status: s, pagina: null });

  return (
    <>
      <PageHeader
        title="Análises preliminares"
        description="Fila de revisão das análises preliminares dos processos recebidos: conferir, editar e aprovar."
        breadcrumbs={[{ label: "Painel executivo", href: "/dashboard" }, { label: "Análises preliminares" }]}
      />

      <Callout tone="warning" className="mb-6" title="Simulação nesta versão">
        As análises preliminares são geradas por uma simulação com regras determinísticas, sem inteligência artificial real,
        a partir do cadastro e dos documentos (fictícios) dos processos. Tudo precisa da revisão do advogado responsável.
      </Callout>

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Prontas para revisão"
          value={formatNumber(counts.ready_for_review)}
          tone="warning"
          icon={<ClipboardCheck />}
          href={statusHref("ready_for_review")}
        />
        <StatCard
          label="Em revisão (editadas)"
          value={formatNumber(counts.in_review)}
          tone="primary"
          icon={<PenLine />}
          href={statusHref("in_review")}
        />
        <StatCard
          label="Em processamento"
          value={formatNumber(counts.generating)}
          tone="info"
          icon={<LoaderCircle />}
          href={statusHref("generating")}
        />
        <StatCard label="Falharam" value={formatNumber(counts.failed)} tone="danger" icon={<CircleAlert />} href={statusHref("failed")} />
      </div>

      <FilterBar basePath="/analises-preliminares" search={false} showClear={hasAnyParam(sp, FILTER_KEYS)}>
        <FilterSelect
          name="status"
          label="Situação"
          options={optionsFromLabels(CASE_BRIEF_STATUS_LABELS)}
          defaultValue={status}
        />
        <FilterSelect name="responsavel" label="Responsável pelo processo" options={userOptions} defaultValue={responsibleId} />
      </FilterBar>

      <Card className="py-0">
        <Table aria-label="Análises preliminares">
          <TableHeader>
            <TableRow>
              <TableHead>Processo</TableHead>
              <TableHead>Situação</TableHead>
              <TableHead>Responsável</TableHead>
              <TableHead className="text-right">Contradições</TableHead>
              <TableHead className="text-right">Doc. faltantes</TableHead>
              <TableHead className="text-right">Urgências</TableHead>
              <TableHead>Gerada em</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.items.length === 0 ? (
              <TableEmpty
                colSpan={7}
                message="Nenhuma análise preliminar encontrada."
                description={
                  hasAnyParam(sp, FILTER_KEYS)
                    ? "Ajuste ou limpe os filtros."
                    : "As análises aparecem aqui quando um processo é recebido ou quando alguém as solicita na aba “Análise preliminar” do processo."
                }
              />
            ) : (
              result.items.map((b) => (
                <TableRow key={b.id} interactive>
                  <TableCell className="min-w-56">
                    <div className="flex flex-col gap-1">
                      <Link href={`/analises-preliminares/${b.id}`} className={tableLinkClasses}>
                        {b.processNumber}
                        <span className="sr-only">, abrir análise preliminar versão {b.version}</span>
                      </Link>
                      <span className="text-xs text-muted-foreground">{truncate(b.processTitle, 80)}</span>
                      <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                        Versão {b.version}
                        {b.currentRevision > 1 ? ` · revisão ${b.currentRevision}` : ""}
                        <SimulationBadge mode={b.mode} />
                        {b.isStale ? <span className="font-medium text-amber-800">· possivelmente desatualizada</span> : null}
                        {b.superseded ? <span className="font-medium">· substituída por versão mais recente</span> : null}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <BriefStatusBadge status={b.status} />
                  </TableCell>
                  <TableCell className="min-w-36">{b.responsibleName ?? <span className="text-muted-foreground">Sem responsável</span>}</TableCell>
                  <TableCell className="text-right tabular-nums">{b.counts ? b.counts.contradictions : <span className="text-muted-foreground">Sem dados</span>}</TableCell>
                  <TableCell className="text-right tabular-nums">{b.counts ? b.counts.missingDocuments : <span className="text-muted-foreground">Sem dados</span>}</TableCell>
                  <TableCell className="text-right tabular-nums">{b.counts ? b.counts.urgencies : <span className="text-muted-foreground">Sem dados</span>}</TableCell>
                  <TableCell className="whitespace-nowrap">{b.generatedAt ? formatDateTime(b.generatedAt) : formatDateTime(b.createdAt)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>
      <Pagination page={result.page} pageSize={result.pageSize} total={result.total} basePath="/analises-preliminares" searchParams={sp} />
      <p className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
        <FileSearch aria-hidden="true" className="size-4" />
        Somente análises cujos processo e documentos de origem você pode acessar aparecem nesta lista. Versões substituídas por
        uma mais recente não entram nas contagens de revisão.
      </p>
    </>
  );
}
