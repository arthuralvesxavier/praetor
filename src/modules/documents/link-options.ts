import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Option } from "@/lib/options";
import { listContractOptions } from "@/modules/contracts/service";
import { listOccurrenceOptions } from "@/modules/occurrences/service";
import { listProcessOptions } from "@/modules/processes/service";
import { processWhere } from "@/server/auth/access";
import type { AuthContext } from "@/server/auth/context";
import { can } from "@/server/auth/permissions";
import { getDb } from "@/server/db/client";
import { legalProcesses } from "@/server/db/schema";

export type LinkOptions = { processes: Option[]; occurrences: Option[]; contracts: Option[] };

const idSchema = z.guid();

/**
 * Select options for linking a document to records visible to the user
 * (uses the cross-module option services, which apply row visibility).
 *
 * `listProcessOptions` returns EVERY visible process (P0.6, no size cap), so
 * `includeProcessId` (a `?processo=` preselection or the document's current
 * process) is normally already listed. The extra lookup is a safeguard with the
 * same visibility rule: a visible process missing from the list is added first,
 * an invisible one is never offered. Without the preselected process the select
 * would silently drop the preselection or unlink the document on save.
 */
export async function loadLinkOptions(ctx: AuthContext, opts: { includeProcessId?: string | null } = {}): Promise<LinkOptions> {
  const canReadProcesses = can(ctx, "process:read");
  const [processes, occurrences, contracts] = await Promise.all([
    canReadProcesses ? listProcessOptions(ctx) : Promise.resolve([]),
    can(ctx, "occurrence:read") ? listOccurrenceOptions(ctx) : Promise.resolve([]),
    can(ctx, "contract:read") ? listContractOptions(ctx) : Promise.resolve([]),
  ]);
  const includeId = opts.includeProcessId;
  let processRows = processes;
  if (canReadProcesses && includeId && idSchema.safeParse(includeId).success && !processes.some((p) => p.id === includeId)) {
    const [extra] = await getDb()
      .select({ id: legalProcesses.id, number: legalProcesses.number, title: legalProcesses.title })
      .from(legalProcesses)
      .where(and(eq(legalProcesses.id, includeId), processWhere(ctx)))
      .limit(1);
    if (extra) processRows = [extra, ...processes];
  }
  return {
    processes: processRows.map((p) => ({ value: p.id, label: `${p.number} · ${p.title}` })),
    occurrences: occurrences.map((o) => ({ value: o.id, label: o.title })),
    contracts: contracts.map((c) => ({ value: c.id, label: `${c.title} (${c.counterparty})` })),
  };
}
