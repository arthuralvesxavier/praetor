"use client";

import { FileSpreadsheet, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { FormField } from "@/components/ui/form-field";
import { FormMessage } from "@/components/ui/form-message";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/select";
import { fieldError, type FormState } from "@/lib/form";
import type { Option } from "@/lib/options";
import { MAX_IMPORT_BYTES, MAX_IMPORT_MB } from "../limits";

type UploadResponse = { batchId?: string; error?: string; fieldErrors?: Record<string, string[]> };

function fail(message: string, field?: string): FormState {
  return { ok: false, error: message, fieldErrors: field ? { [field]: [message] } : undefined };
}

export type ImportFormProps = {
  companies: Option[];
  units: Option[];
  /** "YYYY-MM-DD" (max of the base date input). */
  today: string;
};

/**
 * Sends the spreadsheet to POST /api/imports/upload (multipart; file uploads do
 * not go through server actions) and opens the analysis report. The server
 * re-validates everything; the checks here only give faster feedback.
 */
export function ImportForm({ companies, units, today }: ImportFormProps) {
  const router = useRouter();
  const uid = useId();
  const fid = (name: string) => `${uid}-${name}`;
  const [pending, setPending] = useState(false);
  const [state, setState] = useState<FormState | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const data = new FormData(event.currentTarget);
    const file = data.get("file");
    if (!(file instanceof File) || file.size === 0 || !file.name) {
      setState(fail(file instanceof File && file.name ? "O arquivo está vazio." : "Selecione a planilha.", "file"));
      return;
    }
    if (!/\.xlsx$/i.test(file.name)) {
      setState(fail("Envie uma planilha no formato .xlsx (Excel 2007 ou posterior).", "file"));
      return;
    }
    if (file.size > MAX_IMPORT_BYTES) {
      setState(fail(`O arquivo excede o limite de ${MAX_IMPORT_MB} MB.`, "file"));
      return;
    }
    if (!String(data.get("companyId") ?? "")) {
      setState(fail("Selecione a empresa da carteira.", "companyId"));
      return;
    }

    setPending(true);
    setState(null);
    try {
      const res = await fetch("/api/imports/upload", {
        method: "POST",
        body: data,
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      const body = (await res.json().catch(() => null)) as UploadResponse | null;
      if (!res.ok || !body?.batchId) {
        setState(
          res.status === 401
            ? fail("Sua sessão expirou. Entre novamente para enviar a planilha.")
            : { ok: false, error: body?.error ?? "Não foi possível analisar a planilha. Tente novamente.", fieldErrors: body?.fieldErrors },
        );
        setPending(false);
        return;
      }
      router.push(`/importacoes/${body.batchId}`);
    } catch {
      setState(fail("Falha de conexão ao enviar a planilha. Verifique sua rede e tente novamente."));
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate aria-busy={pending} encType="multipart/form-data" className="grid grid-cols-1 gap-5 sm:grid-cols-2">
      <FormMessage state={state} className="sm:col-span-2" />

      <FormField
        label="Planilha da carteira"
        htmlFor={fid("file")}
        required
        className="sm:col-span-2"
        hint={`Arquivo .xlsx de até ${MAX_IMPORT_MB} MB. São lidas a aba consolidada e as abas por instância (1º, 2º e 3º grau); painéis e registros de atualização são ignorados.`}
        error={fieldError(state, "file")}
      >
        <Input
          type="file"
          name="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          required
          disabled={pending}
        />
      </FormField>

      <FormField
        label="Empresa da carteira"
        htmlFor={fid("companyId")}
        required
        hint="A parte com o mesmo nome desta empresa é marcada como cliente."
        error={fieldError(state, "companyId")}
      >
        <NativeSelect
          name="companyId"
          options={companies}
          placeholder="Selecione…"
          placeholderDisabled
          defaultValue={companies.length === 1 ? companies[0].value : ""}
          required
          disabled={pending}
        />
      </FormField>

      <FormField
        label="Unidade padrão"
        htmlFor={fid("defaultUnitId")}
        hint="Opcional. Aplicada aos processos novos (e aos existentes sem unidade)."
        error={fieldError(state, "defaultUnitId")}
      >
        <NativeSelect name="defaultUnitId" options={units} placeholder="Sem unidade" defaultValue="" disabled={pending} />
      </FormField>

      <FormField
        label="Data-base dos valores"
        htmlFor={fid("baseDate")}
        hint="Data a que os valores da planilha se referem. Se ficar em branco e a planilha indicar a data (ex.: aba “Atualização Geral (29-07-2026)”), ela será sugerida. Você confirma ou altera antes de importar."
        error={fieldError(state, "baseDate")}
      >
        <Input type="date" name="baseDate" max={today} disabled={pending} />
      </FormField>

      <div className="flex items-end sm:pb-1">
        <Checkbox
          name="distributeAfterCommit"
          id={fid("distributeAfterCommit")}
          label="Distribuir os processos novos após confirmar"
          description="Aplica as regras de distribuição aos processos criados sem responsável."
          disabled={pending}
        />
      </div>

      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <Button type="submit" disabled={pending}>
          {pending ? <Loader2 aria-hidden="true" className="animate-spin" /> : <FileSpreadsheet aria-hidden="true" />}
          {pending ? "Analisando planilha…" : "Analisar planilha"}
        </Button>
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {pending
            ? "Lendo as abas e conferindo cada linha — planilhas grandes podem levar alguns segundos."
            : "Nada é gravado na carteira nesta etapa: você confere o relatório antes de confirmar."}
        </p>
      </div>
    </form>
  );
}
