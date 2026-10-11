/**
 * Log-safe description of an unexpected error. Database errors wrapped by the
 * ORM embed the query parameters in their message (titles, descriptions,
 * extracted text), so only the error name and driver code are logged.
 */
export function errorSummary(err: unknown): { errorName: string; errorCode: string | null } {
  if (!(err instanceof Error)) return { errorName: "unknown", errorCode: null };
  const code = (err as { code?: unknown }).code ?? (err.cause as { code?: unknown } | undefined)?.code;
  return { errorName: err.name, errorCode: typeof code === "string" ? code : null };
}
