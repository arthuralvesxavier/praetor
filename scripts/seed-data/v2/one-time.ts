/**
 * Steps of the v2 seed (scripts/seed-v2.ts) that must happen ONCE in the life
 * of the demo organization, whatever a person does afterwards:
 *
 * - the preventive occurrence created from a preventive-intelligence
 *   suggestion. Its marker is ANY occurrence of the organization created from
 *   an indicator (the facts carry the "[ref: pi:" footer), in any status and
 *   even removed: a person may resolve, cancel or remove it, and the seed must
 *   not create a second one on a later run. The occurrence and its action
 *   plan are two actions; a run that stopped between them adds the plan on a
 *   later run only while nobody has touched the occurrence (still open, never
 *   edited, no plan task ever created for it);
 * - the monthly closes of the demo. Closing is definitive (a closed
 *   competência is immutable), so only the first v2 seed closes months: the
 *   two months before the one it runs in. A later run (for example to issue a
 *   new demo API key) never closes the month that just ended: that is
 *   accounting's decision.
 */
import { and, asc, eq, like, ne } from "drizzle-orm";
import { addMonthsISO, periodOf } from "@/modules/contingency/rules";
import { PREVENTIVE_MARKER_PREFIX, parsePreventiveOrigin } from "@/modules/occurrences/preventive-origin";
import { createActionPlanFromSuggestion, createOccurrenceFromSuggestion, getPreventiveIntelligence } from "@/modules/preventive-intel/service";
import type { AuthContext } from "@/server/auth/context";
import { getDb } from "@/server/db/client";
import { auditLogs, occurrences, portfolioSnapshots, tasks } from "@/server/db/schema";
import { PREVENTIVE_SUGGESTION_PREFERENCE } from "./aurora-v2";

// ---------------------------------------------------------------------------
// Preventive occurrence
// ---------------------------------------------------------------------------

/** True when the organization has any occurrence created from an indicator (any status, removed ones included). */
export async function preventiveOccurrenceRecorded(organizationId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: occurrences.id })
    .from(occurrences)
    .where(and(eq(occurrences.organizationId, organizationId), like(occurrences.facts, `%${PREVENTIVE_MARKER_PREFIX}%`)))
    .limit(1);
  return Boolean(row);
}

/**
 * The seed's occurrence (the earliest one created from an indicator) when the
 * run that created it stopped before its action plan: not removed, still
 * open, never edited (no occurrence audit entry besides its creation) and no
 * action-plan task ever created for it (removed ones included). Anything a
 * person did to it means the plan is that person's decision.
 */
export async function preventivePlanToResume(organizationId: string): Promise<{ occurrenceId: string; key: string } | null> {
  const db = getDb();
  const [first] = await db
    .select({ id: occurrences.id, facts: occurrences.facts, status: occurrences.status, deletedAt: occurrences.deletedAt })
    .from(occurrences)
    .where(and(eq(occurrences.organizationId, organizationId), like(occurrences.facts, `%${PREVENTIVE_MARKER_PREFIX}%`)))
    .orderBy(asc(occurrences.createdAt), asc(occurrences.id))
    .limit(1);
  if (!first || first.deletedAt || first.status !== "open") return null;
  const origin = parsePreventiveOrigin(first.facts);
  if (!origin) return null;
  const [task] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.organizationId, organizationId), eq(tasks.occurrenceId, first.id), eq(tasks.kind, "action_plan")))
    .limit(1);
  if (task) return null;
  const [touched] = await db
    .select({ id: auditLogs.id })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.organizationId, organizationId),
        eq(auditLogs.entityType, "occurrence"),
        eq(auditLogs.entityId, first.id),
        like(auditLogs.action, "occurrence.%"),
        ne(auditLogs.action, "occurrence.create"),
      ),
    )
    .limit(1);
  if (touched) return null;
  return { occurrenceId: first.id, key: origin.key };
}

