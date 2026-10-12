"use client";

import { Mail } from "lucide-react";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { FormField } from "@/components/ui/form-field";
import { FormMessage } from "@/components/ui/form-message";
import { Input } from "@/components/ui/input";
import { fieldError, type FormState } from "@/lib/form";
import type { EmailIntakeSettingsInput } from "../schemas";
import { PendingButton, useAdminForm, type FormAction } from "./form-utils";

/** Simulated e-mail (sender and notifications) and the process intake pipeline switches. */
export function EmailIntakeSettingsForm<S extends FormState>({
  action,
  defaults,
}: {
  action: FormAction<S>;
  defaults: Required<EmailIntakeSettingsInput>;
}) {
  const { state, formAction, pending, onSubmit } = useAdminForm(action);
  const err = (f: string) => fieldError(state, f);

  return (
    <form action={formAction} onSubmit={onSubmit} className="flex flex-col gap-6" noValidate>
      <FormMessage state={state} />
      <Card>
        <CardHeader>
          <CardTitle id="email-titulo" className="flex items-center gap-2">
            <Mail aria-hidden="true" className="size-4 text-muted-foreground" />
            E-mail
          </CardTitle>
          <CardDescription>Remetente exibido nas mensagens e quais notificações o sistema gera.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <Callout tone="warning" title="Envio simulado: nenhuma mensagem é enviada">
            Nesta versão os e-mails são apenas gerados e guardados na Central de e-mails para consulta. Nenhum servidor de
            e-mail é contatado e nenhuma mensagem sai do sistema.
          </Callout>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Modo de envio" htmlFor="email-mode" hint="Não pode ser alterado nesta versão.">
              <Input value="Simulado (fixo nesta versão)" readOnly disabled />
            </FormField>
            <div className="hidden sm:block" aria-hidden="true" />
            <FormField label="Nome do remetente" htmlFor="senderName" required error={err("senderName")}>
              <Input name="senderName" defaultValue={defaults.senderName} maxLength={80} required />
            </FormField>
            <FormField
              label="Endereço do remetente (fictício)"
              htmlFor="senderAddress"
              required
              error={err("senderAddress")}
              hint="Use um domínio reservado, que nunca entrega e-mails (ex.: nao-responda@empresa.invalid)."
            >
              <Input name="senderAddress" type="email" defaultValue={defaults.senderAddress} maxLength={254} required />
            </FormField>
          </div>
          <fieldset className="grid gap-3">
            <legend className="mb-1 text-sm font-medium text-slate-800">Notificações geradas (simuladas)</legend>
            <Checkbox
              name="notifyOnBriefReady"
              label="Avisar o advogado quando a análise preliminar ficar pronta"
              description="Gera o e-mail simulado “Análise preliminar disponível” com o link para a revisão."
              defaultChecked={defaults.notifyOnBriefReady}
            />
            <Checkbox
              name="notifyOnAssignment"
              label="Avisar o advogado quando um processo for atribuído a ele"
              description="Gera o e-mail simulado “Novo processo atribuído” quando a entrada define o responsável e quando o responsável é trocado em Distribuição. A distribuição em lote após uma importação não gera esse e-mail, e ninguém recebe aviso da atribuição que ele mesmo fez."
              defaultChecked={defaults.notifyOnAssignment}
            />
          </fieldset>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle id="entrada-titulo">Entrada de processos</CardTitle>
          <CardDescription>
            Etapas automáticas executadas quando um novo processo é registrado na entrada: distribuição, análise preliminar
            (simulada) e aviso ao advogado (e-mail simulado). Com uma etapa desligada, ela fica pendente para ação manual.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <Checkbox
            name="autoAssign"
            label="Definir o responsável automaticamente"
            description="Aplica as regras de distribuição e, sem regra aplicável, a menor carga de trabalho."
            defaultChecked={defaults.autoAssign}
          />
          <Checkbox
            name="autoGenerateBrief"
            label="Gerar a análise preliminar automaticamente"
            description="Simulação demonstrativa: lê os documentos do processo e monta a análise para revisão do advogado. Não é IA real."
            defaultChecked={defaults.autoGenerateBrief}
          />
          <Checkbox
            name="autoNotify"
            label="Notificar o advogado automaticamente ao fim da entrada"
            description="Gera o e-mail simulado ao responsável quando a análise preliminar estiver pronta."
            defaultChecked={defaults.autoNotify}
          />
        </CardContent>
      </Card>

      <div>
        <PendingButton pending={pending}>Salvar e-mail e entrada de processos</PendingButton>
      </div>
    </form>
  );
}
