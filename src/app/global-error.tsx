"use client";

import "./globals.css";

/**
 * Last-resort boundary (replaces the root layout). Self-contained: no app
 * components that could themselves fail, no error details shown.
 */
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="pt-BR">
      <body className="min-h-dvh bg-canvas text-foreground antialiased">
        <title>Erro · Praetor</title>
        <main className="flex min-h-dvh items-center justify-center px-4 py-12">
          <div role="alert" className="w-full max-w-md rounded-lg border border-red-200 bg-white p-8 text-center shadow-sm">
            <p className="text-xs font-semibold tracking-wide text-red-700 uppercase">Erro inesperado</p>
            <h1 className="mt-1 text-xl font-semibold text-slate-900">O Praetor encontrou um problema</h1>
            <p className="mt-2 text-sm text-slate-600">
              Não foi possível exibir esta página. Tente novamente; se o problema persistir, contate o administrador do
              sistema.
            </p>
            {error.digest ? (
              <p className="mt-3 text-xs text-slate-500">
                Código de referência: <code className="font-mono">{error.digest}</code>
              </p>
            ) : null}
            <div className="mt-6 flex flex-col justify-center gap-2 sm:flex-row">
              <button
                type="button"
                onClick={() => retry()}
                className="inline-flex h-9 cursor-pointer items-center justify-center rounded-md bg-[#1f3a5f] px-4 text-sm font-medium text-white hover:bg-[#1a314f] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
              >
                Tentar novamente
              </button>
              {/* Full page load on purpose: the client router may be in a broken state. */}
              <a
                href="/dashboard"
                className="inline-flex h-9 items-center justify-center rounded-md border border-slate-300 bg-white px-4 text-sm font-medium text-slate-800 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
              >
                Ir para o painel executivo
              </a>
            </div>
          </div>
        </main>
      </body>
    </html>
  );
}
