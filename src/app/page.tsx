import {
  ArrowRight,
  Ban,
  BookOpenCheck,
  CalendarClock,
  ChevronDown,
  FileStack,
  FileText,
  Gavel,
  LayoutDashboard,
  Lock,
  Scale,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  UsersRound,
  type LucideIcon,
} from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import type { CSSProperties } from "react";
import { Logo, LogoMark } from "@/components/brand/logo";
import { FlowStepper } from "@/components/landing/flow-stepper";
import { CountUp, RevealRoot, Spotlight } from "@/components/landing/motion";
import { ProductPreview } from "@/components/landing/product-preview";
import { SiteHeader } from "@/components/landing/site-header";
import { getCurrentUser } from "@/server/auth/session";

/**
 * Public presentation page shown before the login. It contains no tenant data:
 * the only server read is whether the visitor already has a session, to switch
 * the call to action between "Entrar" and "Ir para o painel". Product visuals
 * are illustrative and labeled as such; there are no testimonials, client
 * logos or usage statistics, because none exist yet.
 */
export const metadata: Metadata = {
  title: { absolute: "Praetor — Gestão jurídica preventiva e contenciosa" },
  description:
    "Plataforma de gestão jurídica corporativa: jurídico preventivo, contencioso, contratos, documentos, prazos, painel de BI e análises de apoio por IA com fontes citadas.",
};

const delay = (ms: number) => ({ "--reveal-delay": `${ms}ms` }) as CSSProperties;

const FRONTS = [
  {
    icon: ShieldAlert,
    kicker: "Antes do conflito",
    title: "Jurídico preventivo",
    text: "Registre ocorrências que ainda não viraram processo, organize fatos e documentos e acompanhe um plano de ação com responsáveis e prazos.",
    points: ["Sinais de risco e informações faltantes", "Plano de ação acompanhado", "Vínculo posterior com processo"],
  },
  {
    icon: Gavel,
    kicker: "Durante o litígio",
    title: "Gestão do contencioso",
    text: "Centralize processos, partes, movimentações, valores, documentos, prazos e tarefas — separando o que foi cadastrado, importado ou gerado por IA.",
    points: ["Linha do tempo de movimentações", "Exposição e provisão informadas", "Prazos com validação humana"],
  },
] as const;

const MODULES: { icon: LucideIcon; title: string; text: string }[] = [
  { icon: LayoutDashboard, title: "Painel de BI", text: "Filtros por período, unidade, área e responsável, com clique direto nos registros que originam cada número." },
  { icon: Scale, title: "Processos", text: "Cadastro completo, partes, movimentações, documentos, comentários e histórico de alterações." },
  { icon: ShieldAlert, title: "Preventivo", text: "Ocorrências, áreas envolvidas, plano de ação e conversão em processo quando necessário." },
  { icon: FileStack, title: "Contratos e documentos", text: "Vigência, renovação, obrigações, versões e download protegido por permissão." },
  { icon: CalendarClock, title: "Prazos e tarefas", text: "Calendário, alertas de vencimento e fila de validação para prazos sugeridos pela IA." },
  { icon: Sparkles, title: "Central de IA", text: "Resumos, extração, contradições, documentos faltantes e perguntas sobre os registros acessíveis." },
  { icon: UsersRound, title: "Administração", text: "Usuários, equipes, unidades, cinco perfis de acesso, configurações e auditoria." },
];

const AI_DOES = [
  "Cita as fontes de cada achado, com versão do documento.",
  "Informa data, limitações e pontos que exigem validação.",
  "Trata instruções escondidas em documentos como dados, não como comandos.",
  "Evita reprocessar análises idênticas e respeita um orçamento mensal.",
];
const AI_DOESNT = [
  "Prever o resultado de processos.",
  "Inventar jurisprudência, citações ou movimentações.",
  "Calcular prazos processuais sem validação humana.",
  "Alterar registros por conta própria.",
];

