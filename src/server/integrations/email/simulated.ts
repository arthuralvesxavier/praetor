import { randomUUID } from "node:crypto";
import type { EmailDeliveryResult, EmailProvider, OutgoingEmail } from "./provider";

/**
 * Simulated delivery: nothing leaves the application. The message is only
 * stored (by the caller) and shown in the Central de e-mails as a simulation.
 */
export class SimulatedEmailProvider implements EmailProvider {
  readonly name = "simulated";
  readonly mode = "simulated" as const;

  async send(_message: OutgoingEmail): Promise<EmailDeliveryResult> {
    return { providerMessageId: `sim-${randomUUID()}`, acceptedAt: new Date(), simulated: true };
  }
}
