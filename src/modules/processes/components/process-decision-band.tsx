import { CalendarClock, ChevronRight, CircleCheck, ClipboardCheck, ListChecks, Scale, UserRound } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import {
  DEADLINE_KIND_LABELS,
  HEARING_KIND_LABELS,
  HEARING_MODE_LABELS,
  VALUATION_KIND_LABELS,
  VALUATION_SOURCE_LABELS,
} from "@/domain/enums";
import { daysUntil, formatDate, formatMoneyCents, formatNumber, formatRelativeDays, pluralize } from "@/lib/format";
import { TONE_CLASSES } from "@/lib/tones";
import { cn } from "@/lib/utils";
import { ClassificationBadge, EstimateBadge } from "@/modules/contingency/components/badges";
import { formatTime } from "@/modules/hearings/time";
import type { AuthContext } from "@/server/auth/context";
import { logger } from "@/server/lib/logger";
import type {
  BandNextAct,
  BandPendency,
  BandResponsible,
  BandRisk,
  BandValuations,
  PendencyTone,
  ProcessDecisionBand,
} from "../decision-band";
import { getProcessDecisionBand } from "../decision-band-service";

/** Pendências listed before the "ver mais" disclosure. */
export const BAND_VISIBLE_PENDENCIES = 4;
/** Proposed values listed in the band (the count covers all of them). */
export const BAND_VISIBLE_VALUATIONS = 3;

const linkClasses =
  "rounded-sm font-medium text-primary-700 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

const TONE_SR_LABEL: Record<PendencyTone, string> = { danger: "Crítico", warning: "Atenção", info: "Informativo" };

function Cell({
  id,
  title,
  icon,
  count,
  className,
  children,
}: {
  id: string;
  title: string;
  icon: ReactNode;
  count?: number;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div role="group" aria-labelledby={id} className={cn("flex min-w-0 flex-col gap-2 bg-surface px-4 py-3", className)}>
      <h3 id={id} className="flex items-center gap-1.5 text-sm font-semibold text-slate-900">
        <span aria-hidden="true" className="text-muted-foreground [&_svg]:size-4">
          {icon}
        </span>
        {title}
        {count !== undefined && count > 0 ? (
          <Badge tone="warning" className="ml-0.5 px-1.5 py-0 text-[11px] leading-4 tabular-nums">
            {formatNumber(count)}
          </Badge>
        ) : null}
      </h3>
      {children}
    </div>
  );
}

function Calm({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-1.5 text-sm text-muted-foreground">
      <CircleCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-emerald-600" />
      <span>{children}</span>
    </p>
  );
}

function MoreLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className={cn(linkClasses, "mt-auto inline-flex items-center gap-1 self-start pt-1 text-xs")}>
      {children}
      <ChevronRight aria-hidden="true" className="size-3.5" />
    </Link>
  );
}

/** "hoje" / "amanhã" / "em 3 dias" for a calendar date from today on. */
function inDays(date: string, today: string): string {
  const n = daysUntil(date, today);
  if (n <= 0) return "hoje";
  if (n === 1) return "amanhã";
  return `em ${n} dias`;
}

// ---------------------------------------------------------------------------
// Pendências
// ---------------------------------------------------------------------------

function PendencyItem({ item }: { item: BandPendency }) {
  const when =
    item.date && item.kind === "deadline_validation"
      ? `vence em ${formatDate(item.date)}`
      : item.date && item.kind === "hearing_outcome"
        ? `designada para ${formatDate(item.date)}`
        : null;
  const action = item.href ? (item.actionLabel ?? "Abrir") : null;
  return (
    <li className="flex items-start gap-2">
      <span aria-hidden="true" className={cn("mt-1.5 size-2 shrink-0 rounded-full", TONE_CLASSES[item.tone].dot)} />
      <div className="min-w-0 flex-1">
        <p className="text-sm text-slate-900 [overflow-wrap:anywhere]">
          <span className="sr-only">{TONE_SR_LABEL[item.tone]}: </span>
          {item.label}
          {item.tone === "danger" ? (
            <Badge tone="danger" className="ml-1.5 px-1.5 py-0 text-[11px] leading-4">
              Crítico
            </Badge>
          ) : null}
        </p>
        {item.detail || when ? (
          <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
            {[item.detail, when].filter(Boolean).join(" · ")}
          </p>
        ) : null}
      </div>
      {item.href && action ? (
        <Link href={item.href} aria-label={`${action}: ${item.label}`} className={cn(linkClasses, "shrink-0 text-xs")}>
          {action}
        </Link>
      ) : null}
    </li>
  );
}

