import "server-only";
import { centsToInputValue } from "@/lib/format";
import type { Option } from "@/lib/options";
import { listUnitOptions } from "@/modules/admin/service";
import { listCompanyOptions, listLawFirmOptions } from "@/modules/organization/service";
import type { AuthContext } from "@/server/auth/context";
import type { RuleFormUser } from "./components/rule-form";
import { EMPTY_RULE_FORM, type RuleFormValues } from "./schemas";
import { listAssignableUsers, type RuleDetail } from "./service";

/** Options shared by the rule form pages (server only). */
export async function loadRuleFormOptions(ctx: AuthContext): Promise<{
  users: RuleFormUser[];
  companies: Option[];
  units: Option[];
  lawFirms: Option[];
}> {
  const [users, companies, units, lawFirms] = await Promise.all([
    listAssignableUsers(ctx),
    listCompanyOptions(ctx),
    listUnitOptions(ctx),
    listLawFirmOptions(ctx),
  ]);
  return {
    users: users.map((u) => ({
      id: u.id,
      name: u.name,
      detail: [u.roleLabel, u.unitName, u.lawFirmName].filter(Boolean).join(" · "),
    })),
    companies: companies.map((c) => ({ value: c.id, label: c.name })),
    units: units.map((u) => ({ value: u.id, label: u.name })),
    lawFirms: lawFirms.map((f) => ({ value: f.id, label: f.name })),
  };
}

export function ruleFormDefaults(rule: RuleDetail | null, nextPriority: number): RuleFormValues {
  if (!rule) return { ...EMPTY_RULE_FORM, priority: String(nextPriority) };
  const c = rule.criteria;
  return {
    name: rule.name,
    description: rule.description ?? "",
    priority: String(rule.priority),
    isActive: rule.isActive,
    courts: (c.courts ?? []).join(", "),
    areas: c.areas ?? [],
    companyIds: c.companyIds ?? [],
    unitIds: c.unitIds ?? [],
    states: (c.states ?? []).join(", "),
    cities: (c.cities ?? []).join(", "),
    instances: c.instances ?? [],
    processClasses: (c.processClasses ?? []).join(", "),
    minClaim: centsToInputValue(c.minClaimCents ?? null),
    maxClaim: centsToInputValue(c.maxClaimCents ?? null),
    method: rule.assignment.method,
    userIds: rule.assignment.userIds,
    lawFirmId: rule.assignment.lawFirmId ?? "",
    assignUnitId: rule.assignment.unitId ?? "",
  };
}
