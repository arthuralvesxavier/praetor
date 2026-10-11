import {
  ArrowRight,
  BookOpenCheck,
  CalendarClock,
  FileStack,
  FileText,
  Gavel,
  LayoutDashboard,
  Lock,
  Scale,
  ScrollText,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  UsersRound,
  type LucideIcon,
} from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { ButtonLink } from "@/components/ui/button";
import { getCurrentUser } from "@/server/auth/session";

/**
 * Public presentation page shown before the login. It contains no tenant data:
 * the only server read is whether the visitor already has a session, to switch
 * the call to action between "Entrar" and "Ir para o painel".
 */
export const metadata: Metadata = {
  title: { absolute: "Praetor — Gestão jurídica preventiva e contenciosa" },
  description:
    "Plataforma de gestão jurídica corporativa: jurídico preventivo, contencioso, contratos, documentos, prazos e análises de apoio por IA com fontes citadas.",
};

const FRONTS = [
  {
    icon: ShieldAlert,
    title: "Jurídico preventivo",
    text: "Registre ocorrências que ainda não viraram processo, organize fatos e documentos, identifique sinais de risco e informações faltantes e acompanhe um plano de ação com responsáveis e prazos.",
  },
  {
    icon: Gavel,
    title: "Gestão do contencioso",
    text: "Centralize processos, partes, movimentações, valores, documentos, prazos e tarefas. Separe com clareza o que foi cadastrado, o que foi importado e o que foi gerado por IA.",
  },
] as const;

const MODULES: { icon: LucideIcon; title: string; text: string }[] = [
  {
    icon: LayoutDashboard,
    title: "Dashboard executivo",
    text: "Processos por situação, prazos vencidos e próximos, riscos, exposição informada e pendências por responsável — cada número leva aos registros que o originam.",
  },
  {
    icon: Scale,
    title: "Processos",
    text: "Cadastro completo, linha do tempo de movimentações, partes, documentos, comentários e histórico de alterações.",
  },
  {
    icon: ShieldAlert,
    title: "Ocorrências preventivas",
    text: "Fatos, áreas envolvidas, plano de ação e vínculo posterior com um processo judicial, quando necessário.",
  },
  {
    icon: FileStack,
    title: "Contratos e documentos",
    text: "Vigência, renovação, obrigações, histórico de versões e download protegido por permissão.",
  },
  {
    icon: CalendarClock,
    title: "Prazos e tarefas",
    text: "Calendário, alertas de vencimento e fila de validação para prazos sugeridos pela IA.",
  },
  {
    icon: Sparkles,
    title: "Central de IA",
    text: "Resumos, extração de informações, contradições, documentos faltantes, ações preventivas e perguntas sobre os registros acessíveis.",
  },
  {
    icon: UsersRound,
    title: "Administração",
    text: "Usuários, equipes, unidades, perfis de acesso, configurações e trilha de auditoria.",
  },
];

const AI_PRINCIPLES = [
  "Toda análise apresenta as fontes utilizadas, a data, as limitações e os pontos que exigem validação.",
  "A IA não prevê resultados e não substitui a avaliação de um advogado.",
  "Prazos sugeridos pela IA só passam a valer depois de validados por uma pessoa.",
  "Instruções escondidas em documentos enviados são tratadas como dados, nunca como comandos.",
  "Sem credenciais de IA, o modo demonstrativo é identificado em todas as telas.",
] as const;

const GOVERNANCE: { icon: LucideIcon; text: string }[] = [
  { icon: Lock, text: "Isolamento entre organizações e visibilidade por perfil, unidade e confidencialidade." },
  { icon: FileText, text: "Documentos sem URL pública: o download exige sessão e permissão." },
  { icon: BookOpenCheck, text: "Registro de auditoria das alterações relevantes e das análises." },
  { icon: ShieldCheck, text: "Estrutura para retenção de dados e bloqueio de exclusão (legal hold)." },
];