function PendenciesCell({ items, className }: { items: BandPendency[]; className?: string }) {
  const head = items.slice(0, BAND_VISIBLE_PENDENCIES);
  const tail = items.slice(BAND_VISIBLE_PENDENCIES);
  return (
    <Cell id="decisao-pendencias" title="Pendências" icon={<ListChecks />} count={items.length} className={className}>
      {items.length === 0 ? (
        <Calm>Nenhuma pendência aberta neste processo.</Calm>
      ) : (
        <>
          <ul className="flex flex-col gap-2">
            {head.map((item) => (
              <PendencyItem key={item.key} item={item} />
            ))}
          </ul>
          {tail.length > 0 ? (
            <details className="group">
              <summary className={cn(linkClasses, "cursor-pointer text-xs")}>
                {`Ver mais ${pluralize(tail.length, "pendência", "pendências")}`}
              </summary>
              <ul className="mt-2 flex flex-col gap-2">
                {tail.map((item) => (
                  <PendencyItem key={item.key} item={item} />
                ))}
              </ul>
            </details>
          ) : null}
        </>
      )}
    </Cell>
  );
}

// ---------------------------------------------------------------------------
// Próximo ato
// ---------------------------------------------------------------------------

function NextActCell({ next, today }: { next: BandNextAct; today: string }) {
  const act = next.act;
  return (
    <Cell id="decisao-proximo-ato" title="Próximo ato" icon={<CalendarClock />}>
      {!act ? (
        <Calm>
          {next.deadlinesConsidered
            ? "Nenhum prazo em aberto nem audiência designada."
            : "Nenhuma audiência designada."}
        </Calm>
      ) : act.kind === "deadline" ? (
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-xs text-muted-foreground">
            {`Prazo ${DEADLINE_KIND_LABELS[act.deadlineKind].toLowerCase()}`}
            {act.validated ? " · sugestão validada" : ""}
          </p>
          <Link href={act.href} className={cn(linkClasses, "text-sm [overflow-wrap:anywhere]")}>
            {act.title}
          </Link>
          <p className={cn("text-sm tabular-nums", act.overdue ? "font-medium text-red-700" : "text-slate-700")}>
            <time dateTime={act.date}>{formatDate(act.date)}</time> · {formatRelativeDays(act.date, today)}
          </p>
        </div>
      ) : (
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-xs text-muted-foreground">{`Audiência · ${HEARING_MODE_LABELS[act.mode]}`}</p>
          <Link href={act.href} className={cn(linkClasses, "text-sm")}>
            {HEARING_KIND_LABELS[act.hearingKind]}
          </Link>
          <p className="text-sm text-slate-700 tabular-nums">
            <time dateTime={act.at.toISOString()}>{`${formatDate(act.date)} às ${formatTime(act.at)}`}</time> ·{" "}
            {inDays(act.date, today)}
          </p>
        </div>
      )}
      {next.more > 0 ? (
        <MoreLink href={next.moreHref}>{`Depois: ${pluralize(next.more, "outro ato", "outros atos")}`}</MoreLink>
      ) : null}
      {!next.deadlinesConsidered ? <p className="text-xs text-muted-foreground">Considera as audiências designadas.</p> : null}
    </Cell>
  );
}

// ---------------------------------------------------------------------------
// Valor aguardando conferência
// ---------------------------------------------------------------------------

