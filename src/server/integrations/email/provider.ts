import type { EmailMode } from "@/domain/enums";

/**
 * Provider-neutral e-mail interface. In this version the only implementation
 * is `SimulatedEmailProvider`: it accepts the message and returns a synthetic
 * id WITHOUT contacting any server. A future SMTP/API provider implements the
 * same interface; callers (src/modules/emails) never know which one is active.
 *
 * Providers receive already-rendered content and must never log subjects,
 * bodies or addresses (they may contain personal/process data).
 */
export type OutgoingEmail = {
  from: { name: string; address: string };
  to: { name: string; address: string };
  subject: string;
  text: string;
  html: string;
  /** Opaque correlation id (the email_messages row id). */
  messageId: string;
};

export type EmailDeliveryResult = {
  /** Provider message id (simulated: `sim-<uuid>`). */
  providerMessageId: string;
  acceptedAt: Date;
  /** True when nothing was actually delivered. */
  simulated: boolean;
};

export interface EmailProvider {
  name: string;
  mode: EmailMode;
  send(message: OutgoingEmail): Promise<EmailDeliveryResult>;
}

/** Sanitized provider error (`message` never contains addresses or content). */
export class EmailProviderError extends Error {
  readonly retryable: boolean;
  readonly userMessage: string;

  constructor(message: string, opts: { retryable: boolean; userMessage: string }) {
    super(message);
    this.name = "EmailProviderError";
    this.retryable = opts.retryable;
    this.userMessage = opts.userMessage;
  }
}
