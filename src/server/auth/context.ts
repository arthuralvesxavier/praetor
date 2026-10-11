import type { Role } from "@/domain/enums";

/**
 * Identity every service call runs under. Services must never trust ids from
 * the client for organization or user — they always come from here.
 *
 * `kind: "system"` is used by background jobs and routines: it is still bound
 * to a single organization but bypasses per-user scoping.
 */
export type AuthContext = {
  kind: "user" | "system";
  userId: string | null;
  organizationId: string;
  role: Role;
  unitId: string | null;
  /** Law firm of an `external_counsel` user (their row scope). Absent/null for everyone else. */
  lawFirmId?: string | null;
  name: string;
  email: string | null;
  isDemoOrganization: boolean;
  ipAddress?: string | null;
};

export type UserContext = AuthContext & { kind: "user"; userId: string };

export function systemContext(organizationId: string, isDemoOrganization = false): AuthContext {
  return {
    kind: "system",
    userId: null,
    organizationId,
    role: "admin",
    unitId: null,
    lawFirmId: null,
    name: "Sistema",
    email: null,
    isDemoOrganization,
  };
}
