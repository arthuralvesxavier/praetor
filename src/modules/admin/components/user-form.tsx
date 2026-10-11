"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { FormField } from "@/components/ui/form-field";
import { FormMessage } from "@/components/ui/form-message";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/select";
import { ROLE_LABELS, type Role } from "@/domain/enums";
import { fieldError, type FormState } from "@/lib/form";
import type { Option } from "@/lib/options";
import { optionsFromLabels } from "@/lib/options";
import { PendingButton, useAdminForm, type FormAction } from "./form-utils";

const ROLE_DESCRIPTIONS: Record<Role, string> = {
  admin: "Acesso total, inclusive usuários, configurações e auditoria.",
  legal_manager: "Vê todos os registros (inclusive confidenciais), valida prazos e consulta auditoria.",
  lawyer: "Cadastra e edita registros da sua unidade e daqueles em que é responsável.",
  analyst: "Apoia o cadastro de ocorrências, contratos, documentos, prazos e tarefas da sua unidade.",
  executive: "Somente consulta registros não confidenciais da organização.",
};

export type UserFormValues = {
  id?: string;
  name: string;
  email: string;
  role: Role;
  unitId: string | null;
  jobTitle: string | null;
  isActive: boolean;
  teamIds: string[];
};

export type UserFormProps<S extends FormState> = {
  mode: "create" | "edit";
  action: FormAction<S>;
  units: Option[];
  teams: Option[];
  defaults?: UserFormValues;
  /** Editing your own user: role and activation are locked. */
  isSelf?: boolean;
};

export function UserForm<S extends FormState>({ mode, action, units, teams, defaults, isSelf = false }: UserFormProps<S>) {
  const { state, formAction, pending, onSubmit } = useAdminForm(action);
  const err = (f: string) => fieldError(state, f);
  const roleOptions = optionsFromLabels(ROLE_LABELS);

  return (
    <form action={formAction} onSubmit={onSubmit} className="flex flex-col gap-6" noValidate>
      {defaults?.id ? <input type="hidden" name="id" value={defaults.id} /> : null}
      <FormMessage state={state} />

      <Card>
        <CardHeader>
          <CardTitle>Dados do usuário</CardTitle>
          <CardDescription>
            {mode === "create"
              ? "O e-mail é usado para entrar no sistema e não pode ser alterado depois."
              : "O e-mail de acesso não pode ser alterado."}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <FormField label="Nome completo" htmlFor="name" required error={err("name")}>
            <Input name="name" autoComplete="off" defaultValue={defaults?.name} maxLength={120} required />
          </FormField>
          {mode === "create" ? (
            <FormField label="E-mail" htmlFor="email" required error={err("email")}>
              <Input name="email" type="email" autoComplete="off" defaultValue={defaults?.email} maxLength={254} required />
            </FormField>
          ) : (
            <FormField label="E-mail" htmlFor="email-readonly" hint="Identificador de acesso.">
              <Input value={defaults?.email ?? ""} readOnly disabled />
            </FormField>
          )}
          <FormField label="Cargo" htmlFor="jobTitle" error={err("jobTitle")}>
            <Input name="jobTitle" defaultValue={defaults?.jobTitle ?? ""} maxLength={120} placeholder="Ex.: Advogada sênior" />
          </FormField>
          <FormField
            label="Unidade"
            htmlFor="unitId"
            error={err("unitId")}
            hint="Advogados e analistas veem apenas registros da sua unidade (ou sem unidade)."
          >
            <NativeSelect name="unitId" options={units} placeholder="Sem unidade" defaultValue={defaults?.unitId ?? ""} />
          </FormField>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Perfil de acesso</CardTitle>
          <CardDescription>O perfil define o que o usuário pode fazer. Consulte a matriz em Permissões.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {isSelf ? (
            <>
              <input type="hidden" name="role" value={defaults?.role} />
              <FormField label="Perfil" htmlFor="role-locked" hint="Você não pode alterar o seu próprio perfil.">
                <Input value={defaults ? ROLE_LABELS[defaults.role] : ""} readOnly disabled />
              </FormField>
            </>
          ) : (
            <FormField label="Perfil" htmlFor="role" required error={err("role")}>
              <NativeSelect
                name="role"
                options={roleOptions}
                placeholder="Selecione…"
                placeholderDisabled
                defaultValue={defaults?.role ?? ""}
                required
              />
            </FormField>
          )}
          <ul className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
            {roleOptions.map((o) => (
              <li key={o.value}>
                <span className="font-medium text-slate-700">{o.label}:</span> {ROLE_DESCRIPTIONS[o.value as Role]}
              </li>
            ))}
          </ul>
          {mode === "edit" ? (
            <>
              {/* Activation is changed only through the dedicated buttons; the current value is re-sent as is. */}
              <input type="hidden" name="isActive" value={defaults?.isActive ? "on" : ""} />
              {!isSelf ? (
                <p className="text-xs text-muted-foreground">
                  Alterar o perfil ou a unidade encerra as sessões abertas do usuário, que precisará entrar novamente.
                </p>
              ) : null}
            </>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Equipes</CardTitle>
          <CardDescription>Equipes organizam o trabalho; não alteram a visibilidade dos registros.</CardDescription>
        </CardHeader>
        <CardContent>
          {teams.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhuma equipe cadastrada.</p>
          ) : (
            <fieldset aria-describedby={err("teamIds") ? "teamIds-error" : undefined}>
              <legend className="sr-only">Equipes do usuário</legend>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {teams.map((t) => (
                  <Checkbox
                    key={t.value}
                    id={`team-${t.value}`}
                    name="teamIds"
                    value={t.value}
                    label={t.label}
                    defaultChecked={defaults?.teamIds.includes(t.value)}
                  />
                ))}
              </div>
              {err("teamIds") ? (
                <p id="teamIds-error" className="mt-2 text-sm text-red-700">
                  {err("teamIds")}
                </p>
              ) : null}
            </fieldset>
          )}
        </CardContent>
      </Card>

      {mode === "create" ? (
        <Card>
          <CardHeader>
            <CardTitle>Senha inicial</CardTitle>
            <CardDescription>
              Mínimo de 10 caracteres, com letras e números. Informe a senha ao usuário por um canal seguro.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <FormField label="Senha inicial" htmlFor="password" required error={err("password")}>
              <Input name="password" type="password" autoComplete="new-password" minLength={10} maxLength={200} required />
            </FormField>
          </CardContent>
        </Card>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <PendingButton pending={pending}>{mode === "create" ? "Criar usuário" : "Salvar alterações"}</PendingButton>
      </div>
    </form>
  );
}
