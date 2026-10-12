import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { centsToInputValue, formatDocument } from "@/lib/format";
import { ContractForm, type ContractFormValues } from "@/modules/contracts/components/contract-form";
import { loadContractFormOptions, withCurrentOption } from "@/modules/contracts/form-options";
import { getContract } from "@/modules/contracts/service";
import { seesConfidential } from "@/server/auth/access";
import { requirePageContext } from "@/server/auth/session";
import { NotFoundError } from "@/server/lib/errors";

export const metadata: Metadata = { title: "Editar contrato" };

export default async function EditContractPage(props: PageProps<"/contratos/[id]/editar">) {
  const ctx = await requirePageContext("contract:write");
  const { id } = await props.params;

  let contract;
  try {
    contract = await getContract(ctx, id);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
  const options = await loadContractFormOptions(ctx);

  const defaults: ContractFormValues = {
    title: contract.title,
    counterparty: contract.counterparty,
    counterpartyDocument: contract.counterpartyDocument ? formatDocument(contract.counterpartyDocument) : "",
    type: contract.type,
    status: contract.status,
    startDate: contract.startDate ?? "",
    endDate: contract.endDate ?? "",
    renewalType: contract.renewalType,
    renewalNoticeDays: contract.renewalNoticeDays !== null ? String(contract.renewalNoticeDays) : "",
    value: centsToInputValue(contract.valueCents),
    riskLevel: contract.riskLevel,
    unitId: contract.unitId ?? "",
    responsibleId: contract.responsibleId ?? "",
    linkedProcessId: contract.linkedProcessId ?? "",
    linkedOccurrenceId: contract.linkedOccurrenceId ?? "",
    description: contract.description ?? "",
    isConfidential: contract.isConfidential,
  };

  return (
    <>
      <PageHeader
        title="Editar contrato"
        description={contract.title}
        breadcrumbs={[
          { label: "Painel executivo", href: "/dashboard" },
          { label: "Contratos", href: "/contratos" },
          { label: contract.title, href: `/contratos/${contract.id}` },
          { label: "Editar" },
        ]}
      />
      <div className="max-w-4xl">
        <ContractForm
          contractId={contract.id}
          defaults={defaults}
          users={withCurrentOption(options.users, contract.responsibleId, contract.responsibleName ?? "Responsável atual")}
          units={withCurrentOption(options.units, contract.unitId, contract.unitName ?? "Unidade atual")}
          processes={withCurrentOption(options.processes, contract.linkedProcessId, contract.linkedProcess?.label ?? "Processo vinculado")}
          occurrences={withCurrentOption(
            options.occurrences,
            contract.linkedOccurrenceId,
            contract.linkedOccurrence?.label ?? "Ocorrência vinculada",
          )}
          canSetConfidential={seesConfidential(ctx)}
          cancelHref={`/contratos/${contract.id}`}
        />
      </div>
    </>
  );
}
