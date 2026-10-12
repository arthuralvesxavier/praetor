import { BellRing, ChevronRight, FileSearch, Inbox } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CASE_BRIEF_STATUS_LABELS } from "@/domain/enums";
import { formatDate, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { FollowUpData } from "../portfolio-service";
import { MetricList } from "./metric-list";

function Unavailable({ children = "Informação indisponível no momento. Tente novamente mais tarde." }: { children?: ReactNode }) {
  return <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-sm text-muted-foreground">{children}</p>;
}

function Empty({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
      <span aria-hidden="true" className="text-slate-400 [&_svg]:size-5">
        {icon}
      </span>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * Intakes by step. Each linked figure opens `/entrada?status=<status>`, which lists exactly
 * that many intakes; "Em processamento" groups three steps and has no single list (no link).
 * Without `intake:manage` (the permission of `/entrada`) the figures are shown without links.
 */
export function IntakeCard({ data, canOpenIntake }: { data: FollowUpData; canOpenIntake: boolean }) {
  const s = data.intake;
  if (s.status === "forbidden") return null;
  const href = (status: string) => (canOpenIntake ? `/entrada?status=${status}` : undefined);
  return (
    <Card className="flex min-w-0 flex-col">
      <CardHeader
        actions={
          canOpenIntake ? (
            <ButtonLink href="/entrada" variant="outline" size="sm">
              Entrada
            </ButtonLink>
          ) : null
        }
      >
        <CardTitle className="flex items-center gap-2 text-base">
          <Inbox aria-hidden="true" className="size-4 text-muted-foreground" />
          Entrada de processos
        </CardTitle>
        <CardDescription>Etapas: recebido, responsável, análise preliminar (simulada), aviso e revisão do advogado.</CardDescription>
      </CardHeader>
      <CardContent>
        {s.status === "error" ? (
          <Unavailable />
        ) : (
          <MetricList
            label="Entradas de processos por etapa"
            items={[
              { key: "received", label: "Recebidos", hint: "Aguardando distribuição", value: s.data.received, href: href("received"), tone: "info" },
              {
                key: "progress",
                label: "Em processamento",
                hint: "Responsável definido, análise em geração ou aviso pendente",
                value: s.data.inProgress,
                tone: "info",
              },
              {
                key: "notified",
                label: "Aguardando revisão do advogado",
                hint: "Aviso enviado (e-mail simulado), revisão não iniciada",
                value: s.data.notified,
                href: href("notified"),
                tone: "warning",
              },
              { key: "in_review", label: "Em revisão pelo advogado", value: s.data.inReview, href: href("in_review"), tone: "warning" },
              { key: "approved", label: "Análise aprovada", value: s.data.approved, href: href("approved"), tone: "success" },
              { key: "failed", label: "Com falha", value: s.data.failed, href: href("failed"), tone: "danger" },
            ]}
          />
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------

export function AlertGroupsCard({ data }: { data: FollowUpData }) {
  const a = data.alerts;
  const groups = a.groups.filter((g) => g.total > 0);
  return (
    <Card className="flex min-w-0 flex-col">
      <CardHeader
        actions={
          <ButtonLink href="/alertas" variant="outline" size="sm">
            Alertas
          </ButtonLink>
        }
      >
        <CardTitle className="flex items-center gap-2 text-base">
          <BellRing aria-hidden="true" className="size-4 text-muted-foreground" />
          Alertas abertos
        </CardTitle>
        <CardDescription>
          {formatNumber(a.total)} {a.total === 1 ? "alerta aberto" : "alertas abertos"}
          {a.critical > 0 ? `, ${formatNumber(a.critical)} ${a.critical === 1 ? "crítico" : "críticos"}` : ""}.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {groups.length === 0 ? (
          <Empty icon={<BellRing />}>Nenhum alerta aberto.</Empty>
        ) : (
          <ul className="space-y-3" aria-label="Alertas abertos por grupo">
            {groups.map((g) => (
              <li key={g.key}>
                <p className="flex items-center justify-between gap-2 text-sm font-medium text-slate-900">
                  <span>{g.label}</span>
                  <span className="flex items-center gap-1.5 tabular-nums">
                    {g.critical > 0 ? (
                      <Badge tone="danger" dot className="px-1.5 py-0 text-[11px] leading-4">
                        {formatNumber(g.critical)} {g.critical === 1 ? "crítico" : "críticos"}
                      </Badge>
                    ) : null}
                    {formatNumber(g.total)}
                  </span>
                </p>
                <ul className="mt-1 space-y-0.5">
                  {g.types.map((t) => (
                    <li key={t.type}>
                      <Link
                        href={`/alertas?tipo=${t.type}&situacao=abertos`}
                        className="-mx-1 flex items-center justify-between gap-2 rounded px-1 py-0.5 text-xs text-slate-700 hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-ring"
                      >
                        <span className="min-w-0 truncate">{t.label}</span>
                        <span className="tabular-nums">{formatNumber(t.count)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------

const BRIEFS_HREF = {
  ready_for_review: "/analises-preliminares?status=ready_for_review",
  in_review: "/analises-preliminares?status=in_review",
} as const;

/**
 * Preliminary analyses awaiting review (latest version of each process). The total is split
 * by status, each part linking to the list of that status, which shows exactly that many.
 */
export function BriefsAwaitingCard({ data }: { data: FollowUpData }) {
  const s = data.briefs;
  if (s.status === "forbidden") return null;
  return (
    <Card className="flex min-w-0 flex-col">
      <CardHeader
        actions={
          <ButtonLink href={BRIEFS_HREF.ready_for_review} variant="outline" size="sm">
            Revisar
          </ButtonLink>
        }
      >
        <CardTitle className="flex items-center gap-2 text-base">
          <FileSearch aria-hidden="true" className="size-4 text-muted-foreground" />
          Análises preliminares a revisar
        </CardTitle>
        <CardDescription>Geradas por simulação demonstrativa (sem IA real); exigem revisão do advogado.</CardDescription>
      </CardHeader>
      <CardContent>
        {s.status === "error" ? (
          <Unavailable />
        ) : s.data.total === 0 ? (
          <Empty icon={<FileSearch />}>Nenhuma análise preliminar aguardando revisão.</Empty>
        ) : (
          <>
            <p className="text-2xl font-semibold tracking-tight text-slate-900 tabular-nums">
              {formatNumber(s.data.total)}
              <span className="ml-1.5 text-sm font-normal text-muted-foreground">aguardando revisão</span>
            </p>
            <ul className="mt-1 mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label="Análises a revisar por situação">
              {(
                [
                  ["ready_for_review", s.data.readyForReview],
                  ["in_review", s.data.inReview],
                ] as const
              ).map(([status, n]) => (
                <li key={status}>
                  <Link
                    href={BRIEFS_HREF[status]}
                    className="inline-flex items-center gap-0.5 font-medium text-primary-700 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    {CASE_BRIEF_STATUS_LABELS[status]}: {formatNumber(n)}
                    <ChevronRight aria-hidden="true" className="size-3.5" />
                  </Link>
                </li>
              ))}
            </ul>
            <ul className="divide-y divide-border" aria-label="Análises preliminares mais antigas aguardando revisão">
              {s.data.items.map((b) => (
                <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="min-w-0">
                    <Link
                      href={`/analises-preliminares/${b.id}`}
                      className="text-sm font-medium text-primary-700 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      {b.processNumber}
                    </Link>
                    <span className="block text-xs text-muted-foreground">
                      {CASE_BRIEF_STATUS_LABELS[b.status]}
                      {b.generatedAt ? ` · gerada em ${formatDate(b.generatedAt)}` : ""}
                    </span>
                  </span>
                  {b.mode === "demo" ? (
                    <Badge tone="warning" className={cn("px-1.5 py-0 text-[11px] leading-4")}>
                      Simulação
                    </Badge>
                  ) : null}
                </li>
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}
