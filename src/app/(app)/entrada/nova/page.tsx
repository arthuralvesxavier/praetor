import type { Metadata } from "next";
import { Callout } from "@/components/ui/callout";
import { PageHeader } from "@/components/ui/page-header";
import { listUnitOptions } from "@/modules/admin/service";
import { listAssignableUsers } from "@/modules/distribution/service";
import { IntakeForm } from "@/modules/intake/components/intake-form";
import { listCompanyOptions } from "@/modules/organization/service";
import { can } from "@/server/auth/permissions";
import { requirePageContext } from "@/server/auth/session";
import { env } from "@/server/env";

export const metadata: Metadata = { title: "Registrar processo recebido" };

export default async function NewIntakePage() {
  const ctx = await requirePageContext("intake:manage");
  const [companies, units, users] = await Promise.all([
    listCompanyOptions(ctx),
    listUnitOptions(ctx),
    listAssignableUsers(ctx),
  ]);
  // Choosing an external counsel (their law firm gains access) is a redistribution decision.
  const canRedistribute = can(ctx, "distribution:manage");
  const responsibleOptions = users.filter((u) => canRedistribute || u.role !== "external_counsel");

  return (
    <>
      <PageHeader
        title="Registrar processo recebido"
        description="Informe os dados do processo que chegou e anexe os documentos recebidos. Depois do registro, o fluxo segue sozinho."
        breadcrumbs={[
          { label: "Painel executivo", href: "/dashboard" },
          { label: "Entrada de processos", href: "/entrada" },
          { label: "Registrar processo recebido" },
        ]}
      />
      <div className="max-w-5xl">
        <Callout tone="info" title="O que acontece depois do registro" className="mb-6">
          1) O responsável é definido pelas regras de distribuição (ou mantido, se você indicar um). 2) Os documentos são
          lidos e a análise preliminar é montada por uma simulação, sem inteligência artificial real. 3) O advogado recebe
          um e-mail simulado com o resumo (nenhuma mensagem é enviada). 4) O advogado revisa e aprova a análise.
        </Callout>
        <IntakeForm
          companies={companies.map((c) => ({ value: c.id, label: c.name }))}
          units={units.map((u) => ({ value: u.id, label: u.name }))}
          users={responsibleOptions.map((u) => ({ value: u.id, label: `${u.name} (${u.roleLabel}${u.unitName ? `, ${u.unitName}` : ""})` }))}
          maxUploadMb={env().MAX_UPLOAD_MB}
        />
      </div>
    </>
  );
}