export default async function LandingPage() {
  const user = await getCurrentUser();
  const cta = user ? { href: "/dashboard", label: "Ir para o painel" } : { href: "/login", label: "Entrar" };

  return (
    <div className="min-h-dvh bg-canvas text-foreground">
      <a
        href="#conteudo"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:bg-white focus:px-3 focus:py-2 focus:text-sm focus:shadow"
      >
        Pular para o conteúdo
      </a>

      <header className="bg-sidebar text-sidebar-foreground">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <Link href="/" className="flex items-center gap-2.5 rounded-md focus-visible:outline-2 focus-visible:outline-sidebar-indicator">
            <span
              aria-hidden="true"
              className="inline-flex size-9 items-center justify-center rounded-lg bg-primary-600 ring-1 ring-white/10"
            >
              <Scale className="size-4.5 text-white" />
            </span>
            <span className="text-lg font-semibold tracking-tight text-white">Praetor</span>
          </Link>
          <nav aria-label="Seções da página" className="hidden items-center gap-6 text-sm text-sidebar-muted md:flex">
            <a href="#frentes" className="hover:text-white">Frentes</a>
            <a href="#modulos" className="hover:text-white">Módulos</a>
            <a href="#ia" className="hover:text-white">IA responsável</a>
            <a href="#nome" className="hover:text-white">O nome</a>
          </nav>
          <ButtonLink href={cta.href} size="sm" className="bg-white text-primary hover:bg-primary-50 active:bg-primary-100">
            {cta.label}
          </ButtonLink>
        </div>
      </header>

      <main id="conteudo">
        {/* Hero */}
        <section className="bg-sidebar pb-20 text-sidebar-foreground">
          <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 pt-12 sm:px-6 lg:grid-cols-[1.1fr_0.9fr] lg:pt-20">
            <div>
              <p className="text-xs font-semibold tracking-[0.18em] text-sidebar-indicator uppercase">
                Gestão jurídica corporativa
              </p>
              <h1 className="mt-4 text-3xl leading-tight font-semibold tracking-tight text-white sm:text-4xl lg:text-[2.75rem]">
                Do risco ao processo, com a IA como apoio contínuo — e o advogado no comando.
              </h1>
              <p className="mt-5 max-w-xl text-base leading-relaxed text-sidebar-muted">
                O Praetor reúne o jurídico preventivo e a gestão do contencioso em uma só plataforma: ocorrências,
                processos, contratos, documentos, prazos e análises de apoio com fontes citadas.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <ButtonLink href={cta.href} size="lg" className="bg-white text-primary hover:bg-primary-50 active:bg-primary-100">
                  {cta.label}
                  <ArrowRight aria-hidden="true" />
                </ButtonLink>
                <ButtonLink
                  href="#modulos"
                  size="lg"
                  variant="ghost"
                  className="text-white ring-1 ring-white/20 hover:bg-white/10 hover:text-white active:bg-white/15"
                >
                  Conhecer os módulos
                </ButtonLink>
              </div>
            </div>

            {/* Decorative product preview — illustrative shapes, no real data. */}
            <div aria-hidden="true" className="hidden lg:block">
              <div className="rounded-xl bg-white/5 p-4 ring-1 ring-white/10">
                <div className="grid grid-cols-3 gap-3">
                  {["Processos ativos", "Prazos próximos", "Riscos altos"].map((label, i) => (
                    <div key={label} className="rounded-lg bg-white p-3">
                      <p className="text-[11px] text-slate-500">{label}</p>
                      <div className={`mt-2 h-5 w-10 rounded ${["bg-primary-200", "bg-amber-200", "bg-orange-200"][i]}`} />
                    </div>
                  ))}
                </div>
                <div className="mt-3 space-y-2 rounded-lg bg-white p-4">
                  {[80, 62, 45, 30].map((w, i) => (
                    <div key={w} className="flex items-center gap-3">
                      <div className="h-2 w-16 rounded bg-slate-200" />
                      <div className="h-2 flex-1 rounded bg-slate-100">
                        <div
                          className={`h-2 rounded ${["bg-emerald-400", "bg-amber-400", "bg-orange-400", "bg-red-400"][i]}`}
                          style={{ width: `${w}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mt-3 flex items-start gap-3 rounded-lg bg-ai-50 p-4">
                  <Sparkles className="mt-0.5 size-4 shrink-0 text-ai-600" />
                  <div className="flex-1 space-y-2">
                    <div className="h-2 w-3/4 rounded bg-ai-200" />
                    <div className="h-2 w-1/2 rounded bg-ai-200" />
                    <div className="flex gap-1.5 pt-1">
                      <span className="rounded bg-white px-1.5 py-0.5 text-[10px] font-medium text-ai-700">S1</span>
                      <span className="rounded bg-white px-1.5 py-0.5 text-[10px] font-medium text-ai-700">S2</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Two fronts */}
        <section id="frentes" className="mx-auto max-w-6xl scroll-mt-6 px-4 py-16 sm:px-6">
          <h2 className="text-2xl font-semibold tracking-tight text-slate-900">Duas frentes, uma visão</h2>
          <p className="mt-2 max-w-2xl text-muted-foreground">
            Antecipar conflitos e conduzir bem os que já existem fazem parte do mesmo trabalho.
          </p>
          <div className="mt-8 grid gap-5 md:grid-cols-2">
            {FRONTS.map(({ icon: Icon, title, text }) => (
              <article key={title} className="rounded-xl border border-border bg-surface p-6 shadow-xs">
                <span className="inline-flex size-10 items-center justify-center rounded-lg bg-primary-50 text-primary">
                  <Icon aria-hidden="true" className="size-5" />
                </span>
                <h3 className="mt-4 text-lg font-semibold text-slate-900">{title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{text}</p>
              </article>
            ))}
          </div>
        </section>

        {/* Modules */}
        <section id="modulos" className="scroll-mt-6 border-y border-border bg-surface">
          <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
            <h2 className="text-2xl font-semibold tracking-tight text-slate-900">Módulos</h2>
            <p className="mt-2 max-w-2xl text-muted-foreground">
              Um fluxo integrado: registrar a ocorrência ou o processo, anexar documentos, solicitar uma análise, revisar
              o resultado, criar tarefas e acompanhar tudo no dashboard.
            </p>
            <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {MODULES.map(({ icon: Icon, title, text }) => (
                <li key={title} className="rounded-xl border border-border p-5">
                  <div className="flex items-center gap-3">
                    <Icon aria-hidden="true" className="size-5 text-primary-600" />
                    <h3 className="font-semibold text-slate-900">{title}</h3>
                  </div>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{text}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* Responsible AI + governance */}
        <section id="ia" className="mx-auto grid max-w-6xl scroll-mt-6 gap-8 px-4 py-16 sm:px-6 lg:grid-cols-2">
          <div className="rounded-xl border border-ai-200 bg-ai-50 p-6">
            <div className="flex items-center gap-2 text-ai-800">
              <Sparkles aria-hidden="true" className="size-5" />
              <h2 className="text-xl font-semibold tracking-tight">IA responsável</h2>
            </div>
            <ul className="mt-5 space-y-3">
              {AI_PRINCIPLES.map((text) => (
                <li key={text} className="flex items-start gap-2.5 text-sm leading-relaxed text-ai-900">
                  <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-ai-500" />
                  {text}
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-xl border border-border bg-surface p-6 shadow-xs">
            <div className="flex items-center gap-2 text-slate-900">
              <ShieldCheck aria-hidden="true" className="size-5 text-primary-600" />
              <h2 className="text-xl font-semibold tracking-tight">Segurança e governança</h2>
            </div>
            <ul className="mt-5 space-y-3">
              {GOVERNANCE.map(({ icon: Icon, text }) => (
                <li key={text} className="flex items-start gap-2.5 text-sm leading-relaxed text-muted-foreground">
                  <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary-600" />
                  {text}
                </li>
              ))}
            </ul>
            <p className="mt-5 text-xs text-subtle-foreground">
              Esses controles não equivalem a uma declaração de conformidade legal ou de segurança completa.
            </p>
          </div>
        </section>

        {/* Name */}
        <section id="nome" className="scroll-mt-6 bg-sidebar text-sidebar-foreground">
          <div className="mx-auto flex max-w-4xl flex-col items-start gap-6 px-4 py-16 sm:px-6 md:flex-row md:gap-10">
            <span
              aria-hidden="true"
              className="inline-flex size-14 shrink-0 items-center justify-center rounded-xl bg-primary-600 ring-1 ring-white/10"
            >
              <ScrollText className="size-7 text-white" />
            </span>
            <div>
              <h2 className="text-2xl font-semibold tracking-tight text-white">Por que “Praetor”?</h2>
              <p className="mt-4 leading-relaxed text-sidebar-muted">
                <em className="text-white not-italic">Praetor</em> é a palavra latina para <strong className="font-semibold text-white">pretor</strong>,
                o magistrado que administrava a justiça na Roma Antiga. Ao assumir o cargo, o pretor publicava o seu
                <em> edito</em> — as regras que aplicaria —, orientando as pessoas antes do conflito, e conduzia os
                litígios quando eles surgiam.
              </p>
              <p className="mt-3 leading-relaxed text-sidebar-muted">
                Prevenir e conduzir: as duas frentes desta plataforma. A palavra vem de <em>prae-ire</em>, “ir à
                frente” — antecipar-se aos riscos.
              </p>
            </div>
          </div>
        </section>

        {/* Final CTA */}
        <section className="mx-auto max-w-6xl px-4 py-16 text-center sm:px-6">
          <h2 className="text-2xl font-semibold tracking-tight text-slate-900">Pronto para começar?</h2>
          <p className="mx-auto mt-2 max-w-xl text-muted-foreground">
            Acesse com seu e-mail corporativo. No ambiente demonstrativo, use uma das contas fictícias listadas na tela
            de login.
          </p>
          <div className="mt-6 flex justify-center">
            <ButtonLink href={cta.href} size="lg">
              {cta.label}
              <ArrowRight aria-hidden="true" />
            </ButtonLink>
          </div>
        </section>
      </main>

      <footer className="border-t border-border bg-surface">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-6 text-xs text-subtle-foreground sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p>Praetor · versão inicial em desenvolvimento</p>
          <p>As análises por IA são apoio à decisão e não substituem a avaliação profissional.</p>
        </div>
      </footer>
    </div>
  );
}
