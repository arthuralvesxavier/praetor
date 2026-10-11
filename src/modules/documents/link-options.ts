import type { Option } from "@/lib/options";
import { listContractOptions } from "@/modules/contracts/service";
import { listOccurrenceOptions } from "@/modules/occurrences/service";
import { listProcessOptions } from "@/modules/processes/service";
import type { AuthContext } from "@/server/auth/context";
import { can } from "@/server/auth/permissions";

export type LinkOptions = { processes: Option[]; occurrences: Option[]; contracts: Option[] };

/**
 * Select options for linking a document to records visible to the user
 * (uses the cross-module option services, which apply row visibility).
 */
export async function loadLinkOptions(ctx: AuthContext): Promise<LinkOptions> {
  const [processes, occurrences, contracts] = await Promise.all([
    can(ctx, "process:read") ? listProcessOptions(ctx) : Promise.resolve([]),
    can(ctx, "occurrence:read") ? listOccurrenceOptions(ctx) : Promise.resolve([]),
    can(ctx, "contract:read") ? listContractOptions(ctx) : Promise.resolve([]),
  ]);
  return {
    processes: processes.map((p) => ({ value: p.id, label: `${p.number} — ${p.title}` })),
    occurrences: occurrences.map((o) => ({ value: o.id, label: o.title })),
    contracts: contracts.map((c) => ({ value: c.id, label: `${c.title} (${c.counterparty})` })),
  };
}
