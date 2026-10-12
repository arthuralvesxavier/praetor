"use client";

import {
  AlarmClock,
  Bell,
  CalendarClock,
  Check,
  ClipboardCheck,
  FileSearch,
  FileSpreadsheet,
  Gavel,
  Handshake,
  Landmark,
  Menu,
  Plus,
  Scale,
  Search,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { LogoMark, LogoWordmark } from "@/components/brand/logo";
import { NAV_GROUPS } from "@/lib/nav";
import type { Tone } from "@/lib/tones";
import { cn } from "@/lib/utils";
import {
  MiniBadge,
  MiniButton,
  MiniCard,
  MiniCardHeader,
  MiniCnj,
  MiniMissing,
  MiniPageHeader,
  MiniStat,
  MiniTabs,
  Provenance,
} from "./mini-ui";
import { useReducedMotion } from "./motion";
import { SAMPLE, SAMPLE_LAWYER, SAMPLE_PORTFOLIO, SAMPLE_TOTALS } from "./sample-data";

/**
 * Miniature of the real application next to the hero title: navy sidebar with
 * the grouped menu (the real NAV_GROUPS), header with the global search and
 * four screens (executive panel, portfolio, process record, intake). All data
 * is ILLUSTRATIVE (sample-data.ts) and labeled on screen. Below 28rem of width
 * it switches to the mobile shell, like the app does.
 */
const TABS = [
  { key: "painel", label: "Painel", href: "/dashboard" },
  { key: "carteira", label: "Carteira", href: "/processos" },
  { key: "processo", label: "Processo", href: "/processos" },
  { key: "entrada", label: "Entrada", href: "/entrada" },
] as const;

const ROTATE_MS = 7000;

export function ProductPreview({ initialTab = 0 }: { initialTab?: number }) {
  const [active, setActive] = useState(initialTab);
  const [paused, setPaused] = useState(false);
  const reduced = useReducedMotion();
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const rotating = !paused && !reduced;

  useEffect(() => {
    if (!rotating) return;
    const id = window.setTimeout(() => setActive((i) => (i + 1) % TABS.length), ROTATE_MS);
    return () => window.clearTimeout(id);
  }, [active, rotating]);

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    let next: number | null = null;
    if (e.key === "ArrowRight") next = (active + 1) % TABS.length;
    else if (e.key === "ArrowLeft") next = (active - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = TABS.length - 1;
    if (next === null) return;
    e.preventDefault();
    setActive(next);
    tabRefs.current[next]?.focus();
  }

  const tab = TABS[active] ?? TABS[0];

  return (
    <div
      className="relative normal-nums"
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
    >
      <div
        aria-hidden="true"
        className="absolute -inset-5 rounded-[2rem] bg-gradient-to-tr from-gold-500/20 via-navy-400/10 to-transparent blur-2xl"
      />
      <div className="relative overflow-hidden rounded-xl bg-white shadow-2xl ring-1 shadow-black/40 ring-white/10">
        {/* Window bar with the screen switcher */}
        <div className="flex items-center gap-3 border-b border-slate-200 bg-slate-100 px-2.5 py-1.5">
          <div className="hidden gap-1.5 sm:flex" aria-hidden="true">
            <span className="size-2.5 rounded-full bg-slate-300" />
            <span className="size-2.5 rounded-full bg-slate-300" />
            <span className="size-2.5 rounded-full bg-slate-300" />
          </div>
          <div
            role="tablist"
            aria-label="Telas da plataforma"
            className="flex min-w-0 flex-1 gap-0.5 sm:justify-center"
            onKeyDown={onKey}
          >
            {TABS.map((t, i) => {
              const selected = i === active;
              return (
                <button
                  key={t.key}
                  ref={(el) => {
                    tabRefs.current[i] = el;
                  }}
                  type="button"
                  role="tab"
                  id={`previa-aba-${t.key}`}
                  aria-selected={selected}
                  aria-controls="previa-tela"
                  tabIndex={selected ? 0 : -1}
                  onClick={() => setActive(i)}
                  className={cn(
                    "relative flex-1 cursor-pointer overflow-hidden rounded-md px-2 py-1 text-xs font-medium transition-colors sm:flex-none sm:px-3",
                    "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
                    selected ? "bg-white text-navy-900 shadow-sm ring-1 ring-slate-200" : "text-slate-600 hover:text-slate-900",
                  )}
                >
                  {t.label}
                  {selected ? (
                    <span aria-hidden="true" className="absolute inset-x-1.5 bottom-0 h-0.5 overflow-hidden rounded-full">
                      <span
                        key={`${active}-${rotating}`}
                        className={cn(
                          "block h-full origin-left bg-gold-500",
                          rotating ? "animate-progress" : "scale-x-100",
                        )}
                        style={rotating ? { animationDuration: `${ROTATE_MS}ms` } : undefined}
                      />
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>

        <div
          role="tabpanel"
          id="previa-tela"
          aria-labelledby={`previa-aba-${tab.key}`}
          className="@container text-left text-slate-800"
        >
          <div className="flex h-[27rem] @xl:h-[29rem]">
            <MiniSidebar activeHref={tab.href} />
            <div className="flex min-w-0 flex-1 flex-col bg-canvas">
              <MiniTopbar />
              <div className="relative min-h-0 flex-1 overflow-hidden">
                <div key={active} className="p-3 motion-safe:animate-fade-in @lg:p-4">
                  {tab.key === "painel" ? (
                    <PanelScreen />
                  ) : tab.key === "carteira" ? (
                    <PortfolioScreen />
                  ) : tab.key === "processo" ? (
                    <ProcessScreen />
                  ) : (
                    <IntakeScreen />
                  )}
                </div>
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-canvas via-canvas/80 to-transparent"
                />
                <span className="absolute right-2.5 bottom-2 rounded-full bg-white px-2 py-0.5 text-[10px] font-medium text-slate-600 shadow-xs ring-1 ring-slate-200">
                  Dados ilustrativos
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

/**
 * Screens of the real menu (src/lib/nav.ts) shown in the miniature. Labels and
 * icons come from NAV_GROUPS; only these delivered screens are listed, so a
 * menu entry for something still being built never appears on the landing.
 */
const SHOWN_NAV = new Set([
  "/dashboard",
  "/alertas",
  "/processos",
  "/entrada",
  "/analises-preliminares",
  "/audiencias",
  "/prazos",
  "/contingencias",
  "/acordos",
  "/relatorios",
  "/preventivo",
  "/inteligencia-preventiva",
  "/contratos",
  "/documentos",
  "/distribuicao",
  "/emails",
  "/importacoes",
]);

const MINI_NAV = NAV_GROUPS.map((g) => ({ label: g.label, items: g.items.filter((i) => SHOWN_NAV.has(i.href)) })).filter(
  (g) => g.items.length > 0,
);

/** The real grouped menu, cropped by the window height like a screenshot. */
function MiniSidebar({ activeHref }: { activeHref: string }) {
  return (
    <div aria-hidden="true" className="hidden w-[9.5rem] shrink-0 flex-col overflow-hidden bg-sidebar @md:flex @2xl:w-[10.5rem]">
      <div className="flex h-10 shrink-0 items-center border-b border-sidebar-border px-3">
        <LogoWordmark variant="light" title="" className="h-[13px]" />
      </div>
      <div className="flex flex-col gap-2.5 px-1.5 py-2.5">
        {MINI_NAV.map((group, gi) => (
          <div key={group.label ?? `grupo-${gi}`}>
            {group.label ? (
              <p className="mb-0.5 truncate px-2 text-[8px] font-semibold tracking-[0.14em] text-sidebar-heading uppercase">
                {group.label}
              </p>
            ) : null}
            <ul className="flex flex-col gap-px">
              {group.items.map(({ href, label, icon: Icon }) => {
                const isActive = href === activeHref;
                return (
                  <li
                    key={href}
                    className={cn(
                      "relative flex items-center gap-1.5 rounded px-2 py-[3px] text-[9.5px]",
                      isActive ? "bg-sidebar-active font-semibold text-white" : "font-medium text-sidebar-muted",
                    )}
                  >
                    {isActive ? (
                      <span className="absolute inset-y-1 left-0 w-[2px] rounded-r bg-sidebar-indicator" />
                    ) : null}
                    <Icon
                      className={cn("size-2.5 shrink-0", isActive ? "text-sidebar-indicator" : "text-sidebar-heading")}
                    />
                    <span className="truncate">{label}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

function MiniTopbar() {
  return (
    <div
      aria-hidden="true"
      className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-surface px-2.5 @lg:px-3"
    >
      {/* Mobile shell: menu button and the symbol */}
      <Menu className="size-3.5 text-slate-700 @md:hidden" />
      <LogoMark className="size-4 @md:hidden" />
      <div className="min-w-0 flex-1">
        <div className="hidden h-6 w-full max-w-[13rem] items-center gap-1.5 rounded border border-border-strong bg-surface-muted px-2 text-[9.5px] text-slate-500 @md:flex">
          <Search className="size-3 shrink-0" />
          <span className="min-w-0 flex-1 truncate">Buscar nº CNJ, parte, título…</span>
          <span className="rounded border border-border-strong bg-white px-1 text-[8.5px] leading-3 text-slate-600">/</span>
        </div>
      </div>
      <Search className="size-3.5 text-slate-700 @md:hidden" />
      <span className="relative inline-flex size-6 items-center justify-center text-slate-700">
        <Bell className="size-3.5" />
        <span className="absolute -top-0.5 -right-0.5 inline-flex h-3 min-w-3 items-center justify-center rounded-full bg-red-700 px-0.5 text-[8px] leading-none font-semibold text-white ring-1 ring-white">
          3
        </span>
      </span>
      <span className="inline-flex size-6 items-center justify-center rounded-full bg-primary-100 text-[9px] font-semibold text-primary-800">
        CR
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Painel executivo: the "Exige decisão agora" band
// ---------------------------------------------------------------------------

type DecisionMock = {
  title: string;
  icon: LucideIcon;
  count: number;
  noun: string;
  badge?: { tone: Tone; text: string };
  extra?: string;
  item: { ref: string; text: string; when: string; overdue?: boolean };
};

const DECISION: DecisionMock[] = [
  {
    title: "Audiências",
    icon: Gavel,
    count: 1,
    noun: "audiência",
    item: { ref: SAMPLE.overtime.number, text: "Instrução, presencial", when: "14/10, 14h00" },
  },
  {
    title: "Prazos fatais",
    icon: AlarmClock,
    count: 2,
    noun: "prazos fatais",
    badge: { tone: "danger", text: "1 vencido" },
    item: { ref: SAMPLE.liquidation.number, text: "Impugnação aos cálculos", when: "ontem", overdue: true },
  },
  {
    title: "Parcelas de acordo a vencer",
    icon: Handshake,
    count: 1,
    noun: "parcela",
    extra: "R$ 4.200,00 a pagar",
    item: { ref: SAMPLE.appeal.number, text: "Parcela 3 de 10", when: "20/10" },
  },
  {
    title: "Garantias sem movimentação",
    icon: Landmark,
    count: 1,
    noun: "garantia",
    item: { ref: SAMPLE.appeal.number, text: "Depósito recursal", when: "desde 12/03" },
  },
  {
    title: "Valores pendentes de conferência",
    icon: ClipboardCheck,
    count: 1,
    noun: "valor proposto",
    item: { ref: SAMPLE.civil.number, text: "Liquidado proposto", when: "R$ 18.920,00" },
  },
];

function PanelScreen() {
  return (
    <div className="flex flex-col gap-2.5">
      <MiniPageHeader
        title="Painel executivo"
        description="O que exige decisão agora, carteira de passivo, contingências e pendências."
      />
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold text-slate-900">Exige decisão agora</p>
        <MiniBadge tone="info" dot className="hidden @lg:inline-flex">
          Calculado a partir dos registros
        </MiniBadge>
      </div>
      <div className="grid grid-cols-2 gap-2 @xl:grid-cols-3">
        {DECISION.map((b) => (
          <DecisionCard key={b.title} block={b} />
        ))}
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] font-semibold text-slate-900">Carteira de passivo</p>
          <MiniBadge tone="info" dot className="hidden @lg:inline-flex">
            Calculado a partir da carteira
          </MiniBadge>
        </div>
        <CoverageMini />
        <div className="grid grid-cols-2 gap-2">
          <MiniStat label="Valor da causa" value={SAMPLE_TOTALS.claimCompact} hint="Todos informados" tone="info" />
          <MiniStat
            label="Valor liquidado"
            value={SAMPLE_TOTALS.liquidatedCompact}
            hint={`${SAMPLE_TOTALS.notAssessed} não apurados`}
            tone="primary"
          />
        </div>
      </div>
    </div>
  );
}

/** CoverageCard of the real dashboard (first card of "Carteira de passivo"). */
function CoverageMini() {
  const percent = Math.round((SAMPLE_TOTALS.assessed / SAMPLE_TOTALS.processes) * 100);
  return (
    <MiniCard className="flex flex-col gap-1 p-2 @xl:flex-row @xl:items-center @xl:gap-3">
      <div className="min-w-0 flex-1">
        <p className="text-[9.5px] font-medium text-muted-foreground">Cobertura do valor apurado</p>
        <p className="mt-0.5 text-[11px] leading-snug font-semibold text-primary-700 underline decoration-primary-300 underline-offset-2">
          Apurado em {SAMPLE_TOTALS.assessed} de {SAMPLE_TOTALS.processes} processos ({percent}%)
        </p>
        <span className="mt-1 block h-1.5 max-w-xs overflow-hidden rounded-full bg-slate-100">
          <span className="block h-full rounded-full bg-[#2a78d6]" style={{ width: `${percent}%` }} />
        </span>
        <p className="mt-1 text-[9px] leading-snug text-muted-foreground">
          Não apurado nunca entra como zero. Um valor proposto só vira oficial depois de conferido.
        </p>
      </div>
      <MiniButton variant="outline" icon={ClipboardCheck} className="self-start @xl:self-center">
        Conferir valores propostos
      </MiniButton>
    </MiniCard>
  );
}

function DecisionCard({ block }: { block: DecisionMock }) {
  const Icon = block.icon;
  return (
    <MiniCard className="flex flex-col p-2">
      {/* Same titles as the real band (decision-band.tsx); the long ones wrap instead of being cut. */}
      <p className="flex min-w-0 items-start gap-1 text-[10px] leading-tight font-semibold text-slate-900">
        <Icon aria-hidden="true" className="mt-px size-3 shrink-0 text-muted-foreground" />
        <span className="min-w-0">{block.title}</span>
      </p>
      <p className="mt-1 flex min-w-0 flex-wrap items-baseline gap-x-1 gap-y-0.5">
        <span className="text-[15px] leading-none font-semibold text-slate-900 tabular-nums">{block.count}</span>
        <span className="text-[9.5px] text-muted-foreground">{block.noun}</span>
        {block.badge ? (
          <MiniBadge tone={block.badge.tone} dot>
            {block.badge.text}
          </MiniBadge>
        ) : null}
      </p>
      {block.extra ? <p className="truncate text-[9px] text-muted-foreground tabular-nums">{block.extra}</p> : null}
      <div className="mt-auto border-t border-border pt-1.5">
        <MiniCnj>{block.item.ref}</MiniCnj>
        <p className="flex min-w-0 justify-between gap-1 text-[9px]">
          <span className="truncate text-slate-700">{block.item.text}</span>
          <span className={cn("shrink-0 tabular-nums", block.item.overdue ? "text-red-700" : "text-muted-foreground")}>
            {block.item.when}
          </span>
        </p>
      </div>
    </MiniCard>
  );
}

// ---------------------------------------------------------------------------
// Carteira de processos
// ---------------------------------------------------------------------------

function PortfolioScreen() {
  return (
    <div className="flex flex-col gap-2.5">
      <MiniPageHeader
        title="Carteira de processos"
        description="Um registro por número CNJ, com as instâncias vinculadas."
        actions={
          <>
            <MiniButton variant="outline" icon={FileSpreadsheet} className="hidden @xl:inline-flex">
              Exportar Excel
            </MiniButton>
            <MiniButton icon={Plus}>Novo processo</MiniButton>
          </>
        }
      />
      <MiniTabs
        tabs={[
          { label: "Carteira ativa", count: SAMPLE_TOTALS.processes, active: true },
          { label: "Fora da carteira ativa" },
          { label: "Todos" },
        ]}
      />
      <div className="grid grid-cols-3 gap-2">
        <MiniStat label="Processos (CNJ únicos)" value={SAMPLE_TOTALS.processes} />
        <MiniStat label="Valor da causa (soma)" value={SAMPLE_TOTALS.claim} tone="info" />
        <MiniStat
          label="Valor liquidado (soma)"
          value={SAMPLE_TOTALS.liquidated}
          hint={`${SAMPLE_TOTALS.notAssessed} não apurados`}
          tone="primary"
        />
      </div>
      <MiniCard className="overflow-hidden">
        <div className="grid grid-cols-[minmax(0,1fr)_4.6rem_4.6rem] gap-x-1.5 border-b border-border bg-surface-muted px-2.5 py-1 text-[9px] font-medium text-muted-foreground @lg:grid-cols-[minmax(0,1fr)_3.75rem_5.5rem_5.5rem] @lg:gap-x-2">
          <span>Processo (CNJ)</span>
          <span className="hidden @lg:block">Tribunal</span>
          <span className="text-right">Valor da causa</span>
          <span className="text-right">Valor liquidado</span>
        </div>
        <ul className="divide-y divide-border">
          {SAMPLE_PORTFOLIO.map((p) => (
            <li
              key={p.number}
              className="grid grid-cols-[minmax(0,1fr)_4.6rem_4.6rem] items-start gap-x-1.5 px-2.5 py-1.5 text-[9.5px] @lg:grid-cols-[minmax(0,1fr)_3.75rem_5.5rem_5.5rem] @lg:gap-x-2"
            >
              <span className="min-w-0">
                <MiniCnj>{p.number}</MiniCnj>
                <span className="block truncate text-[9px] text-slate-600">
                  {p.plaintiff} × {p.defendant}
                </span>
              </span>
              <span className="hidden min-w-0 @lg:block">
                <span className="block truncate text-slate-800">{p.court}</span>
                <span className="block truncate text-[9px] text-muted-foreground">{p.instance}</span>
              </span>
              <span className="text-right whitespace-nowrap text-slate-900 tabular-nums">
                {p.claim ?? <MiniMissing>Não informado</MiniMissing>}
              </span>
              <span className="text-right whitespace-nowrap text-slate-900 tabular-nums">
                {p.liquidated ?? <MiniMissing />}
              </span>
            </li>
          ))}
        </ul>
      </MiniCard>
      <p className="text-[9px] text-muted-foreground">
        Valor da causa e valor liquidado são grandezas diferentes e nunca são somados entre si.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ficha do processo
// ---------------------------------------------------------------------------

function ProcessScreen() {
  const p = SAMPLE.overtime;
  const cover: [string, string][] = [
    ["Tribunal", p.court],
    ["Órgão julgador", "2ª Vara do Trabalho"],
    ["Cidade/UF", "Brasília/DF"],
    ["Classe", "ATOrd"],
    ["Fase", p.phase],
    ["Responsável", SAMPLE_LAWYER],
    ["Empresa", p.defendant],
    ["Instância atual", p.instance],
  ];
  return (
    <div className="flex flex-col gap-2.5">
      <MiniPageHeader
        crumbs={["Processos", p.number]}
        title={p.title}
        meta={
          <>
            <span className="hidden font-mono text-[9.5px] text-slate-700 @xl:inline">{p.number}</span>
            <MiniBadge tone="success" icon={Check}>
              CNJ válido
            </MiniBadge>
            <MiniBadge>{p.instance}</MiniBadge>
            <MiniBadge>{p.phase}</MiniBadge>
            <MiniBadge tone="info" dot>
              Ativo
            </MiniBadge>
          </>
        }
      />
      <MiniTabs
        tabs={[
          { label: "Visão geral", active: true },
          { label: "Partes", count: 2 },
          { label: "Instâncias", count: 1 },
          { label: "Valores e risco" },
          { label: "Audiências" },
          { label: "Análise preliminar" },
          { label: "Documentos" },
        ]}
      />
      <div className="grid grid-cols-1 gap-2 @xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <MiniCard className="order-2 @xl:order-none">
          <MiniCardHeader title="Capa do processo" aside={<MiniBadge tone="info">Importado</MiniBadge>} />
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 px-2.5 py-2">
            {cover.map(([label, value]) => (
              <div key={label} className="min-w-0">
                <dt className="truncate text-[8.5px] text-muted-foreground">{label}</dt>
                <dd className="truncate text-[10px] text-slate-900">{value}</dd>
              </div>
            ))}
          </dl>
        </MiniCard>
        <div className="flex min-w-0 flex-col gap-2">
          <MiniCard>
            <MiniCardHeader title="Valores" icon={Scale} />
            <dl className="grid grid-cols-2 gap-x-3 px-2.5 py-2 @xl:grid-cols-1 @xl:gap-y-1.5">
              <div className="min-w-0">
                <dt className="text-[8.5px] text-muted-foreground">Valor da causa</dt>
                <dd className="text-[11px] font-semibold text-slate-900 tabular-nums">{p.claim}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-[8.5px] text-muted-foreground">Valor liquidado / apurado</dt>
                <dd className="text-[11px] font-medium">
                  <MiniMissing />
                </dd>
              </div>
            </dl>
            <p className="border-t border-border px-2.5 py-1 text-[8.5px] text-muted-foreground">
              Grandezas diferentes, nunca somadas.
            </p>
          </MiniCard>
          <MiniCard className="hidden @xl:block">
            <MiniCardHeader title="Próxima audiência" icon={CalendarClock} />
            <p className="px-2.5 py-1.5 text-[10px] text-slate-900">
              Instrução · 14/10 às 14h00
              <span className="block text-[9px] text-muted-foreground">Presencial · {SAMPLE_LAWYER}</span>
            </p>
          </MiniCard>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Entrada de processos
// ---------------------------------------------------------------------------

type StageMock = { label: string; state: "done" | "current" | "pending"; detail: string; at?: string; demo?: boolean };

const STAGES: StageMock[] = [
  { label: "Recebido", state: "done", detail: "Cadastro manual com 3 documentos", at: "09:12" },
  {
    label: "Responsável definido",
    state: "done",
    detail: `${SAMPLE_LAWYER} · regra Trabalhista, TRT10`,
    at: "09:12",
  },
  { label: "Leitura dos documentos e análise", state: "done", detail: "Versão 1 pronta para revisão", at: "09:13", demo: true },
  { label: "E-mail ao advogado", state: "done", detail: "Aviso com o link do processo", at: "09:13", demo: true },
  { label: "Revisão", state: "current", detail: `${SAMPLE_LAWYER} editou 2 seções` },
  { label: "Aprovação", state: "pending", detail: "Aguardando o advogado" },
];

function IntakeScreen() {
  const p = SAMPLE.incoming;
  return (
    <div className="flex flex-col gap-2.5">
      <MiniPageHeader
        crumbs={["Entrada de processos", p.number]}
        title={`${p.plaintiff} × ${p.defendant}`}
        meta={
          <MiniBadge tone="warning" dot>
            Em revisão pelo advogado
          </MiniBadge>
        }
      />
      <MiniCard>
        <MiniCardHeader title="Etapas" />
        <ol className="flex flex-col gap-1.5 px-2.5 py-2 @xl:gap-1">
          {STAGES.map((s) => (
            <li key={s.label} className="flex items-start gap-2">
              <StageIcon state={s.state} />
              <span className="min-w-0 flex-1 @xl:flex @xl:items-center @xl:gap-2">
                <span className="flex min-w-0 shrink-0 flex-wrap items-center gap-1">
                  <span
                    className={cn(
                      "text-[10px] font-semibold",
                      s.state === "pending" ? "text-muted-foreground" : "text-slate-900",
                    )}
                  >
                    {s.label}
                  </span>
                  {s.demo ? <MiniBadge tone="warning">Demonstração</MiniBadge> : null}
                </span>
                <span className="block min-w-0 truncate text-[9px] text-muted-foreground">{s.detail}</span>
              </span>
              {s.at ? <span className="hidden shrink-0 text-[9px] text-muted-foreground tabular-nums @lg:block">{s.at}</span> : null}
            </li>
          ))}
        </ol>
      </MiniCard>
      <MiniCard>
        <MiniCardHeader title="Análise preliminar · versão 1" icon={FileSearch} />
        <ul className="flex flex-col gap-1 px-2.5 py-2 text-[9.5px]">
          <BriefLine text="Pedido de diferenças salariais, R$ 31.200,00" badge={<Provenance kind="extracted" />} cite="D1 · p. 4" />
          <BriefLine text="Admissão em 03/02/2021" badge={<Provenance kind="record" />} />
          <BriefLine text="Ficha do paradigma não localizada" badge={<Provenance kind="missing" />} />
          <BriefLine text="Função descrita pela autora" badge={<Provenance kind="reviewer" />} />
        </ul>
      </MiniCard>
    </div>
  );
}

function StageIcon({ state }: { state: StageMock["state"] }) {
  if (state === "done") {
    return (
      <span className="mt-px inline-flex size-3.5 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white">
        <Check aria-hidden="true" className="size-2.5" />
      </span>
    );
  }
  if (state === "current") {
    return (
      <span className="mt-px inline-flex size-3.5 shrink-0 items-center justify-center rounded-full border-2 border-primary-600 bg-white">
        <span className="size-1.5 rounded-full bg-primary-600" />
      </span>
    );
  }
  return <span className="mt-px inline-flex size-3.5 shrink-0 rounded-full border border-dashed border-slate-400" />;
}

function BriefLine({ text, badge, cite }: { text: string; badge: ReactNode; cite?: string }) {
  return (
    <li className="flex min-w-0 items-center justify-between gap-2">
      <span className="min-w-0 truncate text-slate-800">{text}</span>
      <span className="flex shrink-0 items-center gap-1">
        {cite ? <span className="font-mono text-[9px] text-primary-700">{cite}</span> : null}
        {badge}
      </span>
    </li>
  );
}
