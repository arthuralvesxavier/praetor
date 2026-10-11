/**
 * Domain errors thrown by services. Server actions and route handlers convert
 * them to user-facing pt-BR messages with `toActionError()`; anything else is
 * logged and shown as a generic error (never leak internals to the client).
 */
export type AppErrorCode =
  | "not_found"
  | "forbidden"
  | "validation"
  | "conflict"
  | "budget_exceeded"
  | "unauthenticated"
  | "bad_request";

export class AppError extends Error {
  constructor(
    message: string,
    readonly code: AppErrorCode,
    readonly fieldErrors?: Record<string, string[]>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Also used when a record exists but the user cannot see it (do not reveal existence). */
export class NotFoundError extends AppError {
  constructor(message = "Registro não encontrado ou sem permissão de acesso.") {
    super(message, "not_found");
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Você não tem permissão para realizar esta ação.") {
    super(message, "forbidden");
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = "Sessão expirada. Entre novamente.") {
    super(message, "unauthenticated");
  }
}

export class ValidationError extends AppError {
  constructor(message = "Verifique os campos informados.", fieldErrors?: Record<string, string[]>) {
    super(message, "validation", fieldErrors);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, "conflict");
  }
}

export class BudgetExceededError extends AppError {
  constructor(message = "O limite mensal de uso de IA da organização foi atingido.") {
    super(message, "budget_exceeded");
  }
}

/** Shape returned by server actions (used with React's useActionState). */
export type ActionResult<T = undefined> =
  | { ok: true; data?: T; message?: string }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

export function toActionError(err: unknown): { ok: false; error: string; fieldErrors?: Record<string, string[]> } {
  if (err instanceof AppError) return { ok: false, error: err.message, fieldErrors: err.fieldErrors };
  return { ok: false, error: "Não foi possível concluir a operação. Tente novamente." };
}
