"use client";

import { useEffect } from "react";
import { ButtonLink } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";

/**
 * Error boundary for authenticated pages. Shows a generic pt-BR message only:
 * never the error message or stack (server errors arrive redacted anyway).
 */
export default function AppError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    // Browser console only; the server already logged the original error.
    console.error("Falha ao carregar a página", error.digest ?? "");
  }, [error]);

  return (
    <div className="py-6">
      <ErrorState
        title="Não foi possível carregar esta página"
        description={
          <>
            <p>
              Ocorreu um erro inesperado. Tente novamente em instantes; se o problema persistir, contate o
              administrador do sistema.
            </p>
            {error.digest ? (
              <p className="mt-2 text-xs text-slate-500">
                Código de referência: <code className="font-mono">{error.digest}</code>
              </p>
            ) : null}
          </>
        }
        retry={() => retry()}
        action={
          <ButtonLink href="/dashboard" variant="ghost">
            Ir para o painel executivo
          </ButtonLink>
        }
      />
    </div>
  );
}
