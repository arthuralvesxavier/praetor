"use client";

import { BellRing, CheckCircle2, FileSearch, FileSpreadsheet, Inbox, Landmark, Mail, Pause, Play } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { useReducedMotion } from "./motion";

/** v2 flow, from the spreadsheet to the monthly close. Simulated steps say so. */
const STEPS = [
  {
    icon: FileSpreadsheet,
    title: "Importe a carteira",
    text: "Envie a planilha do passivo. O Praetor valida o número CNJ, agrupa as instâncias do mesmo processo e aponta duplicidades e valores divergentes antes da carga.",
    detail: [
      "Dígito verificador do CNJ conferido",
      "Instâncias do mesmo CNJ em um só processo",
      "Relatório de inconsistências por linha e aba",
    ],
    simulated: false,
  },
  {
    icon: Inbox,
    title: "Receba novos processos",
    text: "Cada novo processo entra por uma fila de entrada e é distribuído ao advogado ou escritório responsável pelas regras que você define.",
    detail: [
      "Regras por área, tribunal e empresa",
      "Carga de trabalho por responsável",
      "Redistribuição quando necessário",
    ],
    simulated: false,
  },
  {
    icon: FileSearch,
    title: "Análise preliminar",
    text: "Um resumo do caso com pedidos, valores, riscos e próximos passos. Nesta versão é gerado por um simulador e identificado como demonstrativo.",
    detail: [
      "Extraído: com documento, página e trecho",
      "Cadastro/planilha · Ilustrativo · Lacuna",
      "Revisão e aprovação pelo advogado",
    ],
    simulated: true,
  },
  {
    icon: Mail,
    title: "Aviso ao responsável",
    text: "O advogado recebe o resumo e o link do processo. Nesta versão o e-mail é simulado: fica registrado na Central de e-mails e nada é enviado.",
    detail: [
      "Assunto iniciado por “[Simulação]”",
      "“Envio simulado — nenhuma mensagem foi enviada”",
      "Histórico por processo e destinatário",
    ],
    simulated: true,
  },
  {
    icon: Landmark,
    title: "Valores e provisão",
    text: "Valor da causa e valor liquidado lado a lado, garantias, acordos e risco. Valores propostos só viram oficiais com conferência de uma pessoa identificada.",
    detail: ["Nunca soma causa e liquidado", "“Não apurado” não é zero", "Fechamento mensal imutável"],
    simulated: false,
  },
  {
    icon: BellRing,
    title: "Acompanhe e reporte",
    text: "Audiências, parcelas de acordo, garantias paradas e pendências viram alertas. Relatórios e painéis mostram a carteira por empresa, tribunal e fase.",
    detail: [
      "Alertas com severidade e link para o registro",
      "Relatórios em XLSX e CSV",
      "Painel executivo por empresa",
    ],
    simulated: false,
  },
];

const STEP_MS = 5000;

export function FlowStepper() {
  const [active, setActive] = useState(0);
  const [auto, setAuto] = useState(true);
  const reduced = useReducedMotion();
  const running = auto && !reduced;

  useEffect(() => {
    if (!running) return;
    const id = window.setTimeout(() => setActive((i) => (i + 1) % STEPS.length), STEP_MS);
    return () => window.clearTimeout(id);
  }, [active, running]);

  const step = STEPS[active];
  const Icon = step.icon;

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:gap-12">
      <div>
        <ol className="relative space-y-1">
          <span aria-hidden="true" className="absolute top-5 bottom-5 left-[1.375rem] w-px bg-slate-200" />
          <span
            aria-hidden="true"
            className="absolute top-5 left-[1.375rem] w-px bg-navy-600 transition-[height] duration-500"
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
                        ? "border-navy-600 bg-navy-900 text-white"
                        : done
                          ? "border-navy-600 bg-white text-navy-700"
                          : "border-slate-300 bg-white text-slate-500",
                    )}
                  >
                    {done ? (
                      <CheckCircle2 aria-hidden="true" className="size-4" />
                    ) : (
                      <StepIcon aria-hidden="true" className="size-4" />
                    )}
                  </span>
                  <span className="pt-1.5">
                    <span className="text-[11px] font-semibold tracking-wide text-slate-500 uppercase">
                      Passo {i + 1}
                    </span>
                    <span
                      className={cn("block text-base font-semibold", isActive ? "text-slate-900" : "text-slate-600")}
                    >
                      {s.title}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
        {!reduced ? (
          <div className="mt-2 pl-2">
            <button
              type="button"
              onClick={() => setAuto((v) => !v)}
              aria-pressed={!auto}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-slate-600 hover:bg-white hover:text-slate-900"
            >
              {auto ? (
                <Pause aria-hidden="true" className="size-3.5" />
              ) : (
                <Play aria-hidden="true" className="size-3.5" />
              )}
              {auto ? "Pausar a demonstração automática" : "Retomar a demonstração automática"}
            </button>
          </div>
        ) : null}
      </div>

      <div className="relative">
        <div
          aria-hidden="true"
          className="absolute -inset-4 rounded-3xl bg-gradient-to-br from-navy-500/10 to-gold-400/15 blur-xl"
        />
        <div
          key={active}
          aria-live={running ? "off" : "polite"}
          className="relative rounded-2xl border border-slate-200 bg-white p-6 shadow-xl shadow-slate-900/5 motion-safe:animate-fade-up sm:p-8"
        >
          <span className="inline-flex size-12 items-center justify-center rounded-xl bg-navy-900 text-white">
            <Icon aria-hidden="true" className="size-6" />
          </span>
          <p className="mt-5 flex flex-wrap items-center gap-2 text-xs font-semibold tracking-[0.16em] text-gold-700 uppercase">
            Passo {active + 1} de {STEPS.length}
            {step.simulated ? (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] tracking-normal text-amber-900 normal-case">
                Simulação nesta versão
              </span>
            ) : null}
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
                <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-gold-500" />
                {d}
              </li>
            ))}
          </ul>
          <p className="mt-5 text-[11px] text-slate-500">Exemplo ilustrativo.</p>
        </div>
      </div>
    </div>
  );
}
