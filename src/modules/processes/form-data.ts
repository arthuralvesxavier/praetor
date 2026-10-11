/**
 * Server-side helpers shared by the "novo" and "editar" pages: select options
 * and mapping of records to the string defaults of <ProcessForm>.
 */
import { ROLE_LABELS } from "@/domain/enums";
import { centsToInputValue } from "@/lib/format";
import type { Option } from "@/lib/options";
import { listUnitOptions, listUserOptions } from "@/modules/admin/service";
import type { AuthContext } from "@/server/auth/context";
import { EMPTY_PROCESS_FORM, type ProcessFormDefaults } from "./schemas";
import type { OccurrencePrefill, ProcessDetail } from "./service";

export async function loadProcessFormOptions(
  ctx: AuthContext,
  keep?: { unitId?: string | null; unitName?: string | null; responsibleId?: string | null; responsibleName?: string | null },
): Promise<{ units: Option[]; users: Option[] }> {
  const [unitRows, userRows] = await Promise.all([listUnitOptions(ctx), listUserOptions(ctx)]);
  const units: Option[] = unitRows.map((u) => ({ value: u.id, label: u.name }));
  const users: Option[] = userRows.map((u) => ({ value: u.id, label: `${u.name} — ${ROLE_LABELS[u.role]}` }));
  // Keep the current (possibly inactive) unit/responsible selectable when editing.
  if (keep?.unitId && !units.some((u) => u.value === keep.unitId)) {
    units.push({ value: keep.unitId, label: `${keep.unitName ?? "Unidade atual"} (inativa)` });
  }
  if (keep?.responsibleId && !users.some((u) => u.value === keep.responsibleId)) {
    users.push({ value: keep.responsibleId, label: `${keep.responsibleName ?? "Responsável atual"} (inativo)` });
  }
  return { units, users };
}

export function processToFormDefaults(p: ProcessDetail): ProcessFormDefaults {
  return {
    number: p.number,
    title: p.title,
    court: p.court,
    courtDivision: p.courtDivision ?? "",
    jurisdiction: p.jurisdiction ?? "",
    area: p.area,
    phase: p.phase,
    status: p.status,
    filedAt: p.filedAt ?? "",
    closedAt: p.closedAt ?? "",
    unitId: p.unitId ?? "",
    responsibleId: p.responsibleId ?? "",
    claimAmountCents: centsToInputValue(p.claimAmountCents),
    provisionAmountCents: centsToInputValue(p.provisionAmountCents),
    riskLevel: p.riskLevel,
    lossProbability: p.lossProbability ?? "",
    riskRationale: p.riskRationale ?? "",
    description: p.description ?? "",
    isConfidential: p.isConfidential,
  };
}

export function occurrenceToFormDefaults(o: OccurrencePrefill, validUsers: readonly Option[]): ProcessFormDefaults {
  return {
    ...EMPTY_PROCESS_FORM,
    title: o.title,
    area: o.area ?? "",
    unitId: o.unitId ?? "",
    responsibleId: o.responsibleId && validUsers.some((u) => u.value === o.responsibleId) ? o.responsibleId : "",
    riskLevel: o.riskLevel,
    riskRationale: o.riskRationale ?? "",
    description: o.description,
    isConfidential: o.isConfidential,
  };
}
