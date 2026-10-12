"use client";

import { CircleAlert, CircleCheck, FileUp, LoaderCircle, Paperclip, Send, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Button, ButtonLink } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { FormMessage } from "@/components/ui/form-message";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { isValidCnj, laborCourtFromCnj, normalizeCnj } from "@/domain/cnj";
import {
  DOCUMENT_CATEGORY_LABELS,
  LEGAL_AREA_LABELS,
  PROCESS_INSTANCE_LABELS,
  PROCESS_PHASE_LABELS,
  type DocumentCategory,
} from "@/domain/enums";
import { formatFileSize } from "@/lib/format";
import { fieldError, type FormState } from "@/lib/form";
import { optionsFromLabels, type Option } from "@/lib/options";
import { cn } from "@/lib/utils";
import { ALLOWED_FORMATS_LABEL, isAllowedExtension, maxUploadBytes, UPLOAD_ACCEPT } from "@/modules/documents/file-types";
import { registerIntakeAction, startIntakeProcessingAction } from "../actions";

export type IntakeFormProps = {
  companies: Option[];
  units: Option[];
  users: Option[];
  maxUploadMb: number;
};

type PendingFile = {
  key: string;
  file: File;
  title: string;
  category: DocumentCategory;
  state: "waiting" | "uploading" | "done" | "failed";
  error?: string;
};

type Phase = "idle" | "registering" | "uploading" | "starting" | "done";

const MAX_FILES = 20;
const CATEGORY_OPTIONS = optionsFromLabels(DOCUMENT_CATEGORY_LABELS);

function stripAccents(v: string): string {
  return v.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/** Best guess of the document category from the file name (the user can change it). */
export function guessCategory(fileName: string): DocumentCategory {
  const n = stripAccents(fileName.toLowerCase());
  if (/inicial|peticao/.test(n)) return "initial_petition";
  if (/procura|substabelec/.test(n)) return "power_of_attorney";
  if (/calculo|planilha/.test(n)) return "calculation";
  if (/contestacao|defesa/.test(n)) return "defense";
  if (/sentenca/.test(n)) return "judgment";
  if (/acordao/.test(n)) return "appellate_decision";
  if (/(^|[^a-z])ata([^a-z]|$)/.test(n)) return "hearing_minutes";
  if (/atestado|laudo|(^|[^a-z])cat([^a-z]|$)/.test(n)) return "sensitive_health";
  if (/holerite|recibo|ctps|contrato|ponto/.test(n)) return "evidence";
  return "other";
}

function titleFromFileName(name: string): string {
  const base = name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
  return (base || name).slice(0, 300);
}

function Section({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <fieldset className="grid gap-4 rounded-lg border border-border bg-surface p-4 shadow-xs sm:grid-cols-2 sm:p-5">
      <legend className="px-1 text-sm font-semibold text-slate-900">{title}</legend>
      {description ? <div className="-mt-1 text-xs text-muted-foreground sm:col-span-2">{description}</div> : null}
      {children}
    </fieldset>
  );
}

function CnjHint({ value, court, onUseCourt }: { value: string; court: string; onUseCourt: (court: string) => void }) {
  const normalized = normalizeCnj(value);
  if (!value.trim()) return <>Formato CNJ: NNNNNNN-DD.AAAA.J.TR.OOOO (20 dígitos).</>;
  if (!normalized) {
    const digits = value.replace(/\D/g, "").length;
    return <>Faltam dígitos: {digits} de 20 informados.</>;
  }
  const valid = isValidCnj(normalized);
  const suggested = laborCourtFromCnj(normalized);
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {valid ? (
        <span className="inline-flex items-center gap-1 text-emerald-800">
          <CircleCheck aria-hidden="true" className="size-3.5" />
          Dígito verificador confere ({normalized}).
        </span>
      ) : (
        <span className="inline-flex items-center gap-1 text-amber-800">
          <CircleAlert aria-hidden="true" className="size-3.5" />
          Dígito verificador não confere — o processo será marcado para verificação.
        </span>
      )}
      {suggested && suggested !== court.trim().toUpperCase() ? (
        <Button type="button" variant="link" className="text-xs" onClick={() => onUseCourt(suggested)}>
          Usar tribunal {suggested} (pelo número)
        </Button>
      ) : null}
    </span>
  );
}

/**
 * Registration of an incoming process. Files do not go through server actions
 * (2 MB limit): the process is registered first, then each file is posted to
 * /api/documents/upload and finally the pipeline is started.
 */
