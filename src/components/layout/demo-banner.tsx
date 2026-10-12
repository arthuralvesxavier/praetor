"use client";

import { ChevronRight, FlaskConical } from "lucide-react";
import Link from "next/link";
import { HeaderPopover } from "./header-popover";

/**
 * One-line amber banner shown on every screen of a demo organization: the data
 * is fictitious and the preliminary analysis and e-mails are simulated. The
 * details (including "do not enter real data") are in the "Saiba mais" panel.
 * Below `sm` only the first sentence fits on one line; the header
 * "Simulações" badge lists the simulations at every width.
 */
export function DemoBanner() {
  return (
    <div role="note" aria-label="Aviso de ambiente de demonstração" className="demo-stripes border-b border-amber-300">
      <div className="mx-auto flex max-w-7xl items-center justify-center gap-2 px-4 py-1 text-xs text-amber-950 sm:px-6">
        <FlaskConical aria-hidden="true" className="size-3.5 shrink-0" />
        <p className="min-w-0 truncate">
          <strong className="font-semibold">
            {/* Below 360 px: "Demonstração: dados fictícios." so the line is not cut. */}
            <span className="max-[359px]:hidden">Ambiente de </span>
            <span className="max-[359px]:capitalize">demonstração:</span>
          </strong>{" "}
          dados fictícios.
          <span className="hidden sm:inline"> Análise preliminar e e-mails são simulados.</span>
        </p>
        <HeaderPopover
          triggerLabel="Saiba mais sobre o ambiente de demonstração"
          triggerClassName="shrink-0 rounded-sm font-semibold whitespace-nowrap underline decoration-amber-700/60 underline-offset-2 hover:decoration-amber-950"
          title="Sobre o ambiente de demonstração"
          align="center"
          trigger="Saiba mais"
        >
          <DemoInfoPanel />
        </HeaderPopover>
      </div>
    </div>
  );
}

/** Content of the "Saiba mais" panel (exported for the static render test). */
export function DemoInfoPanel() {
  return (
    <div className="px-3.5 py-3 text-sm text-slate-700">
      <p className="font-semibold text-slate-900">Sobre o ambiente de demonstração</p>
      <ul className="mt-2 list-disc space-y-1.5 pl-4 text-xs leading-relaxed marker:text-amber-600">
        <li>Os processos, pessoas, empresas e valores desta organização são fictícios.</li>
        <li>
          A análise preliminar é gerada por regras fixas, sem inteligência artificial, e passa pela revisão do advogado.
        </li>
        <li>Nenhum e-mail é enviado de verdade. As mensagens ficam registradas dentro do Praetor.</li>
        <li className="font-medium text-slate-900">Não insira informações reais ou confidenciais.</li>
      </ul>
      <Link
        href="/#como-funciona"
        className="mt-3 inline-flex items-center gap-1 rounded text-xs font-medium text-primary-700 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        Como o Praetor funciona
        <ChevronRight aria-hidden="true" className="size-3.5" />
      </Link>
    </div>
  );
}
