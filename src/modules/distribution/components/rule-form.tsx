"use client";

import { ArrowDown, ArrowUp, LoaderCircle, Save, X } from "lucide-react";
import { useActionState, useState, type ReactNode } from "react";
import { Button, ButtonLink } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { FormField } from "@/components/ui/form-field";
import { FormMessage } from "@/components/ui/form-message";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { LEGAL_AREA_LABELS, PROCESS_INSTANCE_LABELS } from "@/domain/enums";
import { fieldError, type FormState } from "@/lib/form";
import { optionsFromLabels, type Option } from "@/lib/options";
import { cn } from "@/lib/utils";
import { createRuleAction, updateRuleAction } from "../actions";
import {
  DISTRIBUTION_METHOD_DESCRIPTIONS,
  DISTRIBUTION_METHOD_LABELS,
  DISTRIBUTION_METHODS,
  type DistributionMethod,
  type RuleFormValues,
} from "../schemas";
import { usePreservingSubmit } from "./use-preserving-submit";

export type RuleFormUser = { id: string; name: string; detail: string };

export type RuleFormProps = {
  ruleId?: string;
  defaults: RuleFormValues;
  users: RuleFormUser[];
  companies: Option[];
  units: Option[];
  lawFirms: Option[];
  cancelHref: string;
};

function Section({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <fieldset className="grid gap-4 rounded-lg border border-border bg-surface p-4 shadow-xs sm:grid-cols-2 sm:p-5">
      <legend className="px-1 text-sm font-semibold text-slate-900">{title}</legend>
      {description ? <div className="-mt-1 text-xs text-muted-foreground sm:col-span-2">{description}</div> : null}
      {children}
    </fieldset>
  );
}

