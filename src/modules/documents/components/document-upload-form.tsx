"use client";

import { Loader2, Upload } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { FormMessage } from "@/components/ui/form-message";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { CONFIDENTIALITY_LABELS, DOCUMENT_CATEGORY_LABELS } from "@/domain/enums";
import { fieldError, type FormState } from "@/lib/form";
import { optionsFromLabels, type Option } from "@/lib/options";
import { cn } from "@/lib/utils";
import { SENSITIVE_HEALTH_HINT } from "../confidentiality";
import { ALLOWED_FORMATS_LABEL, isAllowedExtension, maxUploadBytes, UPLOAD_ACCEPT } from "../file-types";

export type UploadLinkField = "processId" | "occurrenceId" | "contractId";

export type DocumentUploadFormProps = {
  /** "document" creates a new document; "version" adds a version to `documentId`. */
  mode: "document" | "version";
  documentId?: string;
  /** Server limit (env MAX_UPLOAD_MB), used for the client-side pre-check. */
  maxUploadMb: number;
  processOptions?: Option[];
  occurrenceOptions?: Option[];
  contractOptions?: Option[];
  /** Preselected links (e.g. from `?processo=`). */
  defaultLinks?: Partial<Record<UploadLinkField, string>>;
  /** Fixed link (upload from a process/occurrence/contract page): hides the link selectors. */
  fixedLink?: { field: UploadLinkField; id: string };
  /** "open" navigates to the new document; "refresh" stays on the page and refreshes it. */
  afterUpload?: "open" | "refresh";
  submitLabel?: string;
  className?: string;
};

const CATEGORY_OPTIONS = optionsFromLabels(DOCUMENT_CATEGORY_LABELS);
const CONFIDENTIALITY_OPTIONS = optionsFromLabels(CONFIDENTIALITY_LABELS);

type UploadResponse = {
  documentId?: string;
  versionId?: string;
  versionNumber?: number;
  error?: string;
  fieldErrors?: Record<string, string[]>;
};

function fail(message: string, field?: string): FormState {
  return { ok: false, error: message, fieldErrors: field ? { [field]: [message] } : undefined };
}

/**
 * Upload form posting multipart data to POST /api/documents/upload (file
 * uploads do not go through server actions). The server re-validates
 * everything; the checks here only give faster feedback.
 */
