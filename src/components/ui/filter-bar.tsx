import { Search, SlidersHorizontal, X } from "lucide-react";
import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import type { Option } from "@/lib/options";
import { cn } from "@/lib/utils";
import { Button, buttonVariants } from "./button";
import { Input } from "./input";
import { Label } from "./label";
import { NativeSelect } from "./select";

export type FilterBarProps = {
  /** List route the form submits to (GET) and "Limpar" links to, e.g. "/processos". */
  basePath: string;
  /** Show the free-text search input (param "q"). Default true. */
  search?: boolean;
  /** Current value of "q". */
  defaultQuery?: string;
  searchLabel?: string;
  searchPlaceholder?: string;
  /**
   * Params that must survive filtering but have no visible control, e.g.
   * `{ aba: "prazos" }`. Empty values are omitted. "pagina" is never kept:
   * changing filters always goes back to page 1.
   */
  hiddenFields?: Record<string, string | null | undefined>;
  /** Show "Limpar" (link to basePath + hiddenFields). Pass `hasAnyParam(sp, [...])` to show it only when filtered. */
  showClear?: boolean;
  /** FilterSelect / FilterInput controls. */
  children?: ReactNode;
  className?: string;
  /**
   * Form id, so a control rendered elsewhere on the page can submit with the filters
   * through the `form` attribute (e.g. the dashboard's chart dimension, `dimensao`).
   */
  id?: string;
};

/**
 * GET filter form for list pages (works without JavaScript). Each control is a
 * named field whose value becomes a URL param from MODULE_CONTRACTS.
 *
 *   <FilterBar basePath="/processos" defaultQuery={param(sp, "q")} searchPlaceholder="Número, título ou parte">
 *     <FilterSelect name="status" label="Situação" options={optionsFromLabels(PROCESS_STATUS_LABELS)} defaultValue={param(sp, "status")} />
 *     <FilterSelect name="risco" label="Risco" options={optionsFromLabels(RISK_LEVEL_LABELS)} defaultValue={param(sp, "risco")} />
 *   </FilterBar>
 */
export function FilterBar({
  basePath,
  search = true,
  defaultQuery,
  searchLabel = "Buscar",
  searchPlaceholder = "Buscar…",
  hiddenFields,
  showClear = true,
  children,
  className,
  id,
}: FilterBarProps) {
  const hidden = Object.entries(hiddenFields ?? {}).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== "",
  );
  const clearHref = hidden.length > 0 ? `${basePath}?${new URLSearchParams(hidden).toString()}` : basePath;

  return (
    <form
      id={id}
      method="get"
      action={basePath}
      role="search"
      aria-label="Filtros"
      className={cn(
        "mb-4 flex flex-col gap-3 rounded-lg border border-border bg-surface p-3 shadow-xs sm:flex-row sm:flex-wrap sm:items-end",
        className,
      )}
    >
      {hidden.map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {search ? (
        <div className="flex min-w-0 flex-col gap-1 sm:min-w-56 sm:flex-[2]">
          <Label htmlFor="filtro-q" className="text-xs text-muted-foreground">
            {searchLabel}
          </Label>
          <div className="relative">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400"
            />
            <Input
              id="filtro-q"
              name="q"
              type="search"
              defaultValue={defaultQuery ?? ""}
              placeholder={searchPlaceholder}
              className="pl-9"
              autoComplete="off"
              maxLength={200}
            />
          </div>
        </div>
      ) : null}
      {children}
      <div className="flex items-center gap-2 sm:ml-auto">
        <Button type="submit" variant="secondary" className="flex-1 sm:flex-none">
          <SlidersHorizontal aria-hidden="true" />
          Filtrar
        </Button>
        {showClear ? (
          <Link href={clearHref} className={cn(buttonVariants({ variant: "ghost" }), "flex-1 sm:flex-none")}>
            <X aria-hidden="true" />
            Limpar
          </Link>
        ) : null}
      </div>
    </form>
  );
}

export type FilterSelectProps = {
  /** URL param name, e.g. "status", "risco", "responsavel". */
  name: string;
  label: string;
  options: readonly Option[];
  defaultValue?: string | null;
  /** Label of the empty option (no filter). Default "Todos". */
  placeholder?: string;
  className?: string;
};

/** Labelled native select for a FilterBar. The empty option means "no filter". */
export function FilterSelect({ name, label, options, defaultValue, placeholder = "Todos", className }: FilterSelectProps) {
  const id = `filtro-${name}`;
  return (
    <div className={cn("flex min-w-0 flex-col gap-1 sm:w-44", className)}>
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      <NativeSelect id={id} name={name} options={options} placeholder={placeholder} defaultValue={defaultValue ?? ""} />
    </div>
  );
}

export type FilterInputProps = Omit<ComponentProps<"input">, "id" | "defaultValue"> & {
  name: string;
  label: string;
  defaultValue?: string | null;
};

/** Labelled input for a FilterBar (dates "de"/"ate", month "mes"...): `<FilterInput type="date" name="de" label="De" />`. */
export function FilterInput({ name, label, defaultValue, className, ...props }: FilterInputProps) {
  const id = `filtro-${name}`;
  return (
    <div className={cn("flex min-w-0 flex-col gap-1 sm:w-40", className)}>
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      <Input id={id} name={name} defaultValue={defaultValue ?? ""} {...props} />
    </div>
  );
}
