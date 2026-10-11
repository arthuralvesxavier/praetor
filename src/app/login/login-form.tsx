"use client";

import { FlaskConical, LogIn } from "lucide-react";
import { useActionState, useRef } from "react";
import { FormField } from "@/components/ui/form-field";
import { FormMessage } from "@/components/ui/form-message";
import { Input } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { DEMO_ACCOUNTS, DEMO_PASSWORD } from "@/domain/demo";
import { fieldError } from "@/lib/form";
import { loginAction, type LoginState } from "./actions";

export function LoginForm({ next, showDemoAccounts }: { next: string | null; showDemoAccounts: boolean }) {
  const [state, formAction] = useActionState<LoginState, FormData>(loginAction, null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  function fillDemoAccount(email: string) {
    if (emailRef.current) emailRef.current.value = email;
    if (passwordRef.current) passwordRef.current.value = DEMO_PASSWORD;
    passwordRef.current?.focus();
  }

  return (
    <div className="flex flex-col gap-6">
      <form action={formAction} className="flex flex-col gap-4" noValidate>
        {next ? <input type="hidden" name="next" value={next} /> : null}
        <FormMessage state={state} />
        <FormField label="E-mail" htmlFor="email" required error={fieldError(state, "email")}>
          <Input
            ref={emailRef}
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            inputMode="email"
            spellCheck={false}
            required
            defaultValue={state?.email ?? ""}
            autoFocus
          />
        </FormField>
        <FormField label="Senha" htmlFor="password" required error={fieldError(state, "password")}>
          <Input ref={passwordRef} id="password" name="password" type="password" autoComplete="current-password" required />
        </FormField>
        <SubmitButton size="lg" className="mt-2 w-full" pendingLabel="Entrando…">
          <LogIn aria-hidden="true" />
          Entrar
        </SubmitButton>
      </form>

      {showDemoAccounts ? (
        <section aria-labelledby="demo-accounts-title" className="rounded-lg border border-amber-300 bg-amber-50 p-4">
          <h2 id="demo-accounts-title" className="flex items-center gap-2 text-sm font-semibold text-amber-950">
            <FlaskConical aria-hidden="true" className="size-4" />
            Contas de demonstração
          </h2>
          <p className="mt-1 text-xs text-amber-900">
            Este é um ambiente demonstrativo: todos os dados são fictícios. Senha de todas as contas:{" "}
            <code className="rounded bg-white/80 px-1 py-0.5 font-mono text-[12px] text-amber-950">{DEMO_PASSWORD}</code>
          </p>
          <ul className="mt-3 divide-y divide-amber-200 rounded-md border border-amber-200 bg-white/70">
            {DEMO_ACCOUNTS.map((account) => (
              <li key={account.email} className="flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-slate-900">{account.name}</p>
                  <p className="text-xs text-slate-600">{account.description}</p>
                  <p className="truncate font-mono text-[12px] text-slate-700">{account.email}</p>
                </div>
                <button
                  type="button"
                  onClick={() => fillDemoAccount(account.email)}
                  className="shrink-0 cursor-pointer self-start rounded-md border border-amber-300 bg-white px-2.5 py-1 text-xs font-medium text-amber-950 hover:bg-amber-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:self-center"
                  aria-label={`Preencher o formulário com a conta de ${account.name}`}
                >
                  Usar esta conta
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
