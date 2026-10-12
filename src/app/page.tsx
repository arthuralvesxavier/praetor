import {
  ArrowRight,
  BookOpenCheck,
  CalendarClock,
  ChevronDown,
  CircleDashed,
  EyeOff,
  HeartPulse,
  Inbox,
  Landmark,
  LayoutDashboard,
  Lock,
  Scale,
  ShieldCheck,
  UserCheck,
  type LucideIcon,
} from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import type { CSSProperties } from "react";
import { Logo, LogoMark } from "@/components/brand/logo";
import { FlowStepper } from "@/components/landing/flow-stepper";
import { RevealRoot, Spotlight } from "@/components/landing/motion";
import { ProductPreview } from "@/components/landing/product-preview";
import { SiteHeader } from "@/components/landing/site-header";
import { getCurrentUser } from "@/server/auth/session";

/**
 * Public presentation page shown before the login. It contains no tenant data:
 * the only server read is whether the visitor already has a session, to switch
 * the call to action between "Entrar" and "Ir para o painel". Product visuals
 * are illustrative and labeled as such. Copy rule (product owner): no dashes as
 * punctuation and no claims beyond what the code delivers today (no real AI,
 * no tribunal integration, no statistics). tests/landing checks both.
 */
export const metadata: Metadata = {
  title: { absolute: "Praetor: gestão do passivo jurídico e do jurídico preventivo" },
  description:
    "Carteira de processos importada da planilha com validação do número CNJ, distribuição por regras, análise preliminar revisada pelo advogado, valores, garantias, risco e provisão com fechamento mensal.",
};

const delay = (ms: number) => ({ "--reveal-delay": `${ms}ms` }) as CSSProperties;

/** Rules the portfolio follows everywhere (dashboard, lists, reports and exports). */
const RULES: { icon: LucideIcon; title: string; text: string }[] = [
  {
    icon: Scale,
    title: "Causa e apurado separados",
    text: "Valor da causa e valor liquidado medem coisas diferentes e nunca entram na mesma soma.",
  },
  {
    icon: CircleDashed,
    title: "Falta de dado fica visível",
    text: "Sem valor apurado, o processo mostra “Não apurado”, nunca zero, e os totais dizem quantos ficaram de fora.",
  },
  {
    icon: UserCheck,
    title: "Valor oficial tem conferente",
    text: "Um valor proposto só entra nos totais depois que uma pessoa identificada o confere.",
  },
  {
    icon: Lock,
    title: "Mês fechado não muda",
    text: "Os relatórios de uma competência fechada sempre leem o mesmo retrato da carteira.",
  },
];

const AREAS: { icon: LucideIcon; title: string; text: string }[] = [
  {
    icon: Scale,
    title: "Carteira de processos",
    text: "Um registro por número CNJ, com 1º grau, 2º grau e tribunal superior no mesmo processo. Filtros por tribunal, cidade, empresa, escritório, fase e valor.",
  },
  {
    icon: Landmark,
    title: "Valores, garantias e provisão",
    text: "Valor da causa e valor liquidado em campos separados, garantias vinculadas ao processo, classificação de risco e provisão mês a mês.",
  },
  {
    icon: CalendarClock,
    title: "Audiências, prazos e acordos",
    text: "Agenda de audiências, prazos e tarefas por responsável, e acordos com parcelas. Os alertas mostram o que vence e o que está parado.",
  },
  {
    icon: Inbox,
    title: "Entrada e distribuição",
    text: "Fila dos processos que chegam, regras de distribuição e painel de carga por advogado e por escritório externo.",
  },
  {
    icon: ShieldCheck,
    title: "Preventivo e contratos",
    text: "Ocorrências que ainda não viraram processo, com plano de ação, e contratos com vigência, aviso de renovação e obrigações.",
  },
  {
    icon: LayoutDashboard,
    title: "Painel e relatórios",
    text: "Painel executivo, relatórios de provisão por competência e carta de auditoria, com exportação em Excel e CSV.",
  },
];

