/** Client-safe types shared by the work service and its client components. */
import type { ProcessStatus } from "@/domain/enums";

export type WorkUserOption = { id: string; name: string };

export type WorkLinkOptions = {
  /**
   * Most recently updated active/suspended processes (quick picks of the
   * process search), plus the `includeProcessId` one. Not the full list: the
   * form searches every visible process through `searchWorkLinkProcessesAction`.
   */
  processes: { id: string; label: string }[];
  occurrences: { id: string; label: string }[];
  contracts: { id: string; label: string }[];
  /** The user can link processes (`process:read`): the form shows the process search. */
  processSearch?: boolean;
};

/** Result of the process search of the deadline/task forms. */
export type WorkProcessHit = { id: string; label: string; status: ProcessStatus };

/** Fixed link of forms rendered on an entity page (hidden fields). */
export type FixedWorkLink = { processId?: string; occurrenceId?: string; contractId?: string };
