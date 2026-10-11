"use client";

import { AlertTriangle, BadgeCheck, FileText, LayoutDashboard, ShieldAlert, ShieldCheck, Sparkles } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useReducedMotion } from "./motion";

/**
 * Interactive product preview for the landing page. Every number and text here
 * is ILLUSTRATIVE (labeled on screen) — it never reads real data.
 */
const TABS = [
  { key: "painel", label: "Painel", icon: LayoutDashboard },
  { key: "preventivo", label: "Preventivo", icon: ShieldAlert },
  { key: "ia", label: "Análise de IA", icon: Sparkles },
] as const;

const ROTATE_MS = 7000;

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
    const delta = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const next = (active + delta + TABS.length) % TABS.length;
    setActive(next);
    tabRefs.current[next]?.focus();
  }

  return (
    <div
      className="relative"
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
    >
      <div aria-hidden="true" className="absolute -inset-6 rounded-[2rem] bg-gradient-to-tr from-brass-500/20 via-sky-400/10 to-transparent blur-2xl" />
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

        <div role="tablist" aria-label="Prévia da plataforma" className="flex gap-1 border-b border-slate-200 px-3 pt-2" onKeyDown={onKey}>
          {TABS.map((t, i) => {
            const Icon = t.icon;
            const selected = i === active;
            return (
              <button
                key={t.key}
                ref={(el) => {
                  tabRefs.current[i] = el;
                }}
                role="tab"
                id={`preview-tab-${t.key}`}
                aria-selected={selected}
                aria-controls={`preview-panel-${t.key}`}
                tabIndex={selected ? 0 : -1}
                onClick={() => setActive(i)}
                className={cn(
                  "relative inline-flex items-center gap-1.5 rounded-t-md px-3 py-2 text-xs font-medium transition-colors",
                  selected ? "text-[#1f3a5f]" : "text-slate-500 hover:text-slate-800",
                )}
              >
                <Icon aria-hidden="true" className="size-3.5" />
                {t.label}
                {selected ? (
                  <span aria-hidden="true" className="absolute inset-x-2 -bottom-px h-0.5 overflow-hidden rounded-full bg-slate-200">
                    <span
                      key={`${active}-${paused}`}
                      className={cn("block h-full origin-left bg-[#2f5282]", !paused && !reduced && "animate-progress")}
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
          id={`preview-panel-${TABS[active].key}`}
          aria-labelledby={`preview-tab-${TABS[active].key}`}
          className="h-[22rem] p-4 text-slate-800 sm:p-5"
        >
          <div key={active} className="h-full motion-safe:animate-fade-up">
            {active === 0 ? <DashboardPanel /> : active === 1 ? <PreventivePanel /> : <AiPanel reduced={reduced} />}
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

function Tile({ label, value, tone }: { label: string; value: string; tone?: "danger" }) {
  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <p className="text-[11px] text-slate-500">{label}</p>
      <p className={cn("mt-1 text-lg font-semibold tabular-nums", tone === "danger" ? "text-red-700" : "text-slate-900")}>{value}</p>
    </div>
  );
}

const RISK = [
  { label: "Baixo", value: 38, color: "#0ca30c" },
  { label: "Médio", value: 46, color: "#fab219" },
  { label: "Alto", value: 31, color: "#ec835a" },
  { label: "Crítico", value: 13, color: "#d03b3b" },
];
const MONTHS = [6, 9, 7, 11, 8, 12, 10, 14, 9, 13, 15, 12];

function DashboardPanel() {
  const grown = useGrow();
  const total = RISK.reduce((a, r) => a + r.value, 0);
  return (
    <div className="flex h-full flex-col gap-4">
      <div className="grid grid-cols-3 gap-2">
        <Tile label="Processos ativos" value="128" />
        <Tile label="Prazos vencidos" value="3" tone="danger" />
        <Tile label="Exposição informada" value="R$ 18,4 mi" />
      </div>
      <div>
        <p className="mb-1.5 text-[11px] font-medium text-slate-500">Risco por criticidade</p>
        <div className="flex h-5 gap-[2px]">
          {RISK.map((r, i) => (
            <span
              key={r.label}
              title={`${r.label}: ${r.value}`}
              className="h-full transition-[width] duration-700 ease-out first:rounded-l last:rounded-r"
              style={{ width: grown ? `${(r.value / total) * 100}%` : "0%", backgroundColor: r.color, transitionDelay: `${i * 80}ms` }}
            />
          ))}
        </div>
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-slate-500">
          {RISK.map((r) => (
            <span key={r.label} className="inline-flex items-center gap-1">
              <span className="size-2 rounded-[2px]" style={{ backgroundColor: r.color }} />
              {r.label} {r.value}
            </span>
          ))}
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <p className="mb-1.5 text-[11px] font-medium text-slate-500">Entradas de processos por mês</p>
        <div className="flex flex-1 items-end gap-1.5 border-b border-slate-300 pb-px">
          {MONTHS.map((m, i) => (
            <span
              key={i}
              className="flex-1 rounded-t-[3px] bg-[#2a78d6] transition-[height] duration-700 ease-out"
              style={{ height: grown ? `${(m / 15) * 100}%` : "0%", transitionDelay: `${i * 40}ms` }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function PreventivePanel() {
  const grown = useGrow();
  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] text-slate-500">Ocorrência · Contratual</p>
          <p className="font-semibold text-slate-900">Notificação extrajudicial de fornecedor</p>
        </div>
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-orange-50 px-2 py-0.5 text-[11px] font-medium text-orange-800 ring-1 ring-orange-200">
          <span className="size-1.5 rounded-full bg-[#ec835a]" />
          Risco alto
        </span>
      </div>
      <ul className="space-y-1.5 text-xs">
        {[
          { icon: AlertTriangle, text: "Multa contratual de 10% citada na notificação", tag: "S1" },
          { icon: AlertTriangle, text: "Prazo de resposta de 5 dias úteis mencionado", tag: "S2" },
          { icon: FileText, text: "Falta o comprovante de entrega do lote", tag: "lacuna" },
        ].map((s) => (
          <li key={s.text} className="flex items-center gap-2 rounded-md bg-slate-50 px-2.5 py-2">
            <s.icon aria-hidden="true" className="size-3.5 shrink-0 text-orange-600" />
            <span className="flex-1">{s.text}</span>
            <span className="rounded bg-violet-50 px-1.5 py-0.5 text-[10px] font-semibold text-violet-700">{s.tag}</span>
          </li>
        ))}
      </ul>
      <div className="mt-auto rounded-lg border border-slate-200 p-3">
        <div className="mb-2 flex items-center justify-between text-xs">
          <span className="font-medium">Plano de ação</span>
          <span className="text-slate-500">2 de 5 concluídas</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-slate-100">
          <span className="block h-full rounded-full bg-[#1f3a5f] transition-[width] duration-700 ease-out" style={{ width: grown ? "40%" : "0%" }} />
        </div>
        <p className="mt-2 text-[11px] text-slate-500">Próxima: responder ao fornecedor — responsável: Jurídico</p>
      </div>
    </div>
  );
}

const SUMMARY =
  "A notificação cobra multa de 10% por atraso na entrega e fixa 5 dias úteis para resposta. O contrato (versão 2) prevê a multa, mas condiciona a cobrança à comprovação do atraso — documento que não foi anexado.";

function AiPanel({ reduced }: { reduced: boolean }) {
  const [n, setN] = useState(reduced ? SUMMARY.length : 0);
  useEffect(() => {
    if (reduced) return;
    const id = window.setInterval(() => setN((v) => (v >= SUMMARY.length ? v : v + 3)), 22);
    return () => window.clearInterval(id);
  }, [reduced]);
  const done = n >= SUMMARY.length;
  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-violet-800">
          <Sparkles aria-hidden="true" className="size-3.5" />
          Sinais de risco · análise de apoio
        </span>
        <span className="text-[10px] text-slate-500">11/10/2026 14:32</span>
      </div>
      <div className="min-h-[5.5rem] rounded-lg bg-violet-50/70 p-3 text-xs leading-relaxed text-slate-800">
        <span className="sr-only">{SUMMARY}</span>
        <span aria-hidden="true">
          {SUMMARY.slice(0, n)}
          {!done ? <span className="ml-0.5 inline-block h-3 w-px translate-y-0.5 bg-violet-700 motion-safe:animate-caret" /> : null}
        </span>
      </div>
      <div className={cn("space-y-3 transition-opacity duration-500", done ? "opacity-100" : "opacity-0")}>
        <div className="flex flex-wrap gap-1.5 text-[11px]">
          <span className="text-slate-500">Fontes:</span>
          <SourceChip refId="S1" label="Contrato de fornecimento · v2" />
          <SourceChip refId="S2" label="Notificação extrajudicial" />
        </div>
        <div className="grid gap-2 text-[11px] sm:grid-cols-2">
          <p className="flex gap-1.5 rounded-md border border-slate-200 p-2">
            <BadgeCheck aria-hidden="true" className="size-3.5 shrink-0 text-[#2f5282]" />
            Validar: data efetiva da entrega e forma da notificação.
          </p>
          <p className="flex gap-1.5 rounded-md border border-amber-200 bg-amber-50 p-2 text-amber-900">
            <ShieldCheck aria-hidden="true" className="size-3.5 shrink-0" />
            Instrução escondida no documento foi ignorada.
          </p>
        </div>
      </div>
      <p className="mt-auto text-[10px] text-slate-500">Apoio à análise — não substitui a avaliação de um advogado.</p>
    </div>
  );
}

function SourceChip({ refId, label }: { refId: string; label: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-violet-200 bg-white px-2 py-0.5">
      <span className="font-semibold text-violet-700">{refId}</span>
      <span className="text-slate-600">{label}</span>
    </span>
  );
}
