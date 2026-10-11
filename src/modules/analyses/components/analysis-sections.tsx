import { FileText, Scissors } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { ANALYSIS_DISCLAIMER, DEMO_MODE_NOTICE, type AnalysisResult } from "@/domain/analysis";
import type { AiMode } from "@/domain/enums";
import { Badge } from "@/components/ui/badge";
import { Callout } from "@/components/ui/callout";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { PROMPT_INJECTION_NOTICE, type AnalysisSourceItem } from "../service";
import { sourceAnchorId, sourceTypeLabel } from "./analysis-labels";

/** Presentational building blocks shared by the compact and full analysis views (no data access). */

/** Notice shown when the analysed content contained instructions aimed at the AI. */
export function PromptInjectionNotice({ result, className }: { result: AnalysisResult | null; className?: string }) {
  if (!result?.promptInjectionSuspected && !result?.systemNotices.includes(PROMPT_INJECTION_NOTICE)) return null;
  return (
    <Callout tone="warning" title="Possível tentativa de manipulação da IA" className={className}>
      {PROMPT_INJECTION_NOTICE} Confira as fontes com atenção redobrada antes de usar o resultado.
    </Callout>
  );
}

/** Demo label shown at the very top of any demonstrative result. */
export function DemoNotice({ mode, className }: { mode: AiMode; className?: string }) {
  if (mode !== "demo") return null;
  return (
    <Callout tone="warning" title="Resultado demonstrativo — não é uma análise real" className={className}>
      {DEMO_MODE_NOTICE}
    </Callout>
  );
}

export function DisclaimerNotice({ className }: { className?: string }) {
  return (
    <Callout tone="ai" title="Apoio à análise jurídica" className={className}>
      {ANALYSIS_DISCLAIMER}
    </Callout>
  );
}

/** System notices stored with the result, minus the ones already shown by dedicated callouts. */
export function systemNoticesToShow(result: AnalysisResult | null): string[] {
  if (!result) return [];
  return result.systemNotices.filter((n) => n.trim() && n !== DEMO_MODE_NOTICE && n !== PROMPT_INJECTION_NOTICE);
}

export function BulletList({
  items,
  empty,
  tone = "neutral",
  className,
}: {
  items: readonly string[];
  empty: string;
  tone?: "neutral" | "warning";
  className?: string;
}) {
  if (!items.length) return <p className={cn("text-sm text-muted-foreground", className)}>{empty}</p>;
  return (
    <ul className={cn("space-y-1.5 text-sm text-slate-800", className)}>
      {items.map((item, i) => (
        <li key={i} className="flex gap-2">
          <span
            aria-hidden="true"
            className={cn("mt-2 size-1.5 shrink-0 rounded-full", tone === "warning" ? "bg-amber-500" : "bg-slate-400")}
          />
          <span className="min-w-0 whitespace-pre-line">{item}</span>
        </li>
      ))}
    </ul>
  );
}

/** "Fontes utilizadas": ref, label (link), type, version, hash prefix, size and truncation flag. */
export function SourcesList({
  analysisId,
  sources,
  hashPrefixes,
  anchors = true,
  className,
}: {
  analysisId: string;
  sources: readonly AnalysisSourceItem[];
  hashPrefixes?: ReadonlyMap<string, string>;
  /** Give each entry an id so "S1" chips can link to it (full view only). */
  anchors?: boolean;
  className?: string;
}) {
  if (!sources.length) {
    return (
      <p className={cn("text-sm text-muted-foreground", className)}>
        Nenhuma fonte foi enviada para esta análise.
      </p>
    );
  }
  return (
    <ol className={cn("space-y-2", className)}>
      {sources.map((s) => {
        const hash = hashPrefixes?.get(s.ref);
        return (
          <li
            key={s.ref}
            id={anchors ? sourceAnchorId(analysisId, s.ref) : undefined}
            className="scroll-mt-24 rounded-md border border-border bg-white p-3 target:border-ai-400 target:ring-2 target:ring-ai-200"
          >
            <div className="flex flex-wrap items-start gap-2">
              <span className="inline-flex items-center rounded border border-ai-200 bg-ai-50 px-1.5 py-px font-mono text-xs font-semibold text-ai-800">
                {s.ref}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium break-words text-slate-900">
                  {s.href ? (
                    <Link href={s.href} className="text-primary-700 underline-offset-2 hover:text-primary-900 hover:underline">
                      {s.label}
                    </Link>
                  ) : (
                    s.label
                  )}
                </p>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <FileText aria-hidden="true" className="size-3.5" />
                    {sourceTypeLabel(s.sourceType)}
                  </span>
                  {s.versionNumber != null ? <span>Versão {s.versionNumber}</span> : null}
                  <span>{formatNumber(s.charCount)} caracteres enviados</span>
                  {hash ? (
                    <span title="Prefixo do hash SHA-256 do conteúdo analisado (identifica exatamente a versão usada)">
                      Hash <code className="font-mono">{hash}</code>
                    </span>
                  ) : null}
                </p>
              </div>
              {s.truncated ? (
                <Badge tone="warning" icon={<Scissors />} title="O texto excedeu o limite de tamanho e foi cortado">
                  Conteúdo truncado
                </Badge>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** Section with an h2/h3 heading used in the full view. */
export function ResultSection({
  title,
  description,
  id,
  children,
  as: Heading = "h2",
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  id?: string;
  children: ReactNode;
  as?: "h2" | "h3";
  className?: string;
}) {
  const headingId = id ? `${id}-titulo` : undefined;
  return (
    <section id={id} aria-labelledby={headingId} className={cn("scroll-mt-24 space-y-3", className)}>
      <div>
        <Heading id={headingId} className="text-base font-semibold text-slate-900">
          {title}
        </Heading>
        {description ? <p className="mt-0.5 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}
