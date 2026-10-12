import Link from "next/link";
import { Callout } from "@/components/ui/callout";
import { formatNumber, pluralize } from "@/lib/format";
import type { ImportBatchDetail } from "../service";
import { ResumeDistributionButton } from "./batch-actions";

/**
 * Result of the distribution after the commit: finished (assigned / failures),
 * still running, or interrupted (with the resume action for committed batches).
 */
export function DistributionCallout({ batch }: { batch: ImportBatchDetail }) {
  const d = batch.distribution;
  const state = batch.distributionState;

  if (state === "running" || state === "interrupted") {
    const progress = d
      ? `${formatNumber(d.attempted)} de ${formatNumber(d.attempted + (d.remaining ?? 0))} processos novos já passaram pelas regras (${pluralize(d.assigned, "atribuído", "atribuídos")}).`
      : "Nenhum processo novo passou pelas regras ainda.";
    if (state === "running") {
      return (
        <Callout tone="info" title="Distribuição após a importação em andamento">
          {progress} Atualize a página para acompanhar.
        </Callout>
      );
    }
    return (
      <Callout tone="warning" title="Distribuição após a importação interrompida">
        <p>
          {progress} Os demais continuam sem responsável. Até a distribuição ser retomada, os processos atribuídos depois do último
          registro de progresso aparecem como alterados e impedem desfazer a importação.
        </p>
        {batch.status === "committed" ? (
          <div className="mt-2">
            <ResumeDistributionButton batch={batch} />
          </div>
        ) : null}
      </Callout>
    );
  }

  if (!d) return null;
  return (
    <Callout tone={d.failed > 0 ? "warning" : "success"} title={`Distribuição após a importação: ${pluralize(d.assigned, "processo atribuído", "processos atribuídos")}`}>
      {d.failed > 0 ? (
        <>
          {pluralize(d.failed, "processo ficou", "processos ficaram")} sem responsável:
          <ul className="mt-1 list-disc pl-5">
            {d.failures.slice(0, 10).map((f) => (
              <li key={f.processId}>
                <Link href={`/processos/${f.processId}`}>{f.number}</Link>: {f.message}
              </li>
            ))}
          </ul>
          {d.failed > 10 ? <p className="mt-1">e mais {formatNumber(d.failed - 10)}.</p> : null}
        </>
      ) : (
        "Todos os processos novos receberam responsável pelas regras de distribuição."
      )}
    </Callout>
  );
}