function CheckboxGroup({
  name,
  legend,
  options,
  defaults,
  error,
  hint,
  emptyMessage,
  className,
}: {
  name: string;
  legend: string;
  options: Option[];
  defaults: string[];
  error?: string;
  hint?: string;
  emptyMessage?: string;
  className?: string;
}) {
  const errorId = `${name}-group-error`;
  return (
    <fieldset className={cn("min-w-0", className)} aria-describedby={error ? errorId : undefined}>
      <legend className="mb-1.5 text-sm font-medium text-slate-800">{legend}</legend>
      {hint ? <p className="-mt-1 mb-2 text-xs text-muted-foreground">{hint}</p> : null}
      {options.length === 0 ? (
        <p className="text-xs text-muted-foreground">{emptyMessage ?? "Nenhuma opção disponível."}</p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {options.map((o) => (
            <Checkbox
              key={o.value}
              id={`${name}-${o.value}`}
              name={name}
              value={o.value}
              label={o.label}
              defaultChecked={defaults.includes(o.value)}
            />
          ))}
        </div>
      )}
      {error ? (
        <p id={errorId} className="mt-1.5 text-xs font-medium text-red-700">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

export function RuleForm({ ruleId, defaults, users, companies, units, lawFirms, cancelHref }: RuleFormProps) {
  const save = ruleId ? updateRuleAction : createRuleAction;
  const [state, formAction, isPending] = useActionState<FormState | null, FormData>(
    async (_prev, formData) => save(null, formData),
    null,
  );
  const onSubmit = usePreservingSubmit(formAction);
  const err = (field: string) => fieldError(state, field);
  const [method, setMethod] = useState<DistributionMethod>(defaults.method);
  const [selected, setSelected] = useState<string[]>(defaults.userIds.filter((id) => users.some((u) => u.id === id)));
  const byId = new Map(users.map((u) => [u.id, u]));

  const toggle = (id: string, checked: boolean) =>
    setSelected((prev) => (checked ? (prev.includes(id) ? prev : [...prev, id]) : prev.filter((x) => x !== id)));
  const move = (index: number, delta: -1 | 1) =>
    setSelected((prev) => {
      const next = [...prev];
      const target = index + delta;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });

  return (
    <form action={formAction} onSubmit={onSubmit} className="flex flex-col gap-6" noValidate aria-busy={isPending}>
      {ruleId ? <input type="hidden" name="id" value={ruleId} /> : null}
      <FormMessage state={state} />

      <Section title="Identificação">
        <FormField label="Nome da regra" htmlFor="name" required error={err("name")} className="sm:col-span-2">
          <Input name="name" defaultValue={defaults.name} maxLength={120} required autoFocus={!ruleId} />
        </FormField>
        <FormField label="Descrição" htmlFor="description" error={err("description")} className="sm:col-span-2">
          <Textarea name="description" defaultValue={defaults.description} rows={2} maxLength={1000} />
        </FormField>
        <FormField
          label="Prioridade"
          htmlFor="priority"
          required
          hint="Número menor = avaliada antes. A primeira regra que se aplica ao processo decide."
          error={err("priority")}
        >
          <Input name="priority" type="number" inputMode="numeric" min={0} max={100000} step={1} defaultValue={defaults.priority} required />
        </FormField>
        <div className="flex items-end pb-1">
          <Checkbox
            name="isActive"
            label="Regra ativa"
            description="Regras inativas ficam guardadas, mas não são avaliadas."
            defaultChecked={defaults.isActive}
          />
        </div>
      </Section>

      <Section
        title="Quando aplicar (critérios)"
        description="Deixe em branco o que não deve restringir. A regra só se aplica quando TODOS os critérios preenchidos são atendidos pelo processo."
      >
        <FormField
          label="Tribunais"
          htmlFor="courts"
          hint="Separe por vírgula. Ex.: TRT10, TRT2 (hífen e espaços são ignorados)."
          error={err("courts")}
        >
          <Input name="courts" defaultValue={defaults.courts} maxLength={500} autoComplete="off" />
        </FormField>
        <FormField label="Classes processuais" htmlFor="processClasses" hint="Ex.: ATOrd, ATSum, ROT." error={err("processClasses")}>
          <Input name="processClasses" defaultValue={defaults.processClasses} maxLength={500} autoComplete="off" />
        </FormField>
        <FormField label="UFs" htmlFor="states" hint="Siglas separadas por vírgula. Ex.: TO, GO." error={err("states")}>
          <Input name="states" defaultValue={defaults.states} maxLength={200} autoComplete="off" />
        </FormField>
        <FormField label="Cidades" htmlFor="cities" hint="Ex.: Palmas, Gurupi (a UF depois do nome é ignorada)." error={err("cities")}>
          <Input name="cities" defaultValue={defaults.cities} maxLength={1000} autoComplete="off" />
        </FormField>
        <FormField label="Valor da causa mínimo (R$)" htmlFor="minClaim" hint="Ex.: 50.000,00" error={err("minClaimCents")}>
          <Input name="minClaim" inputMode="decimal" autoComplete="off" defaultValue={defaults.minClaim} placeholder="0,00" />
        </FormField>
        <FormField label="Valor da causa máximo (R$)" htmlFor="maxClaim" error={err("maxClaimCents")}>
          <Input name="maxClaim" inputMode="decimal" autoComplete="off" defaultValue={defaults.maxClaim} placeholder="Sem limite" />
        </FormField>
        <CheckboxGroup
          name="areas"
          legend="Áreas"
          options={optionsFromLabels(LEGAL_AREA_LABELS)}
          defaults={defaults.areas}
          error={err("areas")}
          className="sm:col-span-2"
        />
        <CheckboxGroup
          name="instances"
          legend="Instâncias"
          options={optionsFromLabels(PROCESS_INSTANCE_LABELS)}
          defaults={defaults.instances}
          error={err("instances")}
          className="sm:col-span-2"
        />
        <CheckboxGroup
          name="companyIds"
          legend="Empresas"
          options={companies}
          defaults={defaults.companyIds}
          error={err("companyIds")}
          emptyMessage="Nenhuma empresa cadastrada."
        />
        <CheckboxGroup
          name="unitIds"
          legend="Unidades do processo"
          options={units}
          defaults={defaults.unitIds}
          error={err("unitIds")}
          emptyMessage="Nenhuma unidade cadastrada."
        />
      </Section>

      <Section title="Para quem distribuir">
        <fieldset className="sm:col-span-2" aria-describedby={err("method") ? "method-error" : undefined}>
          <legend className="mb-2 text-sm font-medium text-slate-800">
            Método <span className="text-red-700" aria-hidden="true">*</span>
          </legend>
          <div className="grid gap-2 md:grid-cols-3">
            {DISTRIBUTION_METHODS.map((m) => (
              <label
                key={m}
                className={cn(
                  "flex cursor-pointer gap-2.5 rounded-md border p-3 text-sm transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring",
                  method === m ? "border-primary-400 bg-primary-50/60" : "border-border hover:bg-slate-50",
                )}
              >
                <input
                  type="radio"
                  name="method"
                  value={m}
                  checked={method === m}
                  onChange={() => setMethod(m)}
                  className="mt-0.5 size-4 shrink-0 accent-primary"
                />
                <span>
                  <span className="block font-medium text-slate-900">{DISTRIBUTION_METHOD_LABELS[m]}</span>
                  <span className="block text-xs text-muted-foreground">{DISTRIBUTION_METHOD_DESCRIPTIONS[m]}</span>
                </span>
              </label>
            ))}
          </div>
          {err("method") ? (
            <p id="method-error" className="mt-1.5 text-xs font-medium text-red-700">
              {err("method")}
            </p>
          ) : null}
        </fieldset>

        <fieldset className="min-w-0 sm:col-span-2" aria-describedby={err("userIds") ? "userIds-error" : undefined}>
          <legend className="mb-1.5 text-sm font-medium text-slate-800">
            Quem pode receber <span className="text-red-700" aria-hidden="true">*</span>
          </legend>
          <p className="-mt-1 mb-2 text-xs text-muted-foreground">
            Advogados, gestores jurídicos e usuários de escritórios externos ativos. A ordem da lista “Ordem de
            distribuição” vale para os métodos fixo e rodízio.
          </p>
          {users.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhum usuário ativo pode receber processos. Cadastre advogados na administração.</p>
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="grid max-h-72 gap-2 overflow-y-auto rounded-md border border-border p-3">
                {users.map((u) => (
                  <Checkbox
                    key={u.id}
                    id={`user-${u.id}`}
                    label={u.name}
                    description={u.detail}
                    checked={selected.includes(u.id)}
                    onChange={(e) => toggle(u.id, e.currentTarget.checked)}
                  />
                ))}
              </div>
              <div className="rounded-md border border-border bg-surface-muted p-3">
                <p className="mb-2 text-xs font-semibold text-slate-700">Ordem de distribuição</p>
                {selected.length === 0 ? (
                  <p className="text-xs text-muted-foreground">Selecione pelo menos uma pessoa.</p>
                ) : (
                  <ol className="grid gap-1.5">
                    {selected.map((id, index) => (
                      <li key={id} className="flex items-center gap-2 rounded border border-border bg-surface px-2 py-1.5 text-sm">
                        <span className="w-5 text-right text-xs font-semibold text-muted-foreground tabular-nums">{index + 1}.</span>
                        <span className="min-w-0 flex-1 truncate">{byId.get(id)?.name ?? "Usuário"}</span>
                        <input type="hidden" name="userIds" value={id} />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          aria-label={`Subir ${byId.get(id)?.name ?? "usuário"} na ordem`}
                          disabled={index === 0}
                          onClick={() => move(index, -1)}
                        >
                          <ArrowUp aria-hidden="true" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          aria-label={`Descer ${byId.get(id)?.name ?? "usuário"} na ordem`}
                          disabled={index === selected.length - 1}
                          onClick={() => move(index, 1)}
                        >
                          <ArrowDown aria-hidden="true" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          aria-label={`Remover ${byId.get(id)?.name ?? "usuário"}`}
                          onClick={() => toggle(id, false)}
                        >
                          <X aria-hidden="true" />
                        </Button>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            </div>
          )}
          {err("userIds") ? (
            <p id="userIds-error" className="mt-1.5 text-xs font-medium text-red-700">
              {err("userIds")}
            </p>
          ) : null}
        </fieldset>

        <FormField
          label="Escritório externo a vincular"
          htmlFor="lawFirmId"
          hint="Opcional. Só é gravado quando o processo ainda não tem escritório."
          error={err("lawFirmId")}
        >
          <NativeSelect name="lawFirmId" options={lawFirms} placeholder="Nenhum" defaultValue={defaults.lawFirmId} />
        </FormField>
        <FormField
          label="Unidade a atribuir"
          htmlFor="assignUnitId"
          hint="Opcional. Só é gravada quando o processo ainda não tem unidade."
          error={err("assignUnitId")}
        >
          <NativeSelect name="assignUnitId" options={units} placeholder="Não alterar" defaultValue={defaults.assignUnitId} />
        </FormField>
      </Section>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={isPending} aria-busy={isPending || undefined}>
          {isPending ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : <Save aria-hidden="true" />}
          {isPending ? "Salvando…" : ruleId ? "Salvar alterações" : "Criar regra"}
        </Button>
        <ButtonLink href={cancelHref} variant="ghost">
          Cancelar
        </ButtonLink>
      </div>
    </form>
  );
}
