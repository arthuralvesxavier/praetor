"use client";

import { LoaderCircle, Search } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { fieldClasses } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/select";
import { PROCESS_STATUS_LABELS, type ProcessStatus } from "@/domain/enums";
import type { Option } from "@/lib/options";
import { cn } from "@/lib/utils";
import { searchWorkLinkProcessesAction } from "../actions";
import type { WorkLinkOptions } from "../types";

type LinkKind = "" | "legal_process" | "occurrence" | "contract";

export type LinkFieldProps = {
  /** Name of the submitted value: "", "legal_process:<id>", "occurrence:<id>" or "contract:<id>" (parsed by the action). */
  name?: string;
  options: WorkLinkOptions;
  /** Injected by <FormField>: the "Vínculo" label, hint and error describe the link type select. */
  id?: string;
  "aria-invalid"?: boolean | "true" | "false";
  "aria-describedby"?: string;
  "aria-required"?: boolean | "true" | "false";
};

/**
 * "Vínculo" of the deadline/task forms: the link type, then the record.
 * Processes are found with a search over every process the user can access
 * (server action, at least 2 characters); occurrences and contracts are
 * picked from a select. Choosing a type without a record is rejected by the
 * action with a field error (value "<type>:").
 */
export function LinkField({ name = "link", options, id, ...aria }: LinkFieldProps) {
  const fallbackId = useId();
  const baseId = id ?? fallbackId;
  const [kind, setKind] = useState<LinkKind>("");
  const canLinkProcess = options.processSearch ?? options.processes.length > 0;
  const kinds: Option[] = [
    ...(canLinkProcess ? [{ value: "legal_process", label: "Processo" }] : []),
    ...(options.occurrences.length > 0 ? [{ value: "occurrence", label: "Ocorrência (preventivo)" }] : []),
    ...(options.contracts.length > 0 ? [{ value: "contract", label: "Contrato" }] : []),
  ];

  return (
    <div className="flex flex-col gap-3">
      <NativeSelect
        id={baseId}
        value={kind}
        onChange={(e) => setKind(e.target.value as LinkKind)}
        options={kinds}
        placeholder="Sem vínculo"
        {...aria}
      />
      {kind === "" ? <input type="hidden" name={name} value="" /> : null}
      {kind === "legal_process" ? <ProcessSearchField name={name} baseId={baseId} recent={options.processes} /> : null}
      {kind === "occurrence" ? (
        <RecordSelect
          name={name}
          id={`${baseId}-ocorrencia`}
          label="Ocorrência"
          prefix="occurrence"
          placeholder="Selecione a ocorrência…"
          records={options.occurrences}
        />
      ) : null}
      {kind === "contract" ? (
        <RecordSelect
          name={name}
          id={`${baseId}-contrato`}
          label="Contrato"
          prefix="contract"
          placeholder="Selecione o contrato…"
          records={options.contracts}
        />
      ) : null}
    </div>
  );
}

function RecordSelect({
  name,
  id,
  label,
  prefix,
  placeholder,
  records,
}: {
  name: string;
  id: string;
  label: string;
  prefix: "occurrence" | "contract";
  placeholder: string;
  records: { id: string; label: string }[];
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <NativeSelect
        id={id}
        name={name}
        defaultValue={`${prefix}:`}
        options={[{ value: `${prefix}:`, label: placeholder }, ...records.map((r) => ({ value: `${prefix}:${r.id}`, label: r.label }))]}
      />
    </div>
  );
}

const MIN_CHARS = 2;
const RECENT_SHOWN = 8;
/** Results per search (searchWorkLinkProcesses). */
const SEARCH_LIMIT = 10;
const SEARCH_ERROR = "Não foi possível buscar os processos. Verifique sua conexão e tente novamente.";

type Hit = { id: string; label: string; status?: ProcessStatus };
type SearchOutcome = { ok: true; hits: Hit[] } | { ok: false; message: string };

