import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { updateProcessAction } from "@/modules/processes/actions";
import { ProcessForm } from "@/modules/processes/components/process-form";
import { loadProcessFormOptions, processToFormDefaults } from "@/modules/processes/form-data";
import { getProcess, type ProcessDetail } from "@/modules/processes/service";
import { NotFoundError } from "@/server/lib/errors";
import { requirePageContext } from "@/server/auth/session";

export const metadata: Metadata = { title: "Editar processo" };

export default async function EditProcessPage(props: PageProps<"/processos/[id]/editar">) {
  const ctx = await requirePageContext("process:write");
  const { id } = await props.params;

  let process: ProcessDetail;
  try {
    process = await getProcess(ctx, id);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }

  const options = await loadProcessFormOptions(ctx, {
    unitId: process.unitId,
    unitName: process.unitName,
    responsibleId: process.responsibleId,
    responsibleName: process.responsibleName,
  });
  const detailHref = `/processos/${process.id}`;

  return (
    <>
      <PageHeader
        title="Editar processo"
        description={`${process.number} — ${process.title}`}
        breadcrumbs={[
          { label: "Processos", href: "/processos" },
          { label: process.number, href: detailHref },
          { label: "Editar" },
        ]}
      />

      {process.dataOrigin === "imported" ? (
        <Callout tone="info" title="Registro importado" className="mb-6">
          Este processo foi importado{process.externalSource ? ` de ${process.externalSource}` : ""}. As alterações
          feitas aqui ficam registradas no histórico como edições manuais; a origem do cadastro continua indicada como
          importada.
        </Callout>
      ) : null}

      <Card>
        <CardContent>
          <ProcessForm
            mode="edit"
            processId={process.id}
            action={updateProcessAction}
            defaults={processToFormDefaults(process)}
            units={options.units}
            users={options.users}
            canEditConfidential={process.permissions.canEditConfidential}
            cancelHref={detailHref}
          />
        </CardContent>
      </Card>
    </>
  );
}
