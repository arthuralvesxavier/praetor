import type { AuthContext } from "@/server/auth/context";

/** "E-mails" tab of the process page (simulated sends about the process). STUB from the foundation step. */
export async function ProcessEmailsTab({ ctx: _ctx, processId: _processId }: { ctx: AuthContext; processId: string }) {
  return <p className="text-sm text-slate-600">Em construção.</p>;
}
