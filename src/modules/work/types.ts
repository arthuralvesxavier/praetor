/** Client-safe types shared by the work service and its client components. */

export type WorkUserOption = { id: string; name: string };

export type WorkLinkOptions = {
  processes: { id: string; label: string }[];
  occurrences: { id: string; label: string }[];
  contracts: { id: string; label: string }[];
};

/** Fixed link of forms rendered on an entity page (hidden fields). */
export type FixedWorkLink = { processId?: string; occurrenceId?: string; contractId?: string };
