/**
 * Per-API-key request limit of the inbound API (fixed one-minute window,
 * in memory, per server process: with several instances the limit is per
 * instance). Answers 429 with Retry-After instead of waiting.
 */

export const INBOUND_REQUESTS_PER_MINUTE = 60;
const WINDOW_MS = 60_000;

const windows = new Map<string, { start: number; count: number }>();

export function consumeInboundQuota(
  apiKeyId: string,
  opts: { limit?: number; now?: number } = {},
): { ok: true; remaining: number } | { ok: false; retryAfterSeconds: number } {
  const limit = Math.max(1, opts.limit ?? INBOUND_REQUESTS_PER_MINUTE);
  const now = opts.now ?? Date.now();
  const current = windows.get(apiKeyId);
  if (!current || now - current.start >= WINDOW_MS) {
    windows.set(apiKeyId, { start: now, count: 1 });
    if (windows.size > 10_000) {
      for (const [key, w] of windows) if (now - w.start >= WINDOW_MS) windows.delete(key);
    }
    return { ok: true, remaining: limit - 1 };
  }
  if (current.count >= limit) {
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((current.start + WINDOW_MS - now) / 1000)) };
  }
  current.count++;
  return { ok: true, remaining: limit - current.count };
}

/** Tests only. */
export function resetInboundQuotas(): void {
  windows.clear();
}
