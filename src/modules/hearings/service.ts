/**
 * Audiências. STUB from the foundation step — signatures are cross-module
 * contracts (docs/dev/MODULE_CONTRACTS.md); the hearings package replaces them.
 */
import type { HearingKind, HearingMode, HearingStatus } from "@/domain/enums";
import type { AuthContext } from "@/server/auth/context";

export type UpcomingHearing = {
  id: string;
  processId: string;
  processNumber: string;
  processTitle: string;
  kind: HearingKind;
  mode: HearingMode;
  status: HearingStatus;
  scheduledAt: Date;
  location: string | null;
  responsibleName: string | null;
};

/** Scheduled hearings of visible processes from now on (default 30 days, 10 items). Requires `process:read`. */
export async function listUpcomingHearings(
  _ctx: AuthContext,
  _opts: { days?: number; limit?: number } = {},
): Promise<UpcomingHearing[]> {
  return [];
}
