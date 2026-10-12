"use client";

import {
  ArrowRight,
  Check,
  FileSpreadsheet,
  FileSearch,
  Landmark,
  Lock,
  Mail,
  Pause,
  Play,
  Route,
  UserCheck,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Tone } from "@/lib/tones";
import { cn } from "@/lib/utils";
import {
  MiniBadge,
  MiniButton,
  MiniCard,
  MiniCardHeader,
  MiniCnj,
  MiniPageHeader,
  MiniStat,
  Provenance,
} from "./mini-ui";
import { useReducedMotion } from "./motion";
import { SAMPLE, SAMPLE_LAWYER, SAMPLE_LAWYER_FIRST, SAMPLE_TOTALS } from "./sample-data";

/**
 * "Como funciona": the real path of a case in the platform (imports, intake,
 * distribution, briefs, e-mails, contingency), one step per stage. Every step
 * text is always visible; the selected step shows an illustrative screen.
 */
type Step = { key: string; icon: LucideIcon; title: string; text: string; screen: string; render: () => ReactNode };

const STEPS: Step[] = [
  {
    key: "carteira",
    icon: FileSpreadsheet,
    title: "A carteira entra",
    text: "Importe a planilha do passivo ou cadastre um processo recebido. Antes de gravar, o Praetor confere o número CNJ e o dígito verificador, junta as instâncias do mesmo processo, aponta duplicidades e entrega um relatório de inconsistências.",
    screen: "Importação de planilhas",
    render: () => <ImportScreen />,
  },
  {
    key: "distribuicao",
    icon: Route,
    title: "O processo vai para o responsável",
    text: "Regras de distribuição escolhem o advogado ou o escritório pelo tribunal, área, empresa, cidade, instância ou valor. Sem regra aplicável, o caso vai para quem tem menor carga na unidade.",
    screen: "Distribuição",
    render: () => <DistributionScreen />,
  },
  {
    key: "leitura",
    icon: FileSearch,
    title: "Os documentos são lidos",
    text: "Uma análise preliminar organiza fatos, pedidos, valores, lacunas e possíveis prazos. Cada item mostra de onde veio: o documento e a página, ou o cadastro e a planilha.",
    screen: "Análise preliminar",
    render: () => <BriefScreen />,
  },
  {
    key: "aviso",
    icon: Mail,
    title: "O advogado recebe o aviso",
    text: "Um e-mail leva ao responsável a síntese do caso, os pontos de atenção e o link do processo. A mensagem fica guardada na Central de e-mails.",
    screen: "Central de e-mails",
    render: () => <EmailScreen />,
  },
  {
    key: "revisao",
    icon: UserCheck,
    title: "Revisão e aprovação",
    text: "O advogado confere, edita e aprova. Nada muda no processo sem essa decisão, e um prazo sugerido só passa a contar depois que uma pessoa o valida.",
    screen: "Análise preliminar",
    render: () => <ReviewScreen />,
  },
  {
    key: "fechamento",
    icon: Landmark,
    title: "Valores e fechamento do mês",
    text: "Valores, garantias, risco e provisão alimentam o fechamento mensal e o painel executivo. Um valor proposto só entra nos totais depois de conferido, e a competência fechada não muda mais.",
    screen: "Valores e provisão",
    render: () => <ClosingScreen />,
  },
];

const STEP_MS = 6500;

