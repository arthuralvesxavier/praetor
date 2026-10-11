"use client";

import { CheckCircle2, ClipboardList, FilePlus2, LayoutDashboard, ListChecks, ScanSearch, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { prefersReducedMotion } from "./motion";

const STEPS = [
  {
    icon: ClipboardList,
    title: "Registre",
    text: "Cadastre a ocorrência preventiva ou o processo, com responsáveis, unidade, valores e classificação de risco.",
    detail: ["Ocorrência: atraso de fornecedor crítico", "Responsável: Jurídico Contratos", "Risco informado: alto"],
  },
  {
    icon: FilePlus2,
    title: "Anexe documentos",
    text: "Envie contratos, notificações e evidências. Cada envio vira uma versão, com controle de acesso e texto extraído.",
    detail: ["contrato-fornecimento.pdf · versão 2", "notificacao-extrajudicial.docx · versão 1", "Download só com sessão e permissão"],
  },
  {
    icon: Sparkles,
    title: "Solicite a análise",
    text: "A IA lê apenas o que você pode acessar e devolve achados com fontes citadas, limitações e pontos de validação.",
    detail: ["Sinais de risco · 2 achados", "Fontes: S1 contrato v2 · S2 notificação", "Análises idênticas são reaproveitadas"],
  },
  {
    icon: ScanSearch,
    title: "Revise",
    text: "Um advogado revisa o resultado, descarta o que não procede e registra a revisão na trilha de auditoria.",
    detail: ["Revisada por: advogada responsável", "Observação registrada", "Análise antiga é sinalizada quando a fonte muda"],
  },
  {
    icon: ListChecks,
    title: "Transforme em ação",
    text: "Sugestões viram tarefas e prazos só por decisão humana. Prazos sugeridos pela IA aguardam validação.",
    detail: ["Tarefa: responder à notificação", "Prazo sugerido → aguardando validação", "Sem contagem automática de prazos processuais"],
  },
  {
    icon: LayoutDashboard,
    title: "Acompanhe no BI",
    text: "Indicadores, riscos, exposição e pendências por responsável, com clique direto nos registros de origem.",
    detail: ["Prazos vencidos e próximos", "Exposição informada por área", "Pendências por responsável"],
  },
];

const STEP_MS = 5000;

export function FlowStepper() {
  const [active, setActive] = useState(0);
  const [auto, setAuto] = useState(true);

  useEffect(() => {
    if (!auto || prefersReducedMotion()) return;
    const id = window.setTimeout(() => setActive((i) => (i + 1) % STEPS.length), STEP_MS);
    return () => window.clearTimeout(id);
  }, [active, auto]);

  const step = STEPS[active];
  const Icon = step.icon;

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:gap-12">
      <ol className="relative space-y-1">
        <span aria-hidden="true" className="absolute top-5 bottom-5 left-[1.375rem] w-px bg-slate-200" />
        <span
          aria-hidden="true"
          className="absolute top-5 left-[1.375rem] w-px bg-[#2f5282] transition-[height] duration-500"
          style={{ height: `calc((100% - 2.5rem) * ${active / (STEPS.length - 1)})` }}
        />
        {STEPS.map((s, i) => {
          const StepIcon = s.icon;
          const isActive = i === active;
          const done = i < active;
          return (
            <li key={s.title}>
              <button
                type="button"
                aria-current={isActive ? "step" : undefined}
                onClick={() => {
                  setActive(i);
                  setAuto(false);
                }}
                className={cn(
                  "group relative flex w-full items-start gap-4 rounded-xl p-2 text-left transition-colors",
                  isActive ? "bg-white shadow-sm ring-1 ring-slate-200" : "hover:bg-white/70",
                )}
              >
                <span
                  className={cn(
                    "relative z-10 inline-flex size-9 shrink-0 items-center justify-center rounded-full border transition-colors",
                    isActive
                      ? "border-[#2f5282] bg-[#1f3a5f] text-white"
                      : done
                        ? "border-[#2f5282] bg-white text-[#2f5282]"
                        : "border-slate-300 bg-white text-slate-400",
                  )}
                >
                  {done ? <CheckCircle2 aria-hidden="true" className="size-4" /> : <StepIcon aria-hidden="true" className="size-4" />}
                </span>
                <span className="pt-1.5">
                  <span className="text-[11px] font-semibold tracking-wide text-slate-400 uppercase">Passo {i + 1}</span>
                  <span className={cn("block text-base font-semibold", isActive ? "text-slate-900" : "text-slate-600")}>{s.title}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      <div className="relative">
        <div aria-hidden="true" className="absolute -inset-4 rounded-3xl bg-gradient-to-br from-[#2f5282]/10 to-brass-400/10 blur-xl" />
        <div key={active} aria-live="polite" className="relative rounded-2xl border border-slate-200 bg-white p-6 shadow-xl shadow-slate-900/5 motion-safe:animate-fade-up sm:p-8">
          <span className="inline-flex size-12 items-center justify-center rounded-xl bg-[#1f3a5f] text-white">
            <Icon aria-hidden="true" className="size-6" />
          </span>
          <p className="mt-5 text-xs font-semibold tracking-[0.16em] text-brass-600 uppercase">
            Passo {active + 1} de {STEPS.length}
          </p>
          <h3 className="mt-1 font-display text-3xl font-semibold text-slate-900">{step.title}</h3>
          <p className="mt-3 text-base leading-relaxed text-slate-600">{step.text}</p>
          <ul className="mt-6 space-y-2">
            {step.detail.map((d, i) => (
              <li
                key={d}
                className="flex items-center gap-2.5 rounded-lg bg-slate-50 px-3 py-2.5 text-sm text-slate-700 motion-safe:animate-fade-up"
                style={{ animationDelay: `${150 + i * 120}ms` }}
              >
                <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-brass-500" />
                {d}
              </li>
            ))}
          </ul>
          <p className="mt-5 text-[11px] text-slate-400">Exemplo ilustrativo.</p>
        </div>
      </div>
    </div>
  );
}