const GOVERNANCE: { icon: LucideIcon; title: string; text: string }[] = [
  { icon: Lock, title: "Isolamento", text: "Cada organização só enxerga os próprios dados; dentro dela, a visibilidade segue perfil, unidade e confidencialidade." },
  { icon: FileText, title: "Documentos protegidos", text: "Sem URL pública: o download exige sessão e permissão, e os tipos de arquivo são validados no envio." },
  { icon: BookOpenCheck, title: "Auditoria", text: "As alterações relevantes, os acessos a documentos e as análises de IA ficam registrados." },
  { icon: ShieldCheck, title: "Retenção", text: "Estrutura para prazos de retenção e bloqueio de exclusão (legal hold)." },
];

const FAQ = [
  {
    q: "A IA substitui o advogado?",
    a: "Não. As análises são apoio: apontam achados com as fontes usadas, mostram limitações e listam o que precisa ser validado. A decisão é sempre de uma pessoa, e nada é alterado automaticamente.",
  },
  {
    q: "O sistema calcula prazos processuais?",
    a: "Não. Prazos são cadastrados por pessoas. Quando a IA encontra uma data em um documento, ela sugere um prazo que fica aguardando validação humana — as regras de contagem (dias úteis, feriados, suspensões) precisam ser conferidas por quem conhece o caso.",
  },
  {
    q: "Existe integração com tribunais?",
    a: "Ainda não. Nesta versão, movimentações são cadastradas manualmente ou marcadas como importadas, com a fonte informada. Integrações dependem de fonte autorizada, documentação e credenciais.",
  },
  {
    q: "Quem pode ver cada informação?",
    a: "São cinco perfis — administrador, gestor jurídico, advogado, analista e executivo (somente consulta). Advogados e analistas veem os registros da própria unidade e os que estão sob sua responsabilidade; registros confidenciais ficam restritos.",
  },
  {
    q: "E se não houver credenciais de IA configuradas?",
    a: "A plataforma funciona em modo demonstrativo, claramente identificado em todas as telas. Resultados desse modo nunca são apresentados como análises reais.",
  },
];

