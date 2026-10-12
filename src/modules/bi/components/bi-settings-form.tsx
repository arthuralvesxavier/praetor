"use client";

import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { FormField } from "@/components/ui/form-field";
import { FormMessage } from "@/components/ui/form-message";
import { Input } from "@/components/ui/input";
import { fieldError, type FormState } from "@/lib/form";
import { PendingButton, useAdminForm, type FormAction } from "@/modules/admin/components/form-utils";
import { BI_MAX_REPORTS } from "../schemas";

export type BiSettingsFormDefaults = {
  workspaceId: string | null;
  rlsRole: string;
  autoRefresh: boolean;
  reports: { id: string; name: string; datasetId: string }[];
};

type Row = { key: number; name: string; id: string; datasetId: string };

const isFilled = (r: Row) => Boolean(r.name.trim() || r.id.trim() || r.datasetId.trim());

/**
 * Configuração dos painéis: workspace, papel RLS, atualização automática e a
 * lista de relatórios (nome, id do relatório e id do conjunto de dados).
 * Segredos não entram aqui: ficam só nas variáveis de ambiente do servidor.
 */
export function BiSettingsForm<S extends FormState>({ action, defaults }: { action: FormAction<S>; defaults: BiSettingsFormDefaults }) {
  const { state, formAction, pending, onSubmit } = useAdminForm(action);
  const [rows, setRows] = useState<Row[]>(() => {
    const initial = defaults.reports.map((r, i) => ({ key: i, ...r }));
    return initial.length > 0 ? initial : [{ key: 0, name: "", id: "", datasetId: "" }];
  });
  const [nextKey, setNextKey] = useState(rows.length);

  // Server errors refer to the filled rows only (empty rows are ignored on save).
  const filled = rows.filter(isFilled);
  const rowError = (row: Row, field: "name" | "id" | "datasetId") => {
    const index = filled.indexOf(row);
    return index >= 0 ? fieldError(state, `reports.${index}.${field}`) : undefined;
  };
  const update = (key: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  return (
    <form action={formAction} onSubmit={onSubmit} className="flex flex-col gap-6" noValidate>
      <FormMessage state={state} />
      <Card>
        <CardHeader>
          <CardTitle as="h2">Workspace e segurança por linha</CardTitle>
          <CardDescription>
            Copie os ids do endereço do Power BI (app.powerbi.com/groups/<strong>id-do-workspace</strong>/reports/
            <strong>id-do-relatório</strong>). O papel de segurança é o criado no Power BI Desktop com o filtro
            [user_key] = USERNAME() na tabela bi.acesso.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <FormField
            label="Id do workspace"
            htmlFor="bi-workspace"
            error={fieldError(state, "workspaceId")}
            hint="Formato 8-4-4-4-12, por exemplo 0f8fad5b-d9cb-469f-a165-70867728950e."
          >
            <Input
              name="workspaceId"
              defaultValue={defaults.workspaceId ?? ""}
              autoComplete="off"
              spellCheck={false}
              maxLength={36}
              className="font-mono"
            />
          </FormField>
          <FormField
            label="Papel de segurança (RLS)"
            htmlFor="bi-role"
            required
            error={fieldError(state, "rlsRole")}
            hint="Nome exato do papel no conjunto de dados. Sem ele o painel não é exibido."
          >
            <Input name="rlsRole" defaultValue={defaults.rlsRole} maxLength={80} required autoComplete="off" />
          </FormField>
          <div className="sm:col-span-2">
            <Checkbox
              id="bi-auto-refresh"
              name="autoRefresh"
              label="Atualizar o Power BI automaticamente"
              description="Após importação de planilha confirmada ou desfeita, fechamento de competência e coleta nos tribunais com novidades, além da agenda periódica da rotina. Respeita o limite diário de atualizações da licença."
              defaultChecked={defaults.autoRefresh}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle as="h2">Painéis exibidos em Painéis Power BI</CardTitle>
          <CardDescription>
            Cada painel é um relatório publicado no workspace acima. Linhas em branco são ignoradas. Use o teste de conexão
            para listar os relatórios do workspace e copiar os ids.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {fieldError(state, "reports") ? (
            <p role="alert" className="text-sm text-red-700">
              {fieldError(state, "reports")}
            </p>
          ) : null}
          <ul className="flex flex-col gap-4" aria-label="Painéis cadastrados">
            {rows.map((row, i) => (
              <li key={row.key} className="grid gap-3 rounded-md border border-border p-3 md:grid-cols-[1fr_1fr_1fr_auto] md:items-start">
                <FormField label={`Nome do painel ${i + 1}`} htmlFor={`bi-report-name-${row.key}`} error={rowError(row, "name")}>
                  <Input
                    name="reportName"
                    value={row.name}
                    onChange={(e) => update(row.key, { name: e.target.value })}
                    maxLength={80}
                    placeholder="Ex.: Carteira e provisão"
                  />
                </FormField>
                <FormField label="Id do relatório" htmlFor={`bi-report-id-${row.key}`} error={rowError(row, "id")}>
                  <Input
                    name="reportId"
                    value={row.id}
                    onChange={(e) => update(row.key, { id: e.target.value })}
                    maxLength={36}
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono"
                  />
                </FormField>
                <FormField label="Id do conjunto de dados" htmlFor={`bi-report-dataset-${row.key}`} error={rowError(row, "datasetId")}>
                  <Input
                    name="reportDatasetId"
                    value={row.datasetId}
                    onChange={(e) => update(row.key, { datasetId: e.target.value })}
                    maxLength={36}
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono"
                  />
                </FormField>
                <div className="md:pt-6">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      setRows((rs) => (rs.length > 1 ? rs.filter((r) => r.key !== row.key) : [{ key: row.key, name: "", id: "", datasetId: "" }]))
                    }
                    aria-label={`Remover o painel ${i + 1}`}
                  >
                    <Trash2 aria-hidden="true" />
                    Remover
                  </Button>
                </div>
              </li>
            ))}
          </ul>
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={rows.length >= BI_MAX_REPORTS}
              onClick={() => {
                setRows((rs) => [...rs, { key: nextKey, name: "", id: "", datasetId: "" }]);
                setNextKey((k) => k + 1);
              }}
            >
              <Plus aria-hidden="true" />
              Adicionar painel
            </Button>
          </div>
        </CardContent>
      </Card>

      <div>
        <PendingButton pending={pending}>Salvar configuração dos painéis</PendingButton>
      </div>
    </form>
  );
}
