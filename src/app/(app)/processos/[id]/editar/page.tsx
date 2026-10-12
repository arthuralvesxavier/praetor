import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { LOSS_PROBABILITY_LABELS } from "@/domain/enums";
import { formatMoneyCents } from "@/lib/format";
import { updateProcessAction } from "@/modules/processes/actions";
import { ProcessForm } from "@/modules/processes/components/process-form";
import { loadProcessFormOptions, processToFormDefaults } from "@/modules/processes/form-data";
import {
  getProcess,
  isInActivePortfolio,
  recordConfidentialProcessView,
  type ProcessDetail,
} from "@/modules/processes/service";
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
  // TE-10: the edit form shows the whole record, so it counts as a view.
  if (process.isConfidential) await recordConfidentialProcessView(ctx, process.id);

  const options = await loadProcessFormOptions(ctx, {
    unitId: process.unitId,
    unitName: process.unitName,
    responsibleId: process.responsibleId,
    responsibleName: process.responsibleName,
    companyId: process.companyId,
    companyName: process.companyName,
    lawFirmId: process.lawFirmId,
    lawFirmName: process.lawFirmName,
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
            companies={options.companies}
            lawFirms={options.lawFirms}
            canChangeLawFirm={options.canChangeLawFirm}
            lawFirmLabel={process.lawFirmName ?? "Sem escritório externo"}
            canEditConfidential={process.permissions.canEditConfidential}
            statusEditable={isInActivePortfolio(process.status)}
            mirrorValues={{
              liquidated: formatMoneyCents(process.liquidatedAmountCents, "Não apurado"),
              provision: formatMoneyCents(process.provisionAmountCents, "Não calculada"),
              lossProbability: process.lossProbability
                ? LOSS_PROBABILITY_LABELS[process.lossProbability]
                : "Não classificada",
              href: `${detailHref}?aba=valores`,
            }}
            cancelHref={detailHref}
          />
        </CardContent>
      </Card>
    </>
  );
}