const GOVERNANCE: { icon: LucideIcon; title: string; text: string }[] = [
  {
    icon: Lock,
    title: "Acesso por perfil",
    text: "A permissão é conferida no servidor, registro a registro, conforme o perfil, a unidade e o escritório de cada pessoa. Cada organização só enxerga os próprios dados.",
  },
  {
    icon: HeartPulse,
    title: "Documentos sensíveis",
    text: "Atestados, laudos e CAT ficam restritos aos gestores, a quem enviou e ao responsável pelo caso. O download exige sessão e permissão.",
  },
  {
    icon: BookOpenCheck,
    title: "Trilha de auditoria",
    text: "Alterações, conferências de valores, fechamentos, exportações e consultas a processos sigilosos ficam registrados, com autor e horário.",
  },
  {
    icon: EyeOff,
    title: "Dados pessoais mascarados",
    text: "CPF e CNPJ aparecem mascarados nas listas, na aba de partes e nos arquivos exportados.",
  },
];

const HISTORY = [
  { when: "367 a.C.", text: "Roma cria o cargo de pretor para cuidar da justiça na cidade." },
  { when: "242 a.C.", text: "Surge um segundo pretor, para as disputas que envolviam estrangeiros." },
  {
    when: "Por volta de 130 d.C.",
    text: "A pedido do imperador Adriano, os editos são consolidados num texto definitivo, o Edito Perpétuo.",
  },
];

