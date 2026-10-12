import { FileSearch, FileText, Mail, RefreshCw, Route, Scale, Sparkles } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ButtonLink } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DescriptionList } from "@/components/ui/description-list";
import { PageHeader } from "@/components/ui/page-header";
import { StatusBadge } from "@/components/ui/status-badge";
import { Timeline } from "@/components/ui/timeline";
import {
  ASSIGNMENT_METHOD_LABELS,
  DOCUMENT_CATEGORY_LABELS,
  INTAKE_STATUS_LABELS,
  LEGAL_AREA_LABELS,
  PROCESS_INSTANCE_LABELS,
  PROCESS_PHASE_LABELS,
  TEXT_EXTRACTION_STATUS_LABELS,
} from "@/domain/enums";
import { formatDateTime, formatMoneyCents } from "@/lib/format";
import { TEXT_EXTRACTION_STATUS_TONES } from "@/lib/tones";
import { InlineAction } from "@/modules/distribution/components/inline-action";
import { ManualAssignForm } from "@/modules/distribution/components/manual-assign-form";
import { listAssignableUsers } from "@/modules/distribution/service";
import {
  assignIntakeAction,
  autoAssignIntakeAction,
  regenerateIntakeBriefAction,
  resendIntakeEmailAction,
  retryIntakeAction,
} from "@/modules/intake/actions";
import { AutoRefresh } from "@/modules/intake/components/auto-refresh";
import { IntakeSourceBadge, IntakeStatusBadge } from "@/modules/intake/components/intake-badges";
import { IntakeStepper } from "@/modules/intake/components/intake-stepper";
import { getIntake, type IntakeDetail } from "@/modules/intake/service";
import { SIMULATION_LABEL } from "@/modules/intake/simulation";
import type { StageKey } from "@/modules/intake/status";
import { requirePageContext } from "@/server/auth/session";
import { NotFoundError } from "@/server/lib/errors";

export const metadata: Metadata = { title: "Entrada de processo" };

