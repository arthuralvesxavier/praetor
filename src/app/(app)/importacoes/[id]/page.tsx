import { Download } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ButtonLink } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { PageHeader } from "@/components/ui/page-header";
import { LinkTabs } from "@/components/ui/tabs";
import { formatDateTime, formatNumber, pluralize } from "@/lib/format";
import { buildHref, flagParam, param } from "@/lib/search-params";
import { CommitImportButton, RollbackImportButton } from "@/modules/imports/components/batch-actions";
import { BatchDivergences } from "@/modules/imports/components/batch-divergences";
import { BatchIssues } from "@/modules/imports/components/batch-issues";
import { BatchRows } from "@/modules/imports/components/batch-rows";
import { BatchSummary } from "@/modules/imports/components/batch-summary";
import { BatchStatusBadge } from "@/modules/imports/components/badges";
import { getImportBatch, getRollbackBlockers, type ImportBatchDetail, type RollbackBlocker } from "@/modules/imports/service";
import { requirePageContext } from "@/server/auth/session";
import { NotFoundError } from "@/server/lib/errors";

export const metadata: Metadata = { title: "Importação de planilha" };

const TABS = ["resumo", "linhas", "inconsistencias", "divergencias"] as const;
type TabKey = (typeof TABS)[number];

export default async function ImportBatchPage(props: PageProps<"/importacoes/[id]">) {
  const ctx = await requirePageContext("import:run");
  const { id } = await props.params;
  const sp = await props.searchParams;

  let batch: ImportBatchDetail;
  try {
    batch = await getImportBatch(ctx, id);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
  const blockers: RollbackBlocker[] = batch.status === "committed" ? await getRollbackBlockers(ctx, batch.id) : [];

  const requested = param(sp, "aba");
  const active: TabKey = (TABS as readonly string[]).includes(requested ?? "") ? (requested as TabKey) : "resumo";
  const base = `/importacoes/${batch.id}`;
  const s = batch.stats;
  const clientNotFound = batch.issueSummary.some((i) => i.code === "client_not_found");
  const otherSameFile = batch.sameFileBatches.filter((b) => b.status === "committed");

  return (
    <>
      <PageHeader
        title={<span className="break-all">{batch.fileName}</span>}
        description={`${batch.companyName ?? "Empresa não informada"} · enviada por ${batch.createdByName ?? "—"} em ${formatDateTime(batch.createdAt)}`}
        breadcrumbs={[
          { label: "Painel executivo", href: "/dashboard" },
          { label: "Importação de planilhas", href: "/importacoes" },
          { label: batch.fileName },
        ]}
        meta={<BatchStatusBadge status={batch.status} />}
        actions={
          <>
            {batch.hasStoredFile ? (
              <ButtonLink href={`/api/imports/${batch.id}/file`} variant="outline" prefetch={false}>
                <Download aria-hidden="true" />
                Planilha original
              </ButtonLink>
            ) : null}
            {batch.status === "committed" && blockers.length === 0 ? <RollbackImportButton batch={batch} /> : null}
            {batch.status === "analyzed" ? <CommitImportButton batch={batch} /> : null}
          </>
        }
      />

      <div className="mb-6 flex flex-col gap-3">
        {flagParam(sp, "confirmado") && batch.status === "committed" && s ? (
          <Callout tone="success" title="Importação confirmada" role="status">
            {pluralize(s.toCreate, "processo criado", "processos criados")}, {pluralize(s.toUpdate, "atualizado", "atualizados")} e{" "}
            {pluralize(s.unchanged, "sem alteração", "sem alteração")}. Os processos já aparecem na{" "}
            <Link href="/processos">carteira</Link>.
          </Callout>
        ) : null}
        {flagParam(sp, "desfeito") && batch.status === "rolled_back" ? (
          <Callout tone="success" title="Importação desfeita" role="status">
            Os processos criados por esta importação foram removidos da carteira e os atualizados voltaram ao estado anterior.
          </Callout>
        ) : null}
        {batch.status === "analyzed" ? (
          <Callout tone="info" title="Análise concluída — nada foi gravado na carteira ainda">
            Confira o resumo, as inconsistências e as divergências. Ao confirmar, a situação da base é conferida de novo e os processos são
            gravados numa única operação.{" "}
            {s && s.errors > 0
              ? `${pluralize(s.errors, "linha com erro não será importada", "linhas com erro não serão importadas")}.`
              : null}
          </Callout>
        ) : null}
        {clientNotFound ? (
          <Callout tone="warning" title="A empresa selecionada não aparece nas partes">
            Nenhuma parte da planilha tem o nome “{batch.companyName}”. Os processos seriam importados sem marcar o cliente. Confira se a
            empresa escolhida é a da planilha; se não for, envie a planilha novamente com a empresa correta.
          </Callout>
        ) : null}
        {otherSameFile.length > 0 ? (
          <Callout tone="info" title="Este mesmo arquivo já foi importado">
            Importação confirmada em{" "}
            {otherSameFile.map((b, i) => (
              <span key={b.id}>
                {i > 0 ? ", " : ""}
                <Link href={`/importacoes/${b.id}`}>{formatDateTime(b.createdAt)}</Link>
              </span>
            ))}
            . Reimportar o mesmo arquivo não duplica processos, instâncias nem valores.
          </Callout>
        ) : null}
        {batch.distribution ? (
          <Callout
            tone={batch.distribution.failed > 0 ? "warning" : "success"}
            title={`Distribuição após a importação: ${pluralize(batch.distribution.assigned, "processo atribuído", "processos atribuídos")}`}
          >
            {batch.distribution.failed > 0 ? (
              <>
                {pluralize(batch.distribution.failed, "processo ficou", "processos ficaram")} sem responsável:
                <ul className="mt-1 list-disc pl-5">
                  {batch.distribution.failures.slice(0, 10).map((f) => (
                    <li key={f.processId}>
                      <Link href={`/processos/${f.processId}`}>{f.number}</Link> — {f.message}
                    </li>
                  ))}
                </ul>
                {batch.distribution.failed > 10 ? <p className="mt-1">e mais {formatNumber(batch.distribution.failed - 10)}.</p> : null}
              </>
            ) : (
              "Todos os processos novos receberam responsável pelas regras de distribuição."
            )}
          </Callout>
        ) : null}
        {blockers.length > 0 ? (
          <Callout tone="warning" title="Esta importação não pode mais ser desfeita automaticamente">
            {pluralize(blockers.length, "processo foi alterado", "processos foram alterados")} depois dela:
            <ul className="mt-1 list-disc pl-5">
              {blockers.slice(0, 10).map((b) => (
                <li key={b.processId}>
                  <Link href={`/processos/${b.processId}`}>{b.number}</Link> — {b.reasons.join("; ")}
                </li>
              ))}
            </ul>
            {blockers.length > 10 ? <p className="mt-1">e mais {formatNumber(blockers.length - 10)}.</p> : null}
          </Callout>
        ) : null}
      </div>

      <LinkTabs
        className="mb-4"
        label="Seções da importação"
        active={active}
        tabs={[
          { key: "resumo", label: "Resumo", href: buildHref(base, {}, { aba: null }) },
          { key: "linhas", label: "Linhas", href: buildHref(base, {}, { aba: "linhas" }), count: batch.storedRows },
          { key: "inconsistencias", label: "Inconsistências", href: buildHref(base, {}, { aba: "inconsistencias" }), count: batch.problemRows },
          { key: "divergencias", label: "Divergências", href: buildHref(base, {}, { aba: "divergencias" }), count: s?.divergences ?? null },
        ]}
      />

      {active === "resumo" ? <BatchSummary batch={batch} /> : null}
      {active === "linhas" ? <BatchRows ctx={ctx} batch={batch} sp={sp} /> : null}
      {active === "inconsistencias" ? <BatchIssues ctx={ctx} batch={batch} sp={sp} /> : null}
      {active === "divergencias" ? <BatchDivergences ctx={ctx} batch={batch} sp={sp} /> : null}
    </>
  );
}
