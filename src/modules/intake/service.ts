/**
 * Entrada de processos (pipeline). STUB from the foundation step — the
 * signatures are cross-module contracts; the intake package replaces them.
 */
import type { AuthContext } from "@/server/auth/context";

/** Job handler body for `intake.process`: assign → generate brief → notify (simulated e-mail). Idempotent per step. */
export async function processIntakeJob(_intakeId: string, _opts: { attempt: number; maxAttempts: number }): Promise<void> {
  throw new Error("not_implemented: processIntakeJob");
}

export type IntakeCounts = {
  received: number;
  inProgress: number;
  awaitingReview: number;
  approved: number;
  failed: number;
};

/** Counts of intakes visible to ctx (dashboard / nav badges). Requires `process:read`. */
export async function getIntakeCounts(_ctx: AuthContext): Promise<IntakeCounts> {
  return { received: 0, inProgress: 0, awaitingReview: 0, approved: 0, failed: 0 };
}
