"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { safeNextPath } from "@/lib/safe-redirect";
import { signIn } from "@/server/auth/session";
import { AppError, toActionError } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";

/** Login form state. The typed e-mail is echoed back so the field keeps it after a failed attempt (never the password). */
export type LoginState = {
  ok: false;
  error: string;
  fieldErrors?: Record<string, string[]>;
  email?: string;
} | null;

const loginSchema = z.object({
  email: z.string().min(1, "Informe o e-mail.").max(254, "E-mail muito longo.").pipe(z.email("Informe um e-mail válido.")),
  password: z.string().min(1, "Informe a senha.").max(200, "Senha muito longa."),
});

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const rawEmail = formData.get("email");
  const rawPassword = formData.get("password");
  const email = typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";
  const parsed = loginSchema.safeParse({
    email,
    password: typeof rawPassword === "string" ? rawPassword : "",
  });
  if (!parsed.success) {
    return {
      ok: false,
      error: "Verifique os campos informados.",
      fieldErrors: z.flattenError(parsed.error).fieldErrors,
      email,
    };
  }

  try {
    await signIn(parsed.data.email, parsed.data.password);
  } catch (error) {
    // InvalidCredentialsError carries a generic message ("E-mail ou senha inválidos." / throttling notice).
    if (!(error instanceof AppError)) logger.error("action_failed", { action: "login", error });
    return { ...toActionError(error), email };
  }

  redirect(safeNextPath(formData.get("next")) ?? "/dashboard");
}
