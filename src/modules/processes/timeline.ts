/**
 * Pure helpers of the unified timeline (P2.13): one list for every instance of the CNJ,
 * each movement with its instance and its source. Client-safe.
 */
import { PROCESS_INSTANCES, type DataOrigin, type ProcessInstance } from "@/domain/enums";
import { DATAJUD_SOURCE_LABEL } from "@/modules/court-sync/mapping";

/** Movement collected from the DataJud (CNJ) by the court sync. */
export const isDataJudEvent = (e: { origin: DataOrigin; externalSource: string | null }) =>
  e.origin === "imported" && e.externalSource === DATAJUD_SOURCE_LABEL;

/** Movements per instance in grau order; `null` (instance not informed) last. */
export function eventsByInstance(events: readonly { instance: ProcessInstance | null }[]): { instance: ProcessInstance | null; count: number }[] {
  const counts = new Map<ProcessInstance | null, number>();
  for (const e of events) counts.set(e.instance, (counts.get(e.instance) ?? 0) + 1);
  return [...PROCESS_INSTANCES, null].filter((i) => counts.has(i)).map((i) => ({ instance: i, count: counts.get(i) ?? 0 }));
}
