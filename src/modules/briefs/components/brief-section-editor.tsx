"use client";

import { Plus, Trash2 } from "lucide-react";
import { useActionState, useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { FormMessage } from "@/components/ui/form-message";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/select";
import { SubmitButton } from "@/components/ui/submit-button";
import { Textarea } from "@/components/ui/textarea";
import { EVIDENCE_HOLDER_LABELS, type Provenance } from "@/domain/case-brief";
import { PRIORITY_LABELS, RISK_LEVEL_LABELS } from "@/domain/enums";
import { centsToInputValue, parseMoneyToCents } from "@/lib/format";
import { optionsFromLabels, type Option } from "@/lib/options";
import { cn } from "@/lib/utils";
import { saveBriefSectionAction } from "../actions";
import type { EditableSectionKey } from "../schemas";
import { ProvenanceBadge } from "./brief-badges";

type Kind = "headline" | "fields" | "text" | "timeline" | "claims" | "amounts" | "evidence" | "risks" | "nextSteps" | "deadlines";

type FieldSpec = {
  name: string;
  label: string;
  type: "text" | "textarea" | "date" | "money" | "select";
  options?: Option[];
  required?: boolean;
  /** Empty input is stored as null. */
  nullable?: boolean;
  hint?: string;
};

const NOTE: FieldSpec = { name: "note", label: "Observação", type: "textarea", nullable: true };
const HOLDER_OPTIONS = optionsFromLabels(EVIDENCE_HOLDER_LABELS);
const RISK_OPTIONS = optionsFromLabels(RISK_LEVEL_LABELS);
const PRIORITY_OPTIONS = optionsFromLabels(PRIORITY_LABELS);

const SPECS: Record<Exclude<Kind, "headline">, FieldSpec[]> = {
  fields: [
    { name: "label", label: "Campo", type: "text", required: true },
    { name: "value", label: "Valor", type: "text", nullable: true, hint: "Deixe em branco quando a informação não existir." },
    NOTE,
  ],
  text: [{ name: "text", label: "Texto", type: "textarea", required: true }, NOTE],
  timeline: [
    { name: "date", label: "Data", type: "date", nullable: true },
    { name: "description", label: "Evento", type: "textarea", required: true },
    NOTE,
  ],
  claims: [
    { name: "description", label: "Pedido", type: "textarea", required: true },
    { name: "amountCents", label: "Valor (R$)", type: "money", nullable: true, hint: "Ex.: 12.345,67. Em branco = não indicado." },
    NOTE,
  ],
  amounts: [
    { name: "label", label: "Descrição do valor", type: "text", required: true },
    { name: "amountCents", label: "Valor (R$)", type: "money", nullable: true, hint: "Em branco = não informado/não apurado (não é zero)." },
    NOTE,
  ],
  evidence: [
    { name: "description", label: "Prova", type: "textarea", required: true },
    { name: "holder", label: "Origem", type: "select", options: HOLDER_OPTIONS },
    NOTE,
  ],
  risks: [
    { name: "description", label: "Risco", type: "textarea", required: true },
    { name: "level", label: "Nível", type: "select", options: RISK_OPTIONS },
    NOTE,
  ],
  nextSteps: [
    { name: "description", label: "Próximo passo", type: "textarea", required: true },
    { name: "priority", label: "Prioridade", type: "select", options: PRIORITY_OPTIONS },
    NOTE,
  ],
  deadlines: [
    { name: "description", label: "Possível prazo", type: "text", required: true },
    { name: "date", label: "Data escrita no documento", type: "date", nullable: true, hint: "Em branco quando o documento não traz a data." },
    { name: "basis", label: "Base / trecho", type: "textarea", required: true },
    NOTE,
  ],
};

const SECTION_KIND: Record<EditableSectionKey, Kind> = {
  headline: "headline",
  identification: "fields",
  factsSummary: "text",
  timeline: "timeline",
  claims: "claims",
  amounts: "amounts",
  evidence: "evidence",
  plaintiffArguments: "text",
  defendantArguments: "text",
  contradictions: "text",
  missingDocuments: "text",
  theses: "text",
  risks: "risks",
  urgencies: "text",
  nextSteps: "nextSteps",
  possibleDeadlines: "deadlines",
  gaps: "text",
};

type Item = Record<string, unknown> & { provenance: Provenance; citations: unknown[] };
type Row = { uid: string; data: Item; amountText: string; original: string | null };

let rowSeq = 0;
function nextUid(): string {
  rowSeq += 1;
  return `row-${rowSeq}`;
}

function blankItem(kind: Exclude<Kind, "headline">, n: number): Item {
  const base = { provenance: "reviewer" as const, citations: [], note: null };
  switch (kind) {
    case "fields":
      return { key: `reviewer_${n}`, label: "", value: null, ...base };
    case "text":
      return { text: "", ...base };
    case "timeline":
      return { date: null, description: "", ...base };
    case "claims":
      return { description: "", amountCents: null, ...base };
    case "amounts":
      return { label: "", amountCents: null, ...base };
    case "evidence":
      return { description: "", holder: "unknown", ...base };
    case "risks":
      return { description: "", level: "medium", ...base };
    case "nextSteps":
      return { description: "", priority: "medium", ...base };
    case "deadlines":
      return { description: "", date: null, basis: "", ...base };
  }
}

function toRows(items: Item[]): Row[] {
  return items.map((data) => ({
    uid: nextUid(),
    data,
    amountText: typeof data.amountCents === "number" ? centsToInputValue(data.amountCents) : "",
    original: JSON.stringify(data),
  }));
}

export type BriefSectionEditorProps = {
  briefId: string;
  processId: string;
  section: EditableSectionKey;
  label: string;
  /** Current value: the headline string or the items of the section. */
  value: string | Item[];
  baseRevision: number;
};

/**
 * Edits one section of the brief and saves it as a new revision. Items that
 * are added or changed are marked by the server as "Incluído/editado pelo
 * advogado"; citations of unchanged items are kept.
 */
export function BriefSectionEditor({ briefId, processId, section, label, value, baseRevision }: BriefSectionEditorProps) {
  const kind = SECTION_KIND[section];
  const uid = useId();
  const [state, action] = useActionState(saveBriefSectionAction, null);
  const serverValue = JSON.stringify(value);
  const [synced, setSynced] = useState(serverValue);
  const [headline, setHeadline] = useState(typeof value === "string" ? value : "");
  const [rows, setRows] = useState<Row[]>(() => (Array.isArray(value) ? toRows(value) : []));
  const [changeNote, setChangeNote] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  // When this section changes on the server (after a save), restart from the stored content.
  if (synced !== serverValue) {
    setSynced(serverValue);
    setHeadline(typeof value === "string" ? value : "");
    setRows(Array.isArray(value) ? toRows(value) : []);
    setChangeNote("");
  }

  const specs = kind === "headline" ? [] : SPECS[kind];

  const buildValue = (): { value: unknown; error: string | null } => {
    if (kind === "headline") {
      return headline.trim() ? { value: headline.trim(), error: null } : { value: null, error: "Informe o resumo." };
    }
    const out: Item[] = [];
    for (const [i, row] of rows.entries()) {
      const data: Item = { ...row.data };
      for (const spec of specs) {
        if (spec.type === "money") {
          const text = row.amountText.trim();
          if (!text) data[spec.name] = null;
          else {
            const cents = parseMoneyToCents(text);
            if (cents === null || cents < 0) return { value: null, error: `Item ${i + 1}: valor inválido. Use o formato 12.345,67.` };
            data[spec.name] = cents;
          }
          continue;
        }
        const raw = data[spec.name];
        const text = typeof raw === "string" ? raw.trim() : raw;
        if (spec.required && (typeof text !== "string" || !text)) {
          return { value: null, error: `Item ${i + 1}: preencha o campo “${spec.label}”.` };
        }
        if (spec.nullable && (text === "" || text === undefined)) data[spec.name] = null;
        else data[spec.name] = text;
      }
      out.push(data);
    }
    return { value: out, error: null };
  };

  const built = buildValue();

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    if (built.error) {
      event.preventDefault();
      setLocalError(built.error);
    } else {
      setLocalError(null);
    }
  };

  const update = (rowUid: string, patch: Partial<Row> & { field?: [string, unknown] }) => {
    setRows((current) =>
      current.map((r) => {
        if (r.uid !== rowUid) return r;
        const data = patch.field ? { ...r.data, [patch.field[0]]: patch.field[1] } : r.data;
        return { ...r, ...patch, data };
      }),
    );
  };

  const isChanged = (row: Row): boolean => {
    if (row.original === null) return true;
    const original = JSON.parse(row.original) as Item;
    const moneySpec = specs.find((s) => s.type === "money");
    const data = { ...row.data };
    if (moneySpec) {
      const cents = row.amountText.trim() ? parseMoneyToCents(row.amountText) : null;
      data[moneySpec.name] = cents;
    }
    return JSON.stringify(data) !== JSON.stringify(original);
  };

  return (
    <form action={action} onSubmit={onSubmit} className="flex flex-col gap-4" aria-label={`Editar seção ${label}`}>
      <input type="hidden" name="briefId" value={briefId} />
      <input type="hidden" name="processId" value={processId} />
      <input type="hidden" name="section" value={section} />
      <input type="hidden" name="baseRevision" value={baseRevision} />
      <input type="hidden" name="value" value={JSON.stringify(built.value ?? null)} />

      {localError ? (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {localError}
        </p>
      ) : (
        <FormMessage state={state} />
      )}

      {kind === "headline" ? (
        <FormField label="Resumo da análise" htmlFor={`${uid}-headline`} required>
          <Textarea value={headline} onChange={(e) => setHeadline(e.target.value)} rows={4} maxLength={3000} />
        </FormField>
      ) : (
        <>
          {rows.length === 0 ? <p className="text-sm text-muted-foreground">Nenhum item. Use “Adicionar item” para incluir.</p> : null}
          <ol className="flex flex-col gap-3">
            {rows.map((row, i) => (
              <li key={row.uid}>
                <fieldset className="rounded-md border border-border p-3">
                  <legend className="flex flex-wrap items-center gap-2 px-1 text-xs font-semibold text-muted-foreground">
                    Item {i + 1}
                    <ProvenanceBadge provenance={isChanged(row) ? "reviewer" : row.data.provenance} />
                    {Array.isArray(row.data.citations) && row.data.citations.length ? (
                      <span className="font-normal">
                        {row.data.citations.length} citação(ões) mantida(s)
                      </span>
                    ) : null}
                  </legend>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {specs.map((spec) => {
                      const id = `${uid}-${row.uid}-${spec.name}`;
                      const wide = spec.type === "textarea" || (spec.type === "text" && spec.name !== "label");
                      const current = row.data[spec.name];
                      return (
                        <FormField
                          key={spec.name}
                          label={spec.label}
                          htmlFor={id}
                          required={spec.required}
                          hint={spec.hint}
                          className={cn(wide && "sm:col-span-2")}
                        >
                          {spec.type === "textarea" ? (
                            <Textarea
                              rows={spec.name === "note" ? 2 : 3}
                              maxLength={4000}
                              value={typeof current === "string" ? current : ""}
                              onChange={(e) => update(row.uid, { field: [spec.name, e.target.value] })}
                            />
                          ) : spec.type === "select" ? (
                            <NativeSelect
                              options={spec.options ?? []}
                              value={typeof current === "string" ? current : ""}
                              onChange={(e) => update(row.uid, { field: [spec.name, e.target.value] })}
                            />
                          ) : spec.type === "money" ? (
                            <Input
                              inputMode="decimal"
                              autoComplete="off"
                              value={row.amountText}
                              onChange={(e) => update(row.uid, { amountText: e.target.value })}
                            />
                          ) : spec.type === "date" ? (
                            <Input
                              type="date"
                              value={typeof current === "string" ? current : ""}
                              onChange={(e) => update(row.uid, { field: [spec.name, e.target.value || null] })}
                            />
                          ) : (
                            <Input
                              maxLength={1000}
                              value={typeof current === "string" ? current : ""}
                              onChange={(e) => update(row.uid, { field: [spec.name, e.target.value] })}
                            />
                          )}
                        </FormField>
                      );
                    })}
                  </div>
                  <div className="mt-3 flex justify-end">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setRows((current) => current.filter((r) => r.uid !== row.uid))}
                    >
                      <Trash2 aria-hidden="true" />
                      Remover item {i + 1}
                    </Button>
                  </div>
                </fieldset>
              </li>
            ))}
          </ol>
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                setRows((current) => [...current, { uid: nextUid(), data: blankItem(kind, current.length + 1), amountText: "", original: null }])
              }
            >
              <Plus aria-hidden="true" />
              Adicionar item
            </Button>
          </div>
        </>
      )}

      <div className="flex flex-col gap-3 border-t border-border pt-3 sm:flex-row sm:items-end">
        <FormField label="Nota da revisão (opcional)" htmlFor={`${uid}-note`} className="flex-1">
          <Input name="changeNote" maxLength={1000} value={changeNote} onChange={(e) => setChangeNote(e.target.value)} placeholder="Ex.: conferido com a petição." />
        </FormField>
        <SubmitButton pendingLabel="Salvando…">Salvar seção</SubmitButton>
      </div>
    </form>
  );
}
