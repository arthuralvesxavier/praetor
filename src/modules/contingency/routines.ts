import type { RoutineContext } from "@/server/jobs/routines";

/**
 * Routine bodies owned by the contingency module (wired in src/server/jobs/routines.ts).
 * STUB from the foundation step — replaced by the contingency package.
 */

/** `portfolio_alerts`: settlement installments due, valuations pending review, enforcement without value, idle guarantees, processes needing verification. Returns the pt-BR summary. */
export async function runPortfolioAlertsRoutine(_rc: RoutineContext): Promise<string> {
  return "Rotina ainda não implementada.";
}

/** `monthly_snapshot`: (re)generates the PREVIEW of the current month; never touches closed periods. Returns the pt-BR summary. */
export async function runMonthlySnapshotRoutine(_rc: RoutineContext): Promise<string> {
  return "Rotina ainda não implementada.";
}
