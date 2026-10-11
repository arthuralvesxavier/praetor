import { SearchX } from "lucide-react";
import type { Metadata } from "next";
import { ButtonLink } from "@/components/ui/button";

export const metadata: Metadata = { title: "Página não encontrada" };

export default function NotFound() {
  return (
    <main id="conteudo" className="flex min-h-dvh items-center justify-center px-4 py-12">
      <div className="w-full max-w-md rounded-lg border border-border bg-surface p-8 text-center shadow-xs">
        <span
          aria-hidden="true"
          className="mx-auto mb-4 inline-flex size-12 items-center justify-center rounded-full bg-slate-100 text-slate-500"
        >
          <SearchX className="size-6" />
        </span>
        <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Erro 404</p>
        <h1 className="mt-1 text-xl font-semibold text-slate-900">Página não encontrada</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          O endereço acessado não existe ou foi movido. Verifique o link ou volte para o início.
        </p>
        <ButtonLink href="/dashboard" className="mt-6">
          Ir para o dashboard
        </ButtonLink>
      </div>
    </main>
  );
}
