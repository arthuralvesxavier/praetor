/**
 * Server-side helpers shared by the "novo" and "editar" pages: select options
 * and mapping of records to the string defaults of <ProcessForm>.
 */
import { ROLE_LABELS } from "@/domain/enums";
import { centsToInputValue } from "@/lib/format";
import type { Option } from "@/lib/options";
import { listUnitOptions, listUserOptions } from "@/modules/admin/service";
import { listCompanyOptions, listLawFirmOptions } from "@/modules/organization/service";
import type { AuthContext } from "@/server/auth/context";
import { EMPTY_PROCESS_FORM, type ProcessFormDefaults } from "./schemas";
import { canChangeProcessLawFirm, type OccurrencePrefill, type ProcessDetail } from "./service";

export type ProcessFormOptions = {
  units: Option[];
  users: Option[];
  companies: Option[];
  lawFirms: Option[];
  /** False for external counsel: the law firm is fixed (theirs) and the field is not sent. */
  canChangeLawFirm: boolean;
};

type Keep = {
  unitId?: string | null;
  unitName?: string | null;
  responsibleId?: string | null;
  responsibleName?: string | null;
  companyId?: string | null;
  companyName?: string | null;
  lawFirmId?: string | null;
  lawFirmName?: string | null;
};

function keepCurrent(options: Option[], id: string | null | undefined, name: string | null | undefined, fallback: string) {
  if (id && !options.some((o) => o.value === id)) options.push({ value: id, label: `${name ?? fallback} (inativo)` });
}

export async function loadProcessFormOptions(ctx: AuthContext, keep?: Keep): Promise<ProcessFormOptions> {
  const [unitRows, userRows, companyRows, firmRows] = await Promise.all([
    listUnitOptions(ctx),
    listUserOptions(ctx),
    listCompanyOptions(ctx),
    listLawFirmOptions(ctx),
  ]);
  const units: Option[] = unitRows.map((u) => ({ value: u.id, label: u.name }));
  const users: Option[] = userRows.map((u) => ({ value: u.id, label: `${u.name} — ${ROLE_LABELS[u.role]}` }));
  const companies: Option[] = companyRows.map((c) => ({ value: c.id, label: c.name }));
  const lawFirms: Option[] = firmRows.map((f) => ({ value: f.id, label: f.name }));
  // Keep the current (possibly inactive) records selectable when editing.
  keepCurrent(units, keep?.unitId, keep?.unitName, "Unidade atual");
  keepCurrent(users, keep?.responsibleId, keep?.responsibleName, "Responsável atual");
  keepCurrent(companies, keep?.companyId, keep?.companyName, "Empresa atual");
  keepCurrent(lawFirms, keep?.lawFirmId, keep?.lawFirmName, "Escritório atual");
  return { units, users, companies, lawFirms, canChangeLawFirm: canChangeProcessLawFirm(ctx) };
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
    phaseDetail: p.phaseDetail ?? "",
    status: p.status,
    filedAt: p.filedAt ?? "",
    lastMovementAt: p.lastMovementAt ?? "",
    instance: p.instance ?? "",
    processClass: p.processClass ?? "",
    city: p.city ?? "",
    state: p.state ?? "",
    companyId: p.companyId ?? "",
    lawFirmId: p.lawFirmId ?? "",
    unitId: p.unitId ?? "",
    responsibleId: p.responsibleId ?? "",
    claimAmountCents: centsToInputValue(p.claimAmountCents),
    riskLevel: p.riskLevel,
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
