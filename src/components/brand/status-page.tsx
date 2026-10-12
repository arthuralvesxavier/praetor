import Link from "next/link";
import type { ReactNode } from "react";
import { LogoWordmark } from "./logo";

/**
 * Full-page brand frame for standalone status screens (404, sem permissão):
 * navy top bar with the official wordmark, centered card, gold rule.
 */
export function BrandStatusPage({
  icon,
  kicker,
  title,
  children,
  actions,
}: {
  icon: ReactNode;
  kicker: string;
  title: string;
  children: ReactNode;
  actions: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <header className="bg-navy-900">
        <div className="mx-auto flex h-14 max-w-5xl items-center px-4 sm:px-6">
          <Link
            href="/"
            aria-label="Praetor — página inicial"
            className="inline-flex rounded-md py-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-400"
          >
            <LogoWordmark variant="light" title="" className="h-[22px]" />
          </Link>
        </div>
        <div aria-hidden="true" className="h-0.5 bg-gradient-to-r from-gold-400 via-gold-300 to-transparent" />
      </header>
      <main id="conteudo" className="flex flex-1 items-center justify-center px-4 py-12">
        <div className="w-full max-w-md rounded-xl border border-border bg-surface p-8 text-center shadow-sm">
          <span
            aria-hidden="true"
            className="mx-auto mb-5 inline-flex size-12 items-center justify-center rounded-full bg-navy-50 text-navy-700 ring-1 ring-navy-100 [&_svg]:size-6"
          >
            {icon}
          </span>
          <p className="text-xs font-semibold tracking-[0.16em] text-gold-700 uppercase">{kicker}</p>
          <h1 className="mt-2 font-display text-3xl leading-tight font-semibold text-navy-900">{title}</h1>
          <div className="mt-3 text-sm leading-relaxed text-muted-foreground">{children}</div>
          <div className="mt-7 flex flex-col justify-center gap-2 sm:flex-row">{actions}</div>
        </div>
      </main>
    </div>
  );
}
