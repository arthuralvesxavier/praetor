"use client";

import { useMemo, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { FormField } from "@/components/ui/form-field";
import { FormMessage } from "@/components/ui/form-message";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ROLE_LABELS, type Role } from "@/domain/enums";
import { fieldError, type FormState } from "@/lib/form";
import type { Option } from "@/lib/options";
import { cn } from "@/lib/utils";
import { PendingButton, useAdminForm, type FormAction } from "./form-utils";

export type TeamFormValues = {
  id?: string;
  name: string;
  description: string | null;
  unitId: string | null;
  leaderId: string | null;
  memberIds: string[];
};

export type TeamMemberOption = { id: string; name: string; role: Role; isActive: boolean };

export function TeamForm<S extends FormState>({
  mode,
  action,
  units,
  users,
  defaults,
}: {
  mode: "create" | "edit";
  action: FormAction<S>;
  units: Option[];
  /** Active users plus current members (inactive members stay listed so they are not silently removed). */
  users: TeamMemberOption[];
  defaults?: TeamFormValues;
}) {
  const { state, formAction, pending, onSubmit } = useAdminForm(action);
  const [filter, setFilter] = useState("");
  const leaderOptions = users
    .filter((u) => u.isActive || u.id === defaults?.leaderId)
    .map((u) => ({ value: u.id, label: u.isActive ? u.name : `${u.name} (inativo)` }));
  const normalized = filter.trim().toLocaleLowerCase("pt-BR");
  const hidden = useMemo(
    () =>
      new Set(
        normalized ? users.filter((u) => !u.name.toLocaleLowerCase("pt-BR").includes(normalized)).map((u) => u.id) : [],
      ),
    [users, normalized],
  );
  const memberError = fieldError(state, "memberIds");

  return (
    <form action={formAction} onSubmit={onSubmit} className="grid gap-4" noValidate>
      {defaults?.id ? <input type="hidden" name="id" value={defaults.id} /> : null}
      <FormMessage state={state} />
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Nome da equipe" htmlFor="name" required error={fieldError(state, "name")}>
          <Input name="name" defaultValue={defaults?.name} maxLength={120} required placeholder="Ex.: Contencioso trabalhista" />
        </FormField>
        <FormField label="Unidade" htmlFor="unitId" error={fieldError(state, "unitId")}>
          <NativeSelect name="unitId" options={units} placeholder="Sem unidade" defaultValue={defaults?.unitId ?? ""} />
        </FormField>
        <FormField label="Líder" htmlFor="leaderId" error={fieldError(state, "leaderId")}>
          <NativeSelect name="leaderId" options={leaderOptions} placeholder="Sem líder" defaultValue={defaults?.leaderId ?? ""} />
        </FormField>
        <FormField label="Descrição" htmlFor="description" error={fieldError(state, "description")} className="sm:col-span-2">
          <Textarea name="description" defaultValue={defaults?.description ?? ""} maxLength={1000} rows={3} />
        </FormField>
      </div>

      <fieldset
        className="grid gap-3 rounded-md border border-border p-4"
        aria-describedby={memberError ? "memberIds-error" : undefined}
      >
        <legend className="px-1 text-sm font-medium text-slate-800">Membros</legend>
        {users.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nenhum usuário ativo disponível.</p>
        ) : (
          <>
            <div className="max-w-sm">
              <label htmlFor="member-filter" className="sr-only">
                Filtrar usuários por nome
              </label>
              <Input
                id="member-filter"
                type="search"
                placeholder="Filtrar por nome…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.preventDefault();
                }}
              />
            </div>
            <div className="grid max-h-80 gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
              {users.map((u) => (
                <Checkbox
                  key={u.id}
                  id={`member-${u.id}`}
                  name="memberIds"
                  value={u.id}
                  className={cn(hidden.has(u.id) && "hidden")}
                  label={u.name}
                  description={`${ROLE_LABELS[u.role]}${u.isActive ? "" : " · inativo"}`}
                  defaultChecked={defaults?.memberIds.includes(u.id)}
                />
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Usuários ocultos pelo filtro continuam selecionados se estiverem marcados.
            </p>
          </>
        )}
        {memberError ? (
          <p id="memberIds-error" className="text-sm text-red-700">
            {memberError}
          </p>
        ) : null}
      </fieldset>

      <div>
        <PendingButton pending={pending}>{mode === "create" ? "Criar equipe" : "Salvar alterações"}</PendingButton>
      </div>
    </form>
  );
}