export default async function LandingPage() {
  const user = await getCurrentUser();
  const cta = user ? { href: "/dashboard", label: "Ir para o painel" } : { href: "/login", label: "Entrar" };

  return (
    <RevealRoot className="min-h-dvh bg-white text-[15px] text-slate-900">
      <a
        href="#conteudo"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:bg-white focus:px-3 focus:py-2 focus:text-sm focus:shadow"
      >
        Pular para o conteúdo
      </a>
      <SiteHeader cta={cta} />

      <main id="conteudo">
        {/* ------------------------------------------------------------- Hero */}
        <Spotlight className="overflow-hidden bg-[#0b1a2c]" color="rgba(212, 176, 98, 0.13)" size={560}>
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 opacity-[0.35]"
            style={{
              backgroundImage:
                "linear-gradient(rgba(255,255,255,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.06) 1px, transparent 1px)",
              backgroundSize: "56px 56px",
              maskImage: "radial-gradient(ellipse 80% 70% at 50% 30%, black, transparent)",
            }}
          />
          <div aria-hidden="true" className="pointer-events-none absolute -top-40 -right-40 size-[36rem] rounded-full bg-[#2f5282]/40 blur-3xl" />
          <div aria-hidden="true" className="pointer-events-none absolute -bottom-48 -left-24 size-[28rem] rounded-full bg-brass-500/10 blur-3xl" />

          <div className="relative mx-auto grid max-w-6xl items-center gap-14 px-4 pt-32 pb-24 sm:px-6 lg:grid-cols-[1.05fr_0.95fr] lg:pt-40 lg:pb-32">
            <div>
              <p data-reveal className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs font-medium text-slate-200">
                <span aria-hidden="true" className="size-1.5 rounded-full bg-brass-400" />
                Gestão jurídica corporativa · preventivo e contencioso
              </p>
              <h1 data-reveal style={delay(80)} className="mt-6 font-display text-5xl leading-[1.02] font-semibold tracking-tight text-white sm:text-6xl lg:text-7xl">
                Antecipe riscos.
                <br />
                Conduza processos.
                <br />
                <span className="bg-gradient-to-r from-brass-300 via-brass-400 to-brass-500 bg-clip-text text-transparent">Decida com fontes.</span>
              </h1>
              <p data-reveal style={delay(160)} className="mt-6 max-w-xl text-lg leading-relaxed text-slate-300">
                O Praetor reúne o jurídico preventivo e a gestão do contencioso em uma só plataforma — com a inteligência
                artificial como apoio contínuo e o advogado sempre no comando.
              </p>
              <div data-reveal style={delay(240)} className="mt-9 flex flex-wrap gap-3">
                <Link
                  href={cta.href}
                  className="group inline-flex items-center gap-2 rounded-full bg-brass-400 px-6 py-3 text-sm font-semibold text-[#0b1a2c] shadow-lg shadow-brass-500/20 transition hover:bg-brass-300"
                >
                  {user ? "Ir para o painel" : "Acessar a plataforma"}
                  <ArrowRight aria-hidden="true" className="size-4 transition-transform group-hover:translate-x-0.5" />
                </Link>
                <a
                  href="#como-funciona"
                  className="inline-flex items-center gap-2 rounded-full px-6 py-3 text-sm font-semibold text-white ring-1 ring-white/25 transition hover:bg-white/10"
                >
                  Ver como funciona
                </a>
              </div>
              <ul data-reveal style={delay(320)} className="mt-10 flex flex-wrap gap-x-6 gap-y-2 text-sm text-slate-400">
                {["Fontes citadas", "Validação humana", "Isolamento por organização"].map((t) => (
                  <li key={t} className="inline-flex items-center gap-2">
                    <ShieldCheck aria-hidden="true" className="size-4 text-brass-400" />
                    {t}
                  </li>
                ))}
              </ul>
            </div>
            <div data-reveal style={delay(200)}>
              <ProductPreview />
            </div>
          </div>
          <a
            href="#plataforma"
            aria-label="Rolar para a plataforma"
            className="absolute bottom-6 left-1/2 hidden -translate-x-1/2 text-slate-400 transition hover:text-white lg:block"
          >
            <ChevronDown aria-hidden="true" className="size-6 motion-safe:animate-bounce" />
          </a>
        </Spotlight>

        {/* ------------------------------------------------------------ Facts */}
        <section aria-label="A plataforma em números" className="border-b border-slate-200 bg-white">
          <dl className="mx-auto grid max-w-6xl grid-cols-2 gap-px bg-slate-200 lg:grid-cols-4">
            {[
              { n: 7, s: "", label: "módulos integrados" },
              { n: 5, s: "", label: "perfis de acesso" },
              { n: 100, s: "%", label: "das análises com fontes, data e limitações" },
              { n: 0, s: "", label: "prazos da IA sem validação humana" },
            ].map((f, i) => (
              <div key={f.label} data-reveal style={delay(i * 80)} className="bg-white px-6 py-8 text-center">
                <dt className="sr-only">{f.label}</dt>
                <dd>
                  <span className="block font-display text-5xl font-semibold text-[#1f3a5f]">
                    <CountUp value={f.n} suffix={f.s} />
                  </span>
                  <span className="mt-1 block text-sm text-slate-500">{f.label}</span>
                </dd>
              </div>
            ))}
          </dl>
        </section>

        {/* ----------------------------------------------------------- Fronts */}
        <section id="plataforma" className="scroll-mt-16 bg-white">
          <div className="mx-auto max-w-6xl px-4 py-24 sm:px-6">
            <div data-reveal className="max-w-2xl">
              <p className="text-xs font-semibold tracking-[0.18em] text-brass-600 uppercase">Plataforma</p>
              <h2 className="mt-3 font-display text-4xl font-semibold text-slate-900 sm:text-5xl">Duas frentes, uma visão</h2>
              <p className="mt-4 text-lg text-slate-600">Antecipar conflitos e conduzir bem os que já existem fazem parte do mesmo trabalho.</p>
            </div>
            <div className="mt-12 grid gap-6 md:grid-cols-2">
              {FRONTS.map(({ icon: Icon, kicker, title, text, points }, i) => (
                <Spotlight key={title} className="rounded-2xl" color="rgba(47, 82, 130, 0.10)">
                  <article
                    data-reveal
                    style={delay(i * 120)}
                    className="relative h-full rounded-2xl border border-slate-200 bg-white p-8 transition-shadow duration-300 hover:shadow-xl hover:shadow-slate-900/5"
                  >
                    <span className="inline-flex size-12 items-center justify-center rounded-xl bg-[#1f3a5f] text-white">
                      <Icon aria-hidden="true" className="size-6" />
                    </span>
                    <p className="mt-6 text-xs font-semibold tracking-[0.16em] text-brass-600 uppercase">{kicker}</p>
                    <h3 className="mt-1 font-display text-3xl font-semibold">{title}</h3>
                    <p className="mt-3 leading-relaxed text-slate-600">{text}</p>
                    <ul className="mt-6 space-y-2.5">
                      {points.map((p) => (
                        <li key={p} className="flex items-center gap-2.5 text-sm text-slate-700">
                          <span aria-hidden="true" className="inline-flex size-5 items-center justify-center rounded-full bg-brass-400/15">
                            <span className="size-1.5 rounded-full bg-brass-500" />
                          </span>
                          {p}
                        </li>
                      ))}
                    </ul>
                  </article>
                </Spotlight>
              ))}
            </div>
          </div>
        </section>

        {/* ----------------------------------------------------- How it works */}
        <section id="como-funciona" className="scroll-mt-16 bg-slate-50">
          <div className="mx-auto max-w-6xl px-4 py-24 sm:px-6">
            <div data-reveal className="max-w-2xl">
              <p className="text-xs font-semibold tracking-[0.18em] text-brass-600 uppercase">Como funciona</p>
              <h2 className="mt-3 font-display text-4xl font-semibold sm:text-5xl">Do registro à decisão, em um fluxo</h2>
              <p className="mt-4 text-lg text-slate-600">Clique em cada passo — ou deixe a demonstração avançar sozinha.</p>
            </div>
            <div data-reveal style={delay(120)} className="mt-12">
              <FlowStepper />
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------------- Modules */}
        <section className="bg-white">
          <div className="mx-auto max-w-6xl px-4 py-24 sm:px-6">
            <div data-reveal className="flex flex-col justify-between gap-6 md:flex-row md:items-end">
              <div className="max-w-2xl">
                <p className="text-xs font-semibold tracking-[0.18em] text-brass-600 uppercase">Módulos</p>
                <h2 className="mt-3 font-display text-4xl font-semibold sm:text-5xl">Tudo o que o departamento acompanha</h2>
              </div>
              <Link href={cta.href} className="group inline-flex items-center gap-1.5 text-sm font-semibold text-[#2f5282] hover:text-[#1f3a5f]">
                {cta.label}
                <ArrowRight aria-hidden="true" className="size-4 transition-transform group-hover:translate-x-0.5" />
              </Link>
            </div>
            <ul className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {MODULES.map(({ icon: Icon, title, text }, i) => (
                <li key={title} data-reveal style={delay((i % 3) * 90)} className={i === MODULES.length - 1 ? "lg:col-start-2" : undefined}>
                  <Spotlight className="h-full rounded-2xl" color="rgba(212, 176, 98, 0.16)" size={300}>
                    <div className="group relative h-full rounded-2xl border border-slate-200 bg-white p-6 transition duration-300 hover:-translate-y-1 hover:border-brass-400/50">
                      <span className="inline-flex size-10 items-center justify-center rounded-lg bg-slate-100 text-[#1f3a5f] transition-colors group-hover:bg-[#1f3a5f] group-hover:text-white">
                        <Icon aria-hidden="true" className="size-5" />
                      </span>
                      <h3 className="mt-4 text-lg font-semibold">{title}</h3>
                      <p className="mt-2 text-sm leading-relaxed text-slate-600">{text}</p>
                    </div>
                  </Spotlight>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* ------------------------------------------------------ Responsible AI */}
        <section id="ia" className="relative scroll-mt-16 overflow-hidden bg-[#0f1a33] text-white">
          <div aria-hidden="true" className="pointer-events-none absolute top-0 left-1/2 size-[40rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-violet-500/20 blur-3xl" />
          <div className="relative mx-auto max-w-6xl px-4 py-24 sm:px-6">
            <div data-reveal className="max-w-2xl">
              <p className="inline-flex items-center gap-2 text-xs font-semibold tracking-[0.18em] text-violet-300 uppercase">
                <Sparkles aria-hidden="true" className="size-4" />
                IA responsável
              </p>
              <h2 className="mt-3 font-display text-4xl font-semibold sm:text-5xl">Uma camada contínua de análise — com limites claros</h2>
              <p className="mt-4 text-lg text-slate-300">
                A IA analisa novos documentos, mudanças relevantes e rotinas agendadas. E deixa explícito o que fez, com
                base em quê e o que ainda precisa ser conferido.
              </p>
            </div>
            <div className="mt-12 grid gap-6 lg:grid-cols-2">
              <div data-reveal className="rounded-2xl border border-white/10 bg-white/5 p-8 backdrop-blur">
                <h3 className="text-lg font-semibold text-white">O que a IA faz</h3>
                <ul className="mt-5 space-y-3.5">
                  {AI_DOES.map((t) => (
                    <li key={t} className="flex gap-3 text-slate-200">
                      <ShieldCheck aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-emerald-300" />
                      {t}
                    </li>
                  ))}
                </ul>
              </div>
              <div data-reveal style={delay(120)} className="rounded-2xl border border-white/10 bg-white/5 p-8 backdrop-blur">
                <h3 className="text-lg font-semibold text-white">O que a IA não faz</h3>
                <ul className="mt-5 space-y-3.5">
                  {AI_DOESNT.map((t) => (
                    <li key={t} className="flex gap-3 text-slate-200">
                      <Ban aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-rose-300" />
                      {t}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </section>

        {/* -------------------------------------------------------- Governance */}
        <section id="seguranca" className="scroll-mt-16 bg-white">
          <div className="mx-auto max-w-6xl px-4 py-24 sm:px-6">
            <div data-reveal className="max-w-2xl">
              <p className="text-xs font-semibold tracking-[0.18em] text-brass-600 uppercase">Segurança e governança</p>
              <h2 className="mt-3 font-display text-4xl font-semibold sm:text-5xl">Controle de acesso desde a primeira linha</h2>
            </div>
            <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {GOVERNANCE.map(({ icon: Icon, title, text }, i) => (
                <div key={title} data-reveal style={delay(i * 90)} className="rounded-2xl border border-slate-200 p-6">
                  <Icon aria-hidden="true" className="size-6 text-[#2f5282]" />
                  <h3 className="mt-4 font-semibold">{title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-slate-600">{text}</p>
                </div>
              ))}
            </div>
            <p data-reveal className="mt-6 text-xs text-slate-500">
              Esses controles não equivalem a uma declaração de conformidade legal ou de segurança completa. Pontos ainda
              em avaliação estão documentados para a equipe técnica.
            </p>
          </div>
        </section>

        {/* -------------------------------------------------------------- Name */}
        <section className="relative overflow-hidden bg-[#f7f3ea]">
          <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 py-24 sm:px-6 lg:grid-cols-[0.8fr_1.2fr]">
            <div data-reveal className="flex justify-center">
              <div className="relative">
                <div aria-hidden="true" className="absolute inset-0 rounded-full bg-brass-400/20 blur-2xl" />
                <LogoMark animated className="relative size-48 text-[#1f3a5f] sm:size-56" title="Símbolo do Praetor" />
              </div>
            </div>
            <div data-reveal style={delay(120)}>
              <p className="text-xs font-semibold tracking-[0.18em] text-brass-600 uppercase">O nome</p>
              <h2 className="mt-3 font-display text-5xl font-semibold text-[#1f3a5f]">Por que “Praetor”?</h2>
              <p className="mt-5 text-lg leading-relaxed text-slate-700">
                <em className="font-display text-2xl not-italic">Praetor</em> é a palavra latina para <strong>pretor</strong>, o
                magistrado que administrava a justiça na Roma Antiga. Ao assumir o cargo, publicava o seu <em>edito</em> — as
                regras que aplicaria —, orientando as pessoas antes do conflito, e conduzia os litígios quando surgiam.
              </p>
              <blockquote className="mt-6 border-l-2 border-brass-500 pl-5 font-display text-2xl text-slate-800 italic">
                <em>prae-ire</em> — “ir à frente”.
              </blockquote>
              <p className="mt-4 text-slate-600">
                Prevenir e conduzir: as duas frentes desta plataforma. O símbolo une o frontão do templo, onde o edito era
                publicado, à coluna que forma a letra P.
              </p>
            </div>
          </div>
        </section>

        {/* --------------------------------------------------------------- FAQ */}
        <section id="perguntas" className="scroll-mt-16 bg-white">
          <div className="mx-auto max-w-3xl px-4 py-24 sm:px-6">
            <div data-reveal className="text-center">
              <p className="text-xs font-semibold tracking-[0.18em] text-brass-600 uppercase">Perguntas frequentes</p>
              <h2 className="mt-3 font-display text-4xl font-semibold sm:text-5xl">Antes de começar</h2>
            </div>
            <div className="mt-10 divide-y divide-slate-200 rounded-2xl border border-slate-200">
              {FAQ.map((f, i) => (
                <details key={f.q} data-reveal style={delay(i * 60)} className="group px-6 [&_summary::-webkit-details-marker]:hidden">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-5 font-semibold text-slate-900">
                    {f.q}
                    <span
                      aria-hidden="true"
                      className="inline-flex size-7 shrink-0 items-center justify-center rounded-full border border-slate-200 text-slate-500 transition-transform duration-300 group-open:rotate-45 group-open:border-brass-400 group-open:text-brass-600"
                    >
                      +
                    </span>
                  </summary>
                  <p className="pb-5 leading-relaxed text-slate-600">{f.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* --------------------------------------------------------------- CTA */}
        <Spotlight className="overflow-hidden bg-[#0b1a2c]" color="rgba(212, 176, 98, 0.16)" size={500}>
          <div className="relative mx-auto max-w-4xl px-4 py-24 text-center sm:px-6">
            <div data-reveal>
              <LogoMark className="mx-auto size-14 text-white" />
              <h2 className="mt-6 font-display text-4xl font-semibold text-white sm:text-5xl">O jurídico um passo à frente</h2>
              <p className="mx-auto mt-4 max-w-xl text-lg text-slate-300">
                Acesse com seu e-mail corporativo. No ambiente demonstrativo, use uma das contas fictícias listadas na tela
                de login.
              </p>
              <Link
                href={cta.href}
                className="group mt-9 inline-flex items-center gap-2 rounded-full bg-brass-400 px-7 py-3.5 text-sm font-semibold text-[#0b1a2c] shadow-lg shadow-brass-500/20 transition hover:bg-brass-300"
              >
                {user ? "Ir para o painel" : "Acessar a plataforma"}
                <ArrowRight aria-hidden="true" className="size-4 transition-transform group-hover:translate-x-0.5" />
              </Link>
            </div>
          </div>
        </Spotlight>
      </main>

      <footer className="bg-[#081422] text-slate-400">
        <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-10 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <Logo size="sm" />
          <div className="space-y-1 text-xs sm:text-right">
            <p>Praetor · versão inicial em desenvolvimento</p>
            <p>As análises por IA são apoio à decisão e não substituem a avaliação profissional.</p>
          </div>
        </div>
      </footer>
    </RevealRoot>
  );
}
