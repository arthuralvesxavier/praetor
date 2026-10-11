import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import type { Option } from "@/lib/options";
import { requirePageContext } from "@/server/auth/session";
import { NotFoundError } from "@/server/lib/errors";
import { listUnitOptions, listUserOptions } from "@/modules/admin/service";
import { OccurrenceForm, type OccurrenceFormValues } from "@/modules/occurrences/components/occurrence-form";
import { getOccurrence, type OccurrenceDetail } from "@/modules/occurrences/service";

export const metadata: Metadata = { title: "Editar ocorrência" };

/** Keeps the current value selectable even when it is no longer an active option (e.g. inactive user). */
function withCurrent(options: Option[], id: string | null, name: string | null): Option[] {
  if (!id || options.some((o) => o.value === id)) return options;
  return [...options, { value: id, label: `${name ?? "Registro indisponível"} (inativo)` }];
}

export default async function EditOccurrencePage(props: PageProps<"/preventivo/[id]/editar">) {
  const ctx = await requirePageContext("occurrence:write");
  const { id } = await props.params;

  let occurrence: OccurrenceDetail;
  try {
    occurrence = await getOccurrence(ctx, id);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
  const [units, users] = await Promise.all([listUnitOptions(ctx), listUserOptions(ctx)]);
  const userOptions = users.map((u) => ({ value: u.id, label: u.name }));

  const values: OccurrenceFormValues = {
    id: occurrence.id,
    title: occurrence.title,
    facts: occurrence.facts,
    category: occurrence.category,
    status: occurrence.status,
    riskLevel: occurrence.riskLevel,
    riskRationale: occurrence.riskRationale,
    areasInvolved: occurrence.areasInvolved,
    involvedParties: occurrence.involvedParties,
    missingInformation: occurrence.missingInformation,
    estimatedExposureCents: occurrence.estimatedExposureCents,
    unitId: occurrence.unitId,
    responsibleId: occurrence.responsibleId,
    reportedById: occurrence.reportedById,
    occurredOn: occurrence.occurredOn,
    reportedOn: occurrence.reportedOn,
    isConfidential: occurrence.isConfidential,
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Editar ocorrência"
        description={occurrence.title}
        breadcrumbs={[
          { label: "Jurídico preventivo", href: "/preventivo" },
          { label: occurrence.title, href: `/preventivo/${occurrence.id}` },
          { label: "Editar" },
        ]}
      />
      <OccurrenceForm
        mode="edit"
        values={values}
        units={withCurrent(
          units.map((u) => ({ value: u.id, label: u.name })),
          occurrence.unitId,
          occurrence.unitName,
        )}
        users={withCurrent(
          withCurrent(userOptions, occurrence.responsibleId, occurrence.responsibleName),
          occurrence.reportedById,
          occurrence.reportedByName,
        )}
        canSetConfidential={occurrence.canSetConfidential}
        cancelHref={`/preventivo/${occurrence.id}`}
      />
    </div>
  );
}
