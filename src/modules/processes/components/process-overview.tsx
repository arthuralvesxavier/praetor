import { ArrowRight, FileSearch, PencilLine } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DescriptionList, type DescriptionItem } from "@/components/ui/description-list";
import { OriginBadge } from "@/components/ui/origin-badge";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  CASE_BRIEF_STATUS_LABELS,
  CLOSURE_REASON_LABELS,
  LEGACY_PROCESS_PHASE_LABELS,
  LEGAL_AREA_LABELS,
  PROCESS_INSTANCE_LABELS,
  PROCESS_PHASE_LABELS,
  type CaseBriefStatus,
  type PartyRole,
} from "@/domain/enums";
import { formatDate, formatDateTime, formatMoneyCents, pluralize, truncate } from "@/lib/format";
import type { Tone } from "@/lib/tones";
import { cn } from "@/lib/utils";
import { getLatestCaseBriefSummary, type CaseBriefSummary } from "@/modules/briefs/service";
import type { AuthContext } from "@/server/auth/context";
import { can } from "@/server/auth/permissions";
import { logger } from "@/server/lib/logger";
import type { ProcessDetail } from "../service";
import { COVER_FIELD_LABELS, firstSentence, isBlank as blank, missingCoverFields } from "../cover";
import { cityWithState } from "../states";
import { PROCESS_SECTION_IDS, processTabUrl } from "../tabs";
import type { BandValuationItem } from "../decision-band";
import { loadProcessDecisionBand, ProcessDecisionBandOrNotice } from "./process-decision-band";

const BRIEF_STATUS_TONES: Record<CaseBriefStatus, Tone> = {
  generating: "info",
  ready_for_review: "warning",
  in_review: "info",
  approved: "success",
  rejected: "neutral",
  failed: "danger",
};

const linkClasses =
  "inline-flex items-center gap-1 self-start rounded-sm text-sm font-medium text-primary-700 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

// ---------------------------------------------------------------------------
// Resumo tab
// ---------------------------------------------------------------------------

/**
 * "Resumo" tab (default) of the process detail (P0.6): the decision band (P0.4), the
 * compact cover (only fields with a value, plus the ONE "Completar cadastro" link of the
 * tab listing the missing ones) and the short preliminary-analysis card when there is a
 * brief. Cards without content are not rendered. The band is loaded once: its pending
 * claim proposals (contingency:read) are also shown under the cover's valor da causa.
 */
export async function ProcessSummaryTab({ ctx, process: p }: { ctx: AuthContext; process: ProcessDetail }) {
  const [band, brief] = await Promise.all([
    loadProcessDecisionBand(ctx, p.id),
    can(ctx, "brief:read") ? loadLatestBrief(ctx, p.id) : Promise.resolve(null),
  ]);
  const claimProposals = band?.valuations?.items.filter((v) => v.kind === "claim") ?? [];
  return (
    <>
      <ProcessDecisionBandOrNotice band={band} />
      <div className={cn("grid grid-cols-1 gap-6", brief && "lg:grid-cols-3")}>
        <ProcessCover
          ctx={ctx}
          process={p}
          claimProposals={claimProposals}
          className={brief ? "lg:col-span-2" : undefined}
          wide={!brief}
        />
        {brief ? <BriefCard brief={brief} href={processTabUrl(p.id, "documentos-e-analises", PROCESS_SECTION_IDS.brief)} /> : null}
      </div>
    </>
  );
}

async function loadLatestBrief(ctx: AuthContext, processId: string): Promise<CaseBriefSummary | null> {
  try {
    return await getLatestCaseBriefSummary(ctx, processId);
  } catch (error) {
    logger.warn("process_latest_brief_failed", { processId, errorName: error instanceof Error ? error.name : "unknown" });
    return null;
  }
}

const PARTY_POLES: { role: PartyRole; label: string }[] = [
  { role: "plaintiff", label: "Polo ativo" },
  { role: "defendant", label: "Polo passivo" },
];

