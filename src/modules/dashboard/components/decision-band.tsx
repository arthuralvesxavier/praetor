import { AlarmClock, ChevronRight, CircleCheck, ClipboardCheck, Gavel, Handshake, Landmark, Sparkles } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { daysUntil, formatDate, formatDateTime, formatMoneyCents, formatNumber, formatRelativeDays, pluralize } from "@/lib/format";
import { cn } from "@/lib/utils";
import type {
  DecisionBand as DecisionBandData,
  DecisionBlock,
  DecisionBlockKey,
  DecisionItem,
  DeadlineDecisionBlock,
} from "../decision-service";
import type { Section } from "../portfolio-service";

type Windows = DecisionBandData["windows"];

type BlockMeta = {
  title: string;
  icon: ReactNode;
  action: string;
  description: (w: Windows) => string;
  empty: (w: Windows) => string;
  /** Headline noun after the count. */
  noun: (n: number) => string;
  /**
   * Text of the link to the complete list. `count` is the exact number of rows the list
   * shows (null: the list is wider than the block, so no count is shown).
   */
  listLabel: (count: number | null) => string;
};

const fullList = (count: number | null) => (count === null ? "Ver lista completa" : `Ver lista completa (${formatNumber(count)})`);

const META: Record<DecisionBlockKey, BlockMeta> = {
  hearings: {
    title: "Audiências",
    icon: <Gavel />,
    action: "Agenda",
    description: (w) =>
      `Designadas de hoje até os próximos ${w.hearingDays} dias, incluindo as de hoje ainda sem registro do resultado.`,
    empty: (w) => `Nenhuma audiência designada de hoje até os próximos ${w.hearingDays} dias.`,
    noun: (n) => (n === 1 ? "audiência" : "audiências"),
    listLabel: fullList,
  },
  deadlines: {
    title: "Prazos fatais",
    icon: <AlarmClock />,
    action: "Prazos",
    description: (w) =>
      `Processuais e regulatórios em aberto, vencidos ou com vencimento em até ${w.deadlineDays} dias. Só contam prazos manuais ou validados.`,
    empty: (w) => `Nenhum prazo fatal vencido ou com vencimento nos próximos ${w.deadlineDays} dias.`,
    noun: (n) => (n === 1 ? "prazo fatal" : "prazos fatais"),
    // `/prazos` has no filter by kind nor a 7-day window: it opens every open deadline, without a count.
    listLabel: () => "Ver todos os prazos em aberto",
  },
  installments: {
    title: "Parcelas de acordo a vencer",
    icon: <Handshake />,
    action: "Acordos",
    description: (w) =>
      `Parcelas a pagar de acordos firmados, homologados ou descumpridos com vencimento em até ${w.installmentDueDays} dias, vencidas incluídas.`,
    empty: (w) => `Nenhuma parcela a pagar nos próximos ${w.installmentDueDays} dias nem vencida.`,
    noun: (n) => (n === 1 ? "parcela" : "parcelas"),
    // `/acordos?vencendo=1` lists settlements (one row per settlement, not per installment).
    listLabel: (count) =>
      count === null ? "Ver acordos com parcelas a vencer" : `Ver ${pluralize(count, "acordo", "acordos")} com essas parcelas`,
  },
  guarantees: {
    title: "Garantias sem movimentação",
    icon: <Landmark />,
    action: "Garantias",
    description: (w) =>
      `Vinculadas e sem movimentação há ${w.idleGuaranteeDays} dias ou mais: verifique levantamento, liberação ou substituição.`,
    empty: (w) => `Nenhuma garantia vinculada parada há ${w.idleGuaranteeDays} dias ou mais.`,
    noun: (n) => (n === 1 ? "garantia" : "garantias"),
    listLabel: fullList,
  },
  valuations: {
    title: "Valores pendentes de conferência",
    icon: <ClipboardCheck />,
    action: "Revisar",
    description: () =>
      "Valores propostos aguardando conferência humana identificada. Não entram nos totais até a aprovação.",
    empty: () => "Nenhum valor aguardando conferência.",
    noun: (n) => (n === 1 ? "valor proposto" : "valores propostos"),
    listLabel: fullList,
  },
};

function Unavailable() {
  return (
    <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-sm text-muted-foreground">
      Informação indisponível no momento. Tente novamente mais tarde.
    </p>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-2 rounded-md border border-dashed border-border px-3 py-3 text-sm text-muted-foreground">
      <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-emerald-600" />
      {children}
    </p>
  );
}

