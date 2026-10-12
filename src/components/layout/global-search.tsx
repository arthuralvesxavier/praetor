"use client";

import { Search } from "lucide-react";
import Form from "next/form";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/**
 * Header search: GET form to /busca?q= (client-side navigation, works without
 * JavaScript). "/" or Ctrl/⌘+K focuses the field from anywhere on the page.
 */
export function GlobalSearch({ className }: { className?: string }) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const shortcut =
        (event.key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey) ||
        ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k");
      if (!shortcut || event.defaultPrevented) return;
      if (event.key === "/" && isTypingTarget(event.target)) return;
      event.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <Form
      action="/busca"
      prefetch={false}
      role="search"
      aria-label="Busca global"
      className={cn("relative", className)}
    >
      <label htmlFor="busca-global" className="sr-only">
        Buscar processos, documentos, contratos e ocorrências
      </label>
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-500"
      />
      <input
        ref={inputRef}
        id="busca-global"
        name="q"
        type="search"
        required
        minLength={2}
        maxLength={120}
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="search"
        aria-describedby="busca-global-dica"
        placeholder="Buscar nº CNJ, parte, título…"
        className={cn(
          "h-9 w-full rounded-md border border-border-strong bg-surface-muted pr-10 pl-9 text-sm text-slate-900 shadow-xs",
          "placeholder:text-slate-500 transition-colors hover:border-slate-400",
          "focus-visible:border-primary-500 focus-visible:bg-white focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring",
          "[&::-webkit-search-cancel-button]:hidden",
        )}
      />
      <span id="busca-global-dica" className="sr-only">
        Atalho: tecla barra ou Ctrl+K. Mínimo de 2 caracteres.
      </span>
      <kbd
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-2.5 hidden -translate-y-1/2 rounded border border-border-strong bg-white px-1.5 font-sans text-[11px] leading-5 text-slate-600 xl:inline-block"
      >
        /
      </kbd>
    </Form>
  );
}
