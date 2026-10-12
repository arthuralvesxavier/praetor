import { CheckCircle2, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { formatDate, formatNumber, pluralize, todayISO } from "@/lib/format";
import { commitImportAction, rollbackImportAction } from "../actions";
import type { ImportBatchDetail } from "../service";

/** "Confirmar importação" (analyzed batches): asks for the base date of the values. */
export function CommitImportButton({ batch }: { batch: ImportBatchDetail }) {
  const s = batch.stats;
  const hint =
    batch.baseDateSource === "file" && batch.baseDateHint
      ? `Sugerida pela planilha (${batch.baseDateHint.source}). Altere se os valores se referem a outra data.`
      : "Data a que os valores da planilha se referem. Vale para todas as valorações desta importação.";
  return (
    <ConfirmDialog
      action={commitImportAction}
      tone="primary"
      hiddenFields={{ id: batch.id }}
      trigger={
        <Button type="button">
          <CheckCircle2 aria-hidden="true" />
          Confirmar importação
        </Button>
      }
      title="Confirmar a importação?"
      description={
        s ? (
          <>
            Serão criados {pluralize(s.toCreate, "processo novo", "processos novos", { withCount: true })} e atualizados{" "}
            {pluralize(s.toUpdate, "processo", "processos", { withCount: true })} ({formatNumber(s.unchanged)} sem alteração). Os valores
            iniciais entram como oficiais, com você como conferente; valores divergentes entram como propostos para conferência. A
            situação da base é conferida de novo no momento da confirmação.
          </>
        ) : undefined
      }
      confirmLabel="Confirmar importação"
      pendingLabel="Importando…"
    >
      <FormField label="Data-base dos valores" htmlFor={`baseDate-${batch.id}`} required hint={hint}>
        <Input type="date" name="baseDate" defaultValue={batch.baseDate ?? ""} max={todayISO()} required />
      </FormField>
      <Checkbox
        id={`distribute-${batch.id}`}
        name="distributeAfterCommit"
        defaultChecked={batch.distributeAfterCommit}
        label="Distribuir os processos novos após confirmar"
        description="Aplica as regras de distribuição aos processos criados sem responsável. Falhas são listadas no resumo."
      />
    </ConfirmDialog>
  );
}

/** "Desfazer importação" (committed batches without blockers). */
export function RollbackImportButton({ batch }: { batch: ImportBatchDetail }) {
  const s = batch.stats;
  return (
    <ConfirmDialog
      action={rollbackImportAction}
      hiddenFields={{ id: batch.id }}
      trigger={
        <Button type="button" variant="outline">
          <Undo2 aria-hidden="true" />
          Desfazer importação
        </Button>
      }
      title="Desfazer esta importação?"
      description={
        <>
          {s ? (
            <>
              {pluralize(s.toCreate, "processo criado", "processos criados", { withCount: true })} por ela{" "}
              {s.toCreate === 1 ? "será removido" : "serão removidos"} da carteira e{" "}
              {pluralize(s.toUpdate, "processo atualizado volta", "processos atualizados voltam", { withCount: true })} ao estado
              anterior.{" "}
            </>
          ) : null}
          Vínculos de instância e valores incluídos pela importação são apagados. O relatório desta importação
          {batch.committedAt ? ` (confirmada em ${formatDate(batch.committedAt)})` : ""} continua disponível para auditoria.
        </>
      }
      confirmLabel="Desfazer importação"
      pendingLabel="Desfazendo…"
    />
  );
}
