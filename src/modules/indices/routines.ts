import { systemContext } from "@/server/auth/context";
import type { RoutineContext } from "@/server/jobs/routines";
import { describeIndexRefresh, refreshIndexSeries } from "./service";

/**
 * Routine body (wired in src/server/jobs/routines.ts).
 *
 * `index_series_refresh` (daily): fetches the months missing in the IPCA-E,
 * IPCA, INPC, Selic and TR series from the Banco Central SGS API. The series
 * are shared by every organization, so the runs of other organizations find
 * nothing to fetch (idempotent) and a series consulted recently is skipped.
 * Failures are recorded on the series and shown in /admin/integracoes.
 */
export async function runIndexSeriesRefreshRoutine(rc: RoutineContext): Promise<string> {
  const summary = await refreshIndexSeries(systemContext(rc.organizationId, rc.isDemo));
  return describeIndexRefresh(summary);
}
