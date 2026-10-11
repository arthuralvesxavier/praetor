import type { AuthContext } from "@/server/auth/context";

/** "Audiências" tab of the process page. STUB from the foundation step. */
export async function ProcessHearingsTab({ ctx: _ctx, processId: _processId }: { ctx: AuthContext; processId: string }) {
  return <p className="text-sm text-slate-600">Em construção.</p>;
}
