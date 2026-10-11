import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/page-header";
import { todayISO } from "@/lib/format";
import { seesConfidential } from "@/server/auth/access";
import { requirePageContext } from "@/server/auth/session";
import { listUnitOptions, listUserOptions } from "@/modules/admin/service";
import { OccurrenceForm, type OccurrenceFormValues } from "@/modules/occurrences/components/occurrence-form";

export const metadata: Metadata = { title: "Nova ocorrência" };

export default async function NewOccurrencePage() {
  const ctx = await requirePageContext("occurrence:write");
  const [units, users] = await Promise.all([listUnitOptions(ctx), listUserOptions(ctx)]);

  const values: OccurrenceFormValues = {
    title: "",
    facts: "",
    category: "",
    status: "open",
    riskLevel: "medium",
    riskRationale: null,
    areasInvolved: [],
    involvedParties: null,
    missingInformation: [],
    estimatedExposureCents: null,
    unitId: ctx.unitId && units.some((u) => u.id === ctx.unitId) ? ctx.unitId : null,
    responsibleId: null,
    reportedById: ctx.userId,
    occurredOn: null,
    reportedOn: todayISO(),
    isConfidential: false,
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Nova ocorrência"
        description="Registre os fatos como foram relatados. A classificação de risco é sempre feita pela equipe jurídica."
        breadcrumbs={[
          { label: "Jurídico preventivo", href: "/preventivo" },
          { label: "Nova ocorrência" },
        ]}
      />
      <OccurrenceForm
        mode="create"
        values={values}
        units={units.map((u) => ({ value: u.id, label: u.name }))}
        users={users.map((u) => ({ value: u.id, label: u.name }))}
        canSetConfidential={seesConfidential(ctx)}
        cancelHref="/preventivo"
      />
    </div>
  );
}
