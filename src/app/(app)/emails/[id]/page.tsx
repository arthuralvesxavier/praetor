import { ExternalLink, Gavel, Inbox, Mail, ScrollText, Send } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DescriptionList } from "@/components/ui/description-list";
import { PageHeader } from "@/components/ui/page-header";
import { StatusBadge } from "@/components/ui/status-badge";
import { Timeline } from "@/components/ui/timeline";
import { EMAIL_MODE_LABELS, EMAIL_STATUS_LABELS, EMAIL_TEMPLATE_LABELS, ENTITY_TYPE_LABELS } from "@/domain/enums";
import { formatDateTime } from "@/lib/format";
import { resendEmailAction } from "@/modules/emails/actions";
import { EmailBodyViewer } from "@/modules/emails/components/email-body-viewer";
import { EmailStatusBadge } from "@/modules/emails/components/email-status-badge";
import { emailEventTone, SIMULATED_EMAIL_BANNER } from "@/modules/emails/labels";
import { getEmail, type EmailDetail } from "@/modules/emails/service";
import { can } from "@/server/auth/permissions";
import { requirePageContext } from "@/server/auth/session";
import { NotFoundError } from "@/server/lib/errors";

export const metadata: Metadata = { title: "E-mail simulado" };

const linkClasses = "inline-flex items-center gap-1.5 font-medium text-primary-700 underline-offset-2 hover:underline";

