"use client";

import {
  AlertTriangle,
  BellRing,
  CheckCircle2,
  FileSearch,
  FileSpreadsheet,
  FlaskConical,
  Inbox,
  Info,
  Landmark,
  Lock,
  Mail,
  Route,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils";
import { useReducedMotion } from "./motion";

/**
 * Interactive product preview for the landing page. Every number, name and
 * text here is ILLUSTRATIVE (labeled on screen) — it never reads real data.
 * Simulated features (preliminary analysis, e-mail) are labeled as such.
 */
const TABS = [
  { key: "carteira", label: "Carteira", icon: FileSpreadsheet },
  { key: "entrada", label: "Entrada", icon: Inbox },
  { key: "provisao", label: "Provisão", icon: Landmark },
  { key: "alertas", label: "Alertas", icon: BellRing },
] as const;

const ROTATE_MS = 7500;

export function ProductPreview() {
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);
  const reduced = useReducedMotion();
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    if (paused || reduced) return;
    const id = window.setTimeout(() => setActive((i) => (i + 1) % TABS.length), ROTATE_MS);
    return () => window.clearTimeout(id);
  }, [active, paused, reduced]);

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

  const tab = TABS[active];

  return (
    <div
      className="relative"
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
    >
      <div
        aria-hidden="true"
        className="absolute -inset-6 rounded-[2rem] bg-gradient-to-tr from-gold-500/25 via-navy-400/10 to-transparent blur-2xl"
      />
      <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-white shadow-2xl shadow-black/40">
        {/* window chrome */}
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-4 py-2.5">
          <div className="flex gap-1.5" aria-hidden="true">
            <span className="size-2.5 rounded-full bg-slate-300" />
            <span className="size-2.5 rounded-full bg-slate-300" />
            <span className="size-2.5 rounded-full bg-slate-300" />
          </div>
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-amber-900 uppercase">
            Dados ilustrativos
          </span>
        </div>

        <div
          role="tablist"
          aria-label="Prévia da plataforma"
          className="flex gap-0.5 overflow-x-auto border-b border-slate-200 px-2 pt-2 sm:gap-1 sm:px-3"
          onKeyDown={onKey}
        >
          {TABS.map((t, i) => {
            const Icon = t.icon;
            const selected = i === active;
            return (
              <button
                key={t.key}
                ref={(el) => {
                  tabRefs.current[i] = el;
                }}
                type="button"
                role="tab"
                id={`preview-tab-${t.key}`}
                aria-selected={selected}
                aria-controls={`preview-panel-${t.key}`}
                tabIndex={selected ? 0 : -1}
                onClick={() => setActive(i)}
                className={cn(
                  "relative inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-t-md px-2.5 py-2 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring sm:px-3",
                  selected ? "text-navy-900" : "text-slate-600 hover:text-slate-900",
                )}
              >
                <Icon aria-hidden="true" className="size-3.5" />
                {t.label}
                {selected ? (
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-2 -bottom-px h-0.5 overflow-hidden rounded-full bg-slate-200"
                  >
                    <span
                      key={`${active}-${paused}`}
                      className={cn("block h-full origin-left bg-gold-500", !paused && !reduced && "animate-progress")}
                      style={{ animationDuration: `${ROTATE_MS}ms` }}
                    />
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>

        <div
          role="tabpanel"
          id={`preview-panel-${tab.key}`}
          aria-labelledby={`preview-tab-${tab.key}`}
          className="h-[24rem] p-4 text-slate-800 sm:h-[23rem] sm:p-5"
        >
          <div key={active} className="h-full motion-safe:animate-fade-up">
            {tab.key === "carteira" ? (
              <PortfolioPanel />
            ) : tab.key === "entrada" ? (
              <IntakePanel reduced={reduced} />
            ) : tab.key === "provisao" ? (
              <ProvisionPanel />
            ) : (
              <AlertsPanel />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function useGrow() {
  const [grown, setGrown] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setGrown(true));
    return () => cancelAnimationFrame(id);
  }, []);
  return grown;
}

function Tile({ label, value, tone }: { label: string; value: string; tone?: "warn" }) {
  return (
    <div className="rounded-lg border border-slate-200 p-2.5">
      <p className="text-[10px] leading-tight text-slate-600 sm:text-[11px]">{label}</p>
      <p
        className={cn(
          "mt-1 text-base font-semibold tabular-nums sm:text-lg",
          tone === "warn" ? "text-amber-800" : "text-slate-900",
        )}
      >
        {value}
      </p>
    </div>
  );
}

type Level = "erro" | "divergencia" | "ajuste" | "info";
const LEVEL: Record<Level, { label: string; className: string; icon: LucideIcon }> = {
  erro: { label: "Erro", className: "bg-red-50 text-red-800 ring-red-200", icon: AlertTriangle },
  divergencia: { label: "Divergência", className: "bg-orange-50 text-orange-800 ring-orange-200", icon: AlertTriangle },
  ajuste: { label: "Ajuste", className: "bg-sky-50 text-sky-800 ring-sky-200", icon: Info },
  info: { label: "Informativo", className: "bg-slate-100 text-slate-700 ring-slate-200", icon: Info },
};

function LevelBadge({ level }: { level: Level }) {
  const l = LEVEL[level];
  const Icon = l.icon;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ring-1",
        l.className,
      )}
    >
      <Icon aria-hidden="true" className="size-2.5" />
      {l.label}
    </span>
  );
}

function PortfolioPanel() {
  const grown = useGrow();
  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[11px] text-slate-600">Importação de planilha · 5 abas</p>
          <p className="truncate font-semibold text-slate-900">carteira-passivo-consolidado.xlsx</p>
        </div>
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-sky-50 px-2 py-0.5 text-[10px] font-semibold text-sky-800 ring-1 ring-sky-200">
          Em conferência
        </span>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Tile label="Linhas lidas" value="1.240" />
        <Tile label="Processos (CNJ únicos)" value="1.012" />
        <Tile label="Inconsistências" value="23" tone="warn" />
      </div>
      <ul className="space-y-1.5 text-[11px] leading-snug sm:text-xs">
        {(
          [
            { level: "erro", text: "Dígito verificador do CNJ não confere — linha 214, aba “1º Grau”" },
            { level: "divergencia", text: "Mesmo CNJ em 3 abas com valores diferentes — divergência registrada" },
            { level: "ajuste", text: "Cidade “Palmas/TO” padronizada como Palmas · TO" },
            { level: "info", text: "Valor liquidado em branco → “Não apurado” (não vira zero)" },
          ] as const
        ).map((row) => (
          <li key={row.text} className="flex items-start gap-2 rounded-md bg-slate-50 px-2.5 py-1.5">
            <LevelBadge level={row.level} />
            <span className="min-w-0 flex-1 text-slate-700">{row.text}</span>
          </li>
        ))}
      </ul>
      <div className="mt-auto">
        <div className="mb-1 flex items-center justify-between text-[11px] text-slate-600">
          <span>Relatório de inconsistências</span>
          <span className="tabular-nums">18 de 23 conferidas</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
          <span
            className="block h-full rounded-full bg-navy-700 transition-[width] duration-700 ease-out"
            style={{ width: grown ? "78%" : "0%" }}
          />
        </div>
      </div>
    </div>
  );
}

const INTAKE_STEPS: { icon: LucideIcon; title: string; detail: string; simulated?: boolean }[] = [
  { icon: Inbox, title: "Processo recebido", detail: "0009876-34.2026.5.10.0011 · CNJ válido" },
  {
    icon: Route,
    title: "Responsável definido",
    detail: "Regra de distribuição: Trabalhista · TRT10 → Dra. Camila (fictícia)",
  },
  {
    icon: FileSearch,
    title: "Análise preliminar gerada",
    detail: "Pedidos, valores e prazos com a origem de cada item",
    simulated: true,
  },
  {
    icon: Mail,
    title: "[Simulação] Aviso ao advogado",
    detail: "Envio simulado — nenhuma mensagem foi enviada",
    simulated: true,
  },
];

function IntakePanel({ reduced }: { reduced: boolean }) {
  const [shown, setShown] = useState(reduced ? INTAKE_STEPS.length : 1);
  useEffect(() => {
    if (reduced) return;
    const id = window.setInterval(() => setShown((n) => (n >= INTAKE_STEPS.length ? n : n + 1)), 900);
    return () => window.clearInterval(id);
  }, [reduced]);
  const visible = reduced ? INTAKE_STEPS.length : shown;
  return (
    <div className="flex h-full flex-col gap-3">
      <div>
        <p className="text-[11px] text-slate-600">Entrada de processo · Reclamação trabalhista</p>
        <p className="font-semibold text-slate-900">Novo processo na carteira</p>
      </div>
      <ol className="relative space-y-2.5">
        <span aria-hidden="true" className="absolute top-3 bottom-3 left-[0.9rem] w-px bg-slate-200" />
        {INTAKE_STEPS.map((step, i) => {
          const done = i < visible;
          const Icon = step.icon;
          return (
            <li
              key={step.title}
              className={cn(
                "relative flex items-start gap-3 transition-opacity duration-500",
                done ? "opacity-100" : "opacity-35",
              )}
            >
              <span
                className={cn(
                  "relative z-10 inline-flex size-7 shrink-0 items-center justify-center rounded-full border",
                  done ? "border-navy-700 bg-navy-900 text-white" : "border-slate-300 bg-white text-slate-500",
                )}
              >
                {done ? (
                  <CheckCircle2 aria-hidden="true" className="size-3.5" />
                ) : (
                  <Icon aria-hidden="true" className="size-3.5" />
                )}
              </span>
              <span className="min-w-0 flex-1 pt-0.5">
                <span className="flex flex-wrap items-center gap-1.5 text-xs font-semibold text-slate-900">
                  {step.title}
                  {step.simulated ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-900">
                      <FlaskConical aria-hidden="true" className="size-2.5" />
                      Simulação
                    </span>
                  ) : null}
                </span>
                <span className="block text-[11px] text-slate-600">{step.detail}</span>
              </span>
            </li>
          );
        })}
      </ol>
      <p className="mt-auto rounded-md border border-amber-200 bg-amber-50 px-2.5 py-2 text-[11px] leading-snug text-amber-900">
        Nesta versão, a análise preliminar e o e-mail são simulações demonstrativas. O advogado revisa tudo antes de
        qualquer uso.
      </p>
    </div>
  );
}

const PROVISION = [
  { label: "Provável", share: 0.32, amount: "R$ 1,84 mi", bar: "bg-red-600" },
  { label: "Possível", share: 0.48, amount: "R$ 2,76 mi", bar: "bg-amber-500" },
  { label: "Remota", share: 0.2, amount: "R$ 1,15 mi", bar: "bg-emerald-600" },
];

function ProvisionPanel() {
  const grown = useGrow();
  return (
    <div className="flex h-full flex-col gap-3">
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-lg border border-slate-200 p-2.5">
          <p className="text-[11px] text-slate-600">Valor da causa</p>
          <p className="mt-0.5 font-semibold tabular-nums text-slate-900">R$ 85.000,00</p>
          <p className="text-[10px] text-slate-500">Cadastro / planilha</p>
        </div>
        <div className="rounded-lg border border-dashed border-slate-300 p-2.5">
          <p className="text-[11px] text-slate-600">Valor liquidado</p>
          <p className="mt-0.5 font-semibold text-slate-700">Não apurado</p>
          <p className="text-[10px] text-slate-500">Nunca somado à causa</p>
        </div>
      </div>
      <div>
        <p className="mb-1.5 text-[11px] font-medium text-slate-600">Exposição por probabilidade de perda</p>
        <ul className="space-y-1.5">
          {PROVISION.map((p, i) => (
            <li key={p.label} className="grid grid-cols-[4.5rem_1fr_auto] items-center gap-2 text-[11px]">
              <span className="text-slate-700">{p.label}</span>
              <span className="h-2 overflow-hidden rounded-full bg-slate-100">
                <span
                  className={cn("block h-full rounded-full transition-[width] duration-700 ease-out", p.bar)}
                  style={{ width: grown ? `${p.share * 100}%` : "0%", transitionDelay: `${i * 90}ms` }}
                />
              </span>
              <span className="text-right font-semibold tabular-nums text-slate-900">{p.amount}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="mt-auto grid gap-2 sm:grid-cols-2">
        <p className="flex items-start gap-1.5 rounded-md border border-slate-200 p-2 text-[11px] text-slate-700">
          <Lock aria-hidden="true" className="mt-px size-3.5 shrink-0 text-navy-700" />
          <span>
            <span className="font-semibold text-slate-900">Competência 09/2026 fechada</span>
            <span className="block">Relatórios leem o fechamento, que não muda.</span>
          </span>
        </p>
        <p className="flex items-start gap-1.5 rounded-md border border-slate-200 p-2 text-[11px] text-slate-700">
          <CheckCircle2 aria-hidden="true" className="mt-px size-3.5 shrink-0 text-navy-700" />
          <span>
            <span className="font-semibold text-slate-900">6 valores propostos</span>
            <span className="block">Viram oficiais só com conferência identificada.</span>
          </span>
        </p>
      </div>
    </div>
  );
}

type Severity = "critical" | "warning" | "info";
const SEVERITY: Record<Severity, { label: string; className: string }> = {
  critical: { label: "Crítico", className: "bg-red-50 text-red-800 ring-red-200" },
  warning: { label: "Atenção", className: "bg-amber-50 text-amber-900 ring-amber-200" },
  info: { label: "Informativo", className: "bg-sky-50 text-sky-800 ring-sky-200" },
};

const ALERTS: { severity: Severity; title: string; meta: string }[] = [
  { severity: "critical", title: "Audiência de instrução em 2 dias", meta: "Vara do Trabalho (fictícia) · 14h00" },
  { severity: "warning", title: "Parcela de acordo vence em 5 dias", meta: "Acordo 3 de 10 · R$ 4.200,00" },
  { severity: "warning", title: "Execução sem valor liquidado apurado", meta: "Fase de execução · conferir cálculo" },
  {
    severity: "warning",
    title: "Garantia sem movimentação há 180 dias",
    meta: "Depósito recursal · verificar levantamento",
  },
  { severity: "info", title: "Análise preliminar aguardando revisão", meta: "Simulação · revisão do advogado" },
];

function AlertsPanel() {
  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-[11px] text-slate-600">Alertas e pendências</p>
          <p className="font-semibold text-slate-900">5 abertos · 1 crítico</p>
        </div>
        <BellRing aria-hidden="true" className="size-5 text-navy-700" />
      </div>
      <ul className="space-y-1.5">
        {ALERTS.map((a) => {
          const s = SEVERITY[a.severity];
          return (
            <li key={a.title} className="flex items-start gap-2 rounded-md border border-slate-200 px-2.5 py-2">
              <span
                className={cn(
                  "mt-px inline-flex shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ring-1",
                  s.className,
                )}
              >
                {s.label}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium text-slate-900">{a.title}</span>
                <span className="block truncate text-[11px] text-slate-600">{a.meta}</span>
              </span>
            </li>
          );
        })}
      </ul>
      <p className="mt-auto text-[10px] text-slate-500">
        Alertas gerados por rotinas a partir dos dados cadastrados — sem consulta automática a tribunais.
      </p>
    </div>
  );
}
