import { MailCheck, MailWarning, Send } from "lucide-react";
import type { Metadata } from "next";
import { Callout } from "@/components/ui/callout";
import { Card } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FilterBar, FilterSelect } from "@/components/ui/filter-bar";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { EMAIL_TEMPLATES, EMAIL_TEMPLATE_LABELS } from "@/domain/enums";
import { formatNumber } from "@/lib/format";
import { optionsFromLabels } from "@/lib/options";
import { enumParam, hasAnyParam, idParam, pageParam } from "@/lib/search-params";
import { sendDailyDigestAction } from "@/modules/emails/actions";
import { EmailsTable } from "@/modules/emails/components/emails-table";
import { EMAIL_CENTER_NOTICE } from "@/modules/emails/labels";
import { listEmailFilterOptions, listEmails } from "@/modules/emails/service";
import { getEmailRuntimeInfo } from "@/server/integrations/email";
import { can } from "@/server/auth/permissions";
import { requirePageContext } from "@/server/auth/session";

export const metadata: Metadata = { title: "Central de e-mails" };

const FILTER_KEYS = ["modelo", "destinatario", "processo"] as const;

export default async function EmailsPage(props: PageProps<"/emails">) {
  const ctx = await requirePageContext("email:read");
  const sp = await props.searchParams;

  const template = enumParam(sp, "modelo", EMAIL_TEMPLATES);
  const toUserId = idParam(sp, "destinatario");
  const processId = idParam(sp, "processo");

  const [result, options] = await Promise.all([
    listEmails(ctx, { template, toUserId, processId, page: pageParam(sp) }),
    listEmailFilterOptions(ctx),
  ]);
  const runtime = getEmailRuntimeInfo();
  const canSend = can(ctx, "email:send");
  const filtered = hasAnyParam(sp, FILTER_KEYS);

  // Keep a selected process/recipient selectable even when it has no visible message yet.
  const processOptions = options.processes.map((p) => ({ value: p.id, label: `${p.number} — ${p.title}` }));
  if (processId && !processOptions.some((o) => o.value === processId)) {
    processOptions.unshift({ value: processId, label: "Processo selecionado" });
  }

  return (
    <>
      <PageHeader
        title="Central de e-mails"
        description="Avisos gerados pelo sistema (análise preliminar, atribuição, prazos, audiências e resumo diário)."
        breadcrumbs={[{ label: "Dashboard", href: "/dashboard" }, { label: "Central de e-mails" }]}
        actions={
          canSend ? (
            <ConfirmDialog
              action={sendDailyDigestAction}
              tone="primary"
              triggerLabel="Gerar resumo diário (simulação)"
              title="Gerar resumo diário (simulação)?"
              description="Será registrado um e-mail simulado para você com as contagens de alertas, prazos, audiências e análises preliminares que você pode acessar. Nenhuma mensagem é entregue."
              confirmLabel="Gerar resumo"
              pendingLabel="Gerando…"
            />
          ) : null
        }
      />

      <Callout tone="warning" title={EMAIL_CENTER_NOTICE} className="mb-6">
        Modo de envio: <strong>{runtime.mode === "simulated" ? "simulado" : "real"}</strong> (provedor “{runtime.provider}”).
        Os textos são gerados a partir dos registros do sistema; abra uma mensagem para ver a versão HTML, a versão em
        texto e o histórico de eventos.
      </Callout>

      <FilterBar basePath="/emails" search={false} showClear={filtered}>
        <FilterSelect name="modelo" label="Modelo" options={optionsFromLabels(EMAIL_TEMPLATE_LABELS)} defaultValue={template} />
        <FilterSelect
          name="destinatario"
          label="Destinatário"
          options={options.recipients.map((r) => ({ value: r.id, label: r.name }))}
          defaultValue={toUserId}
        />
        <FilterSelect name="processo" label="Processo" options={processOptions} defaultValue={processId} />
      </FilterBar>

      <p className="mb-2 text-sm text-muted-foreground" aria-live="polite">
        {result.total === 0
          ? "Nenhuma mensagem."
          : `${formatNumber(result.total)} ${result.total === 1 ? "mensagem simulada" : "mensagens simuladas"}`}
      </p>

      <Card className="py-0">
        <EmailsTable
          items={result.items}
          emptyMessage={filtered ? "Nenhum e-mail encontrado com esses filtros." : "Nenhum e-mail simulado registrado."}
          emptyDescription={
            filtered
              ? "Ajuste ou limpe os filtros para ver outras mensagens."
              : canSend
                ? "Os avisos aparecem aqui quando o sistema os gera. Você também pode gerar o seu resumo diário."
                : "Os avisos aparecem aqui quando o sistema os gera para você ou para processos que você acompanha."
          }
          emptyAction={
            !filtered && canSend ? (
              <ConfirmDialog
                action={sendDailyDigestAction}
                tone="primary"
                triggerLabel="Gerar resumo diário (simulação)"
                triggerSize="sm"
                title="Gerar resumo diário (simulação)?"
                description="Será registrado um e-mail simulado para você com as suas contagens de pendências. Nenhuma mensagem é entregue."
                confirmLabel="Gerar resumo"
                pendingLabel="Gerando…"
              />
            ) : undefined
          }
        />
      </Card>

      <Pagination page={result.page} pageSize={result.pageSize} total={result.total} basePath="/emails" searchParams={sp} />

      <div className="mt-6 grid gap-3 text-xs text-muted-foreground sm:grid-cols-3">
        <p className="flex items-start gap-2">
          <Send aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          Assunto sempre iniciado por “[Simulação]”.
        </p>
        <p className="flex items-start gap-2">
          <MailCheck aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          “Simulado”: mensagem gerada e registrada, sem entrega real.
        </p>
        <p className="flex items-start gap-2">
          <MailWarning aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          “Falha”: a geração não foi concluída; é possível reenviar.
        </p>
      </div>
    </>
  );
}
