"use client";

import { ChevronLeft, ChevronRight, Database, ExternalLink, FileText, LoaderCircle } from "lucide-react";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { loadBriefCitationPageAction } from "../actions";
import type { BriefCitationPage } from "../types";

export type CitationChipProps = {
  briefId: string;
  citation: { ref: string; page: number | null; excerpt: string | null };
  /** Title of the cited source (from the brief's sources list). */
  sourceLabel: string | null;
  /** Whether the viewer can open documents (`document:read`). */
  canOpen: boolean;
};

const chipClasses =
  "inline-flex max-w-full items-center gap-1 rounded border px-1.5 py-0.5 text-xs font-medium tabular-nums leading-5";

/** "D1 · p. 3" chip; opens a dialog with the text of that page and the excerpt highlighted. */
export function CitationChip({ briefId, citation, sourceLabel, canOpen }: CitationChipProps) {
  if (citation.ref === "REG") {
    return (
      <span
        className={cn(chipClasses, "border-border bg-surface-muted text-slate-700")}
        title="Dado do cadastro do processo / planilha importada"
      >
        <Database aria-hidden="true" className="size-3.5" />
        Cadastro
      </span>
    );
  }
  const label = `${citation.ref}${citation.page ? ` · p. ${citation.page}` : ""}`;
  const full = `${sourceLabel ?? citation.ref}${citation.page ? `, página ${citation.page}` : ""}`;
  if (!canOpen) {
    return (
      <span className={cn(chipClasses, "border-sky-200 bg-sky-50 text-sky-900")} title={full}>
        <FileText aria-hidden="true" className="size-3.5" />
        {label}
      </span>
    );
  }
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          className={cn(
            chipClasses,
            "cursor-pointer border-sky-200 bg-sky-50 text-sky-900 hover:bg-sky-100 focus-visible:outline-2 focus-visible:outline-ring",
          )}
          title={`Ver trecho: ${full}`}
        >
          <FileText aria-hidden="true" className="size-3.5" />
          {label}
          <span className="sr-only"> — ver o trecho em {full}</span>
        </button>
      </DialogTrigger>
      <DialogContent size="lg">
        <CitationViewer briefId={briefId} citation={citation} sourceLabel={sourceLabel} />
      </DialogContent>
    </Dialog>
  );
}

type Outcome = { status: "error"; message: string } | { status: "ready"; data: BriefCitationPage };
type LoadState = { status: "loading" } | Outcome;

function CitationViewer({
  briefId,
  citation,
  sourceLabel,
}: {
  briefId: string;
  citation: CitationChipProps["citation"];
  sourceLabel: string | null;
}) {
  const [page, setPage] = useState<number | null>(citation.page);
  const [result, setResult] = useState<{ page: number | null; outcome: Outcome } | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadBriefCitationPageAction({ briefId, ref: citation.ref, page })
      .then((r): Outcome => (r.ok && r.data ? { status: "ready", data: r.data } : { status: "error", message: r.ok ? "Trecho indisponível." : r.error }))
      .catch((): Outcome => ({ status: "error", message: "Não foi possível carregar o trecho. Verifique sua conexão e tente novamente." }))
      .then((outcome) => {
        if (!cancelled) setResult({ page, outcome });
      });
    return () => {
      cancelled = true;
    };
  }, [briefId, citation.ref, page]);

  const state: LoadState = result && result.page === page ? result.outcome : { status: "loading" };
  const data = state.status === "ready" ? state.data : null;
  const pageCount = data?.pageCount ?? null;
  const isCitedPage = page === citation.page;

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {citation.ref} · {data?.title ?? sourceLabel ?? "Documento"}
        </DialogTitle>
        <DialogDescription>
          {data
            ? `${data.page ? `Página ${data.page}${pageCount ? ` de ${pageCount}` : ""}` : "Documento sem divisão em páginas"} · versão ${data.versionNumber}. ` +
              "Texto extraído automaticamente do arquivo (conteúdo não confiável)."
            : "Carregando o texto da página citada…"}
        </DialogDescription>
      </DialogHeader>

      {citation.excerpt && isCitedPage ? (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">
          <span className="font-semibold">Trecho citado: </span>“{citation.excerpt}”
        </p>
      ) : null}

      <div aria-live="polite" aria-busy={state.status === "loading"}>
        {state.status === "loading" ? (
          <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
            Carregando…
          </p>
        ) : state.status === "error" ? (
          <Callout tone="danger" role="alert">
            {state.message}
          </Callout>
        ) : (
          <pre
            tabIndex={0}
            aria-label={`Texto da página ${data?.page ?? ""}`}
            className="max-h-[55dvh] overflow-auto rounded-md border border-border bg-surface-muted p-3 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-slate-800"
          >
            {highlight(data!.text, isCitedPage ? citation.excerpt : null)}
            {data!.truncated ? "\n…" : ""}
          </pre>
        )}
      </div>

      <DialogFooter className="flex-wrap gap-2 sm:justify-between">
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!page || page <= 1 || state.status === "loading"}
            onClick={() => setPage((p) => (p && p > 1 ? p - 1 : p))}
          >
            <ChevronLeft aria-hidden="true" />
            Página anterior
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!page || !pageCount || page >= pageCount || state.status === "loading"}
            onClick={() => setPage((p) => (p && pageCount && p < pageCount ? p + 1 : p))}
          >
            Próxima página
            <ChevronRight aria-hidden="true" />
          </Button>
        </div>
        {data ? (
          <Link
            href={`/documentos/${data.documentId}`}
            className="inline-flex items-center gap-1 text-sm font-medium text-primary-700 hover:underline"
          >
            <ExternalLink aria-hidden="true" className="size-4" />
            Abrir documento
          </Link>
        ) : null}
      </DialogFooter>
    </>
  );
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Highlights the excerpt in the page text, ignoring whitespace differences (line breaks of the PDF). */
function highlight(text: string, excerpt: string | null): ReactNode {
  if (!excerpt) return text;
  const words = excerpt.replace(/…$/, "").trim().split(/\s+/).filter(Boolean).slice(0, 40);
  if (!words.length) return text;
  const re = new RegExp(words.map(escapeRegExp).join("\\s+"));
  const m = re.exec(text);
  if (!m) return text;
  return (
    <>
      {text.slice(0, m.index)}
      <mark className="rounded-sm bg-amber-200 px-0.5 text-slate-950">{m[0]}</mark>
      {text.slice(m.index + m[0].length)}
    </>
  );
}