/** The active suggestion whose open occurrence is the one to resume (null when it is no longer active). */
async function resumableSuggestion(gestor: AuthContext) {
  const resume = await preventivePlanToResume(gestor.organizationId);
  if (!resume) return null;
  const intel = await getPreventiveIntelligence(gestor);
  return intel.suggestions.find((s) => s.key === resume.key && s.existingOccurrence?.id === resume.occurrenceId) ?? null;
}

/**
 * True while the step still has something to do: no occurrence from an
 * indicator yet and a suggestion is active, or the seed's occurrence still
 * waits for the action plan an interrupted run did not create.
 */
export async function preventiveOccurrencePending(gestor: AuthContext): Promise<boolean> {
  if (await preventiveOccurrenceRecorded(gestor.organizationId)) return (await resumableSuggestion(gestor)) !== null;
  return (await getPreventiveIntelligence(gestor)).suggestions.length > 0;
}

export type PreventiveSeedResult =
  | { status: "already_recorded" }
  | { status: "no_suggestion" }
  | { status: "created"; title: string; tasks: number }
  | { status: "plan_resumed"; title: string; tasks: number };

/**
 * Creates, as the legal manager, the occurrence of the preferred active
 * suggestion and its action plan (preventive-intelligence service, the same
 * two actions a person takes on the screen). When an occurrence from an
 * indicator already exists, in any status, it only adds the plan an
 * interrupted run left out (see `preventivePlanToResume`), or does nothing.
 */
export async function seedPreventiveOccurrence(gestor: AuthContext): Promise<PreventiveSeedResult> {
  if (await preventiveOccurrenceRecorded(gestor.organizationId)) {
    const s = await resumableSuggestion(gestor);
    if (!s) return { status: "already_recorded" };
    const plan = await createActionPlanFromSuggestion(gestor, s.key);
    return { status: "plan_resumed", title: s.title, tasks: plan.created };
  }
  const intel = await getPreventiveIntelligence(gestor);
  const pick =
    PREVENTIVE_SUGGESTION_PREFERENCE.map((k) => intel.suggestions.find((s) => s.key === k)).find(Boolean) ?? intel.suggestions[0];
  if (!pick) return { status: "no_suggestion" };
  await createOccurrenceFromSuggestion(gestor, pick.key);
  const plan = await createActionPlanFromSuggestion(gestor, pick.key);
  return { status: "created", title: pick.title, tasks: plan.created };
}

// ---------------------------------------------------------------------------
// Monthly closes of the demo
// ---------------------------------------------------------------------------

export type ClosedCompetencia = { period: string; closedById: string | null };

/**
 * Competências (`YYYY-MM`) the seed still closes, in order (pure).
 *
 * - No closed competência in the organization: this is the first v2 seed, it
 *   closes the two months before `current`.
 * - Otherwise it only finishes the pair its first run started, when that run
 *   stopped between the two closes: the earliest closed competência was closed
 *   by the demo accountant and the month after it is still open and before
 *   `current`. Every other month is left for accounting to close.
 */
export function demoClosePlan(input: { current: string; closed: readonly ClosedCompetencia[]; accountantId: string | null }): string[] {
  const { current, closed } = input;
  if (closed.length === 0) {
    const first = `${current}-01`;
    return [periodOf(addMonthsISO(first, -2)), periodOf(addMonthsISO(first, -1))];
  }
  const earliest = [...closed].sort((a, b) => a.period.localeCompare(b.period))[0];
  if (!input.accountantId || earliest.closedById !== input.accountantId) return [];
  const next = periodOf(addMonthsISO(`${earliest.period}-01`, 1));
  if (next >= current || closed.some((c) => c.period === next)) return [];
  return [next];
}

/** Closed competências of the organization (period and who closed it). */
export async function closedCompetencias(organizationId: string): Promise<ClosedCompetencia[]> {
  return getDb()
    .select({ period: portfolioSnapshots.period, closedById: portfolioSnapshots.closedById })
    .from(portfolioSnapshots)
    .where(and(eq(portfolioSnapshots.organizationId, organizationId), eq(portfolioSnapshots.status, "closed")))
    .orderBy(asc(portfolioSnapshots.period));
}