/** Date / amount column of an item, per block. */
function ItemWhen({ blockKey, item, today }: { blockKey: DecisionBlockKey; item: DecisionItem; today: string }) {
  const tone = item.overdue ? "text-red-700" : "text-muted-foreground";
  let when: ReactNode = null;
  if (blockKey === "hearings" && item.at) {
    when = (
      <time dateTime={item.at.toISOString()} className={cn(item.overdue && "text-amber-800")}>
        {formatDateTime(item.at)}
      </time>
    );
  } else if ((blockKey === "deadlines" || blockKey === "installments") && item.date) {
    when = (
      <>
        <time dateTime={item.date}>{formatDate(item.date)}</time>
        <span className={cn("block", tone)}>{formatRelativeDays(item.date, today)}</span>
      </>
    );
  } else if (blockKey === "guarantees" && item.date) {
    const days = -daysUntil(item.date, today);
    when = (
      <>
        desde <time dateTime={item.date}>{formatDate(item.date)}</time>
        <span className="block">{`há ${pluralize(days, "dia", "dias")}`}</span>
      </>
    );
  } else if (blockKey === "valuations" && item.date) {
    when = (
      <>
        data-base <time dateTime={item.date}>{formatDate(item.date)}</time>
      </>
    );
  }
  return (
    <span className="ml-auto shrink-0 text-right text-xs text-muted-foreground tabular-nums">
      {item.amountCents !== null ? (
        <span className="block text-sm font-semibold text-slate-900">{formatMoneyCents(item.amountCents)}</span>
      ) : null}
      {when}
    </span>
  );
}

/** Heading of an item: process number, else contract/occurrence title; a hidden parent is never named. */
export function itemHeading(item: Pick<DecisionItem, "processNumber" | "reference" | "restricted">): string {
  return item.processNumber ?? item.reference ?? (item.restricted ? "Registro sem acesso" : "Sem processo vinculado");
}

function ItemRow({ blockKey, item, today }: { blockKey: DecisionBlockKey; item: DecisionItem; today: string }) {
  const heading = itemHeading(item);
  const awaitingRecord = blockKey === "hearings" && item.overdue;
  const hidden = !item.processNumber && !item.reference && item.restricted;
  return (
    <li>
      <Link
        href={item.href}
        className="group -mx-2 flex flex-wrap items-start justify-between gap-x-3 gap-y-0.5 rounded-md px-2 py-2 hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
      >
        <span className="min-w-0 flex-[1_1_11rem]">
          <span
            className={cn(
              "block text-sm font-medium [overflow-wrap:anywhere] group-hover:underline",
              hidden ? "text-muted-foreground italic" : "text-primary-700",
            )}
            title={hidden ? "Vinculado a um registro que o seu perfil não pode ver" : undefined}
          >
            {heading}
          </span>
          <span className="block text-xs text-slate-700 [overflow-wrap:anywhere]">{item.description}</span>
          {item.tags.length > 0 || item.estimate || awaitingRecord ? (
            <span className="mt-1 flex flex-wrap items-center gap-1">
              {item.tags.map((t) => (
                <Badge
                  key={t}
                  tone={item.simulated ? "warning" : "neutral"}
                  className="px-1.5 py-0 text-[11px] leading-4"
                >
                  {t}
                </Badge>
              ))}
              {item.estimate ? (
                <Badge tone="warning" className="px-1.5 py-0 text-[11px] leading-4">
                  Estimativa
                </Badge>
              ) : null}
              {awaitingRecord ? (
                <Badge tone="warning" className="px-1.5 py-0 text-[11px] leading-4">
                  Aguardando registro do resultado
                </Badge>
              ) : null}
            </span>
          ) : null}
        </span>
        <ItemWhen blockKey={blockKey} item={item} today={today} />
      </Link>
    </li>
  );
}

/** Headline: count + short breakdown (overdue, amounts of the same quantity). */
function Headline({ block, meta }: { block: DecisionBlock; meta: BlockMeta }) {
  const parts: ReactNode[] = [];
  if (block.overdue > 0) {
    parts.push(
      <Badge key="overdue" tone="danger" dot>
        {block.key === "installments"
          ? pluralize(block.overdue, "vencida", "vencidas")
          : pluralize(block.overdue, "vencido", "vencidos")}
      </Badge>,
    );
  }
  if (block.totalCents !== null && block.total > 0) {
    parts.push(
      <span key="cents" className="text-xs text-muted-foreground tabular-nums">
        {`${formatMoneyCents(block.totalCents)} ${block.key === "installments" ? "a pagar" : "vinculados"}`}
      </span>,
    );
  }
  return (
    <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
      <p className="text-2xl font-semibold tracking-tight text-slate-900 tabular-nums">
        {formatNumber(block.total)}
        <span className="ml-1.5 text-sm font-normal text-muted-foreground">{meta.noun(block.total)}</span>
      </p>
      {parts}
    </div>
  );
}

