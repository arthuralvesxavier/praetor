import { FINDING_KIND_LABELS, FINDING_KINDS, type AnalysisFinding } from "@/domain/analysis";
import { cn } from "@/lib/utils";
import { SeverityBadge } from "./analysis-badges";
import { severityRank, sourceAnchorId } from "./analysis-labels";

/**
 * Presentation of analysis findings (client-safe, no data access). Findings
 * are suggestions produced from the cited sources, never established facts.
 */

export type SourceRefInfo = { ref: string; label: string };

/** "S1" chips linking to the entry in the "Fontes utilizadas" list. */
export function SourceRefChips({
  analysisId,
  refs,
  sources,
  linkToAnchor = true,
  className,
}: {
  analysisId: string;
  refs: readonly string[];
  sources: readonly SourceRefInfo[];
  /** False in compact views where the sources list is not on the page. */
  linkToAnchor?: boolean;
  className?: string;
}) {
  if (!refs.length) return null;
  const byRef = new Map(sources.map((s) => [s.ref, s.label]));
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1", className)}>
      <span className="text-xs text-muted-foreground">Fontes:</span>
      {refs.map((ref) => {
        const label = byRef.get(ref);
        const chipClasses =
          "inline-flex items-center rounded border border-ai-200 bg-ai-50 px-1.5 py-px font-mono text-[11px] font-semibold text-ai-800";
        const a11y = label ? `Fonte ${ref}: ${label}` : `Fonte ${ref}`;
        return linkToAnchor ? (
          <a
            key={ref}
            href={`#${sourceAnchorId(analysisId, ref)}`}
            title={label}
            aria-label={a11y}
            className={cn(chipClasses, "hover:bg-ai-100 focus-visible:outline-2 focus-visible:outline-ring")}
          >
            {ref}
          </a>
        ) : (
          <span key={ref} title={label} aria-label={a11y} className={chipClasses}>
            {ref}
          </span>
        );
      })}
    </span>
  );
}

function FindingCard({
  analysisId,
  finding,
  sources,
  linkToAnchor,
  showKind,
}: {
  analysisId: string;
  finding: AnalysisFinding;
  sources: readonly SourceRefInfo[];
  linkToAnchor: boolean;
  showKind: boolean;
}) {
  return (
    <li className="rounded-md border border-ai-100 bg-white p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 flex-1 text-sm font-medium text-slate-900">
          {showKind ? (
            <span className="mr-1 text-xs font-normal text-ai-700">{FINDING_KIND_LABELS[finding.kind]} ·</span>
          ) : null}
          {finding.title}
        </p>
        <SeverityBadge severity={finding.severity} />
      </div>
      {finding.detail ? <p className="mt-1 text-sm whitespace-pre-line text-slate-700">{finding.detail}</p> : null}
      {finding.excerpt ? (
        <blockquote className="mt-2 border-l-2 border-ai-300 bg-ai-50/60 py-1 pr-2 pl-3 text-sm text-slate-700 italic">
          “{finding.excerpt}”
        </blockquote>
      ) : null}
      <SourceRefChips
        analysisId={analysisId}
        refs={finding.sourceRefs}
        sources={sources}
        linkToAnchor={linkToAnchor}
        className="mt-2"
      />
    </li>
  );
}

/** Full list grouped by FINDING_KINDS order. */
export function FindingsByKind({
  analysisId,
  findings,
  sources,
  headingLevel = "h3",
}: {
  analysisId: string;
  findings: readonly AnalysisFinding[];
  sources: readonly SourceRefInfo[];
  headingLevel?: "h3" | "h4";
}) {
  if (!findings.length) {
    return <p className="text-sm text-muted-foreground">Nenhum achado foi apontado nesta análise.</p>;
  }
  const Heading = headingLevel;
  const groups = FINDING_KINDS.map((kind) => ({
    kind,
    items: findings.filter((f) => f.kind === kind).sort((a, b) => severityRank(a.severity) - severityRank(b.severity)),
  })).filter((g) => g.items.length > 0);
  return (
    <div className="space-y-5">
      {groups.map((g) => (
        <section key={g.kind} aria-label={FINDING_KIND_LABELS[g.kind]}>
          <Heading className="mb-2 flex items-center gap-2 text-sm font-semibold text-ai-900">
            {FINDING_KIND_LABELS[g.kind]}
            <span className="rounded-full bg-ai-100 px-1.5 text-xs font-semibold text-ai-800 tabular-nums">
              {g.items.length}
            </span>
          </Heading>
          <ul className="space-y-2">
            {g.items.map((f, i) => (
              <FindingCard
                key={`${g.kind}-${i}`}
                analysisId={analysisId}
                finding={f}
                sources={sources}
                linkToAnchor
                showKind={false}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** Top findings (most severe first) for compact views. */
export function TopFindings({
  analysisId,
  findings,
  sources,
  limit = 3,
}: {
  analysisId: string;
  findings: readonly AnalysisFinding[];
  sources: readonly SourceRefInfo[];
  limit?: number;
}) {
  if (!findings.length) return null;
  const top = [...findings].sort((a, b) => severityRank(a.severity) - severityRank(b.severity)).slice(0, limit);
  return (
    <ul className="space-y-2">
      {top.map((f, i) => (
        <FindingCard key={i} analysisId={analysisId} finding={f} sources={sources} linkToAnchor={false} showKind />
      ))}
    </ul>
  );
}
