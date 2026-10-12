import { Calculator, FlaskConical } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PriorityBadge } from "@/components/ui/priority-badge";
import { RiskBadge } from "@/components/ui/risk-badge";
import {
  CASE_BRIEF_SECTIONS,
  EVIDENCE_HOLDER_LABELS,
  type BriefAmount,
  type BriefCitation,
  type BriefRisk,
  type CaseBriefSectionKey,
  type Provenance,
  type StoredCaseBrief,
} from "@/domain/case-brief";
import { formatDate, formatMoneyCents, pluralize } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ProvenanceBadge } from "./brief-badges";
import { BriefItemAction } from "./brief-actions";
import { CitationChip } from "./citation-chip";

export type BriefViewAbilities = {
  canOpenDocuments: boolean;
  /** Suggestions may be applied (status ready/in review/approved). */
  applicable: boolean;
  canCreateDeadline: boolean;
  canCreateTask: boolean;
  canProposeAmount: boolean;
};

export type BriefViewProps = {
  briefId: string;
  processId: string;
  content: StoredCaseBrief;
  /** ref -> source label ("Petição inicial"...). */
  sourceLabels: Record<string, string>;
  abilities: BriefViewAbilities;
};

/** Section descriptions shown under each title. */
const SECTION_HINTS: Partial<Record<CaseBriefSectionKey, string>> = {
  identification: "Dados do cadastro conferidos com os documentos.",
  timeline: "Datas copiadas dos documentos e do cadastro.",
  claims: "Pedidos listados na petição inicial, com o valor atribuído a cada um.",
  amounts: "Valor da causa e valor liquidado aparecem lado a lado e nunca são somados. Ausência de valor não é zero.",
  plaintiffArguments: "Resumo dos fundamentos apresentados pelo autor.",
  theses: "Hipóteses ilustrativas a verificar — sem jurisprudência e sem fundamento legal citado.",
  risks: "Separados entre o que foi calculado a partir da carteira e as sugestões ilustrativas.",
  possibleDeadlines: "Somente datas escritas nos documentos. Nada é contado pelo sistema; o prazo só vale após validação humana.",
  missingDocuments: "Documentos esperados para os pedidos identificados que não estão no processo.",
};

export function sectionAnchor(key: string): string {
  return `secao-${key}`;
}

function Citations({ briefId, citations, sourceLabels, canOpen }: { briefId: string; citations: BriefCitation[]; sourceLabels: Record<string, string>; canOpen: boolean }) {
  if (!citations.length) return null;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Fontes citadas">
      {citations.map((c, i) => (
        <li key={`${c.ref}-${c.page}-${i}`} className="max-w-full">
          <CitationChip briefId={briefId} citation={c} sourceLabel={sourceLabels[c.ref] ?? null} canOpen={canOpen} />
        </li>
      ))}
    </ul>
  );
}

