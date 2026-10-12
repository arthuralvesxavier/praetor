import {
  ArrowRight,
  Ban,
  BellRing,
  BookOpenCheck,
  ChevronDown,
  FileSearch,
  FileSignature,
  FileSpreadsheet,
  FlaskConical,
  Gavel,
  Handshake,
  HeartPulse,
  Inbox,
  Landmark,
  LayoutDashboard,
  Lightbulb,
  Lock,
  Mail,
  PlugZap,
  Scale,
  ShieldAlert,
  ShieldCheck,
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
import { ProfileSwitcher } from "@/components/landing/profile-switcher";
import { SiteHeader } from "@/components/landing/site-header";
import { getCurrentUser } from "@/server/auth/session";

/**
 * Public presentation page shown before the login. It contains no tenant data:
 * the only server read is whether the visitor already has a session, to switch
 * the call to action between "Entrar" and "Ir para o painel". Product visuals
 * are illustrative and labeled as such; simulated features (preliminary
 * analysis, e-mail) are presented as simulations; there are no testimonials,
 * client logos, usage statistics or tribunal integrations, because none exist.
 */
export const metadata: Metadata = {
  title: { absolute: "Praetor — Gestão do passivo jurídico e do jurídico preventivo" },
  description:
    "Carteira de processos importada da planilha com validação de CNJ, entrada de processos com análise preliminar e e-mail simulados nesta versão, valores, garantias, risco e provisão com fechamento mensal, audiências, alertas e perfis por função.",
};

const delay = (ms: number) => ({ "--reveal-delay": `${ms}ms` }) as CSSProperties;

const FRONTS = [
  {
    icon: Gavel,
    kicker: "Passivo e contencioso",
    title: "A carteira, conferida",
    text: "Um processo por número CNJ, com todas as instâncias, partes, fases, valores, garantias, acordos e audiências — e a origem de cada dado: cadastro, planilha ou simulação.",
    points: [
      "Importação da planilha com relatório de inconsistências",
      "Valor da causa e valor liquidado lado a lado",
      "Provisão mensal com fechamento imutável",
    ],
  },
  {
    icon: ShieldAlert,
    kicker: "Antes do conflito",
    title: "Jurídico preventivo",
    text: "Ocorrências que ainda não viraram processo, contratos e uma leitura da carteira que mostra onde os conflitos se concentram — calculada a partir dos dados, separada das sugestões ilustrativas.",
    points: [
      "Ocorrências com plano de ação",
      "Contratos, vigências e obrigações",
      "Inteligência preventiva por empresa e tribunal",
    ],
  },
] as const;

const MODULES: { icon: LucideIcon; title: string; text: string; simulated?: boolean }[] = [
  {
    icon: Scale,
    title: "Carteira de processos",
    text: "Filtros por tribunal, instância, cidade, empresa, escritório, fase e valor; carteira ativa e encerrada.",
  },
  {
    icon: FileSpreadsheet,
    title: "Importação de planilhas",
    text: "Leitura das abas, validação de CNJ, duplicidades, divergências de valor e relatório por linha.",
  },
  {
    icon: Inbox,
    title: "Entrada e distribuição",
    text: "Fila de novos processos e regras que definem o advogado ou escritório responsável.",
  },
  {
    icon: FileSearch,
    title: "Análise preliminar",
    text: "Resumo do caso com a origem de cada item e revisão do advogado. Simulada nesta versão.",
    simulated: true,
  },
  {
    icon: Landmark,
    title: "Valores e provisão",
    text: "Valores propostos e oficiais, garantias, risco e fechamento mensal da competência.",
  },
  {
    icon: Handshake,
    title: "Acordos",
    text: "Parcelas, vencimentos e alertas de pagamento, com o histórico de valores preservado.",
  },
  {
    icon: BellRing,
    title: "Audiências e alertas",
    text: "Agenda de audiências e alertas de prazos, parcelas, garantias paradas e pendências.",
  },
  {
    icon: LayoutDashboard,
    title: "Painel e relatórios",
    text: "Visão executiva por empresa, tribunal e fase; exportação em XLSX e CSV.",
  },
  {
    icon: Lightbulb,
    title: "Inteligência preventiva",
    text: "Concentrações calculadas a partir da carteira, separadas das sugestões ilustrativas.",
  },
  {
    icon: Mail,
    title: "Central de e-mails",
    text: "Avisos aos responsáveis registrados com assunto “[Simulação]”. Nenhuma mensagem é enviada.",
    simulated: true,
  },
  {
    icon: FileSignature,
    title: "Contratos e documentos",
    text: "Vigências, obrigações, versões e download protegido por permissão.",
  },
  {
    icon: UsersRound,
    title: "Perfis e auditoria",
    text: "Oito perfis de acesso, escritórios externos restritos à própria carteira e trilha de auditoria.",
  },
];

const SIMULATED: { icon: LucideIcon; title: string; text: string; label: string }[] = [
  {
    icon: FileSearch,
    title: "Análise preliminar",
    label: "Simulação",
    text: "Gerada por um simulador e marcada como demonstrativa. Cada item mostra a origem — extraído do documento (com página e trecho), cadastro/planilha, ilustrativo ou lacuna — e nada é aplicado ao processo sem revisão do advogado.",
  },
  {
    icon: Mail,
    title: "E-mails ao responsável",
    label: "Envio simulado",
    text: "As mensagens ficam registradas na Central de e-mails com o assunto iniciado por “[Simulação]” e o aviso “Envio simulado — nenhuma mensagem foi enviada”.",
  },
  {
    icon: PlugZap,
    title: "Tribunais",
    label: "Não integrado",
    text: "DataJud, MNI e PJe aparecem como “não integrado nesta versão”. Movimentações vêm do cadastro ou da planilha importada, sempre com a origem indicada.",
  },
];

const NEVER = [
  "Inventar jurisprudência, citações ou movimentações processuais.",
  "Somar o valor da causa ao valor liquidado.",
  "Tratar um valor não apurado como zero.",
  "Tornar oficial um valor proposto sem a conferência de uma pessoa identificada.",
  "Apresentar uma simulação como fato do processo.",
];

const GOVERNANCE: { icon: LucideIcon; title: string; text: string }[] = [
  {
    icon: Lock,
    title: "Isolamento e perfis",
    text: "Cada organização só enxerga os próprios dados; dentro dela, a visibilidade segue perfil, unidade, escritório e sigilo.",
  },
  {
    icon: HeartPulse,
    title: "Documentos sensíveis",
    text: "Atestados, laudos e CAT ficam restritos a gestores, a quem enviou e ao responsável pelo caso. Download só com sessão e permissão.",
  },
  {
    icon: BookOpenCheck,
    title: "Trilha de auditoria",
    text: "Alterações relevantes, conferências de valores, fechamentos e acessos a documentos ficam registrados.",
  },
  {
    icon: ShieldCheck,
    title: "Fechamento imutável",
    text: "Uma competência fechada não muda: os relatórios daquele mês sempre leem o mesmo retrato da carteira.",
  },
];

const FAQ = [
  {
    q: "A análise preliminar é feita por inteligência artificial?",
    a: "Nesta versão, não: ela é gerada por um simulador e identificada como demonstrativa em todas as telas. Cada item informa a origem (extraído do documento, cadastro/planilha, ilustrativo ou lacuna) e o advogado revisa, edita e aprova antes de qualquer uso.",
  },
  {
    q: "Os e-mails são enviados de verdade?",
    a: "Não. O envio é simulado: as mensagens ficam registradas na Central de e-mails, com o assunto iniciado por “[Simulação]” e o aviso “Envio simulado — nenhuma mensagem foi enviada”.",
  },
  {
    q: "Como a planilha da carteira é importada?",
    a: "O Praetor lê as abas da planilha, valida o número CNJ pelo dígito verificador, agrupa as instâncias do mesmo processo, aponta duplicidades e valores divergentes e gera um relatório de inconsistências para conferência antes da carga.",
  },
  {
    q: "Como ficam o valor da causa e o valor liquidado?",
    a: "Lado a lado e sempre identificados — nunca somados. Valor não apurado aparece como “Não apurado”, e não como zero. Valores propostos só se tornam oficiais com a conferência de uma pessoa identificada, e o fechamento mensal congela a provisão da competência.",
  },
  {
    q: "Existe integração com tribunais?",
    a: "Não nesta versão. As integrações aparecem como “não integrado nesta versão”, e as movimentações vêm do cadastro ou da planilha importada, com a origem indicada.",
  },
  {
    q: "Quem vê cada informação?",
    a: "São perfis para o jurídico (administrador, gestor, advogado e analista), diretoria, contabilidade, auditoria e escritório externo. Advogados e analistas veem a própria unidade e os casos sob sua responsabilidade; o escritório externo vê somente os processos atribuídos a ele; registros sigilosos e documentos de saúde têm acesso mais restrito.",
  },
];

function Kicker({ children, tone = "light" }: { children: string; tone?: "light" | "dark" }) {
  return (
    <p
      className={`text-xs font-semibold tracking-[0.18em] uppercase ${tone === "dark" ? "text-gold-400" : "text-gold-700"}`}
    >
      {children}
    </p>
  );
}

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
        <Spotlight className="overflow-hidden bg-navy-900" color="rgba(212, 176, 98, 0.13)" size={560}>
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
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -top-40 -right-40 size-[36rem] rounded-full bg-navy-600/40 blur-3xl"
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -bottom-48 -left-24 size-[28rem] rounded-full bg-gold-500/10 blur-3xl"
          />

          <div className="relative mx-auto grid max-w-6xl items-center gap-14 px-4 pt-32 pb-24 sm:px-6 lg:grid-cols-[1.05fr_0.95fr] lg:pt-40 lg:pb-32">
            <div>
              <p
                data-reveal
                className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs font-medium text-slate-200"
              >
                <span aria-hidden="true" className="size-1.5 rounded-full bg-gold-400" />
                Gestão do passivo jurídico · contencioso e preventivo
              </p>
              <h1
                data-reveal
                style={delay(80)}
                className="mt-6 font-display text-5xl leading-[1.04] font-semibold tracking-tight text-white sm:text-6xl xl:text-[4.25rem]"
              >
                Toda a carteira.
                <br />
                Cada valor conferido.
                <br />
                <span className="bg-gradient-to-r from-gold-300 via-gold-400 to-gold-500 bg-clip-text text-transparent">
                  Nada inventado.
                </span>
              </h1>
              <p data-reveal style={delay(160)} className="mt-6 max-w-xl text-lg leading-relaxed text-slate-300">
                O Praetor organiza a carteira de processos a partir da sua planilha, acompanha valores, garantias, risco
                e provisão mês a mês e prepara cada novo processo para o advogado responsável — com as simulações desta
                versão sempre identificadas.
              </p>
              <div data-reveal style={delay(240)} className="mt-9 flex flex-wrap gap-3">
                <Link
                  href={cta.href}
                  className="group inline-flex items-center gap-2 rounded-full bg-gold-400 px-6 py-3 text-sm font-semibold text-navy-900 shadow-lg shadow-gold-500/20 transition hover:bg-gold-300 focus-visible:outline-gold-300"
                >
                  {user ? "Ir para o painel" : "Acessar a plataforma"}
                  <ArrowRight aria-hidden="true" className="size-4 transition-transform group-hover:translate-x-0.5" />
                </Link>
                <a
                  href="#como-funciona"
                  className="inline-flex items-center gap-2 rounded-full px-6 py-3 text-sm font-semibold text-white ring-1 ring-white/25 transition hover:bg-white/10 focus-visible:outline-gold-300"
                >
                  Ver como funciona
                </a>
              </div>
              <ul
                data-reveal
                style={delay(320)}
                className="mt-10 flex flex-wrap gap-x-6 gap-y-2 text-sm text-slate-300"
              >
                {["Validação do número CNJ", "Fechamento mensal imutável", "Simulações sempre identificadas"].map(
                  (t) => (
                    <li key={t} className="inline-flex items-center gap-2">
                      <ShieldCheck aria-hidden="true" className="size-4 text-gold-400" />
                      {t}
                    </li>
                  ),
                )}
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
              { n: 1, s: "", label: "processo por número CNJ, com todas as instâncias" },
              { n: 8, s: "", label: "perfis de acesso, do jurídico ao escritório externo" },
              { n: 100, s: "%", label: "dos itens da análise preliminar com origem indicada" },
              { n: 0, s: "", label: "e-mails reais enviados nesta versão (envio simulado)" },
            ].map((f, i) => (
              <div key={f.label} data-reveal style={delay(i * 80)} className="bg-white px-6 py-8 text-center">
                <dt className="sr-only">{f.label}</dt>
                <dd>
                  <span className="block font-display text-5xl font-semibold text-navy-900">
                    <CountUp value={f.n} suffix={f.s} />
                  </span>
                  <span className="mt-1 block text-sm text-slate-600">{f.label}</span>
                </dd>
              </div>
            ))}
          </dl>
        </section>

        {/* ----------------------------------------------------------- Fronts */}
        <section id="plataforma" className="scroll-mt-16 bg-white">
          <div className="mx-auto max-w-6xl px-4 py-24 sm:px-6">
            <div data-reveal className="max-w-2xl">
              <Kicker>Plataforma</Kicker>
              <h2 className="mt-3 font-display text-4xl font-semibold text-slate-900 sm:text-5xl">
                Duas frentes, uma carteira
              </h2>
              <p className="mt-4 text-lg text-slate-600">
                Conduzir bem o passivo existente e evitar o próximo conflito fazem parte do mesmo trabalho.
              </p>
            </div>
            <div className="mt-12 grid gap-6 md:grid-cols-2">
              {FRONTS.map(({ icon: Icon, kicker, title, text, points }, i) => (
                <Spotlight key={title} className="rounded-2xl" color="rgba(11, 26, 44, 0.07)">
                  <article
                    data-reveal
                    style={delay(i * 120)}
                    className="relative h-full rounded-2xl border border-slate-200 bg-white p-8 transition-shadow duration-300 hover:shadow-xl hover:shadow-slate-900/5"
                  >
                    <span className="inline-flex size-12 items-center justify-center rounded-xl bg-navy-900 text-gold-400">
                      <Icon aria-hidden="true" className="size-6" />
                    </span>
                    <p className="mt-6 text-xs font-semibold tracking-[0.16em] text-gold-700 uppercase">{kicker}</p>
                    <h3 className="mt-1 font-display text-3xl font-semibold">{title}</h3>
                    <p className="mt-3 leading-relaxed text-slate-600">{text}</p>
                    <ul className="mt-6 space-y-2.5">
                      {points.map((p) => (
                        <li key={p} className="flex items-center gap-2.5 text-sm text-slate-700">
                          <span
                            aria-hidden="true"
                            className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-gold-400/20"
                          >
                            <span className="size-1.5 rounded-full bg-gold-600" />
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
              <Kicker>Como funciona</Kicker>
              <h2 className="mt-3 font-display text-4xl font-semibold sm:text-5xl">Da planilha ao fechamento do mês</h2>
              <p className="mt-4 text-lg text-slate-600">
                Clique em cada passo — ou deixe a demonstração avançar sozinha.
              </p>
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
                <Kicker>Módulos</Kicker>
                <h2 className="mt-3 font-display text-4xl font-semibold sm:text-5xl">
                  Tudo o que o jurídico acompanha
                </h2>
              </div>
              <Link
                href={cta.href}
                className="group inline-flex items-center gap-1.5 text-sm font-semibold text-navy-700 hover:text-navy-900"
              >
                {cta.label}
                <ArrowRight aria-hidden="true" className="size-4 transition-transform group-hover:translate-x-0.5" />
              </Link>
            </div>
            <ul className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {MODULES.map(({ icon: Icon, title, text, simulated }, i) => (
                <li key={title} data-reveal style={delay((i % 3) * 90)}>
                  <Spotlight className="h-full rounded-2xl" color="rgba(212, 176, 98, 0.16)" size={300}>
                    <div className="group relative h-full rounded-2xl border border-slate-200 bg-white p-6 transition duration-300 hover:-translate-y-1 hover:border-gold-400/60">
                      <div className="flex items-start justify-between gap-3">
                        <span className="inline-flex size-10 items-center justify-center rounded-lg bg-navy-50 text-navy-800 transition-colors group-hover:bg-navy-900 group-hover:text-gold-400">
                          <Icon aria-hidden="true" className="size-5" />
                        </span>
                        {simulated ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-900">
                            <FlaskConical aria-hidden="true" className="size-3" />
                            Simulação nesta versão
                          </span>
                        ) : null}
                      </div>
                      <h3 className="mt-4 text-lg font-semibold">{title}</h3>
                      <p className="mt-2 text-sm leading-relaxed text-slate-600">{text}</p>
                    </div>
                  </Spotlight>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* ---------------------------------------------------------- Profiles */}
        <section id="perfis" className="scroll-mt-16 bg-slate-50">
          <div className="mx-auto max-w-6xl px-4 py-24 sm:px-6">
            <div data-reveal className="max-w-2xl">
              <Kicker>Perfis</Kicker>
              <h2 className="mt-3 font-display text-4xl font-semibold sm:text-5xl">Cada área vê o que precisa</h2>
              <p className="mt-4 text-lg text-slate-600">
                A permissão é conferida no servidor, registro a registro — esconder um botão nunca é a única barreira.
              </p>
            </div>
            <div data-reveal style={delay(120)} className="mt-12">
              <ProfileSwitcher />
            </div>
          </div>
        </section>

        {/* ------------------------------------------------- Simulations & limits */}
        <section id="simulacoes" className="relative scroll-mt-16 overflow-hidden bg-navy-900 text-white">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute top-0 left-1/2 size-[40rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-gold-500/10 blur-3xl"
          />
          <div className="relative mx-auto max-w-6xl px-4 py-24 sm:px-6">
            <div data-reveal className="max-w-2xl">
              <Kicker tone="dark">Transparência</Kicker>
              <h2 className="mt-3 font-display text-4xl font-semibold sm:text-5xl">
                O que é simulado — e o que nunca acontece
              </h2>
              <p className="mt-4 text-lg text-slate-300">
                Esta versão demonstra o fluxo completo. O que ainda não é real está identificado em cada tela, com o
                mesmo aviso.
              </p>
            </div>
            <div className="mt-12 grid gap-4 md:grid-cols-3">
              {SIMULATED.map(({ icon: Icon, title, text, label }, i) => (
                <div
                  key={title}
                  data-reveal
                  style={delay(i * 100)}
                  className="rounded-2xl border border-white/10 bg-white/[0.04] p-6 backdrop-blur"
                >
                  <div className="flex items-center justify-between gap-3">
                    <Icon aria-hidden="true" className="size-6 text-gold-400" />
                    <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-900">
                      <FlaskConical aria-hidden="true" className="size-3" />
                      {label}
                    </span>
                  </div>
                  <h3 className="mt-4 text-lg font-semibold text-white">{title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-slate-300">{text}</p>
                </div>
              ))}
            </div>
            <div data-reveal className="mt-6 rounded-2xl border border-white/10 bg-white/[0.04] p-6 sm:p-8">
              <h3 className="text-lg font-semibold text-white">O Praetor nunca vai</h3>
              <ul className="mt-5 grid gap-3.5 md:grid-cols-2">
                {NEVER.map((t) => (
                  <li key={t} className="flex gap-3 text-slate-200">
                    <Ban aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-rose-300" />
                    {t}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        {/* -------------------------------------------------------- Governance */}
        <section id="seguranca" className="scroll-mt-16 bg-white">
          <div className="mx-auto max-w-6xl px-4 py-24 sm:px-6">
            <div data-reveal className="max-w-2xl">
              <Kicker>Segurança e governança</Kicker>
              <h2 className="mt-3 font-display text-4xl font-semibold sm:text-5xl">
                Controle de acesso desde a primeira linha
              </h2>
            </div>
            <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {GOVERNANCE.map(({ icon: Icon, title, text }, i) => (
                <div key={title} data-reveal style={delay(i * 90)} className="rounded-2xl border border-slate-200 p-6">
                  <Icon aria-hidden="true" className="size-6 text-navy-600" />
                  <h3 className="mt-4 font-semibold">{title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-slate-600">{text}</p>
                </div>
              ))}
            </div>
            <p data-reveal className="mt-6 text-xs text-slate-600">
              Esses controles não equivalem a uma declaração de conformidade legal ou de segurança completa. Pontos
              ainda em avaliação estão documentados para a equipe técnica.
            </p>
          </div>
        </section>

        {/* -------------------------------------------------------------- Name */}
        <section className="relative overflow-hidden bg-gold-50">
          <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 py-24 sm:px-6 lg:grid-cols-[0.8fr_1.2fr]">
            <div data-reveal className="flex justify-center">
              <div className="relative">
                <div aria-hidden="true" className="absolute inset-4 rounded-full bg-gold-400/25 blur-3xl" />
                <LogoMark animated className="relative size-36 sm:size-44" title="Símbolo do Praetor" />
              </div>
            </div>
            <div data-reveal style={delay(120)}>
              <Kicker>O nome</Kicker>
              <h2 className="mt-3 font-display text-5xl font-semibold text-navy-900">Por que “Praetor”?</h2>
              <p className="mt-5 text-lg leading-relaxed text-slate-700">
                <em className="font-display text-2xl not-italic">Praetor</em> é a palavra latina para{" "}
                <strong>pretor</strong>, o magistrado que administrava a justiça na Roma Antiga. Ao assumir o cargo,
                publicava o seu <em>edito</em> — as regras que aplicaria —, orientando as pessoas antes do conflito, e
                conduzia os litígios quando surgiam.
              </p>
              <blockquote className="mt-6 border-l-2 border-gold-500 pl-5 font-display text-2xl text-slate-800 italic">
                <em>prae-ire</em> — “ir à frente”.
              </blockquote>
              <p className="mt-4 text-slate-700">
                Prevenir e conduzir: as duas frentes desta plataforma. O símbolo reúne um arco, a passagem dos pórticos
                romanos, e um quadrado dourado.
              </p>
            </div>
          </div>
        </section>

        {/* --------------------------------------------------------------- FAQ */}
        <section id="perguntas" className="scroll-mt-16 bg-white">
          <div className="mx-auto max-w-3xl px-4 py-24 sm:px-6">
            <div data-reveal className="text-center">
              <Kicker>Perguntas frequentes</Kicker>
              <h2 className="mt-3 font-display text-4xl font-semibold sm:text-5xl">Antes de começar</h2>
            </div>
            <div className="mt-10 divide-y divide-slate-200 rounded-2xl border border-slate-200">
              {FAQ.map((f, i) => (
                <details
                  key={f.q}
                  data-reveal
                  style={delay(i * 60)}
                  className="group px-6 [&_summary::-webkit-details-marker]:hidden"
                >
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4 rounded-md py-5 font-semibold text-slate-900">
                    {f.q}
                    <span
                      aria-hidden="true"
                      className="inline-flex size-7 shrink-0 items-center justify-center rounded-full border border-slate-200 text-slate-600 transition-transform duration-300 group-open:rotate-45 group-open:border-gold-400 group-open:text-gold-700"
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
        <Spotlight className="overflow-hidden bg-navy-900" color="rgba(212, 176, 98, 0.16)" size={500}>
          <div className="relative mx-auto max-w-4xl px-4 py-24 text-center sm:px-6">
            <div data-reveal>
              <LogoMark variant="light" className="mx-auto size-14" />
              <h2 className="mt-6 font-display text-4xl font-semibold text-white sm:text-5xl">
                O jurídico um passo à frente
              </h2>
              <p className="mx-auto mt-4 max-w-xl text-lg text-slate-300">
                Acesse com seu e-mail corporativo. No ambiente demonstrativo, use uma das contas fictícias listadas na
                tela de login.
              </p>
              <Link
                href={cta.href}
                className="group mt-9 inline-flex items-center gap-2 rounded-full bg-gold-400 px-7 py-3.5 text-sm font-semibold text-navy-900 shadow-lg shadow-gold-500/20 transition hover:bg-gold-300 focus-visible:outline-gold-300"
              >
                {user ? "Ir para o painel" : "Acessar a plataforma"}
                <ArrowRight aria-hidden="true" className="size-4 transition-transform group-hover:translate-x-0.5" />
              </Link>
            </div>
          </div>
        </Spotlight>
      </main>

      <footer className="border-t border-white/5 bg-navy-950 text-slate-300">
        <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-10 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <Logo size="sm" />
          <div className="space-y-1 text-xs sm:text-right">
            <p>Praetor · versão em desenvolvimento</p>
            <p>Análise preliminar e e-mails simulados nesta versão; sem integração com tribunais.</p>
          </div>
        </div>
      </footer>
    </RevealRoot>
  );
}
