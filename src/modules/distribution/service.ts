/**
 * Distribuição de demandas (RF-20). STUB from the foundation step — the
 * signatures are cross-module contracts; the intake/distribution package
 * replaces the bodies.
 */
import type { AssignmentMethod } from "@/domain/enums";
import type { AuthContext } from "@/server/auth/context";

export type AssignmentDecision = {
  userId: string | null;
  userName: string | null;
  method: AssignmentMethod;
  ruleId: string | null;
  ruleName: string | null;
  lawFirmId: string | null;
  unitId: string | null;
  /** pt-BR explanation shown in the intake timeline and the e-mail. */
  reason: string;
};

/** Decides who should handle the process (does not persist). */
export async function decideAssignment(_ctx: AuthContext, _processId: string): Promise<AssignmentDecision> {
  throw new Error("not_implemented: decideAssignment");
}

/**
 * Decides and applies the assignment (responsibleId; lawFirmId/unitId only
 * when empty), audited. Keeps an existing responsible unless `force`.
 * Requires `distribution:manage` or `intake:manage` (system context allowed).
 */
export async function assignResponsible(
  _ctx: AuthContext,
  _processId: string,
  _opts: { force?: boolean } = {},
): Promise<AssignmentDecision> {
  throw new Error("not_implemented: assignResponsible");
}
