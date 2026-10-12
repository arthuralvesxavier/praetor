"use client";

import { Check, Copy, KeyRound } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Checkbox } from "@/components/ui/checkbox";
import { FormField } from "@/components/ui/form-field";
import { FormMessage } from "@/components/ui/form-message";
import { Input } from "@/components/ui/input";
import { API_KEY_SCOPE_LABELS, API_KEY_SCOPES } from "@/domain/enums";
import { fieldError } from "@/lib/form";
import { PendingButton, useAdminForm } from "@/modules/admin/components/form-utils";
import type { CreatedApiKey } from "../schemas";

type CreateState =
  | { ok: true; data?: CreatedApiKey; message?: string }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };
type CreateAction = (prev: CreateState | null, fd: FormData) => Promise<CreateState>;

/** Creates a key and shows the full value ONCE (it is never stored nor shown again). */
export function ApiKeyCreateForm({ action }: { action: CreateAction }) {
  const { state, formAction, pending, onSubmit } = useAdminForm(action);
  const created = state?.ok ? state.data : undefined;
  return (
    <div className="flex flex-col gap-5">
      {created ? <NewKeyNotice created={created} /> : null}
      <form action={formAction} onSubmit={onSubmit} className="flex flex-col gap-4">
        {state && !state.ok ? <FormMessage state={state} /> : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Nome da chave" htmlFor="api-key-name" hint="Ex.: ERP jurídico, portal do escritório" error={fieldError(state, "name")} required>
            <Input id="api-key-name" name="name" maxLength={80} required autoComplete="off" />
          </FormField>
          <FormField label="Válida até (opcional)" htmlFor="api-key-expires" error={fieldError(state, "expiresOn")}>
            <Input id="api-key-expires" name="expiresOn" type="date" />
          </FormField>
        </div>
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-sm font-medium text-slate-800">Permissões</legend>
          {API_KEY_SCOPES.map((scope) => (
            <Checkbox
              key={scope}
              id={`api-key-scope-${scope}`}
              name="scopes"
              value={scope}
              defaultChecked={scope === "intake:create"}
              label={API_KEY_SCOPE_LABELS[scope]}
              description={<code className="text-xs">{scope}</code>}
            />
          ))}
          {fieldError(state, "scopes") ? <p className="text-sm text-red-700">{fieldError(state, "scopes")}</p> : null}
        </fieldset>
        <div>
          <PendingButton pending={pending} pendingLabel="Criando…">
            <KeyRound aria-hidden="true" />
            Criar chave
          </PendingButton>
        </div>
      </form>
    </div>
  );
}

function NewKeyNotice({ created }: { created: CreatedApiKey }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(created.key);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <Callout tone="success" title={`Chave "${created.name}" criada`}>
      <p className="mb-2">Copie agora e guarde em local seguro: ela não será mostrada de novo. Se perder, revogue e crie outra.</p>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Input readOnly value={created.key} aria-label="Chave de API criada" className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
        <Button type="button" variant="outline" size="sm" onClick={copy}>
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {copied ? "Copiada" : "Copiar"}
        </Button>
      </div>
    </Callout>
  );
}