function Muted({ children }: { children: ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>;
}

/** Compact cover: every empty field is hidden; the gaps are listed once, next to the edit link. */
function ProcessCover({
  ctx,
  process: p,
  claimProposals,
  className,
  wide,
}: {
  ctx: AuthContext;
  process: ProcessDetail;
  /** Valor da causa proposals awaiting review (oldest first; empty without contingency:read). */
  claimProposals: readonly BandValuationItem[];
  className?: string;
  /** Full-width cover (no side card): three columns on large screens. */
  wide: boolean;
}) {
  const closure = p.closureReason ? CLOSURE_REASON_LABELS[p.closureReason] : null;
  const latestProposal = claimProposals.at(-1) ?? null;
  const missing = missingCoverFields(p, { claimPending: latestProposal !== null });
  const instancesHref = processTabUrl(p.id, "partes-e-andamento", PROCESS_SECTION_IDS.instances);
  const text = (v: string | null | undefined) => (blank(v) ? null : v);

  const poles = PARTY_POLES.map((pole) => {
    const names = p.parties.filter((x) => x.role === pole.role).map((x) => x.name);
    if (names.length === 0) return null;
    // The group company as the only defendant is already the "Empresa" field.
    if (pole.role === "defendant" && names.length === 1 && names[0] === p.companyName) return null;
    const value = names.length > 1 ? `${names[0]} e mais ${pluralize(names.length - 1, "parte", "partes")}` : names[0];
    return { label: pole.label, value } satisfies DescriptionItem;
  });

  const items: (DescriptionItem | null)[] = [
    text(p.title) ? { label: "Título interno", value: p.title } : null,
    text(p.court)
      ? { label: "Tribunal", value: [p.court, text(p.courtDivision)].filter(Boolean).join(" · ") }
      : text(p.courtDivision)
        ? { label: "Vara ou órgão julgador", value: p.courtDivision }
        : null,
    cityWithState(text(p.city), text(p.state)) ? { label: "Cidade/UF", value: cityWithState(text(p.city), text(p.state)) } : null,
    text(p.jurisdiction) ? { label: "Comarca", value: p.jurisdiction } : null,
    text(p.processClass) ? { label: "Classe", value: p.processClass } : null,
    { label: "Área", value: LEGAL_AREA_LABELS[p.area] },
    p.instance
      ? {
          label: "Instância atual",
          value: (
            <span>
              {PROCESS_INSTANCE_LABELS[p.instance]}
              {p.instances.length > 1 ? (
                <Link href={instancesHref} className="ml-2 text-xs font-medium text-primary-700 underline-offset-2 hover:underline">
                  {pluralize(p.instances.length, "instância vinculada", "instâncias vinculadas")}
                </Link>
              ) : null}
            </span>
          ),
        }
      : null,
    {
      label: "Fase",
      value: (
        <span>
          {PROCESS_PHASE_LABELS[p.phase]}
          {text(p.phaseDetail) ? <span className="block text-xs text-muted-foreground">{p.phaseDetail}</span> : null}
          {p.legacyPhase ? (
            <span className="block text-xs text-muted-foreground">
              Antes da separação entre fase e instância: {LEGACY_PROCESS_PHASE_LABELS[p.legacyPhase]}
            </span>
          ) : null}
        </span>
      ),
    },
    ...poles,
    p.companyName ? { label: "Empresa", value: p.companyName } : null,
    p.unitName ? { label: "Unidade", value: p.unitName } : null,
    p.responsibleName ? { label: "Responsável", value: p.responsibleName } : null,
    p.lawFirmName ? { label: "Escritório externo", value: p.lawFirmName } : null,
    p.filedAt ? { label: "Ajuizamento", value: formatDate(p.filedAt) } : null,
    p.lastMovementAt ? { label: "Última movimentação", value: formatDate(p.lastMovementAt) } : null,
    closure || p.closedAt
      ? {
          label: "Saída da carteira ativa",
          value: [closure, p.closedAt ? `em ${formatDate(p.closedAt)}` : null].filter(Boolean).join(" "),
        }
      : null,
  ];

  return (
    <Card aria-labelledby="capa-titulo" className={cn("min-w-0", className)}>
      <CardHeader actions={p.dataOrigin === "imported" ? <OriginBadge origin="imported" /> : null}>
        <CardTitle id="capa-titulo">Capa do processo</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {/* Two columns on phones too: short values, half the height. */}
        <DescriptionList columns={wide ? 3 : 2} items={items} className="grid-cols-2" />
        {text(p.description) ? (
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">Descrição</p>
            <p className="mt-0.5 text-sm break-words whitespace-pre-line text-slate-900">{truncate(p.description, 600)}</p>
          </div>
        ) : null}

        {/* Valor da causa and valor apurado: different quantities, side by side, never summed (RN-02). */}
        <div className="flex flex-col gap-3 rounded-md border border-border bg-surface-muted px-4 py-3">
          <dl className="grid grid-cols-2 gap-3">
            <div className="min-w-0">
              <dt className="text-xs font-medium text-muted-foreground">Valor da causa</dt>
              <dd className="mt-0.5 text-sm font-semibold text-slate-900 tabular-nums">
                {p.claimAmountCents === null ? <Muted>Não informado</Muted> : formatMoneyCents(p.claimAmountCents)}
              </dd>
              {latestProposal ? (
                // Not part of the value above nor of any total until a person approves it.
                <dd className="mt-0.5 text-xs text-amber-800 tabular-nums">
                  {`${formatMoneyCents(latestProposal.amountCents)} proposto${latestProposal.simulated ? " por extração simulada" : ""}, aguardando conferência`}
                  {claimProposals.length > 1 ? ` (${pluralize(claimProposals.length, "proposta", "propostas")})` : ""}
                </dd>
              ) : null}
            </div>
            <div className="min-w-0">
              <dt className="text-xs font-medium text-muted-foreground">Valor apurado (liquidado)</dt>
              <dd className="mt-0.5 text-sm font-semibold text-slate-900 tabular-nums">
                {p.liquidatedAmountCents === null ? <Muted>Não apurado</Muted> : formatMoneyCents(p.liquidatedAmountCents)}
              </dd>
            </div>
          </dl>
          <p className="text-xs text-muted-foreground">
            Grandezas diferentes, nunca somadas.
            {can(ctx, "contingency:read") ? (
              <>
                {" "}
                <Link href={processTabUrl(p.id, "valores-e-acordos")} className="font-medium text-primary-700 underline-offset-2 hover:underline">
                  Ver valores, risco e provisão
                </Link>
              </>
            ) : null}
          </p>
        </div>

        {missing.length > 0 ? (
          <div className="flex flex-col gap-1 border-t border-border pt-4 text-sm">
            {p.permissions.canEdit ? (
              <Link href={`/processos/${p.id}/editar`} className={linkClasses}>
                <PencilLine aria-hidden="true" className="size-4" />
                {`Completar cadastro (${pluralize(missing.length, "campo", "campos")})`}
              </Link>
            ) : (
              <p className="font-medium text-slate-900">{`Cadastro incompleto (${pluralize(missing.length, "campo", "campos")})`}</p>
            )}
            <p className="text-xs text-muted-foreground">
              Não informados: {missing.map((f) => COVER_FIELD_LABELS[f]).join(", ")}.
            </p>
          </div>
        ) : null}

        <p className="border-t border-border pt-3 text-xs text-muted-foreground">
          {[
            p.createdByName ? `Cadastrado por ${p.createdByName} em ${formatDateTime(p.createdAt)}` : `Cadastrado em ${formatDateTime(p.createdAt)}`,
            `atualizado em ${formatDateTime(p.updatedAt)}`,
            p.dataOrigin === "imported"
              ? `importado${p.externalSource ? ` de ${p.externalSource}` : ""}${p.importedAt ? ` em ${formatDateTime(p.importedAt)}` : ""}`
              : null,
          ]
            .filter(Boolean)
            .join(" · ")}
          .
          {p.importBatchId && can(ctx, "import:run") ? (
            <>
              {" "}
              <Link href={`/importacoes/${p.importBatchId}`} className="font-medium text-primary-700 underline-offset-2 hover:underline">
                Ver lote de importação
              </Link>
            </>
          ) : null}
        </p>
      </CardContent>
    </Card>
  );
}

/** Short preliminary-analysis card: status, one sentence and the link to the full analysis. */
function BriefCard({ brief, href }: { brief: CaseBriefSummary; href: string }) {
  const sentence = firstSentence(brief.headline);
  return (
    <Card aria-labelledby="resumo-analise-preliminar" className="min-w-0 self-start border-ai-200 bg-ai-50/50">
      <CardHeader>
        <CardTitle id="resumo-analise-preliminar" className="flex items-center gap-2 text-ai-900">
          <FileSearch aria-hidden="true" className="size-4 text-ai-600" />
          Análise preliminar
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge label={CASE_BRIEF_STATUS_LABELS[brief.status]} tone={BRIEF_STATUS_TONES[brief.status]} />
          <Badge tone="neutral">Versão {brief.version}</Badge>
          {brief.mode === "demo" ? <Badge tone="warning">Simulação</Badge> : null}
          {brief.isStale ? <Badge tone="warning">Desatualizada</Badge> : null}
        </div>
        {sentence ? <p className="text-slate-800">{sentence}</p> : <Muted>Resumo ainda não disponível.</Muted>}
        {brief.mode === "demo" ? (
          <p className="text-xs text-amber-800">Conteúdo demonstrativo, gerado por simulação sem inteligência artificial real.</p>
        ) : null}
        <Link href={href} className={linkClasses}>
          Abrir análise preliminar
          <ArrowRight aria-hidden="true" className="size-3.5" />
        </Link>
      </CardContent>
    </Card>
  );
}
