import type { Metadata } from "next";
import Link from "next/link";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { idParam } from "@/lib/search-params";
import { createProcessAction } from "@/modules/processes/actions";
import { ProcessForm } from "@/modules/processes/components/process-form";
import { loadProcessFormOptions, occurrenceToFormDefaults } from "@/modules/processes/form-data";
import { EMPTY_PROCESS_FORM } from "@/modules/processes/schemas";
import { canEditProcessConfidentiality, getOccurrencePrefill } from "@/modules/processes/service";
import { requirePageContext } from "@/server/auth/session";

export const metadata: Metadata = { title: "Novo processo" };

export default async function NewProcessPage(props: PageProps<"/processos/novo">) {
  const ctx = await requirePageContext("process:write");
  const sp = await props.searchParams;
  const occurrenceId = idParam(sp, "ocorrencia");
  const requestedOccurrence = Boolean(sp.ocorrencia);

  const [options, occurrence] = await Promise.all([
    loadProcessFormOptions(ctx),
    occurrenceId ? getOccurrencePrefill(ctx, occurrenceId) : Promise.resolve(null),
  ]);
  const canEditConfidential = canEditProcessConfidentiality(ctx);
  const defaults = occurrence ? occurrenceToFormDefaults(occurrence, options.users) : EMPTY_PROCESS_FORM;

  return (
    <>
      <PageHeader
        title="Novo processo"
        description="Cadastro manual de processo. Não há consulta automática a tribunais: informe os dados conforme os autos."
        breadcrumbs={[{ label: "Processos", href: "/processos" }, { label: "Novo processo" }]}
      />

      {occurrence ? (
        <Callout tone="info" title="Processo originado de ocorrência preventiva" className="mb-6">
          Os campos foram pré-preenchidos a partir da ocorrência{" "}
          <Link href={`/preventivo/${occurrence.occurrenceId}`} className="font-medium underline underline-offset-2">
            {occurrence.title}
          </Link>
          . Revise todos os dados antes de salvar; após o cadastro, a ocorrência será vinculada a este processo.
          {occurrence.isConfidential && !canEditConfidential
            ? " Como a ocorrência é confidencial, o processo também será cadastrado como confidencial."
            : null}
          {occurrence.alreadyLinkedProcessId ? (
            <>
              {" "}
              <strong>Atenção:</strong> esta ocorrência já está vinculada a outro processo; ao salvar, o vínculo
              será substituído por este novo processo.
            </>
          ) : null}
        </Callout>
      ) : requestedOccurrence ? (
        <Callout tone="warning" title="Ocorrência não encontrada" className="mb-6">
          A ocorrência informada não existe ou você não tem permissão para acessá-la. O formulário foi aberto em branco.
        </Callout>
      ) : null}

      <Card>
        <CardContent>
          <ProcessForm
            mode="create"
            action={createProcessAction}
            defaults={defaults}
            units={options.units}
            users={options.users}
            canEditConfidential={canEditConfidential}
            fromOccurrence={occurrence ? { id: occurrence.occurrenceId, title: occurrence.title } : null}
            cancelHref={occurrence ? `/preventivo/${occurrence.occurrenceId}` : "/processos"}
          />
        </CardContent>
      </Card>
    </>
  );
}
