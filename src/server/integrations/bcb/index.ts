import { BcbSgsClient, type SgsClient } from "./sgs";

export * from "./sgs";

/**
 * SGS client registry. The SGS API is public (no key): the real client is the
 * default. Tests install a fake with `setSgsClientForTesting` (no network).
 */

let override: SgsClient | undefined;

export function getSgsClient(): SgsClient {
  return override ?? new BcbSgsClient();
}

/** Tests only: `undefined` restores the real client. */
export function setSgsClientForTesting(client: SgsClient | undefined): void {
  override = client;
}
