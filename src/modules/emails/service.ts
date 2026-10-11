/**
 * Central de e-mails (SIMULATED delivery in this version). STUB from the
 * foundation step — signatures are cross-module contracts; the emails package
 * replaces the bodies.
 */
import type { EmailTemplate, EntityType } from "@/domain/enums";
import type { AuthContext } from "@/server/auth/context";
import type { EmailTemplateDataMap } from "./templates";

export type SendTemplatedEmailInput<T extends EmailTemplate> = {
  template: T;
  /** Recipient user (must belong to ctx.organizationId and be active). */
  toUserId: string;
  data: EmailTemplateDataMap[T];
  /** App path the e-mail links to, e.g. `/processos/<id>?aba=analise-preliminar`. */
  linkPath: string;
  processId?: string | null;
  briefId?: string | null;
  intakeId?: string | null;
  entity?: { type: EntityType; id: string } | null;
};

/**
 * Renders the template, stores the message and "sends" it through the active
 * EmailProvider (simulated: nothing is delivered). System context allowed;
 * user contexts need `email:send`. Never logs subject/body/addresses.
 */
export async function sendTemplatedEmail<T extends EmailTemplate>(
  _ctx: AuthContext,
  _input: SendTemplatedEmailInput<T>,
): Promise<{ emailId: string }> {
  throw new Error("not_implemented: sendTemplatedEmail");
}