/** Search-as-you-type combobox (ARIA 1.2 pattern: input + listbox, arrows, Enter, Escape). */
function ProcessSearchField({ name, baseId, recent }: { name: string; baseId: string; recent: { id: string; label: string }[] }) {
  const inputId = `${baseId}-processo`;
  const listId = `${baseId}-processo-opcoes`;
  const hintId = `${baseId}-processo-dica`;
  const optionId = (i: number) => `${listId}-${i}`;

  const [selected, setSelected] = useState<Hit | null>(null);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<{ term: string; outcome: SearchOutcome } | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const refocus = useRef(false);

  const term = query.trim();
  const searching = term.length >= MIN_CHARS;

  useEffect(() => {
    if (!searching) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      searchWorkLinkProcessesAction(term)
        .then((r): SearchOutcome => (r.ok ? { ok: true, hits: r.data ?? [] } : { ok: false, message: r.error }))
        .catch((): SearchOutcome => ({ ok: false, message: SEARCH_ERROR }))
        .then((outcome) => {
          if (!cancelled) setResult({ term, outcome });
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [term, searching]);

  useEffect(() => {
    // "Trocar" puts the focus back in the search field.
    if (!selected && refocus.current) {
      refocus.current = false;
      inputRef.current?.focus();
    }
  }, [selected]);

  const outcome = searching && result?.term === term ? result.outcome : null;
  const loading = searching && !outcome;
  const items: Hit[] = searching ? (outcome?.ok ? outcome.hits : []) : recent.slice(0, RECENT_SHOWN);
  const showList = open && items.length > 0;

  function choose(hit: Hit) {
    setSelected(hit);
    setQuery("");
    setOpen(false);
    setActive(-1);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(items.length - 1, i + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (event.key === "Enter") {
      // Enter picks a result; it never submits the form from this field.
      event.preventDefault();
      const hit = active >= 0 ? items[active] : items.length === 1 ? items[0] : undefined;
      if (hit) choose(hit);
    } else if (event.key === "Escape" && open) {
      setOpen(false);
      setActive(-1);
    }
  }

  let status: string;
  if (!searching) {
    status = showList ? "Processos atualizados recentemente. Digite para buscar entre todos." : "";
  } else if (loading) {
    status = "Buscando processos…";
  } else if (outcome && !outcome.ok) {
    status = outcome.message;
  } else {
    status =
      items.length === 0
        ? "Nenhum processo encontrado."
        : items.length >= SEARCH_LIMIT
          ? `Mostrando os ${SEARCH_LIMIT} processos atualizados mais recentemente. Refine a busca para encontrar outros.`
          : `${items.length} processo(s) encontrado(s).`;
  }

  if (selected) {
    return (
      <div className="flex flex-col gap-1.5">
        <input type="hidden" name={name} value={`legal_process:${selected.id}`} />
        <span className="text-sm font-medium text-slate-800">Processo vinculado</span>
        <div className="flex items-start justify-between gap-2 rounded-md border border-border bg-surface-muted px-3 py-2 text-sm">
          <span className="min-w-0 break-words">
            {selected.label}
            {selected.status && selected.status !== "active" ? (
              <span className="ml-1 text-xs text-muted-foreground">({PROCESS_STATUS_LABELS[selected.status]})</span>
            ) : null}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              refocus.current = true;
              setSelected(null);
              setOpen(true);
            }}
          >
            Trocar
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <input type="hidden" name={name} value="legal_process:" />
      <Label htmlFor={inputId}>Buscar processo</Label>
      <div className="relative">
        <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-slate-500" />
        <input
          ref={inputRef}
          id={inputId}
          type="search"
          role="combobox"
          autoComplete="off"
          aria-autocomplete="list"
          aria-expanded={showList}
          aria-controls={listId}
          aria-activedescendant={showList && active >= 0 && active < items.length ? optionId(active) : undefined}
          aria-describedby={hintId}
          placeholder="Número, título, parte ou vara"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setActive(-1);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
          className={cn(fieldClasses, "h-9 pr-3 pl-8")}
        />
      </div>
      <p id={hintId} className="text-xs text-muted-foreground">
        Digite ao menos {MIN_CHARS} caracteres. A busca considera todos os processos que você pode acessar.
      </p>
      <ul
        id={listId}
        role="listbox"
        aria-label="Processos"
        hidden={!showList}
        className="max-h-60 overflow-auto rounded-md border border-border bg-white py-1 shadow-sm"
      >
        {items.map((hit, i) => (
          <li
            key={hit.id}
            id={optionId(i)}
            role="option"
            aria-selected={i === active}
            // mousedown (not click) so the choice happens before the input loses focus.
            onMouseDown={(e) => {
              e.preventDefault();
              choose(hit);
            }}
            className={cn("cursor-pointer px-3 py-1.5 text-sm break-words hover:bg-surface-muted", i === active && "bg-primary-50")}
          >
            {hit.label}
            {hit.status && hit.status !== "active" ? (
              <span className="ml-1 text-xs text-muted-foreground">({PROCESS_STATUS_LABELS[hit.status]})</span>
            ) : null}
          </li>
        ))}
      </ul>
      <p role="status" className={cn("flex items-center gap-1.5 text-xs", outcome && !outcome.ok ? "text-red-700" : "text-muted-foreground")}>
        {loading ? <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" /> : null}
        {status}
      </p>
    </div>
  );
}