export function FlowStepper({ initialStep = 0 }: { initialStep?: number }) {
  const [active, setActive] = useState(initialStep);
  const [auto, setAuto] = useState(true);
  const [inView, setInView] = useState(false);
  const reduced = useReducedMotion();
  const rootRef = useRef<HTMLDivElement>(null);
  const running = auto && !reduced && inView;

  useEffect(() => {
    const el = rootRef.current;
    if (!el || !("IntersectionObserver" in window)) return;
    const io = new IntersectionObserver(([entry]) => setInView(Boolean(entry?.isIntersecting)), { threshold: 0.35 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!running) return;
    const id = window.setTimeout(() => setActive((i) => (i + 1) % STEPS.length), STEP_MS);
    return () => window.clearTimeout(id);
  }, [active, running]);

  const select = (i: number) => {
    setActive(i);
    setAuto(false);
  };

  return (
    <div ref={rootRef} className="grid gap-8 normal-nums lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)] lg:gap-12">
      <div className="min-w-0">
        <ol className="relative flex flex-col gap-1">
          <span aria-hidden="true" className="absolute top-8 bottom-8 left-[1.6875rem] w-px bg-slate-200" />
          {STEPS.map((s, i) => {
            const isActive = i === active;
            const done = i < active;
            return (
              <li key={s.key} className="relative">
                <div
                  className={cn(
                    "relative flex gap-4 rounded-xl p-3 transition-colors",
                    isActive ? "bg-white shadow-sm ring-1 ring-slate-200" : "hover:bg-white/70",
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "relative z-10 inline-flex size-8 shrink-0 items-center justify-center rounded-full border text-sm font-semibold tabular-nums transition-colors",
                      isActive
                        ? "border-navy-900 bg-navy-900 text-gold-300"
                        : done
                          ? "border-navy-600 bg-white text-navy-700"
                          : "border-slate-300 bg-white text-slate-500",
                    )}
                  >
                    {done ? <Check className="size-4" /> : i + 1}
                  </span>
                  <div className="min-w-0 pt-1">
                    <h3 className="text-base font-semibold text-slate-900">
                      <button
                        type="button"
                        aria-current={isActive ? "step" : undefined}
                        onClick={() => select(i)}
                        className="cursor-pointer rounded-sm text-left after:absolute after:inset-0 after:rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                      >
                        <span className="sr-only">Etapa {i + 1}: </span>
                        {s.title}
                      </button>
                    </h3>
                    <p className={cn("mt-1 text-sm leading-relaxed", isActive ? "text-slate-700" : "text-slate-600")}>
                      {s.text}
                    </p>
                  </div>
                </div>
                {isActive ? (
                  <div className="mt-2 mb-3 pl-0 sm:pl-12 lg:hidden">
                    <StepWindow step={s} />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
        {!reduced ? (
          <button
            type="button"
            onClick={() => setAuto((v) => !v)}
            aria-pressed={!auto}
            className="mt-3 ml-3 inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-slate-600 hover:bg-white hover:text-slate-900"
          >
            {auto ? <Pause aria-hidden="true" className="size-3.5" /> : <Play aria-hidden="true" className="size-3.5" />}
            {auto ? "Pausar a troca automática das etapas" : "Retomar a troca automática das etapas"}
          </button>
        ) : null}
      </div>

      <div className="relative hidden min-w-0 lg:block">
        <div className="sticky top-24">
          <div
            aria-hidden="true"
            className="absolute -inset-4 rounded-3xl bg-gradient-to-br from-navy-500/10 to-gold-400/15 blur-xl"
          />
          <div className="relative" aria-live={running ? "off" : "polite"}>
            <StepWindow key={active} step={STEPS[active]} progress={running ? STEP_MS : null} />
          </div>
        </div>
      </div>
    </div>
  );
}

/** Window with the illustrative screen of a step. */
function StepWindow({ step, progress = null }: { step: Step; progress?: number | null }) {
  const Icon = step.icon;
  return (
    <figure className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl shadow-slate-900/10 motion-safe:animate-fade-in">
      <div className="relative flex items-center gap-2 border-b border-slate-200 bg-slate-100 px-3 py-2">
        <span className="inline-flex size-5 items-center justify-center rounded bg-navy-900 text-gold-300">
          <Icon aria-hidden="true" className="size-3" />
        </span>
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-slate-700">{step.screen}</span>
        <span className="shrink-0 text-[10px] font-medium text-slate-500">Tela ilustrativa</span>
        {progress ? (
          <span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-0.5 bg-slate-200">
            <span className="block h-full origin-left animate-progress bg-gold-500" style={{ animationDuration: `${progress}ms` }} />
          </span>
        ) : null}
      </div>
      <div className="@container bg-canvas p-3 text-left text-slate-800 sm:p-4 lg:h-[23.5rem] lg:overflow-hidden">
        {step.render()}
      </div>
      <figcaption className="sr-only">Tela ilustrativa da etapa {step.title}, com dados fictícios.</figcaption>
    </figure>
  );
}

// ---------------------------------------------------------------------------
// Screens (illustrative data from sample-data.ts)
// ---------------------------------------------------------------------------

function IssueRow({ tone, level, line, text }: { tone: Tone; level: string; line: number; text: string }) {
  return (
    <li className="flex min-w-0 items-center gap-2 px-2.5 py-1.5">
      <MiniBadge tone={tone} dot className="w-[5.4rem] justify-center">
        {level}
      </MiniBadge>
      <span className="w-12 shrink-0 text-[9.5px] text-muted-foreground tabular-nums">Linha {line}</span>
      <span className="min-w-0 truncate text-[10px] text-slate-800">{text}</span>
    </li>
  );
}

function ImportScreen() {
  return (
    <div className="flex flex-col gap-2.5">
      <MiniPageHeader
        crumbs={["Importação de planilhas", "carteira-passivo.xlsx"]}
        title="carteira-passivo.xlsx"
        meta={
          <MiniBadge tone="warning" dot>
            Analisada, aguardando confirmação
          </MiniBadge>
        }
      />
      <MiniCard>
        <MiniCardHeader title="Abas detectadas" />
        <ul className="divide-y divide-border text-[10px]">
          <li className="flex items-center justify-between gap-2 px-2.5 py-1.5">
            <span className="truncate">Atualização Geral</span>
            <MiniBadge tone="primary">Base consolidada (oficial)</MiniBadge>
          </li>
          <li className="flex items-center justify-between gap-2 px-2.5 py-1.5">
            <span className="truncate">2º Grau</span>
            <MiniBadge tone="info">Aba por instância (conferência)</MiniBadge>
          </li>
        </ul>
      </MiniCard>
      <MiniCard>
        <MiniCardHeader title="Inconsistências" aside={<MiniBadge>4 ocorrências</MiniBadge>} />
        <ul className="divide-y divide-border">
          <IssueRow tone="danger" level="Erro" line={214} text="Número fora do padrão CNJ" />
          <IssueRow tone="warning" level="Alerta" line={96} text="Dígito verificador não confere" />
          <IssueRow tone="warning" level="Alerta" line={388} text="Número repetido na aba" />
          <IssueRow tone="info" level="Informação" line={77} text="Tribunal derivado do número" />
        </ul>
      </MiniCard>
      <div className="flex flex-wrap items-center justify-between gap-1.5">
        {/* A repeated number is a warning in the parser, but its line is skipped like an error. */}
        <p className="text-[9px] text-muted-foreground">Erro e número repetido: linha não importada. Demais alertas: conferir.</p>
        <span className="flex gap-1.5">
          <MiniButton variant="outline">Exportar CSV</MiniButton>
          <MiniButton>Confirmar importação</MiniButton>
        </span>
      </div>
    </div>
  );
}

function RuleRow({
  order,
  name,
  matched,
  reason,
}: {
  order: number;
  name: string;
  matched: boolean;
  reason: string;
}) {
  return (
    <li className="flex min-w-0 items-start gap-2 px-2.5 py-1.5">
      <span className="w-3 shrink-0 text-[9.5px] text-muted-foreground tabular-nums">{order}</span>
      <span
        className={cn(
          "mt-px inline-flex size-3.5 shrink-0 items-center justify-center rounded-full",
          matched ? "bg-emerald-600 text-white" : "bg-slate-200 text-slate-600",
        )}
      >
        {matched ? <Check aria-hidden="true" className="size-2.5" /> : <X aria-hidden="true" className="size-2.5" />}
      </span>
      <span className="min-w-0">
        <span className={cn("block truncate text-[10px] font-medium", matched ? "text-slate-900" : "text-slate-600")}>
          {name}
        </span>
        <span className="block truncate text-[9px] text-muted-foreground">{reason}</span>
      </span>
    </li>
  );
}

function DistributionScreen() {
  const p = SAMPLE.incoming;
  return (
    <div className="flex flex-col gap-2.5">
      <MiniPageHeader
        crumbs={["Distribuição", "Testar regras"]}
        title="Testar regras"
        description={`${p.number} · ${p.court} · Trabalhista`}
      />
      <MiniCard>
        <MiniCardHeader title="Regras, em ordem de prioridade" />
        <ol className="divide-y divide-border">
          <RuleRow order={1} name="Cível · TJSP" matched={false} reason="Não se aplica: a área é trabalhista" />
          <RuleRow
            order={2}
            name="Trabalhista · acima de R$ 500.000,00"
            matched={false}
            reason="Não se aplica: valor da causa de R$ 58.000,00"
          />
          <RuleRow order={3} name="Trabalhista · TRT10 (rodízio da equipe)" matched reason="Aplica: área trabalhista, tribunal TRT10" />
        </ol>
      </MiniCard>
      <MiniCard className="p-2.5">
        <p className="text-[9.5px] text-muted-foreground">Responsável definido</p>
        <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[12px] font-semibold text-slate-900">
          {SAMPLE_LAWYER}
          <MiniBadge tone="primary">Regra de distribuição</MiniBadge>
        </p>
        <p className="mt-1 text-[9.5px] text-muted-foreground">
          A atribuição e o motivo ficam registrados no histórico do processo.
        </p>
      </MiniCard>
    </div>
  );
}

function BriefItem({ text, kind, cite }: { text: string; kind: Parameters<typeof Provenance>[0]["kind"]; cite?: string }) {
  return (
    <li className="flex min-w-0 items-center justify-between gap-2 px-2.5 py-1.5">
      <span className="min-w-0 truncate text-[10px] text-slate-800">{text}</span>
      <span className="flex shrink-0 items-center gap-1">
        {cite ? <span className="font-mono text-[9px] text-primary-700">{cite}</span> : null}
        <Provenance kind={kind} />
      </span>
    </li>
  );
}

function BriefGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <p className="border-b border-border bg-surface-muted px-2.5 py-1 text-[9px] font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </p>
      <ul className="divide-y divide-border">{children}</ul>
    </div>
  );
}

function BriefScreen() {
  const p = SAMPLE.incoming;
  return (
    <div className="flex flex-col gap-2.5">
      <MiniPageHeader
        crumbs={["Análises preliminares", p.number]}
        title="Análise preliminar · versão 1"
        meta={
          <>
            <MiniBadge tone="warning" dot>
              Pronta para revisão
            </MiniBadge>
            <MiniBadge tone="warning">Demonstração</MiniBadge>
          </>
        }
      />
      <MiniCard className="overflow-hidden">
        <BriefGroup title="Pedidos">
          <BriefItem text="Diferenças salariais por equiparação, R$ 31.200,00" kind="extracted" cite="D1 · p. 4" />
          <BriefItem text="Reflexos em férias e 13º salário" kind="extracted" cite="D1 · p. 5" />
        </BriefGroup>
        <BriefGroup title="Fatos">
          <BriefItem text="Admissão em 03/02/2021" kind="record" />
        </BriefGroup>
        <BriefGroup title="Lacunas">
          <BriefItem text="Ficha funcional do paradigma não localizada" kind="missing" />
        </BriefGroup>
        <BriefGroup title="Possíveis prazos">
          <BriefItem text="Audiência inicial em 04/11/2026" kind="extracted" cite="D2 · p. 1" />
        </BriefGroup>
      </MiniCard>
      <p className="text-[9.5px] text-muted-foreground">
        D1 é a petição inicial e D2 a notificação. Clicar na citação abre a página com o trecho destacado.
      </p>
    </div>
  );
}

function EmailScreen() {
  const p = SAMPLE.incoming;
  return (
    <div className="flex flex-col gap-2.5">
      <MiniPageHeader crumbs={["Central de e-mails", "Mensagem"]} title="Análise preliminar disponível" />
      <MiniCard className="overflow-hidden">
        <div className="space-y-0.5 border-b border-border px-3 py-2 text-[9.5px]">
          <p className="flex items-center justify-between gap-2">
            <span className="truncate">
              <span className="text-muted-foreground">Para: </span>
              {SAMPLE_LAWYER}
            </span>
            <MiniBadge tone="warning">Demonstração</MiniBadge>
          </p>
          <p className="truncate">
            <span className="text-muted-foreground">Assunto: </span>
            Análise preliminar disponível: {p.number}
          </p>
        </div>
        <div className="space-y-2 px-3 py-2.5 text-[10px] leading-relaxed text-slate-800">
          <p>
            Olá, {SAMPLE_LAWYER_FIRST}. A análise preliminar (versão 1) do processo abaixo foi gerada e aguarda a sua
            revisão. Nada foi alterado no cadastro do processo.
          </p>
          <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-2 gap-y-0.5 rounded bg-surface-muted px-2 py-1.5 text-[9.5px]">
            <dt className="text-muted-foreground">Processo</dt>
            <dd className="truncate font-mono">{p.number}</dd>
            <dt className="text-muted-foreground">Partes</dt>
            <dd className="truncate">
              {p.plaintiff} × {p.defendant}
            </dd>
            <dt className="text-muted-foreground">Órgão julgador</dt>
            <dd className="truncate">11ª Vara do Trabalho</dd>
          </dl>
          <div>
            <p className="text-[9.5px] font-semibold text-slate-900">Possíveis prazos a conferir</p>
            <p className="text-[9.5px]">Audiência inicial, 04/11/2026</p>
          </div>
          <MiniButton icon={ArrowRight}>Abrir o processo</MiniButton>
        </div>
      </MiniCard>
    </div>
  );
}

function ReviewScreen() {
  return (
    <div className="flex flex-col gap-2.5">
      <MiniPageHeader
        crumbs={["Análises preliminares", "Revisão"]}
        title="Revisão do advogado"
        meta={
          <MiniBadge tone="info" dot>
            Em revisão
          </MiniBadge>
        }
      />
      <MiniCard>
        <MiniCardHeader title="Sugestões para aplicar" />
        <ul className="divide-y divide-border">
          <li className="flex min-w-0 flex-col gap-1 px-2.5 py-2">
            <span className="flex min-w-0 items-center justify-between gap-2">
              <span className="truncate text-[10px] font-medium text-slate-900">Prazo: audiência inicial, 04/11/2026</span>
              <MiniBadge tone="ai">Aguardando validação</MiniBadge>
            </span>
            <span className="flex gap-1">
              <MiniButton>Validar</MiniButton>
              <MiniButton variant="outline">Rejeitar</MiniButton>
            </span>
          </li>
          <li className="flex min-w-0 items-center justify-between gap-2 px-2.5 py-2">
            <span className="min-w-0">
              <span className="block truncate text-[10px] font-medium text-slate-900">Valor: pedido de R$ 31.200,00</span>
              <span className="block truncate text-[9px] text-muted-foreground">Vai para a fila de conferência</span>
            </span>
            <MiniBadge>Proposto</MiniBadge>
          </li>
          <li className="flex min-w-0 items-center justify-between gap-2 px-2.5 py-2">
            <span className="truncate text-[10px] font-medium text-slate-900">Tarefa: pedir a ficha funcional do paradigma</span>
            <MiniBadge>Sugerida</MiniBadge>
          </li>
        </ul>
      </MiniCard>
      <MiniCard className="flex items-center justify-between gap-2 p-2.5">
        <span className="min-w-0 text-[9.5px] text-muted-foreground">
          Seções editadas: Fatos e Pedidos <Provenance kind="reviewer" />
        </span>
      </MiniCard>
      <div className="flex flex-wrap justify-end gap-1.5">
        <MiniButton variant="outline">Rejeitar com motivo</MiniButton>
        <MiniButton icon={Check}>Aprovar análise</MiniButton>
      </div>
    </div>
  );
}

function ClosingScreen() {
  return (
    <div className="flex flex-col gap-2.5">
      <MiniPageHeader
        crumbs={["Valores e provisão", "Fechamento mensal"]}
        title="Fechamento mensal"
        meta={
          <MiniBadge tone="success" icon={Lock}>
            Competência 09/2026 fechada
          </MiniBadge>
        }
      />
      <div className="grid grid-cols-2 gap-2 @md:grid-cols-3">
        <MiniStat label="Valor da causa (soma)" value={SAMPLE_TOTALS.claim} tone="info" />
        <MiniStat
          label="Valor liquidado (soma)"
          value={SAMPLE_TOTALS.liquidated}
          hint={`Apurado em ${SAMPLE_TOTALS.assessed} de ${SAMPLE_TOTALS.processes}`}
          tone="primary"
        />
        <MiniStat label="Provisão apurada" value="R$ 97.450,00" hint="Classificação provável" tone="danger" />
      </div>
      <MiniCard>
        <MiniCardHeader title="Movimentação desde 08/2026" />
        <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 px-2.5 py-2 text-[10px]">
          <dt className="text-muted-foreground">Provisão no fechamento anterior</dt>
          <dd className="text-right tabular-nums">R$ 92.100,00</dd>
          <dt className="text-muted-foreground">Atualização de valor apurado</dt>
          <dd className="text-right tabular-nums">R$ 5.350,00</dd>
          <dt className="font-medium text-slate-900">Provisão em 09/2026</dt>
          <dd className="text-right font-semibold tabular-nums">R$ 97.450,00</dd>
        </dl>
      </MiniCard>
      <MiniCard className="p-2.5">
        <MiniCnj className="text-slate-700">{SAMPLE.liquidation.number}</MiniCnj>
        <p className="text-[9.5px] text-muted-foreground">
          Valor liquidado de R$ 97.450,00 conferido por Paulo Mendes, da contabilidade, antes do fechamento.
        </p>
      </MiniCard>
      <div className="flex flex-wrap justify-end gap-1.5">
        <MiniButton variant="outline">Exportar CSV para a contabilidade</MiniButton>
      </div>
    </div>
  );
}