export function DocumentUploadForm({
  mode,
  documentId,
  maxUploadMb,
  processOptions = [],
  occurrenceOptions = [],
  contractOptions = [],
  defaultLinks,
  fixedLink,
  afterUpload = mode === "document" && !fixedLink ? "open" : "refresh",
  submitLabel,
  className,
}: DocumentUploadFormProps) {
  const router = useRouter();
  const uid = useId();
  const fid = (name: string) => `${uid}-${name}`;
  const formRef = useRef<HTMLFormElement>(null);
  const [pending, setPending] = useState(false);
  const [state, setState] = useState<FormState | null>(null);
  const [category, setCategory] = useState("other");
  const healthDocument = category === "sensitive_health";
  const maxBytes = maxUploadBytes(maxUploadMb);
  const limitLabel = `${maxUploadMb.toLocaleString("pt-BR")} MB`;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const file = data.get("file");

    if (!(file instanceof File) || file.size === 0 || !file.name) {
      setState(fail(file instanceof File && file.name ? "O arquivo está vazio." : "Selecione um arquivo.", "file"));
      return;
    }
    if (file.size > maxBytes) {
      setState(fail(`O arquivo excede o limite de ${limitLabel}.`, "file"));
      return;
    }
    if (!isAllowedExtension(file.name)) {
      setState(fail(`Formato não permitido. Envie arquivos ${ALLOWED_FORMATS_LABEL}.`, "file"));
      return;
    }
    if (mode === "document" && !String(data.get("title") ?? "").trim()) {
      setState(fail("Informe o título.", "title"));
      return;
    }

    setPending(true);
    setState(null);
    try {
      const res = await fetch("/api/documents/upload", {
        method: "POST",
        body: data,
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      const body = (await res.json().catch(() => null)) as UploadResponse | null;
      if (!res.ok || !body?.documentId) {
        if (res.status === 401) {
          setState(fail("Sua sessão expirou. Entre novamente para enviar o arquivo."));
        } else {
          setState({
            ok: false,
            error: body?.error ?? "Não foi possível enviar o arquivo. Tente novamente.",
            fieldErrors: body?.fieldErrors,
          });
        }
        return;
      }
      if (afterUpload === "open" && mode === "document") {
        router.push(`/documentos/${body.documentId}`);
        return;
      }
      formRef.current?.reset();
      setCategory("other");
      setState({
        ok: true,
        message:
          mode === "version"
            ? `Versão ${body.versionNumber ?? ""} enviada. A extração de texto será feita em segundo plano.`
            : "Documento enviado. A extração de texto será feita em segundo plano.",
      });
      router.refresh();
    } catch {
      setState(fail("Falha de conexão ao enviar o arquivo. Verifique sua rede e tente novamente."));
    } finally {
      setPending(false);
    }
  }

  const linkSelect = (field: UploadLinkField, label: string, options: Option[]) =>
    options.length > 0 ? (
      <FormField label={label} htmlFor={fid(field)} error={fieldError(state, field)}>
        <NativeSelect
          name={field}
          options={options}
          placeholder="Sem vínculo"
          defaultValue={defaultLinks?.[field] ?? ""}
          disabled={pending}
        />
      </FormField>
    ) : null;

  return (
    <form
      ref={formRef}
      onSubmit={onSubmit}
      noValidate
      aria-busy={pending}
      encType="multipart/form-data"
      className={cn("grid grid-cols-1 gap-4 sm:grid-cols-2", className)}
    >
      <FormMessage state={state} className="sm:col-span-2" />
      {mode === "version" && documentId ? <input type="hidden" name="documentId" value={documentId} /> : null}
      {fixedLink ? <input type="hidden" name={fixedLink.field} value={fixedLink.id} /> : null}

      <FormField
        label="Arquivo"
        htmlFor={fid("file")}
        required
        className="sm:col-span-2"
        hint={`Formatos aceitos: ${ALLOWED_FORMATS_LABEL}. Tamanho máximo: ${limitLabel}.`}
        error={fieldError(state, "file")}
      >
        <Input
          type="file"
          name="file"
          accept={UPLOAD_ACCEPT}
          required
          disabled={pending}
          className="h-auto py-1.5 file:mr-3 file:rounded file:border-0 file:bg-surface-muted file:px-2 file:py-1 file:text-sm file:font-medium"
        />
      </FormField>

      {mode === "document" ? (
        <>
          <FormField label="Título" htmlFor={fid("title")} required className="sm:col-span-2" error={fieldError(state, "title")}>
            <Input name="title" required maxLength={300} disabled={pending} autoComplete="off" />
          </FormField>
          <FormField label="Categoria" htmlFor={fid("category")} required error={fieldError(state, "category")}>
            <NativeSelect
              name="category"
              options={CATEGORY_OPTIONS}
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              required
              disabled={pending}
            />
          </FormField>
          <FormField
            label="Confidencialidade"
            htmlFor={fid("confidentiality")}
            hint={
              healthDocument
                ? SENSITIVE_HEALTH_HINT
                : "Confidencial: gestores e advogados. Restrito: gestores, quem enviou e o responsável pelo registro vinculado."
            }
            error={fieldError(state, "confidentiality")}
          >
            {healthDocument ? (
              <NativeSelect options={CONFIDENTIALITY_OPTIONS} value="restricted" disabled aria-readonly="true" onChange={() => undefined} />
            ) : (
              <NativeSelect name="confidentiality" options={CONFIDENTIALITY_OPTIONS} defaultValue="internal" disabled={pending} />
            )}
          </FormField>
          {healthDocument ? <input type="hidden" name="confidentiality" value="restricted" /> : null}
          {!fixedLink ? (
            <>
              {linkSelect("processId", "Processo vinculado", processOptions)}
              {linkSelect("occurrenceId", "Ocorrência vinculada", occurrenceOptions)}
              {linkSelect("contractId", "Contrato vinculado", contractOptions)}
            </>
          ) : null}
          <FormField label="Descrição" htmlFor={fid("description")} className="sm:col-span-2" error={fieldError(state, "description")}>
            <Textarea name="description" rows={3} maxLength={5000} disabled={pending} />
          </FormField>
        </>
      ) : (
        <FormField
          label="O que mudou nesta versão?"
          htmlFor={fid("changeNote")}
          className="sm:col-span-2"
          hint="Opcional. Ex.: minuta revisada pelo jurídico."
          error={fieldError(state, "changeNote")}
        >
          <Textarea name="changeNote" rows={2} maxLength={1000} disabled={pending} />
        </FormField>
      )}

      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <Button type="submit" disabled={pending}>
          {pending ? <Loader2 aria-hidden="true" className="animate-spin" /> : <Upload aria-hidden="true" />}
          {pending ? "Enviando…" : (submitLabel ?? (mode === "version" ? "Enviar nova versão" : "Enviar documento"))}
        </Button>
        <p className="text-xs text-muted-foreground">O tipo do arquivo é conferido pelo conteúdo, não apenas pela extensão.</p>
      </div>
    </form>
  );
}