export default async function EmailDetailPage(props: PageProps<"/emails/[id]">) {
  const ctx = await requirePageContext("email:read");
  const { id } = await props.params;

  let email: EmailDetail;
  try {
    email = await getEmail(ctx, id);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
  const canResend = can(ctx, "email:send") && email.toUserId !== null;

  return (
    <>
      <PageHeader
        title={email.subject}
        description={EMAIL_TEMPLATE_LABELS[email.template]}
        breadcrumbs={[
          { label: "Painel executivo", href: "/dashboard" },
          { label: "Central de e-mails", href: "/emails" },
          { label: "Mensagem" },
        ]}
        meta={
          <div className="flex flex-wrap items-center gap-2">
            <EmailStatusBadge status={email.status} />
            <Badge tone="warning" icon={<Mail />}>
              {email.mode === "simulated" ? "Envio simulado" : "Envio real"}
            </Badge>
            {email.resendOfId ? <Badge tone="primary">Cópia de reenvio</Badge> : null}
          </div>
        }
        actions={
          canResend ? (
            <ConfirmDialog
              action={resendEmailAction}
              hiddenFields={{ id: email.id }}
              tone="primary"
              trigger={
                <Button type="button" variant="outline">
                  <Send aria-hidden="true" />
                  Reenviar (simulação)
                </Button>
              }
              title="Reenviar este e-mail (simulação)?"
              description={`Uma cópia será registrada para ${email.toName}. Nenhuma mensagem é entregue: o reenvio também é simulado.`}
              confirmLabel="Reenviar (simulação)"
              pendingLabel="Reenviando…"
            />
          ) : null
        }
      />

      <Callout tone="warning" title={SIMULATED_EMAIL_BANNER} className="mb-6">
        Esta mensagem foi gerada e registrada apenas para demonstração. Nenhum servidor de e-mail foi contatado.
      </Callout>

      {email.status === "failed" && email.errorMessage ? (
        <Callout tone="danger" title="A geração deste envio falhou" className="mb-6">
          {email.errorMessage}
        </Callout>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Cabeçalho</CardTitle>
            </CardHeader>
            <CardContent>
              <DescriptionList
                items={[
                  { label: "De", value: <Address name={email.fromName} address={email.fromAddress} /> },
                  { label: "Para", value: <Address name={email.toName} address={email.toAddress} /> },
                  { label: "Assunto", value: email.subject, full: true },
                  { label: "Gerado em", value: formatDateTime(email.createdAt) },
                  { label: "Entrega simulada em", value: email.sentAt ? formatDateTime(email.sentAt) : "Não concluída" },
                  { label: "Modo", value: EMAIL_MODE_LABELS[email.mode] },
                  { label: "Situação", value: EMAIL_STATUS_LABELS[email.status] },
                  { label: "Modelo", value: EMAIL_TEMPLATE_LABELS[email.template] },
                  {
                    label: "Origem",
                    value: email.triggeredById ? `Gerado por ${email.triggeredByName ?? "usuário"}` : "Rotina automática do sistema",
                  },
                  {
                    label: "Identificador do provedor",
                    value: email.providerMessageId ? (
                      <span className="font-mono text-xs break-all">{email.providerMessageId}</span>
                    ) : null,
                  },
                  { label: "Provedor", value: email.provider === "simulated" ? "Simulado (sem entrega)" : email.provider },
                ]}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Conteúdo</CardTitle>
              <CardDescription>Exatamente como foi gerado. O cabeçalho da mensagem identifica a simulação.</CardDescription>
            </CardHeader>
            <CardContent>
              <EmailBodyViewer html={email.bodyHtml} text={email.bodyText} subject={email.subject} />
            </CardContent>
          </Card>
        </div>

        <div className="flex min-w-0 flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle as="h3">Vínculos</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="flex flex-col gap-3 text-sm">
                <li>
                  <p className="text-xs font-medium text-muted-foreground">Processo</p>
                  {email.process ? (
                    <Link href={`/processos/${email.process.id}`} className={linkClasses}>
                      <Gavel aria-hidden="true" className="size-4 shrink-0" />
                      <span className="min-w-0">
                        <span className="font-mono text-xs">{email.process.number}</span>
                        <span className="block text-xs font-normal text-slate-600">{email.process.title}</span>
                      </span>
                    </Link>
                  ) : email.processId ? (
                    <span className="text-muted-foreground">Processo vinculado (sem acesso)</span>
                  ) : (
                    <span className="text-muted-foreground">Nenhum</span>
                  )}
                </li>
                <li>
                  <p className="text-xs font-medium text-muted-foreground">Análise preliminar</p>
                  {email.briefId && email.briefVisible ? (
                    <Link href={`/analises-preliminares/${email.briefId}`} className={linkClasses}>
                      <ScrollText aria-hidden="true" className="size-4 shrink-0" />
                      Abrir análise preliminar
                    </Link>
                  ) : email.briefId ? (
                    <span className="text-muted-foreground">Análise vinculada (sem acesso)</span>
                  ) : (
                    <span className="text-muted-foreground">Nenhuma</span>
                  )}
                </li>
                <li>
                  <p className="text-xs font-medium text-muted-foreground">Entrada do processo</p>
                  {email.intakeId && email.intakeVisible ? (
                    <Link href={`/entrada/${email.intakeId}`} className={linkClasses}>
                      <Inbox aria-hidden="true" className="size-4 shrink-0" />
                      Abrir entrada
                    </Link>
                  ) : email.intakeId ? (
                    <span className="text-muted-foreground">Entrada vinculada (sem acesso)</span>
                  ) : (
                    <span className="text-muted-foreground">Nenhuma</span>
                  )}
                </li>
                {email.entityType && email.entityType !== "legal_process" ? (
                  <li>
                    <p className="text-xs font-medium text-muted-foreground">Registro de origem</p>
                    <span className="text-slate-800">{ENTITY_TYPE_LABELS[email.entityType]}</span>
                  </li>
                ) : null}
                {email.resendOfId ? (
                  <li>
                    <p className="text-xs font-medium text-muted-foreground">Mensagem original</p>
                    <Link href={`/emails/${email.resendOfId}`} className={linkClasses}>
                      <Mail aria-hidden="true" className="size-4 shrink-0" />
                      Abrir mensagem original
                    </Link>
                  </li>
                ) : null}
                {email.linkUrl ? (
                  <li>
                    <p className="text-xs font-medium text-muted-foreground">Endereço do botão do e-mail</p>
                    <span className="inline-flex items-start gap-1.5 font-mono text-xs break-all text-slate-700">
                      <ExternalLink aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                      {email.linkUrl}
                    </span>
                  </li>
                ) : null}
              </ul>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle as="h3">Histórico de eventos</CardTitle>
            </CardHeader>
            <CardContent>
              <Timeline
                emptyMessage="Nenhum evento registrado."
                items={[...email.events].reverse().map((e) => ({
                  id: e.id,
                  date: e.createdAt,
                  title: e.label,
                  badge: <StatusBadge label={eventBadge(e.type)} tone={emailEventTone(e.type)} />,
                  description: e.detail ?? undefined,
                  meta: (
                    <>
                      {e.actorName ? `Por ${e.actorName}` : "Pelo sistema"}
                      {e.relatedEmailId ? (
                        <>
                          {" · "}
                          <Link href={`/emails/${e.relatedEmailId}`} className="font-medium text-primary-700 underline-offset-2 hover:underline">
                            {e.type === "resent" ? "Abrir cópia" : "Abrir original"}
                          </Link>
                        </>
                      ) : null}
                    </>
                  ),
                }))}
              />
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}

function Address({ name, address }: { name: string; address: string }) {
  return (
    <span>
      <span className="block text-slate-900">{name}</span>
      <span className="block font-mono text-xs break-all text-muted-foreground">{address}</span>
    </span>
  );
}

function eventBadge(type: string): string {
  switch (type) {
    case "composed":
      return "Gerada";
    case "simulated_delivery":
      return "Simulada";
    case "viewed":
      return "Lida";
    case "failed":
      return "Falha";
    case "resent":
      return "Reenvio";
    default:
      return "Evento";
  }
}
