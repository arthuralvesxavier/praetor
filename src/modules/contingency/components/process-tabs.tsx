import type { AuthContext } from "@/server/auth/context";

/**
 * Process-detail tab content owned by the contingency module. The process page
 * (owned by the portfolio package) renders these; each component checks its
 * own permission (`contingency:read`) and loads its own data.
 * STUB from the foundation step.
 */

/** "Valores e risco": valuations history, guarantees, risk classification, exposure and provision. */
export async function ProcessContingencyTab({ ctx: _ctx, processId: _processId }: { ctx: AuthContext; processId: string }) {
  return <p className="text-sm text-slate-600">Em construção.</p>;
}

/** "Acordos": settlements and installments of the process. */
export async function ProcessSettlementsTab({ ctx: _ctx, processId: _processId }: { ctx: AuthContext; processId: string }) {
  return <p className="text-sm text-slate-600">Em construção.</p>;
}

/** Compact card for the overview tab: valor da causa and valor liquidado side by side (never summed), exposure, provision. */
export async function ProcessValuesSummary({ ctx: _ctx, processId: _processId }: { ctx: AuthContext; processId: string }) {
  return null;
}
