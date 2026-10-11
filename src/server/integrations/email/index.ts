import type { EmailProvider } from "./provider";
import { SimulatedEmailProvider } from "./simulated";

export { EmailProviderError } from "./provider";
export type { EmailDeliveryResult, EmailProvider, OutgoingEmail } from "./provider";
export { SimulatedEmailProvider } from "./simulated";

let override: EmailProvider | null = null;
let cached: EmailProvider | null = null;

/**
 * Active e-mail provider. This version ships ONLY the simulated provider: no
 * SMTP/API credentials are read and no message is ever delivered. To add a
 * real provider later, implement `EmailProvider` and select it here from an
 * environment variable (keeping `simulated` as the default).
 */
export function getEmailProvider(): EmailProvider {
  if (override) return override;
  cached ??= new SimulatedEmailProvider();
  return cached;
}

/** What the UI shows about e-mail delivery (never secrets). */
export function getEmailRuntimeInfo(): { mode: "simulated" | "live"; provider: string } {
  const p = getEmailProvider();
  return { mode: p.mode, provider: p.name };
}

/** Tests only. */
export function setEmailProviderForTesting(provider: EmailProvider | null): void {
  override = provider;
}