const FAQ: { q: string; a: string }[] = [
  {
    q: "De onde vêm os processos?",
    a: "Da planilha da carteira, importada em Excel (.xlsx); do cadastro de um processo recebido na Entrada de processos, junto com os documentos que chegaram; ou do cadastro direto na carteira. Nos três caminhos, o Praetor confere o dígito verificador do número CNJ e sinaliza o que não confere, sem corrigir o número por conta própria.",
  },
  {
    q: "Por que o valor da causa e o valor apurado nunca são somados?",
    a: "Porque medem coisas diferentes. O valor da causa é o atribuído na petição inicial. O valor liquidado, ou apurado, é o resultado do cálculo feito na liquidação ou na execução. Somar os dois contaria o mesmo risco duas vezes. Por isso eles aparecem lado a lado, em colunas separadas, na carteira, no painel e nas exportações.",
  },
  {
    q: "O que acontece quando falta um dado?",
    a: "A falta aparece. Um processo sem valor apurado mostra “Não apurado”, nunca zero, e os totais oficiais somam só os processos com valor apurado, dizendo quantos ficaram de fora (por exemplo, apurado em 9 de 14 processos). Quando o painel usa uma estimativa, como o valor da causa multiplicado pelo percentual de risco, ela vem marcada como estimativa. Processos sem tribunal, fase ou cidade entram numa lista de pendências de cadastro.",
  },
  {
    q: "Quem vê o quê?",
    a: "Cada pessoa entra com um perfil. No jurídico interno, o gestor vê a carteira inteira, inclusive os processos sigilosos, e advogados e analistas veem a própria unidade e os casos sob sua responsabilidade. A diretoria consulta painéis e relatórios, sem editar. A contabilidade cuida de valores, garantias, provisão e fechamento mensal. A auditoria lê a carteira, os relatórios e a trilha de auditoria, sem alterar nada. O escritório externo vê apenas os processos atribuídos a ele. Diretoria, contabilidade e auditoria não acessam processos sigilosos.",
  },
  {
    q: "Como funciona o fechamento mensal?",
    a: "Durante o mês, o Praetor mantém uma prévia da provisão, que pode ser recalculada. No fechamento, uma pessoa autorizada (contabilidade ou gestão jurídica) fecha a competência e o retrato da carteira fica gravado: valores, risco e provisão daquele mês não mudam mais, e os relatórios passam a ler esse retrato. O mês seguinte é comparado com ele, e o fechamento pode ser exportado em CSV para a contabilidade.",
  },
  {
    q: "A análise preliminar substitui o advogado?",
    a: "Não. Ela prepara a primeira leitura do caso: fatos, pedidos, valores, provas, lacunas e possíveis prazos, cada item com a sua origem. Quem decide é o advogado, que revisa, edita e aprova. Nada é aplicado ao processo sem uma ação dele: prazos sugeridos ficam aguardando validação e valores entram como propostos, para conferência. Nesta versão, a análise é gerada em modo de demonstração.",
  },
  {
    q: "O escritório externo tem acesso ao sistema?",
    a: "Sim, com um usuário do perfil Escritório externo, vinculado ao escritório. Ele vê só os processos atribuídos ao escritório e, nessa carteira, atualiza processos, documentos, prazos e tarefas, lança valores (que entram como propostos, para conferência) e revisa análises preliminares. O restante da carteira e os relatórios da empresa ficam fora do alcance dele.",
  },
  {
    q: "Como ficam a segurança e a LGPD?",
    a: "O acesso é conferido no servidor, registro a registro, conforme o perfil, a unidade e o escritório. Alterações, conferências de valores, fechamentos, exportações e consultas a processos sigilosos ficam na trilha de auditoria. Atestados, laudos e CAT são guardados como documentos restritos, e CPF e CNPJ aparecem mascarados nas listas e nas exportações. Esses controles ajudam na adequação à LGPD, mas não substituem a avaliação da própria empresa (bases legais, relatório de impacto e encarregado de dados) antes do uso com dados reais.",
  },
  {
    q: "Dá para exportar para Excel?",
    a: "Sim. A carteira sai em Excel (.xlsx), com uma aba consolidada e uma aba por instância, ou em CSV, sempre com os filtros aplicados na tela. Os relatórios também exportam em XLSX e CSV, e o fechamento mensal gera um CSV pronto para a contabilidade.",
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
    <RevealRoot className="min-h-dvh overflow-x-clip bg-white text-[15px] text-slate-900 normal-nums">
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

          <div className="relative mx-auto grid max-w-7xl items-center gap-12 px-4 pt-28 pb-20 sm:px-6 sm:pt-32 lg:pb-24 xl:grid-cols-[minmax(0,0.82fr)_minmax(0,1.18fr)] xl:gap-12 xl:pt-36 xl:pb-28">
            <div className="max-w-2xl">
              <p
                data-reveal
                className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs font-medium text-slate-200"
              >
                <span aria-hidden="true" className="size-1.5 rounded-full bg-gold-400" />
                Passivo jurídico · contencioso e preventivo
              </p>
              <h1
                data-reveal
                style={delay(80)}
                className="mt-6 font-display text-5xl leading-[1.04] font-semibold tracking-tight text-white sm:text-6xl xl:text-[4rem]"
              >
                O passivo jurídico da empresa,{" "}
                <span className="bg-gradient-to-r from-gold-300 via-gold-400 to-gold-500 bg-clip-text whitespace-nowrap text-transparent">
                  em ordem.
                </span>
              </h1>
              <p data-reveal style={delay(160)} className="mt-6 max-w-xl text-lg leading-relaxed text-slate-300">
                O Praetor reúne a carteira de processos, os valores e a provisão de cada mês. Cada processo novo chega
                ao advogado responsável com uma análise preliminar para revisar, e cada valor oficial passa pela
                conferência de uma pessoa.
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
            </div>
            <div data-reveal style={delay(200)} className="mx-auto w-full max-w-3xl min-w-0 xl:max-w-none">
              <ProductPreview />
            </div>
          </div>
          <a
            href="#plataforma"
            aria-label="Ir para a plataforma"
            className="absolute bottom-5 left-1/2 hidden -translate-x-1/2 text-slate-400 transition hover:text-white xl:block"
          >
            <ChevronDown aria-hidden="true" className="size-6 motion-safe:animate-bounce" />
          </a>
        </Spotlight>

        {/* ------------------------------------------------------------ Rules */}
        <section aria-labelledby="regras" className="border-b border-slate-200 bg-white">
          <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
            <h2 id="regras" data-reveal className="text-xs font-semibold tracking-[0.18em] text-gold-700 uppercase">
              Regras que valem em toda a carteira
            </h2>
            <ul className="mt-8 grid gap-x-8 gap-y-8 sm:grid-cols-2 lg:grid-cols-4">
              {RULES.map(({ icon: Icon, title, text }, i) => (
                <li key={title} data-reveal style={delay(i * 80)} className="flex gap-3.5">
                  <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-navy-900 text-gold-400">
                    <Icon aria-hidden="true" className="size-[18px]" />
                  </span>
                  <span>
                    <span className="block font-semibold text-slate-900">{title}</span>
                    <span className="mt-1 block text-sm leading-relaxed text-slate-600">{text}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* --------------------------------------------------------- Platform */}
        <section id="plataforma" className="scroll-mt-16 bg-white">
          <div className="mx-auto max-w-6xl px-4 py-24 sm:px-6">
            <div data-reveal className="flex flex-col justify-between gap-6 md:flex-row md:items-end">
              <div className="max-w-2xl">
                <Kicker>Plataforma</Kicker>
                <h2 className="mt-3 font-display text-4xl font-semibold text-slate-900 sm:text-5xl">
                  O que o Praetor controla
                </h2>
                <p className="mt-4 text-lg text-slate-600">
                  O contencioso e o preventivo da empresa no mesmo lugar, com os mesmos dados e as mesmas regras.
                </p>
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
              {AREAS.map(({ icon: Icon, title, text }, i) => (
                <li key={title} data-reveal style={delay((i % 3) * 90)}>
                  <Spotlight className="h-full rounded-2xl" color="rgba(212, 176, 98, 0.16)" size={300}>
                    <div className="group relative h-full rounded-2xl border border-slate-200 bg-white p-5 transition duration-300 hover:-translate-y-1 hover:border-gold-400/60 sm:p-6">
                      <div className="flex items-center gap-3">
                        <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg bg-navy-50 text-navy-800 transition-colors group-hover:bg-navy-900 group-hover:text-gold-400">
                          <Icon aria-hidden="true" className="size-5" />
                        </span>
                        <h3 className="text-lg leading-snug font-semibold">{title}</h3>
                      </div>
                      <p className="mt-3 text-sm leading-relaxed text-slate-600">{text}</p>
                    </div>
                  </Spotlight>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* ----------------------------------------------------- How it works */}
        <section id="como-funciona" className="scroll-mt-16 bg-slate-50">
          <div className="mx-auto max-w-6xl px-4 py-24 sm:px-6">
            <div data-reveal className="max-w-2xl">
              <Kicker>Como funciona</Kicker>
              <h2 className="mt-3 font-display text-4xl font-semibold sm:text-5xl">
                Do processo recebido ao fechamento do mês
              </h2>
              <p className="mt-4 text-lg text-slate-600">
                O caminho de um processo dentro do Praetor, na ordem em que o trabalho acontece. Escolha uma etapa para
                ver a tela correspondente.
              </p>
            </div>
            <div data-reveal style={delay(120)} className="mt-12">
              <FlowStepper />
            </div>
            <p className="mt-10 border-t border-slate-200 pt-5 text-xs text-slate-600">
              Nesta versão, a leitura automática dos documentos e o envio de e-mails funcionam em modo de demonstração.
            </p>
          </div>
        </section>

        {/* -------------------------------------------------------- Governance */}
        <section id="seguranca" className="scroll-mt-16 bg-white">
          <div className="mx-auto max-w-6xl px-4 py-24 sm:px-6">
            <div data-reveal className="max-w-2xl">
              <Kicker>Segurança</Kicker>
              <h2 className="mt-3 font-display text-4xl font-semibold sm:text-5xl">Acesso controlado e registrado</h2>
              <p className="mt-4 text-lg text-slate-600">
                Cada pessoa vê só o que o perfil dela permite, e o que muda na carteira fica registrado com autor e
                horário.
              </p>
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
              Esses controles são uma base técnica e não equivalem a uma declaração de conformidade com a LGPD ou de
              segurança completa.
            </p>
          </div>
        </section>

        {/* -------------------------------------------------------------- Name */}
        <section id="por-que-praetor" className="relative scroll-mt-16 overflow-hidden bg-gold-50">
          <div className="mx-auto grid max-w-6xl items-start gap-12 px-4 py-24 sm:px-6 lg:grid-cols-[0.75fr_1.25fr] lg:gap-16">
            <div data-reveal className="order-last flex flex-col items-center text-center lg:sticky lg:top-28 lg:order-none">
              <div className="relative">
                <div aria-hidden="true" className="absolute inset-4 rounded-full bg-gold-400/25 blur-3xl" />
                <LogoMark animated className="relative size-24 sm:size-32 lg:size-40" title="Símbolo do Praetor" />
              </div>
              <p className="mt-6 font-display text-2xl text-slate-800">
                <em>praetor</em>, de <em>prae-ire</em>
              </p>
              <p className="mt-1 text-sm text-slate-600">“ir à frente”, em latim</p>
              <p className="mt-5 max-w-xs text-sm leading-relaxed text-slate-600">
                O símbolo une um arco, como os pórticos romanos, a um quadrado dourado.
              </p>
            </div>
            <div data-reveal style={delay(120)}>
              <Kicker>O nome</Kicker>
              <h2 className="mt-3 font-display text-5xl font-semibold text-navy-900">Por que Praetor</h2>
              <p className="mt-6 text-lg leading-relaxed text-slate-700">
                Na Roma antiga, o pretor (<em>praetor</em>, em latim) era o magistrado encarregado de administrar a
                justiça. Ao assumir o cargo, que durava um ano, ele publicava um <strong>edito</strong>: um texto que
                dizia, de antemão, como receberia os pedidos e conduziria as disputas durante o mandato.
              </p>
              <p className="mt-4 text-lg leading-relaxed text-slate-700">
                Quem tinha um conflito sabia o que esperar. Edito após edito, essa prática deu ordem e previsibilidade
                ao direito romano.
              </p>
              <ol className="mt-8 space-y-4 border-l-2 border-gold-400 pl-6">
                {HISTORY.map((h) => (
                  <li key={h.when} className="relative">
                    <span
                      aria-hidden="true"
                      className="absolute top-2 -left-[1.9rem] size-2.5 rounded-full border-2 border-gold-50 bg-gold-500"
                    />
                    <span className="block text-sm font-semibold text-gold-800">{h.when}</span>
                    <span className="block text-slate-700">{h.text}</span>
                  </li>
                ))}
              </ol>
              <p className="mt-8 rounded-2xl border border-gold-200 bg-white/70 p-6 text-lg leading-relaxed text-slate-800">
                O nome vem daí. Como o edito, o Praetor deixa as regras claras antes do conflito: cada processo segue o
                mesmo método, do cadastro ao fechamento do mês, e cada decisão tem um responsável identificado.
              </p>
            </div>
          </div>
        </section>

        {/* --------------------------------------------------------------- FAQ */}
        <section id="perguntas" className="scroll-mt-16 bg-white">
          <div className="mx-auto max-w-3xl px-4 py-24 sm:px-6">
            <div data-reveal className="text-center">
              <Kicker>Perguntas</Kicker>
              <h2 className="mt-3 font-display text-4xl font-semibold sm:text-5xl">Perguntas frequentes</h2>
              <p className="mt-4 text-lg text-slate-600">Respostas sobre o que a plataforma faz hoje.</p>
            </div>
            <div className="mt-10 divide-y divide-slate-200 rounded-2xl border border-slate-200">
              {FAQ.map((f, i) => (
                <details
                  key={f.q}
                  open={i === 0}
                  data-reveal
                  style={delay(Math.min(i, 4) * 50)}
                  className="group px-5 sm:px-6 [&_summary::-webkit-details-marker]:hidden"
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
                Acesse com o seu e-mail corporativo. No ambiente de demonstração, use uma das contas fictícias listadas
                na tela de login.
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
          <Logo size="sm" className="self-start sm:self-auto" />
          <p className="text-xs sm:text-right">Praetor · gestão do passivo jurídico · versão em desenvolvimento</p>
        </div>
      </footer>
    </RevealRoot>
  );
}
