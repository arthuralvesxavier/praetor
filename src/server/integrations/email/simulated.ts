import { randomUUID } from "node:crypto";
import { EmailProviderError, type EmailDeliveryResult, type EmailProvider, type OutgoingEmail } from "./provider";

/** Every simulated message must be identifiable as such by its subject. */
export const SIMULATED_SUBJECT_PREFIX = "[Simulação]";

/**
 * Simulated delivery: nothing leaves the application (no network, no SMTP, no
 * API). The message is only stored (by the caller) and shown in the Central de
 * e-mails as a simulation. As a safety net it refuses messages whose subject
 * does not carry the "[Simulação]" prefix.
 */
export class SimulatedEmailProvider implements EmailProvider {
  readonly name = "simulated";
  readonly mode = "simulated" as const;

  async send(message: OutgoingEmail): Promise<EmailDeliveryResult> {
    if (!message.subject.startsWith(SIMULATED_SUBJECT_PREFIX)) {
      throw new EmailProviderError("simulated_subject_without_prefix", {
        retryable: false,
        userMessage: "Mensagem simulada sem o prefixo “[Simulação]” no assunto: envio não registrado.",
      });
    }
    return { providerMessageId: `sim-${randomUUID()}`, acceptedAt: new Date(), simulated: true };
  }
}
