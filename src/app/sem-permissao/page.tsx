import { ShieldX } from "lucide-react";
import type { Metadata } from "next";
import { ButtonLink } from "@/components/ui/button";

export const metadata: Metadata = { title: "Acesso não permitido" };

/** Target of requirePageContext(permission) when the user lacks the permission (HTTP 403 equivalent). */
export default function NoPermissionPage() {
  return (
    <main id="conteudo" className="flex min-h-dvh items-center justify-center px-4 py-12">
      <div className="w-full max-w-md rounded-lg border border-border bg-surface p-8 text-center shadow-xs">
        <span
          aria-hidden="true"
          className="mx-auto mb-4 inline-flex size-12 items-center justify-center rounded-full bg-amber-50 text-amber-700"
        >
          <ShieldX className="size-6" />
        </span>
        <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Acesso restrito</p>
        <h1 className="mt-1 text-xl font-semibold text-slate-900">Você não tem permissão para acessar esta página</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Seu perfil de acesso não inclui esta funcionalidade. Se você precisa dela para o seu trabalho, solicite a
          liberação ao administrador do Praetor na sua organização.
        </p>
        <div className="mt-6 flex flex-col justify-center gap-2 sm:flex-row">
          <ButtonLink href="/dashboard">Voltar ao dashboard</ButtonLink>
        </div>
      </div>
    </main>
  );
}
