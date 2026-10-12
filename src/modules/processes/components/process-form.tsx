"use client";

import Link from "next/link";
import { useActionState, useState, type ReactNode } from "react";
import { ButtonLink } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { FormField } from "@/components/ui/form-field";
import { FormMessage } from "@/components/ui/form-message";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/select";
import { SubmitButton } from "@/components/ui/submit-button";
import { Textarea } from "@/components/ui/textarea";
import {
  LEGAL_AREA_LABELS,
  PROCESS_INSTANCE_LABELS,
  PROCESS_PHASE_LABELS,
  PROCESS_STATUS_LABELS,
  RISK_LEVEL_LABELS,
} from "@/domain/enums";
import { fieldError } from "@/lib/form";
import { optionsFromLabels, type Option } from "@/lib/options";
import { cnjCheck, type ProcessFormDefaults, type ValuesFormState } from "../schemas";
import { STATE_OPTIONS } from "../states";

/** Read-only values maintained by the contingency module (shown in edit mode). */
export type ProcessMirrorValues = {
  liquidated: string;
  provision: string;
  lossProbability: string;
  /** Link to the "Valores e risco" tab. */
  href: string;
};

export type ProcessFormProps<S extends ValuesFormState> = {
  action: (prev: S | null, formData: FormData) => Promise<S>;
  mode: "create" | "edit";
  /** Required in edit mode (sent as hidden field `id`). */
  processId?: string;
  defaults: ProcessFormDefaults;
  units: readonly Option[];
  users: readonly Option[];
  companies: readonly Option[];
  lawFirms: readonly Option[];
  /** False for external counsel: the field is not rendered (their firm is fixed). */
  canChangeLawFirm: boolean;
  /** Shown instead of the select when the law firm cannot be changed. */
  lawFirmLabel?: string | null;
  canEditConfidential: boolean;
  /**
   * False when the process is out of the active portfolio: the status is not
   * sent (use "Reativar" on the process page).
   */
  statusEditable: boolean;
  mirrorValues?: ProcessMirrorValues | null;
  /** When creating from a preventive occurrence. */
  fromOccurrence?: { id: string; title: string } | null;
  cancelHref: string;
};

function Section({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <fieldset className="grid grid-cols-1 gap-4 border-t border-border pt-5 first-of-type:border-t-0 first-of-type:pt-0 sm:grid-cols-2">
      <legend className="sr-only">{title}</legend>
      <div className="sm:col-span-2">
        <h2 aria-hidden="true" className="text-sm font-semibold text-slate-900">
          {title}
        </h2>
        {description ? <p className="mt-0.5 text-xs text-muted-foreground">{description}</p> : null}
      </div>
      {children}
    </fieldset>
  );
}

const areaOptions = optionsFromLabels(LEGAL_AREA_LABELS);
const phaseOptions = optionsFromLabels(PROCESS_PHASE_LABELS);
const activeStatusOptions = optionsFromLabels(PROCESS_STATUS_LABELS, ["active", "suspended"]);
const riskOptions = optionsFromLabels(RISK_LEVEL_LABELS);
const instanceOptions = optionsFromLabels(PROCESS_INSTANCE_LABELS);

function NumberHint({ value }: { value: string }) {
  if (value.trim() === "") return <>Padrão CNJ: NNNNNNN-DD.AAAA.J.TR.OOOO. Outros formatos são aceitos e sinalizados.</>;
  const check = cnjCheck(value);
  if (check === "valid") return <span className="text-emerald-800">Número no padrão CNJ, dígito verificador conferido.</span>;
  if (check === "invalid_check_digit") {
    return (
      <span className="font-medium text-amber-800">
        Atenção: o dígito verificador não confere com o restante do número. Confira nos autos — o cadastro não é
        bloqueado e o número será salvo como informado.
      </span>
    );
  }
  const digits = value.replace(/\D/g, "");
  if (digits.length === 20 && /^[\d.\-\s/]+$/.test(value.trim())) {
    return <span>Os 20 dígitos serão salvos no formato CNJ (NNNNNNN-DD.AAAA.J.TR.OOOO).</span>;
  }
  return (
    <span className="font-medium text-amber-800">
      Fora do padrão CNJ (NNNNNNN-DD.AAAA.J.TR.OOOO). O número será salvo como informado.
    </span>
  );
}