function ValuationsCell({ block }: { block: BandValuations }) {
  const shown = block.items.slice(0, BAND_VISIBLE_VALUATIONS);
  return (
    <Cell id="decisao-valores" title="Valor aguardando conferência" icon={<ClipboardCheck />} count={block.total}>
      {block.total === 0 ? (
        <Calm>Nenhum valor aguardando conferência.</Calm>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            {`${pluralize(block.total, "valor proposto", "valores propostos")}. Não entram nos totais até a conferência humana.`}
          </p>
          <ul className="flex flex-col gap-1.5">
            {shown.map((v) => (
              <li key={v.id}>
                <Link
                  href={v.href}
                  className="group -mx-1.5 flex flex-wrap items-start justify-between gap-x-2 rounded-md px-1.5 py-1 hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
                >
                  <span className="min-w-0 flex-[1_1_8rem]">
                    <span className="block text-sm text-primary-700 group-hover:underline">{VALUATION_KIND_LABELS[v.kind]}</span>
                    <span className="block text-xs text-muted-foreground">{`data-base ${formatDate(v.baseDate)}`}</span>
                  </span>
                  <span className="shrink-0 text-sm font-semibold text-slate-900 tabular-nums">{formatMoneyCents(v.amountCents)}</span>
                  {v.simulated || v.estimate ? (
                    <span className="flex basis-full flex-wrap gap-1">
                      {v.simulated ? (
                        <Badge tone="warning" className="px-1.5 py-0 text-[11px] leading-4">
                          {VALUATION_SOURCE_LABELS.simulation}
                        </Badge>
                      ) : null}
                      {v.estimate ? <EstimateBadge className="px-1.5 py-0 text-[11px] leading-4" /> : null}
                    </span>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
          <MoreLink href={block.href}>
            {block.total > shown.length ? `Conferir (${formatNumber(block.total)} na fila)` : "Conferir"}
          </MoreLink>
        </>
      )}
    </Cell>
  );
}

// ---------------------------------------------------------------------------
// Risco
// ---------------------------------------------------------------------------

function RiskCell({ risk }: { risk: BandRisk }) {
  const classifyLabel = risk.canClassify && risk.basis !== "official" ? "Classificar" : "Ver valores e risco";
  return (
    <Cell id="decisao-risco" title="Risco" icon={<Scale />}>
      {risk.basis === "none" ? (
        <>
          <p className="text-sm font-medium text-amber-800">Sem classificação</p>
          <p className="text-xs text-muted-foreground">Sem classificação de risco, a provisão não é calculada.</p>
        </>
      ) : (
        <>
          <div>
            <ClassificationBadge classification={risk.classification} percentageBp={risk.percentageBp} />
          </div>
          <p className="text-xs text-muted-foreground">
            {risk.basis === "official" && risk.effectiveFrom
              ? `Classificação oficial em vigor desde ${formatDate(risk.effectiveFrom)}.`
              : "Somente no cadastro: sem classificação oficial em vigor."}
          </p>
        </>
      )}
      {risk.pendingProposals > 0 ? (
        <p className="text-xs font-medium text-amber-800">
          {`${pluralize(risk.pendingProposals, "sugestão", "sugestões")} por regra aguardando aprovação humana.`}
        </p>
      ) : null}
      <MoreLink href={risk.href}>{classifyLabel}</MoreLink>
    </Cell>
  );
}

// ---------------------------------------------------------------------------
// Responsável
// ---------------------------------------------------------------------------

function ResponsibleCell({ responsible: r }: { responsible: BandResponsible }) {
  return (
    <Cell id="decisao-responsavel" title="Responsável" icon={<UserRound />}>
      {r.assigned ? (
        <p className="text-sm font-medium text-slate-900 [overflow-wrap:anywhere]">{r.name ?? "Responsável não identificado"}</p>
      ) : (
        <p className="text-sm font-medium text-amber-800">Sem responsável</p>
      )}
      <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
        {r.lawFirmName ? `Escritório externo: ${r.lawFirmName}` : "Sem escritório externo"}
      </p>
      {r.distributeHref ? (
        <MoreLink href={r.distributeHref}>{r.assigned ? "Redistribuir" : "Distribuir"}</MoreLink>
      ) : !r.assigned ? (
        <p className="text-xs text-muted-foreground">A distribuição é feita pela gestão jurídica.</p>
      ) : null}
    </Cell>
  );
}

// ---------------------------------------------------------------------------
// Band
// ---------------------------------------------------------------------------

/**
 * Decision band of the process detail (P0.4). Blocks the viewer cannot read are not
 * rendered (`valuations`/`risk` null); every item links to where the user acts.
 */
export function ProcessDecisionBandView({ band }: { band: ProcessDecisionBand }) {
  const withValues = band.valuations !== null && band.risk !== null;
  return (
    <section aria-labelledby="faixa-decisao" className="mb-6 overflow-hidden rounded-lg border border-border bg-surface shadow-xs">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-border px-4 py-2.5">
        <h2 id="faixa-decisao" className="text-base font-semibold text-slate-900">
          Exige decisão agora
        </h2>
        <p className="text-xs text-muted-foreground">Calculado a partir dos registros que você pode acessar.</p>
      </div>
      <div
        className={cn(
          "grid grid-cols-1 gap-px bg-border md:grid-cols-2",
          withValues
            ? "xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)]"
            : "xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)]",
        )}
      >
        <PendenciesCell items={band.pendencies} className={cn("md:col-span-2 xl:col-span-1", withValues && "xl:row-span-2")} />
        <NextActCell next={band.nextAct} today={band.today} />
        {band.valuations ? <ValuationsCell block={band.valuations} /> : null}
        {band.risk ? <RiskCell risk={band.risk} /> : null}
        <ResponsibleCell responsible={band.responsible} />
      </div>
    </section>
  );
}

/** Loads the band; null when it fails (logged by name only), so the process page never breaks. */
export async function loadProcessDecisionBand(ctx: AuthContext, processId: string): Promise<ProcessDecisionBand | null> {
  try {
    return await getProcessDecisionBand(ctx, processId);
  } catch (error) {
    logger.error("process_decision_band_failed", { processId, errorName: error instanceof Error ? error.name : "unknown" });
    return null;
  }
}

/** The band already loaded, or a notice when it could not be loaded. */
export function ProcessDecisionBandOrNotice({ band }: { band: ProcessDecisionBand | null }) {
  if (!band) {
    return (
      <p className="mb-6 rounded-md border border-dashed border-border px-3 py-3 text-sm text-muted-foreground">
        Faixa de decisão indisponível no momento. As abas do processo continuam disponíveis.
      </p>
    );
  }
  return <ProcessDecisionBandView band={band} />;
}

/** Loads and renders the band; a failure never breaks the process page. */
export async function ProcessDecisionBandSection({ ctx, processId }: { ctx: AuthContext; processId: string }) {
  return <ProcessDecisionBandOrNotice band={await loadProcessDecisionBand(ctx, processId)} />;
}
