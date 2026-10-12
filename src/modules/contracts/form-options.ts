import type { Option } from "@/lib/options";
import { listUnitOptions, listUserOptions } from "@/modules/admin/service";
import { listOccurrenceOptions } from "@/modules/occurrences/service";
import { listProcessOptions } from "@/modules/processes/service";
import type { AuthContext } from "@/server/auth/context";

/** Select options for the contract form (server only; every list is scoped by its own module). */
export async function loadContractFormOptions(ctx: AuthContext): Promise<{
  users: Option[];
  units: Option[];
  processes: Option[];
  occurrences: Option[];
}> {
  const [users, units, processes, occurrences] = await Promise.all([
    listUserOptions(ctx),
    listUnitOptions(ctx),
    listProcessOptions(ctx),
    listOccurrenceOptions(ctx),
  ]);
  return {
    users: users.map((u) => ({ value: u.id, label: u.name })),
    units: units.map((u) => ({ value: u.id, label: u.name })),
    processes: processes.map((p) => ({ value: p.id, label: `${p.number} · ${p.title}` })),
    occurrences: occurrences.map((o) => ({ value: o.id, label: o.title })),
  };
}

/**
 * Keeps the currently stored value selectable even when it is no longer in the
 * option list (inactive user, record the editor cannot open), so saving the
 * form does not silently drop it.
 */
export function withCurrentOption(options: Option[], value: string | null | undefined, label: string): Option[] {
  if (!value || options.some((o) => o.value === value)) return options;
  return [{ value, label }, ...options];
}