export function IntakeForm({ companies, units, users, maxUploadMb }: IntakeFormProps) {
  const router = useRouter();
  const uid = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<FormState | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [number, setNumber] = useState("");
  const [court, setCourt] = useState("");
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ intakeId: string; processId: string } | null>(null);
  const maxBytes = maxUploadBytes(maxUploadMb);
  const busy = phase !== "idle";
  const err = (field: string) => fieldError(state, field);

  function addFiles(list: FileList | null) {
    if (!list) return;
    const problems: string[] = [];
    const next: PendingFile[] = [];
    for (const file of Array.from(list)) {
      if (files.length + next.length >= MAX_FILES) {
        problems.push(`Limite de ${MAX_FILES} arquivos por entrada.`);
        break;
      }
      if (!isAllowedExtension(file.name)) {
        problems.push(`${file.name}: formato não permitido (${ALLOWED_FORMATS_LABEL}).`);
        continue;
      }
      if (file.size === 0) {
        problems.push(`${file.name}: arquivo vazio.`);
        continue;
      }
      if (file.size > maxBytes) {
        problems.push(`${file.name}: excede o limite de ${maxUploadMb.toLocaleString("pt-BR")} MB.`);
        continue;
      }
      next.push({
        key: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2, 8)}`,
        file,
        title: titleFromFileName(file.name),
        category: guessCategory(file.name),
        state: "waiting",
      });
    }
    setFiles((prev) => [...prev, ...next]);
    setFileError(problems.length ? problems.join(" ") : null);
    if (fileInput.current) fileInput.current.value = "";
  }

  const patchFile = (key: string, patch: Partial<PendingFile>) =>
    setFiles((prev) => prev.map((f) => (f.key === key ? { ...f, ...patch } : f)));

  async function uploadAll(processId: string): Promise<number> {
    let failed = 0;
    for (const f of files) {
      patchFile(f.key, { state: "uploading", error: undefined });
      const body = new FormData();
      body.set("file", f.file);
      body.set("title", f.title.trim() || titleFromFileName(f.file.name));
      body.set("category", f.category);
      body.set("confidentiality", "internal");
      body.set("processId", processId);
      try {
        const res = await fetch("/api/documents/upload", {
          method: "POST",
          body,
          credentials: "same-origin",
          headers: { Accept: "application/json" },
        });
        const json = (await res.json().catch(() => null)) as { documentId?: string; error?: string } | null;
        if (!res.ok || !json?.documentId) {
          failed++;
          patchFile(f.key, { state: "failed", error: json?.error ?? "Não foi possível enviar o arquivo." });
        } else {
          patchFile(f.key, { state: "done" });
        }
      } catch {
        failed++;
        patchFile(f.key, { state: "failed", error: "Falha de conexão ao enviar o arquivo." });
      }
    }
    return failed;
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const data = new FormData(event.currentTarget);
    data.delete("files");
    setState(null);
    setPhase("registering");
    let registered: { intakeId: string; processId: string };
    try {
      const result = await registerIntakeAction(null, data);
      if (!result.ok || !result.data) {
        setState(result.ok ? { ok: false, error: "Não foi possível registrar o processo." } : result);
        setPhase("idle");
        return;
      }
      registered = result.data;
      setCreated(registered);
    } catch {
      setState({ ok: false, error: "Falha de conexão ao registrar o processo. Tente novamente." });
      setPhase("idle");
      return;
    }

    setPhase("uploading");
    const failed = files.length > 0 ? await uploadAll(registered.processId) : 0;

    setPhase("starting");
    const start = new FormData();
    start.set("intakeId", registered.intakeId);
    start.set("failedUploads", String(failed));
    try {
      const started = await startIntakeProcessingAction(null, start);
      if (!started.ok) {
        setState({ ok: false, error: `${started.error} Abra a entrada para iniciar o processamento.` });
        setPhase("done");
        return;
      }
    } catch {
      setState({ ok: false, error: "Falha de conexão ao iniciar o processamento. Abra a entrada para iniciar novamente." });
      setPhase("done");
      return;
    }
    setPhase("done");
    router.push(`/entrada/${registered.intakeId}`);
  }

  const progressText: Record<Phase, string> = {
    idle: "",
    registering: "Registrando o processo…",
    uploading: "Enviando os documentos…",
    starting: "Iniciando a distribuição e a análise (simulação)…",
    done: "Concluído. Abrindo a entrada…",
  };

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-6" aria-busy={busy}>
      <FormMessage state={state} />

      <Section
        title="Número e órgão"
        description="O número CNJ é a chave do processo: não pode repetir na organização. Não há consulta a tribunais nesta versão."
      >
        <FormField
          label="Número do processo (CNJ)"
          htmlFor="number"
          required
          className="sm:col-span-2"
          hint={<CnjHint value={number} court={court} onUseCourt={setCourt} />}
          error={err("number")}
        >
          <Input
            name="number"
            value={number}
            onChange={(e) => setNumber(e.currentTarget.value)}
            maxLength={60}
            inputMode="numeric"
            autoComplete="off"
            placeholder="0000000-00.2026.5.10.0000"
            required
            autoFocus
            disabled={busy}
          />
        </FormField>
        <FormField label="Tribunal" htmlFor="court" required hint="Ex.: TRT10, TRT2, TJSP." error={err("court")}>
          <Input name="court" value={court} onChange={(e) => setCourt(e.currentTarget.value)} maxLength={120} required disabled={busy} />
        </FormField>
        <FormField label="Vara / órgão julgador" htmlFor="courtDivision" error={err("courtDivision")}>
          <Input name="courtDivision" maxLength={200} disabled={busy} />
        </FormField>
        <FormField label="Cidade" htmlFor="city" error={err("city")}>
          <Input name="city" maxLength={120} disabled={busy} />
        </FormField>
        <FormField label="UF" htmlFor="state" hint="2 letras." error={err("state")}>
          <Input name="state" maxLength={2} className="uppercase" autoComplete="off" disabled={busy} />
        </FormField>
        <FormField label="Classe processual" htmlFor="processClass" hint="Ex.: ATOrd, ATSum." error={err("processClass")}>
          <Input name="processClass" maxLength={40} disabled={busy} />
        </FormField>
        <FormField label="Data de ajuizamento" htmlFor="filedAt" error={err("filedAt")}>
          <Input name="filedAt" type="date" disabled={busy} />
        </FormField>
        <FormField label="Área" htmlFor="area" required error={err("area")}>
          <NativeSelect name="area" options={optionsFromLabels(LEGAL_AREA_LABELS)} defaultValue="labor" required disabled={busy} />
        </FormField>
        <FormField label="Fase" htmlFor="phase" required error={err("phase")}>
          <NativeSelect name="phase" options={optionsFromLabels(PROCESS_PHASE_LABELS)} defaultValue="knowledge" required disabled={busy} />
        </FormField>
        <FormField label="Instância" htmlFor="instance" required error={err("instance")}>
          <NativeSelect name="instance" options={optionsFromLabels(PROCESS_INSTANCE_LABELS)} defaultValue="first" required disabled={busy} />
        </FormField>
      </Section>

      <Section title="Partes e valores">
        <FormField label="Parte autora" htmlFor="plaintiffName" required error={err("plaintiffName")}>
          <Input name="plaintiffName" maxLength={200} required disabled={busy} />
        </FormField>
        <FormField label="Empresa (parte ré)" htmlFor="companyId" hint="Empresa do grupo que figura no processo." error={err("companyId")}>
          <NativeSelect
            name="companyId"
            options={companies}
            placeholder="Selecione…"
            defaultValue={companies.length === 1 ? companies[0].value : ""}
            disabled={busy}
          />
        </FormField>
        <FormField
          label="Nome da parte ré"
          htmlFor="defendantName"
          hint="Deixe em branco para usar o nome da empresa selecionada."
          error={err("defendantName")}
        >
          <Input name="defendantName" maxLength={200} disabled={busy} />
        </FormField>
        <FormField label="Valor da causa (R$)" htmlFor="claimAmount" hint="Ex.: 85.000,00. Deixe em branco se não informado." error={err("claimAmountCents")}>
          <Input name="claimAmount" inputMode="decimal" autoComplete="off" placeholder="0,00" disabled={busy} />
        </FormField>
        <FormField label="Título" htmlFor="title" hint="Opcional. Padrão: “Autor x Empresa”." error={err("title")} className="sm:col-span-2">
          <Input name="title" maxLength={200} disabled={busy} />
        </FormField>
        <FormField label="Observações" htmlFor="description" error={err("description")} className="sm:col-span-2">
          <Textarea name="description" rows={3} maxLength={5000} disabled={busy} />
        </FormField>
      </Section>

      <Section
        title="Distribuição"
        description="Deixe o responsável em branco para que as regras de distribuição escolham automaticamente."
      >
        <FormField label="Unidade" htmlFor="unitId" error={err("unitId")}>
          <NativeSelect name="unitId" options={units} placeholder="Sem unidade" defaultValue="" disabled={busy} />
        </FormField>
        <FormField label="Responsável" htmlFor="responsibleId" error={err("responsibleId")}>
          <NativeSelect name="responsibleId" options={users} placeholder="Distribuição automática" defaultValue="" disabled={busy} />
        </FormField>
      </Section>

      <Section
        title="Documentos recebidos"
        description={
          <>
            Petição inicial, procuração, documentos do autor, cálculos… Formatos: {ALLOWED_FORMATS_LABEL}; até{" "}
            {maxUploadMb.toLocaleString("pt-BR")} MB por arquivo. A leitura dos documentos e a análise preliminar são uma
            simulação nesta versão (sem inteligência artificial real).
          </>
        }
      >
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <label htmlFor={`${uid}-files`} className="text-sm font-medium text-slate-800">
            Adicionar arquivos
          </label>
          <input
            ref={fileInput}
            id={`${uid}-files`}
            name="files"
            type="file"
            multiple
            accept={UPLOAD_ACCEPT}
            disabled={busy}
            onChange={(e) => addFiles(e.currentTarget.files)}
            aria-describedby={fileError ? `${uid}-files-error` : undefined}
            className="block w-full cursor-pointer rounded-md border border-border-strong bg-white text-sm text-slate-700 file:mr-3 file:cursor-pointer file:border-0 file:bg-surface-muted file:px-3 file:py-2 file:text-sm file:font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-60"
          />
          {fileError ? (
            <p id={`${uid}-files-error`} role="alert" className="text-xs font-medium text-red-700">
              {fileError}
            </p>
          ) : null}
        </div>
        {files.length > 0 ? (
          <ul className="grid gap-2 sm:col-span-2" aria-label="Arquivos a enviar">
            {files.map((f) => (
              <li key={f.key} className="grid gap-2 rounded-md border border-border p-3 sm:grid-cols-[1fr_14rem_auto] sm:items-end">
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
                    <Paperclip aria-hidden="true" className="size-3.5 shrink-0" />
                    <span className="truncate">{f.file.name}</span>
                    <span className="shrink-0">· {formatFileSize(f.file.size)}</span>
                  </p>
                  <label htmlFor={`${f.key}-title`} className="sr-only">
                    Título do documento {f.file.name}
                  </label>
                  <Input
                    id={`${f.key}-title`}
                    value={f.title}
                    maxLength={300}
                    disabled={busy}
                    onChange={(e) => patchFile(f.key, { title: e.currentTarget.value })}
                    className="mt-1"
                  />
                </div>
                <div>
                  <label htmlFor={`${f.key}-category`} className="sr-only">
                    Categoria do documento {f.file.name}
                  </label>
                  <NativeSelect
                    id={`${f.key}-category`}
                    options={CATEGORY_OPTIONS}
                    value={f.category}
                    disabled={busy}
                    onChange={(e) => patchFile(f.key, { category: e.currentTarget.value as DocumentCategory })}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <UploadState file={f} />
                  {phase === "idle" ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Remover ${f.file.name}`}
                      onClick={() => setFiles((prev) => prev.filter((x) => x.key !== f.key))}
                    >
                      <Trash2 aria-hidden="true" />
                    </Button>
                  ) : null}
                </div>
                {f.error ? <p className="text-xs font-medium text-red-700 sm:col-span-3">{f.error}</p> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground sm:col-span-2">
            Nenhum arquivo selecionado. Você pode registrar sem documentos e enviá-los depois pela aba Documentos do processo.
          </p>
        )}
      </Section>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={busy} aria-busy={busy || undefined}>
          {busy ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : <Send aria-hidden="true" />}
          {busy ? "Processando…" : "Registrar processo recebido"}
        </Button>
        {phase === "idle" ? (
          <ButtonLink href="/entrada" variant="ghost">
            Cancelar
          </ButtonLink>
        ) : null}
        <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
          {progressText[phase]}
          {created && phase === "done" && state && !state.ok ? (
            <>
              {" "}
              <Link href={`/entrada/${created.intakeId}`} className="font-medium text-primary-700 underline">
                Abrir a entrada
              </Link>
            </>
          ) : null}
        </p>
      </div>
    </form>
  );
}

function UploadState({ file }: { file: PendingFile }) {
  const base = "inline-flex items-center gap-1 text-xs whitespace-nowrap";
  switch (file.state) {
    case "uploading":
      return (
        <span className={cn(base, "text-slate-700")}>
          <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />
          Enviando…
        </span>
      );
    case "done":
      return (
        <span className={cn(base, "text-emerald-800")}>
          <CircleCheck aria-hidden="true" className="size-3.5" />
          Enviado
        </span>
      );
    case "failed":
      return (
        <span className={cn(base, "text-red-700")}>
          <CircleAlert aria-hidden="true" className="size-3.5" />
          Falhou
        </span>
      );
    default:
      return (
        <span className={cn(base, "text-muted-foreground")}>
          <FileUp aria-hidden="true" className="size-3.5" />
          A enviar
        </span>
      );
  }
}