function isDeadlineBlock(block: DecisionBlock | DeadlineDecisionBlock): block is DeadlineDecisionBlock {
  return block.key === "deadlines" && "pendingValidation" in block && "pendingValidationHref" in block;
}

function PendingValidation({ block }: { block: DeadlineDecisionBlock }) {
  const n = block.pendingValidation;
  return (
    <div className="mt-3 border-t border-border pt-3">
      <Link
        href={block.pendingValidationHref}
        className="group -mx-2 flex items-center justify-between gap-3 rounded-md px-2 py-1.5 hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
      >
        <span className="flex min-w-0 items-center gap-2 text-sm text-slate-700">
          <Sparkles aria-hidden="true" className={cn("size-4 shrink-0", n > 0 ? "text-ai-600" : "text-slate-400")} />
          Aguardando validação
        </span>
        <span className="flex shrink-0 items-center gap-1 text-sm font-semibold text-slate-900 tabular-nums">
          {formatNumber(n)}
          <ChevronRight aria-hidden="true" className="size-3.5 text-slate-400 group-hover:text-slate-600" />
        </span>
      </Link>
      <p className="text-xs text-muted-foreground">
        Sugestões da IA ou da análise preliminar (simulação). Não contam como prazo fatal até a validação humana.
      </p>
    </div>
  );
}

function BlockCard({
  blockKey,
  section,
  windows,
  today,
}: {
  blockKey: DecisionBlockKey;
  section: Section<DecisionBlock | DeadlineDecisionBlock>;
  windows: Windows;
  today: string;
}) {
  if (section.status === "forbidden") return null;
  const meta = META[blockKey];
  const block = section.status === "ok" ? section.data : null;
  const href = block?.href;
  return (
    <Card className="flex min-w-0 flex-col" aria-labelledby={`decisao-${blockKey}`}>
      <CardHeader
        actions={
          href ? (
            <ButtonLink href={href} variant="outline" size="sm">
              {meta.action}
            </ButtonLink>
          ) : null
        }
      >
        <CardTitle as="h3" id={`decisao-${blockKey}`} className="flex items-center gap-2 text-base">
          <span aria-hidden="true" className="text-muted-foreground [&_svg]:size-4">
            {meta.icon}
          </span>
          {meta.title}
        </CardTitle>
        <CardDescription>{meta.description(windows)}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col">
        {!block ? (
          <Unavailable />
        ) : (
          <>
            <Headline block={block} meta={meta} />
            {block.total === 0 ? (
              <Empty>{meta.empty(windows)}</Empty>
            ) : (
              <ol className="divide-y divide-border" aria-label={`${meta.title}: itens mais urgentes`}>
                {block.items.map((item) => (
                  <ItemRow key={item.id} blockKey={blockKey} item={item} today={today} />
                ))}
              </ol>
            )}
            {block.total > block.items.length ? (
              <Link
                href={block.list.href}
                className="mt-2 inline-flex items-center gap-1 self-start text-sm font-medium text-primary-700 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
              >
                {meta.listLabel(block.list.count)}
                <ChevronRight aria-hidden="true" className="size-3.5" />
              </Link>
            ) : null}
            {isDeadlineBlock(block) ? <PendingValidation block={block} /> : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * "Exige decisão agora": first band of the executive panel. Blocks the user cannot
 * access are not rendered; each block links to the place where the user acts.
 */
export function DecisionBand({ band }: { band: DecisionBandData }) {
  const blocks: { key: DecisionBlockKey; section: Section<DecisionBlock | DeadlineDecisionBlock> }[] = [
    { key: "hearings", section: band.hearings },
    { key: "deadlines", section: band.deadlines },
    { key: "installments", section: band.installments },
    { key: "guarantees", section: band.guarantees },
    { key: "valuations", section: band.valuations },
  ];
  const visible = blocks.filter((b) => b.section.status !== "forbidden");
  if (visible.length === 0) return null;
  return (
    <section aria-labelledby="exige-decisao" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id="exige-decisao" className="text-lg font-semibold tracking-tight text-slate-900">
            Exige decisão agora
          </h2>
          <p className="text-sm text-muted-foreground">
            O que pede uma ação sua, com o caminho para resolver. Situação atual de todos os registros que você pode acessar;
            os filtros do painel não se aplicam a esta faixa.
          </p>
        </div>
        <Badge tone="info" dot>
          Calculado a partir dos registros
        </Badge>
      </div>
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
        {visible.map((b) => (
          <BlockCard key={b.key} blockKey={b.key} section={b.section} windows={band.windows} today={band.today} />
        ))}
      </div>
    </section>
  );
}
