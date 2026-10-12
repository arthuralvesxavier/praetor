import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/page-header";
import { ContractForm } from "@/modules/contracts/components/contract-form";
import { loadContractFormOptions } from "@/modules/contracts/form-options";
import { seesConfidential } from "@/server/auth/access";
import { requirePageContext } from "@/server/auth/session";

export const metadata: Metadata = { title: "Novo contrato" };

export default async function NewContractPage() {
  const ctx = await requirePageContext("contract:write");
  const options = await loadContractFormOptions(ctx);

  return (
    <>
      <PageHeader
        title="Novo contrato"
        description="Cadastre os dados principais. Arquivos e versões do contrato são enviados depois, na aba “Documentos e versões”."
        breadcrumbs={[
          { label: "Painel executivo", href: "/dashboard" },
          { label: "Contratos", href: "/contratos" },
          { label: "Novo contrato" },
        ]}
      />
      <div className="max-w-4xl">
        <ContractForm {...options} canSetConfidential={seesConfidential(ctx)} cancelHref="/contratos" />
      </div>
    </>
  );
}
