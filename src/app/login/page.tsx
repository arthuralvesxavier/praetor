import { eq } from "drizzle-orm";
import { FileSpreadsheet, Inbox, Landmark, UsersRound } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { LogoMark, LogoWordmark } from "@/components/brand/logo";
import { safeNextPath } from "@/lib/safe-redirect";
import { param } from "@/lib/search-params";
import { getCurrentUser } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { organizations } from "@/server/db/schema";
import { logger } from "@/server/lib/logger";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Entrar" };

const HIGHLIGHTS = [
  {
    icon: FileSpreadsheet,
    text: "Carteira importada da planilha, com validação do número CNJ, duplicidades e relatório de inconsistências.",
  },
  {
    icon: Inbox,
    text: "Entrada de processos com análise preliminar e aviso ao advogado responsável, ambos simulados nesta versão.",
  },
  { icon: Landmark, text: "Valores, garantias, risco e provisão com fechamento mensal conferido por pessoas." },
  { icon: UsersRound, text: "Perfis para jurídico, diretoria, contabilidade, auditoria e escritórios externos." },
] as const;

async function demoOrganizationExists(): Promise<boolean> {
  try {
    const [row] = await getDb()
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.isDemo, true))
      .limit(1);
    return Boolean(row);
  } catch (error) {
    logger.error("login_demo_check_failed", { error });
    return false;
  }
}

export default async function LoginPage(props: PageProps<"/login">) {
  const sp = await props.searchParams;
  const next = safeNextPath(param(sp, "next"));

  if (await getCurrentUser()) redirect(next ?? "/dashboard");

  const showDemoAccounts = await demoOrganizationExists();

  return (
    <div className="grid min-h-dvh bg-white lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <aside className="relative hidden flex-col justify-between overflow-hidden bg-navy-900 px-10 py-12 text-sidebar-foreground lg:flex">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 opacity-40"
          style={{
            backgroundImage:
              "linear-gradient(rgba(255,255,255,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px)",
            backgroundSize: "48px 48px",
            maskImage: "radial-gradient(ellipse 80% 60% at 30% 40%, black, transparent)",
          }}
        />
        <LogoMark
          variant="light"
          className="pointer-events-none absolute -right-24 -bottom-24 size-[26rem] opacity-[0.06]"
        />
        <Link
          href="/"
          aria-label="Praetor, página inicial"
          className="relative w-fit rounded-md py-1 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-gold-400"
        >
          <LogoWordmark variant="light" title="" className="h-8" />
        </Link>
        <div className="relative max-w-md">
          <p className="text-xs font-semibold tracking-[0.18em] text-gold-400 uppercase">Gestão do passivo jurídico</p>
          <p className="mt-3 font-display text-4xl leading-tight font-semibold text-white">
            A carteira inteira, conferida e sob controle.
          </p>
          <ul className="mt-8 space-y-4">
            {HIGHLIGHTS.map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-start gap-3 text-sm leading-relaxed text-sidebar-muted">
                <span
                  aria-hidden="true"
                  className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-white/5 text-gold-400 ring-1 ring-white/10"
                >
                  <Icon className="size-4" />
                </span>
                <span>{text}</span>
              </li>
            ))}
          </ul>
        </div>
        <p className="relative max-w-md text-xs leading-relaxed text-sidebar-muted">
          Nesta versão, a análise preliminar por IA e o envio de e-mails são simulações demonstrativas (nenhuma
          mensagem é enviada) e não há integração com tribunais.
        </p>
      </aside>

      <main id="conteudo" className="flex items-center justify-center px-4 py-10 sm:px-8">
        <div className="w-full max-w-md">
          <div className="mb-8 lg:hidden">
            <Link
              href="/"
              aria-label="Praetor, página inicial"
              className="inline-flex w-fit rounded-md py-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <LogoWordmark variant="color" title="" className="h-7" />
            </Link>
            <p className="mt-3 text-sm text-muted-foreground">Gestão do passivo jurídico e do jurídico preventivo</p>
          </div>

          <h1 className="font-display text-3xl font-semibold tracking-tight text-navy-900">Entrar no Praetor</h1>
          <p className="mt-1 mb-6 text-sm text-muted-foreground">Use seu e-mail corporativo e senha.</p>

          <LoginForm next={next} showDemoAccounts={showDemoAccounts} />

          <p className="mt-8 text-center text-sm">
            <Link
              href="/"
              className="font-medium text-primary-700 underline-offset-4 hover:text-primary-900 hover:underline"
            >
              Conhecer o Praetor
            </Link>
          </p>
        </div>
      </main>
    </div>
  );
}
