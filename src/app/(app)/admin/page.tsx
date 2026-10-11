import { Building2, ChevronRight, KeyRound, ScrollText, Settings, Sparkles, Users, UsersRound } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { AiModeBadge } from "@/components/ui/ai-mode-badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { StatCard } from "@/components/ui/stat-card";
import { formatDateTime, formatNumber, formatPercent } from "@/lib/format";
import { AdminNav } from "@/modules/admin/components/admin-nav";
import { requireAdminAreaContext } from "@/modules/admin/guard";
import { actionLabel } from "@/modules/admin/history-format";
import { ADMIN_SECTIONS, type AdminSectionKey } from "@/modules/admin/sections";
import { getAdminOverview } from "@/modules/admin/service";
import { getAiRuntimeInfo, getAiUsageSummary } from "@/modules/analyses/service";
import { can } from "@/server/auth/permissions";
import { logger } from "@/server/lib/logger";

export const metadata: Metadata = { title: "Administração" };

const SECTION_ICONS: Partial<Record<AdminSectionKey, ReactNode>> = {
  usuarios: <Users aria-hidden="true" />,
  equipes: <UsersRound aria-hidden="true" />,
  unidades: <Building2 aria-hidden="true" />,
  permissoes: <KeyRound aria-hidden="true" />,
  auditoria: <ScrollText aria-hidden="true" />,
  configuracoes: <Settings aria-hidden="true" />,
};

export default async function AdminOverviewPage() {
  const ctx = await requireAdminAreaContext();
  const overview = await getAdminOverview(ctx);
  const canOrg = can(ctx, "admin:organization");

  let ai: { mode: "live" | "demo"; provider: string; model: string; used: number; budget: number } | null = null;
  if (canOrg) {
    try {
      const runtime = getAiRuntimeInfo();
      const usage = await getAiUsageSummary(ctx);
      ai = { ...runtime, used: usage.inputTokens + usage.outputTokens, budget: usage.monthlyTokenBudget };
    } catch (error) {
      logger.error("admin_ai_overview_failed", { error });
    }
  }

  const sections = ADMIN_SECTIONS.filter((s) => s.key !== "visao-geral" && s.permissions.some((p) => can(ctx, p)));

  return (
    <>
      <PageHeader
        title="Administração"
        description="Usuários, equipes, unidades, permissões, auditoria e configurações da organização."
      />
      <AdminNav ctx={ctx} active="visao-geral" />

      {overview.users || ai ? (
        <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {overview.users ? (
            <StatCard
              label="Usuários ativos"
              value={formatNumber(overview.users.active)}
              hint={`${formatNumber(overview.users.total)} cadastrados`}
              href="/admin/usuarios?situacao=ativos"
              icon={<Users aria-hidden="true" />}
              tone="primary"
            />
          ) : null}
          {overview.teams !== null ? (
            <StatCard
              label="Equipes"
              value={formatNumber(overview.teams)}
              href="/admin/equipes"
              icon={<UsersRound aria-hidden="true" />}
            />
          ) : null}
          {overview.units ? (
            <StatCard
              label="Unidades ativas"
              value={formatNumber(overview.units.active)}
              hint={`${formatNumber(overview.units.total)} cadastradas`}
              href="/admin/unidades"
              icon={<Building2 aria-hidden="true" />}
            />
          ) : null}
          {ai ? (
            <StatCard
              label="Uso de IA no mês"
              value={ai.budget > 0 ? formatPercent(Math.min(1, ai.used / ai.budget)) : "IA bloqueada"}
              hint={
                <span className="inline-flex flex-wrap items-center gap-1.5">
                  <AiModeBadge mode={ai.mode} />
                  {formatNumber(ai.used)} de {formatNumber(ai.budget)} tokens
                </span>
              }
              href="/admin/configuracoes#ia"
              icon={<Sparkles aria-hidden="true" />}
              tone="ai"
            />
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Seções</CardTitle>
            <CardDescription>Áreas da administração disponíveis para o seu perfil.</CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            <ul className="divide-y divide-border">
              {sections.map((s) => (
                <li key={s.key}>
                  <Link
                    href={s.href}
                    className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-surface-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                  >
                    <span className="text-muted-foreground [&_svg]:size-4">{SECTION_ICONS[s.key]}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-slate-900">{s.label}</span>
                      <span className="block text-xs text-muted-foreground">{s.description}</span>
                    </span>
                    <ChevronRight aria-hidden="true" className="size-4 text-slate-400" />
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        {overview.recentAudit ? (
          <Card>
            <CardHeader actions={<ButtonLink href="/admin/auditoria" variant="outline" size="sm">Ver auditoria</ButtonLink>}>
              <CardTitle>Últimas ações auditadas</CardTitle>
              <CardDescription>As cinco ações mais recentes registradas na organização.</CardDescription>
            </CardHeader>
            <CardContent>
              {overview.recentAudit.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nenhuma ação registrada ainda.</p>
              ) : (
                <ul className="space-y-3">
                  {overview.recentAudit.map((entry) => (
                    <li key={entry.id} className="text-sm">
                      <p className="font-medium text-slate-900">{actionLabel(entry.action)}</p>
                      <p className="text-slate-700">{entry.summary}</p>
                      <p className="text-xs text-muted-foreground">
                        {formatDateTime(entry.createdAt)} · {entry.actorName ?? "Sistema"}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        ) : null}
      </div>
    </>
  );
}
