import { eq } from "drizzle-orm";
import { CalendarClock, FileSearch, Scale, ShieldCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { safeNextPath } from "@/lib/safe-redirect";
import { param } from "@/lib/search-params";
import { getCurrentUser } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { organizations } from "@/server/db/schema";
import { logger } from "@/server/lib/logger";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Entrar" };

const HIGHLIGHTS = [
  { icon: Scale, text: "Processos, ocorrências preventivas e contratos em um só lugar." },
  { icon: CalendarClock, text: "Prazos e tarefas com responsáveis, alertas e validação humana." },
  { icon: FileSearch, text: "Análises de apoio por IA com fontes citadas — sem substituir o advogado." },
  { icon: ShieldCheck, text: "Controle de acesso por perfil e unidade, com trilha de auditoria." },
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
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <aside className="relative hidden flex-col justify-between overflow-hidden bg-sidebar px-10 py-12 text-sidebar-foreground lg:flex">
        <Link href="/" className="flex w-fit items-center gap-3 rounded-md focus-visible:outline-2 focus-visible:outline-sidebar-indicator">
          <span
            aria-hidden="true"
            className="inline-flex size-10 items-center justify-center rounded-lg bg-primary-600 ring-1 ring-white/10"
          >
            <Scale className="size-5 text-white" />
          </span>
          <span className="text-lg font-semibold tracking-tight text-white">Praetor</span>
        </Link>
        <div className="max-w-md">
          <p className="text-2xl leading-snug font-semibold tracking-tight text-white">
            Gestão jurídica preventiva e contenciosa com apoio de IA
          </p>
          <ul className="mt-8 space-y-4">
            {HIGHLIGHTS.map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-start gap-3 text-sm text-sidebar-muted">
                <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-sidebar-indicator" />
                <span>{text}</span>
              </li>
            ))}
          </ul>
        </div>
        <p className="text-xs text-sidebar-muted">
          As análises por IA são apoio à decisão: não preveem resultados e não substituem a avaliação profissional.
        </p>
      </aside>

      <main id="conteudo" className="flex items-center justify-center px-4 py-10 sm:px-8">
        <div className="w-full max-w-md">
          <div className="mb-8 lg:hidden">
            <Link href="/" className="flex w-fit items-center gap-2.5 rounded-md">
              <span
                aria-hidden="true"
                className="inline-flex size-9 items-center justify-center rounded-md bg-primary text-white"
              >
                <Scale className="size-4" />
              </span>
              <span className="text-lg font-semibold tracking-tight text-slate-900">Praetor</span>
            </Link>
            <p className="mt-2 text-sm text-muted-foreground">Gestão jurídica preventiva e contenciosa com apoio de IA</p>
          </div>

          <h1 className="text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl">Entrar no Praetor</h1>
          <p className="mt-1 mb-6 text-sm text-muted-foreground">Use seu e-mail corporativo e senha.</p>

          <LoginForm next={next} showDemoAccounts={showDemoAccounts} />

          <p className="mt-8 text-center text-sm">
            <Link href="/" className="text-primary-600 underline-offset-4 hover:underline">
              Conhecer o Praetor
            </Link>
          </p>
        </div>
      </main>
    </div>
  );
}