export default async function IntakeDetailPage(props: PageProps<"/entrada/[id]">) {
  const ctx = await requirePageContext("process:read");
  const { id } = await props.params;
  let intake: IntakeDetail;
  try {
    intake = await getIntake(ctx, id);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
  const p = intake.process;
  const perms = intake.permissions;
  const users = perms.canAssign ? await listAssignableUsers(ctx) : [];
  const userOptions = users
    .filter((u) => u.id !== intake.assignedToId)
    .map((u) => ({ value: u.id, label: `${u.name} — ${u.roleLabel}${u.unitName ? ` · ${u.unitName}` : ""}` }));

  const briefHref = `/processos/${p.id}?aba=analise-preliminar`;
  const links: Partial<Record<StageKey, { href: string; label: string }>> = {
    received: { href: `/processos/${p.id}`, label: "Abrir o processo" },
  };
  if (intake.brief) {
    links.analysis = { href: briefHref, label: `Ver a análise preliminar (versão ${intake.brief.version})` };
    links.review = { href: `/analises-preliminares/${intake.brief.id}`, label: "Abrir a revisão da análise" };
    links.approval = { href: `/analises-preliminares/${intake.brief.id}`, label: "Abrir a análise" };
  }
  if (intake.email) links.email = { href: `/emails/${intake.email.id}`, label: "Ver o e-mail simulado" };

  const finished = intake.effectiveStatus === "approved" || intake.status === "cancelled";
  const pendingWork = !intake.assignedToId || !intake.hasBrief || !intake.emailSent;
  const showRetry = perms.canProcess && !intake.processing && !finished && (intake.status === "failed" || pendingWork);
  const history = [...intake.steps].reverse().map((s, index) => ({
    id: `${s.at}-${index}`,
    date: new Date(s.at),
    title: INTAKE_STATUS_LABELS[s.status],
    description: s.detail,
    meta: s.actorName ?? undefined,
  }));

  return (
    <>
      <PageHeader
        title={
          <span className="font-mono text-lg sm:text-xl">
            Entrada {p.number}
          </span>
        }
        description={p.title}
        breadcrumbs={[
          { label: "Dashboard", href: "/dashboard" },
          { label: "Entrada de processos", href: "/entrada" },
          { label: p.number },
        ]}
        meta={
          <>
            <IntakeStatusBadge status={intake.effectiveStatus} />
            <IntakeSourceBadge source={intake.source} />
            <span className="text-xs text-muted-foreground">Recebido em {formatDateTime(intake.receivedAt)}</span>
          </>
        }
        actions={
          <>
            <ButtonLink href={`/processos/${p.id}`} variant="outline">
              <Scale aria-hidden="true" />
              Abrir processo
            </ButtonLink>
            {intake.brief ? (
              <ButtonLink href={briefHref}>
                <FileSearch aria-hidden="true" />
                Análise preliminar
              </ButtonLink>
            ) : null}
          </>
        }
      />

      <div className="mb-4 grid gap-3">
        {intake.source === "simulated_feed" ? (
          <Callout tone="warning" title={SIMULATION_LABEL}>
            Este processo, suas partes, valores e documentos foram gerados pela demonstração. Não correspondem a um caso real
            e nenhum tribunal foi consultado.
          </Callout>
        ) : null}
        <Callout tone="info" title="Simulação nesta versão">
          A leitura dos documentos e a análise preliminar são simuladas (regras determinísticas, sem inteligência artificial
          real). O e-mail ao advogado é simulado: o conteúdo fica na Central de e-mails e nenhuma mensagem é enviada.
        </Callout>
        <AutoRefresh active={intake.processing} />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="grid min-w-0 gap-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle as="h2">Andamento</CardTitle>
              <CardDescription>Recebido → Responsável → Leitura e análise (simulação) → E-mail (simulado) → Revisão → Aprovação.</CardDescription>
            </CardHeader>
            <CardContent>
              <IntakeStepper stages={intake.stages} links={links} animate={intake.processing} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle as="h2">Histórico do processamento</CardTitle>
              <CardDescription>Cada etapa registra data, hora e quem a executou. Nenhum conteúdo de documento é registrado aqui.</CardDescription>
            </CardHeader>
            <CardContent>
              <Timeline items={history} emptyMessage="Nenhuma etapa registrada." />
            </CardContent>
          </Card>
        </div>

        <div className="grid min-w-0 content-start gap-6">
          {perms.canAssign || perms.canProcess || perms.canGenerateBrief || perms.canResendEmail ? (
            <Card>
              <CardHeader>
                <CardTitle as="h2">Ações</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-4">
                {showRetry ? (
                  <div>
                    <InlineAction
                      action={retryIntakeAction}
                      hiddenFields={{ intakeId: intake.id }}
                      variant={intake.status === "failed" ? "primary" : "outline"}
                      size="md"
                      pendingLabel="Agendando…"
                      showSuccess
                    >
                      <RefreshCw aria-hidden="true" />
                      {intake.status === "failed" ? "Reprocessar etapa com falha" : "Continuar processamento automático"}
                    </InlineAction>
                  </div>
                ) : null}
                {perms.canAssign && !intake.assignedToId ? (
                  <div>
                    <InlineAction
                      action={autoAssignIntakeAction}
                      hiddenFields={{ intakeId: intake.id }}
                      size="md"
                      pendingLabel="Distribuindo…"
                      showSuccess
                    >
                      <Route aria-hidden="true" />
                      Distribuir pelas regras
                    </InlineAction>
                  </div>
                ) : null}
                {perms.canGenerateBrief && intake.assignedToId && !finished ? (
                  <div>
                    <InlineAction
                      action={regenerateIntakeBriefAction}
                      hiddenFields={{ intakeId: intake.id }}
                      size="md"
                      pendingLabel="Gerando análise (simulação)…"
                      showSuccess
                    >
                      <Sparkles aria-hidden="true" />
                      {intake.hasBrief ? "Gerar nova versão da análise (simulação)" : "Gerar análise preliminar (simulação)"}
                    </InlineAction>
                  </div>
                ) : null}
                {perms.canResendEmail && intake.brief && intake.assignedToId ? (
                  <div>
                    <InlineAction
                      action={resendIntakeEmailAction}
                      hiddenFields={{ intakeId: intake.id }}
                      size="md"
                      pendingLabel="Gerando e-mail simulado…"
                      showSuccess
                    >
                      <Mail aria-hidden="true" />
                      {intake.emailSent ? "Reenviar e-mail (simulado)" : "Enviar e-mail (simulado)"}
                    </InlineAction>
                  </div>
                ) : null}
                {perms.canAssign ? (
                  <div className="border-t border-border pt-4">
                    <h3 className="mb-2 text-sm font-semibold text-slate-900">
                      {intake.assignedToId ? "Reatribuir responsável" : "Atribuir manualmente"}
                    </h3>
                    {userOptions.length > 0 ? (
                      <ManualAssignForm
                        action={assignIntakeAction}
                        hiddenFields={{ intakeId: intake.id }}
                        users={userOptions}
                        submitLabel={intake.assignedToId ? "Reatribuir" : "Atribuir"}
                      />
                    ) : (
                      <p className="text-sm text-muted-foreground">Nenhum outro advogado ativo disponível.</p>
                    )}
                  </div>
                ) : null}
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle as="h2">Distribuição</CardTitle>
            </CardHeader>
            <CardContent>
              <DescriptionList
                columns={1}
                items={[
                  { label: "Responsável", value: intake.assignedToName ?? "Aguardando distribuição" },
                  { label: "Critério", value: intake.assignmentMethod ? ASSIGNMENT_METHOD_LABELS[intake.assignmentMethod] : null },
                  intake.ruleName ? { label: "Regra aplicada", value: intake.ruleName } : null,
                  intake.assignedLawFirmName ? { label: "Escritório externo", value: intake.assignedLawFirmName } : null,
                  intake.assignedUnitName ? { label: "Unidade", value: intake.assignedUnitName } : null,
                  { label: "Motivo", value: intake.assignmentReason },
                ]}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle as="h2">Processo</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3">
              {p.needsVerification ? (
                <Callout tone="warning" title="Marcado para verificação">
                  {p.verificationNote ?? "Confira os dados do processo."}
                </Callout>
              ) : null}
              <DescriptionList
                columns={1}
                items={[
                  { label: "Tribunal", value: [p.court, p.courtDivision].filter(Boolean).join(" · ") },
                  { label: "Cidade / UF", value: [p.city, p.state].filter(Boolean).join(" / ") },
                  { label: "Classe", value: p.processClass },
                  { label: "Área / fase", value: `${LEGAL_AREA_LABELS[p.area]} · ${PROCESS_PHASE_LABELS[p.phase]}` },
                  { label: "Instância", value: p.instance ? PROCESS_INSTANCE_LABELS[p.instance] : null },
                  { label: "Empresa", value: p.companyName },
                  { label: "Valor da causa", value: p.claimAmountCents === null ? "Não informado" : formatMoneyCents(p.claimAmountCents) },
                ]}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle as="h2">Documentos recebidos</CardTitle>
              {intake.source === "simulated_feed" ? (
                <CardDescription>Documentos fictícios gerados para a demonstração.</CardDescription>
              ) : null}
            </CardHeader>
            <CardContent>
              {intake.documents.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Nenhum documento visível para você. Envie pela aba{" "}
                  <Link href={`/processos/${p.id}?aba=documentos`} className="font-medium text-primary-700 underline">
                    Documentos do processo
                  </Link>
                  .
                </p>
              ) : (
                <ul className="grid gap-2">
                  {intake.documents.map((d) => (
                    <li key={d.id} className="flex items-start gap-2 text-sm">
                      <FileText aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-slate-500" />
                      <div className="min-w-0">
                        <Link href={`/documentos/${d.id}`} className="font-medium text-primary-700 underline-offset-2 hover:underline">
                          {d.title}
                        </Link>
                        <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                          {DOCUMENT_CATEGORY_LABELS[d.category]}
                          {d.extractionStatus ? (
                            <StatusBadge
                              label={TEXT_EXTRACTION_STATUS_LABELS[d.extractionStatus]}
                              tone={TEXT_EXTRACTION_STATUS_TONES[d.extractionStatus]}
                            />
                          ) : null}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
