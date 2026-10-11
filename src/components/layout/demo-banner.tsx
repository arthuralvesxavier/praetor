import { FlaskConical } from "lucide-react";

/** Amber striped banner shown on every screen of a demo organization. */
export function DemoBanner() {
  return (
    <div role="note" aria-label="Aviso de ambiente demonstrativo" className="demo-stripes border-b border-amber-300">
      <p className="mx-auto flex max-w-7xl items-start gap-2 px-4 py-1.5 text-xs font-medium text-amber-950 sm:items-center sm:justify-center sm:px-6">
        <FlaskConical aria-hidden="true" className="mt-px size-3.5 shrink-0 sm:mt-0" />
        <span>
          <strong className="font-semibold">Ambiente demonstrativo</strong> — todos os dados são fictícios. Não insira
          informações reais ou confidenciais.
        </span>
      </p>
    </div>
  );
}