function ItemShell({
  provenance,
  children,
  aside,
  note,
  citations,
  actions,
}: {
  provenance: Provenance;
  children: ReactNode;
  aside?: ReactNode;
  note: string | null;
  citations: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <li className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1 text-sm leading-relaxed text-foreground">{children}</div>
        {aside ? <div className="shrink-0 sm:text-right">{aside}</div> : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <ProvenanceBadge provenance={provenance} />
        {citations}
      </div>
      {note ? <p className="text-xs text-muted-foreground">Observação: {note}</p> : null}
      {actions ? <div>{actions}</div> : null}
    </li>
  );
}

function Money({ cents, empty }: { cents: number | null; empty: string }) {
  return cents === null ? (
    <span className="text-sm text-muted-foreground italic">{empty}</span>
  ) : (
    <span className="text-sm font-semibold whitespace-nowrap tabular-nums">{formatMoneyCents(cents)}</span>
  );
}

function amountCanBeProposed(a: BriefAmount): boolean {
  return a.amountCents !== null && (a.provenance === "extracted" || a.provenance === "reviewer") && a.citations.some((c) => c.ref !== "REG" && c.page !== null);
}

function RiskGroup({ title, icon, risks, render }: { title: string; icon: ReactNode; risks: { r: BriefRisk; i: number }[]; render: (r: BriefRisk, i: number) => ReactNode }) {
  if (!risks.length) return null;
  return (
    <div className="flex flex-col gap-2">
      <p className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        <span aria-hidden="true" className="[&_svg]:size-3.5">
          {icon}
        </span>
        {title}
      </p>
      <ul className="divide-y divide-border">{risks.map(({ r, i }) => render(r, i))}</ul>
    </div>
  );
}

/** All sections of a brief, in CASE_BRIEF_SECTIONS order, with provenance and citations per item. */
export function BriefView({ briefId, processId, content, sourceLabels, abilities }: BriefViewProps) {
  const cites = (citations: BriefCitation[]) => (
    <Citations briefId={briefId} citations={citations} sourceLabels={sourceLabels} canOpen={abilities.canOpenDocuments} />
  );

  const renderSection = (key: CaseBriefSectionKey): ReactNode => {
    switch (key) {
      case "identification":
        return (
          <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
            {content.identification.map((f, i) => (
              <div key={`${f.key}-${i}`} className="flex min-w-0 flex-col gap-1.5">
                <dt className="text-xs font-medium text-muted-foreground">{f.label}</dt>
                <dd className="flex flex-col gap-1.5">
                  <span className={cn("text-sm break-words", f.value ? "text-foreground" : "text-muted-foreground italic")}>
                    {f.value ?? "Não informado"}
                  </span>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <ProvenanceBadge provenance={f.provenance} />
                    {cites(f.citations)}
                  </span>
                  {f.note ? <span className="text-xs text-muted-foreground">{f.note}</span> : null}
                </dd>
              </div>
            ))}
          </dl>
        );
      case "timeline":
        return (
          <ol className="divide-y divide-border">
            {content.timeline.map((e, i) => (
              <ItemShell
                key={i}
                provenance={e.provenance}
                note={e.note}
                citations={cites(e.citations)}
                aside={<span className="text-sm font-medium whitespace-nowrap tabular-nums">{e.date ? formatDate(e.date) : "Sem data"}</span>}
              >
                {e.description}
              </ItemShell>
            ))}
          </ol>
        );
      case "claims": {
        const total = content.claims.reduce((sum, c) => sum + (c.amountCents ?? 0), 0);
        const withAmount = content.claims.filter((c) => c.amountCents !== null).length;
        return (
          <>
            <ol className="divide-y divide-border">
              {content.claims.map((c, i) => (
                <ItemShell
                  key={i}
                  provenance={c.provenance}
                  note={c.note}
                  citations={cites(c.citations)}
                  aside={<Money cents={c.amountCents} empty="Valor não indicado" />}
                >
                  {c.description}
                </ItemShell>
              ))}
            </ol>
            {withAmount > 0 ? (
              <p className="mt-3 flex justify-between gap-3 border-t border-border pt-3 text-sm">
                <span className="text-muted-foreground">
                  Soma dos pedidos com valor ({withAmount}) — calculada para conferência
                </span>
                <span className="font-semibold tabular-nums">{formatMoneyCents(total)}</span>
              </p>
            ) : null}
          </>
        );
      }
      case "amounts":
        return (
          <ul className="divide-y divide-border">
            {content.amounts.map((a, i) => (
              <ItemShell
                key={i}
                provenance={a.provenance}
                note={a.note}
                citations={cites(a.citations)}
                aside={<Money cents={a.amountCents} empty={/liquidad/i.test(a.label) ? "Não apurado" : "Não informado"} />}
                actions={
                  abilities.applicable && abilities.canProposeAmount && amountCanBeProposed(a) ? (
                    <BriefItemAction kind="amount" briefId={briefId} processId={processId} index={i} itemLabel={a.label} />
                  ) : null
                }
              >
                <span className="font-medium">{a.label}</span>
              </ItemShell>
            ))}
          </ul>
        );
      case "evidence":
        return (
          <ul className="divide-y divide-border">
            {content.evidence.map((e, i) => (
              <ItemShell
                key={i}
                provenance={e.provenance}
                note={e.note}
                citations={cites(e.citations)}
                aside={<Badge tone="neutral">{EVIDENCE_HOLDER_LABELS[e.holder]}</Badge>}
              >
                {e.description}
              </ItemShell>
            ))}
          </ul>
        );
      case "risks": {
        const indexed = content.risks.map((r, i) => ({ r, i }));
        const renderRisk = (r: BriefRisk, i: number) => (
          <ItemShell key={i} provenance={r.provenance} note={r.note} citations={cites(r.citations)} aside={<RiskBadge level={r.level} withPrefix />}>
            {r.description}
          </ItemShell>
        );
        return (
          <div className="flex flex-col gap-5">
            <RiskGroup
              title="Calculado a partir da carteira"
              icon={<Calculator />}
              risks={indexed.filter((x) => x.r.provenance === "record" || x.r.provenance === "extracted")}
              render={renderRisk}
            />
            <RiskGroup
              title="Sugestão ilustrativa"
              icon={<FlaskConical />}
              risks={indexed.filter((x) => x.r.provenance !== "record" && x.r.provenance !== "extracted")}
              render={renderRisk}
            />
          </div>
        );
      }
      case "nextSteps":
        return (
          <ul className="divide-y divide-border">
            {content.nextSteps.map((s, i) => (
              <ItemShell
                key={i}
                provenance={s.provenance}
                note={s.note}
                citations={cites(s.citations)}
                aside={<PriorityBadge priority={s.priority} withPrefix />}
                actions={
                  abilities.applicable && abilities.canCreateTask ? (
                    <BriefItemAction kind="task" briefId={briefId} processId={processId} index={i} itemLabel={s.description} />
                  ) : null
                }
              >
                {s.description}
              </ItemShell>
            ))}
          </ul>
        );
      case "possibleDeadlines":
        return (
          <ul className="divide-y divide-border">
            {content.possibleDeadlines.map((d, i) => (
              <ItemShell
                key={i}
                provenance={d.provenance}
                note={d.note}
                citations={cites(d.citations)}
                aside={
                  d.date ? (
                    <span className="text-sm font-semibold whitespace-nowrap tabular-nums">{formatDate(d.date)}</span>
                  ) : (
                    <Badge tone="alert">Sem data — contar manualmente</Badge>
                  )
                }
                actions={
                  d.date && abilities.applicable && abilities.canCreateDeadline ? (
                    <BriefItemAction kind="deadline" briefId={briefId} processId={processId} index={i} itemLabel={d.description} />
                  ) : null
                }
              >
                <span className="font-medium">{d.description}</span>
                <span className="mt-1 block text-xs text-muted-foreground">Base: {d.basis}</span>
              </ItemShell>
            ))}
          </ul>
        );
      default: {
        const items = content[key];
        return (
          <ul className="divide-y divide-border">
            {items.map((t, i) => (
              <ItemShell key={i} provenance={t.provenance} note={t.note} citations={cites(t.citations)}>
                {t.text}
              </ItemShell>
            ))}
          </ul>
        );
      }
    }
  };

  return (
    <div className="flex flex-col gap-6">
      {CASE_BRIEF_SECTIONS.map((s) => {
        const count = (content[s.key] as unknown[]).length;
        return (
          <Card key={s.key} id={sectionAnchor(s.key)} className="scroll-mt-20">
            <CardHeader actions={<Badge tone={count ? "neutral" : "warning"}>{count ? pluralize(count, "item", "itens", { withCount: true }) : "Vazio"}</Badge>}>
              <CardTitle>{s.label}</CardTitle>
              {SECTION_HINTS[s.key] ? <CardDescription>{SECTION_HINTS[s.key]}</CardDescription> : null}
            </CardHeader>
            <CardContent>{count ? renderSection(s.key) : <p className="text-sm text-muted-foreground">Nenhum item nesta seção.</p>}</CardContent>
          </Card>
        );
      })}
    </div>
  );
}