export function ProcessForm<S extends ValuesFormState>({
  action,
  mode,
  processId,
  defaults,
  units,
  users,
  companies,
  lawFirms,
  canChangeLawFirm,
  lawFirmLabel,
  canEditConfidential,
  statusEditable,
  mirrorValues,
  fromOccurrence,
  cancelHref,
}: ProcessFormProps<S>) {
  const [state, formAction] = useActionState(action, null);
  // After a failed submit React resets the form; re-fill it with what was sent.
  const sent = state && !state.ok ? state.values : undefined;
  const val = (key: Exclude<keyof ProcessFormDefaults, "isConfidential">): string =>
    sent ? (sent[key] ?? "") : defaults[key];
  const confidential = sent ? sent.isConfidential === "on" : defaults.isConfidential;

  const [numberDraft, setNumberDraft] = useState<string | null>(null);
  const numberValue = numberDraft ?? val("number");
  const err = (field: string) => fieldError(state, field);

  return (
    <form action={formAction} className="flex flex-col gap-6" noValidate>
      {mode === "edit" && processId ? <input type="hidden" name="id" value={processId} /> : null}
      {fromOccurrence ? <input type="hidden" name="fromOccurrenceId" value={fromOccurrence.id} /> : null}
      <FormMessage state={state} />
      {err("fromOccurrenceId") ? (
        <p role="alert" className="text-sm font-medium text-red-700">
          {err("fromOccurrenceId")}
        </p>
      ) : null}
      {err("closureReason") ? (
        <p role="alert" className="text-sm font-medium text-red-700">
          {err("closureReason")}
        </p>
      ) : null}

      <Section title="Identificação">
        <FormField
          label="Número do processo (CNJ)"
          htmlFor="number"
          required
          error={err("number")}
          hint={<NumberHint value={numberValue} />}
        >
          <Input
            name="number"
            defaultValue={val("number")}
            required
            maxLength={60}
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            placeholder="0000000-00.0000.0.00.0000"
            onChange={(e) => setNumberDraft(e.currentTarget.value)}
          />
        </FormField>
        <FormField
          label="Título"
          htmlFor="title"
          required
          error={err("title")}
          hint="Identificação interna, ex.: “Reclamação trabalhista — ex-colaborador”."
        >
          <Input name="title" defaultValue={val("title")} required maxLength={200} />
        </FormField>
        <FormField label="Área do direito" htmlFor="area" required error={err("area")}>
          <NativeSelect name="area" options={areaOptions} placeholder="Selecione…" defaultValue={val("area")} required />
        </FormField>
        {statusEditable ? (
          <FormField
            label="Situação"
            htmlFor="status"
            required
            error={err("status")}
            hint="Para retirar da carteira ativa (encerramento, arquivamento, perda do patrocínio), use a ação na página do processo."
          >
            <NativeSelect
              name="status"
              options={activeStatusOptions}
              placeholder="Selecione…"
              defaultValue={val("status")}
              required
            />
          </FormField>
        ) : (
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-slate-900">Situação</span>
            <p className="rounded-md border border-border bg-surface-muted px-3 py-2 text-sm text-slate-700">
              {PROCESS_STATUS_LABELS[defaults.status as keyof typeof PROCESS_STATUS_LABELS] ?? defaults.status} — fora da
              carteira ativa. Use “Reativar” na página do processo para trazê-lo de volta.
            </p>
          </div>
        )}
      </Section>

      <Section title="Tribunal e localização" description="Dados da instância atual. Os demais graus ficam na aba “Instâncias”.">
        <FormField label="Tribunal" htmlFor="court" required error={err("court")} hint="Ex.: TRT10, TST, TJSP.">
          <Input name="court" defaultValue={val("court")} required maxLength={120} />
        </FormField>
        <FormField label="Instância atual" htmlFor="instance" error={err("instance")}>
          <NativeSelect name="instance" options={instanceOptions} placeholder="Não informada" defaultValue={val("instance")} />
        </FormField>
        <FormField label="Vara / órgão julgador / turma" htmlFor="courtDivision" error={err("courtDivision")}>
          <Input name="courtDivision" defaultValue={val("courtDivision")} maxLength={200} />
        </FormField>
        <FormField label="Classe processual" htmlFor="processClass" error={err("processClass")} hint="Ex.: ATOrd, ATSum, ROT, AIRR.">
          <Input name="processClass" defaultValue={val("processClass")} maxLength={40} />
        </FormField>
        <FormField label="Cidade" htmlFor="city" error={err("city")}>
          <Input name="city" defaultValue={val("city")} maxLength={120} />
        </FormField>
        <FormField label="UF" htmlFor="state" error={err("state")}>
          <NativeSelect name="state" options={STATE_OPTIONS} placeholder="Não informada" defaultValue={val("state")} />
        </FormField>
        <FormField label="Comarca / jurisdição" htmlFor="jurisdiction" error={err("jurisdiction")}>
          <Input name="jurisdiction" defaultValue={val("jurisdiction")} maxLength={120} />
        </FormField>
      </Section>

      <Section title="Andamento">
        <FormField label="Fase processual" htmlFor="phase" required error={err("phase")}>
          <NativeSelect name="phase" options={phaseOptions} placeholder="Selecione…" defaultValue={val("phase")} required />
        </FormField>
        <FormField
          label="Detalhe da fase"
          htmlFor="phaseDetail"
          error={err("phaseDetail")}
          hint="Texto livre, como consta na planilha ou nos autos (ex.: “Execução — aguardando cálculos”)."
        >
          <Input name="phaseDetail" defaultValue={val("phaseDetail")} maxLength={500} />
        </FormField>
        <FormField label="Data de ajuizamento / distribuição" htmlFor="filedAt" error={err("filedAt")}>
          <Input name="filedAt" type="date" defaultValue={val("filedAt")} />
        </FormField>
        <FormField
          label="Última movimentação"
          htmlFor="lastMovementAt"
          error={err("lastMovementAt")}
          hint="Atualizada também ao registrar uma movimentação na aba “Movimentações”."
        >
          <Input name="lastMovementAt" type="date" defaultValue={val("lastMovementAt")} />
        </FormField>
      </Section>

      <Section title="Vínculos e responsabilidade">
        <FormField label="Empresa do grupo" htmlFor="companyId" error={err("companyId")}>
          <NativeSelect name="companyId" options={companies} placeholder="Não informada" defaultValue={val("companyId")} />
        </FormField>
        {canChangeLawFirm ? (
          <FormField label="Escritório externo" htmlFor="lawFirmId" error={err("lawFirmId")}>
            <NativeSelect name="lawFirmId" options={lawFirms} placeholder="Sem escritório externo" defaultValue={val("lawFirmId")} />
          </FormField>
        ) : (
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-slate-900">Escritório externo</span>
            <p className="rounded-md border border-border bg-surface-muted px-3 py-2 text-sm text-slate-700">
              {lawFirmLabel ?? "Seu escritório"} — definido pelo seu acesso.
            </p>
            {err("lawFirmId") ? (
              <p role="alert" className="text-sm font-medium text-red-700">
                {err("lawFirmId")}
              </p>
            ) : null}
          </div>
        )}
        <FormField label="Unidade" htmlFor="unitId" error={err("unitId")}>
          <NativeSelect name="unitId" options={units} placeholder="Sem unidade" defaultValue={val("unitId")} />
        </FormField>
        <FormField label="Responsável" htmlFor="responsibleId" error={err("responsibleId")}>
          <NativeSelect name="responsibleId" options={users} placeholder="Sem responsável" defaultValue={val("responsibleId")} />
        </FormField>
      </Section>

      <Section
        title="Valores e risco"
        description="Valor da causa e valor liquidado são grandezas diferentes e nunca são somados. A classificação de risco é uma avaliação da equipe jurídica — não é previsão de resultado."
      >
        <FormField
          label="Valor da causa (R$)"
          htmlFor="claimAmountCents"
          error={err("claimAmountCents")}
          hint="Cada alteração fica registrada no histórico de valores. Deixe em branco se não informado."
        >
          <Input name="claimAmountCents" inputMode="decimal" placeholder="0,00" defaultValue={val("claimAmountCents")} />
        </FormField>
        <FormField label="Classificação de risco (interna)" htmlFor="riskLevel" required error={err("riskLevel")}>
          <NativeSelect name="riskLevel" options={riskOptions} placeholder="Selecione…" defaultValue={val("riskLevel")} required />
        </FormField>
        <div className="rounded-md border border-dashed border-border-strong bg-surface-muted px-3 py-3 text-sm sm:col-span-2">
          {mirrorValues ? (
            <>
              <p className="font-medium text-slate-900">Mantidos na aba “Valores e risco” (somente leitura aqui)</p>
              <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-3">
                <div>
                  <dt className="text-xs text-muted-foreground">Valor liquidado / apurado</dt>
                  <dd className="tabular-nums text-slate-900">{mirrorValues.liquidated}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Provisão vigente</dt>
                  <dd className="tabular-nums text-slate-900">{mirrorValues.provision}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Probabilidade de perda</dt>
                  <dd className="text-slate-900">{mirrorValues.lossProbability}</dd>
                </div>
              </dl>
              <Link
                href={mirrorValues.href}
                className="mt-2 inline-block rounded-sm text-sm font-medium text-primary-700 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                Abrir “Valores e risco”
              </Link>
            </>
          ) : (
            <p className="text-muted-foreground">
              Valor liquidado/apurado, classificação de perda (remota/possível/provável), garantias e provisão são
              lançados na aba “Valores e risco” do processo, depois do cadastro, com conferência e histórico.
            </p>
          )}
        </div>
        <FormField
          label="Justificativa da classificação"
          htmlFor="riskRationale"
          error={err("riskRationale")}
          className="sm:col-span-2"
        >
          <Textarea name="riskRationale" rows={3} maxLength={4000} defaultValue={val("riskRationale")} />
        </FormField>
      </Section>

      <Section title="Descrição">
        <FormField label="Resumo do caso" htmlFor="description" error={err("description")} className="sm:col-span-2">
          <Textarea name="description" rows={6} maxLength={20000} defaultValue={val("description")} />
        </FormField>
      </Section>

      {canEditConfidential ? (
        <Section title="Confidencialidade">
          <div className="sm:col-span-2">
            <input type="hidden" name="confidentialityField" value="1" />
            <Checkbox
              name="isConfidential"
              defaultChecked={confidential}
              label="Processo sigiloso / confidencial"
              description="Visível apenas para administradores, gestores jurídicos, o responsável, quem o cadastrou e o escritório externo que o patrocina. Cada consulta fica registrada na auditoria."
            />
          </div>
        </Section>
      ) : null}

      <div className="flex flex-col-reverse gap-2 border-t border-border pt-5 sm:flex-row sm:justify-end">
        <ButtonLink href={cancelHref} variant="outline">
          Cancelar
        </ButtonLink>
        <SubmitButton>{mode === "create" ? "Cadastrar processo" : "Salvar alterações"}</SubmitButton>
      </div>
    </form>
  );
}
