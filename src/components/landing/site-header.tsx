"use client";

import { ArrowRight, Menu, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Logo } from "@/components/brand/logo";
import { cn } from "@/lib/utils";

const LINKS = [
  { href: "#plataforma", label: "Plataforma" },
  { href: "#como-funciona", label: "Como funciona" },
  { href: "#seguranca", label: "Segurança" },
  { href: "#por-que-praetor", label: "Por que Praetor" },
  { href: "#perguntas", label: "Perguntas" },
];

/** Sticky header: transparent over the hero, solid with blur after scrolling. */
export function SiteHeader({ cta }: { cta: { href: string; label: string } }) {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={cn(
        "fixed inset-x-0 top-0 z-40 transition-[background-color,box-shadow,backdrop-filter] duration-300",
        scrolled || open ? "bg-navy-900/90 shadow-lg shadow-black/10 backdrop-blur-md" : "bg-transparent",
      )}
    >
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6">
        <Link href="/" aria-label="Praetor, página inicial" className="rounded-md py-1 focus-visible:outline-gold-400">
          <Logo size="md" title="" />
        </Link>
        <nav aria-label="Seções da página" className="hidden items-center gap-7 text-sm text-slate-300 lg:flex">
          {LINKS.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className="relative transition-colors hover:text-white after:absolute after:-bottom-1 after:left-0 after:h-px after:w-0 after:bg-gold-400 after:transition-all hover:after:w-full"
            >
              {l.label}
            </a>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <Link
            href={cta.href}
            className="group hidden items-center gap-1.5 rounded-full bg-white px-4 py-2 text-sm font-semibold text-navy-900 shadow-sm transition hover:bg-gold-300 sm:inline-flex"
          >
            {cta.label}
            <ArrowRight aria-hidden="true" className="size-4 transition-transform group-hover:translate-x-0.5" />
          </Link>
          <button
            type="button"
            className="inline-flex size-10 cursor-pointer items-center justify-center rounded-md text-white focus-visible:outline-gold-400 lg:hidden"
            aria-expanded={open}
            aria-controls="menu-site"
            aria-label={open ? "Fechar menu" : "Abrir menu"}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? <X aria-hidden="true" className="size-5" /> : <Menu aria-hidden="true" className="size-5" />}
          </button>
        </div>
      </div>
      {open ? (
        <nav id="menu-site" aria-label="Seções da página" className="border-t border-white/10 px-4 pb-5 lg:hidden">
          <ul className="flex flex-col py-2">
            {LINKS.map((l) => (
              <li key={l.href}>
                <a
                  href={l.href}
                  onClick={() => setOpen(false)}
                  className="block py-2.5 text-base text-slate-200 hover:text-white"
                >
                  {l.label}
                </a>
              </li>
            ))}
          </ul>
          <Link
            href={cta.href}
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-full bg-white px-4 py-2.5 text-sm font-semibold text-navy-900"
          >
            {cta.label}
            <ArrowRight aria-hidden="true" className="size-4" />
          </Link>
        </nav>
      ) : null}
    </header>
  );
}
