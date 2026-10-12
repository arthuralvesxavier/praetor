import { ArrowDown, ArrowUp, ArrowUpDown, Lock, PauseCircle, SearchCheck, TriangleAlert } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
  tableLinkClasses,
} from "@/components/ui/table";
import { CLOSURE_REASON_LABELS, PROCESS_INSTANCE_LABELS, PROCESS_PHASE_LABELS, PROCESS_STATUS_LABELS } from "@/domain/enums";
import { formatMoneyCents } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ProcessSort } from "../schemas";
import type { ProcessListItem } from "../service";
import { cityWithState } from "../states";

/** Sortable column headers: the current sort and the link that applies another one (filters kept). */
export type PortfolioSortControl = {
  current: ProcessSort;
  href: (sort: ProcessSort) => string;
};

export type PortfolioTableProps = {
  items: ProcessListItem[];
  emptyDescription: string;
  /** Company (second line under the autor): only when the organization has more than one active company (else it is in the page subtitle). */
  showCompany?: boolean;
  sort?: PortfolioSortControl;
};

const NOT_INFORMED = "Não informado";

function Muted({ children }: { children: ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>;
}

/** Plaintiff column: first plaintiff (as registered, never re-cased) and "+N" for the others. */
function plaintiffText(p: ProcessListItem): { name: string | null; more: number } {
  return { name: p.plaintiffName?.trim() || null, more: Math.max(0, p.plaintiffCount - 1) };
}

/**
 * Plaintiff name and "+N" on one line: only the name is truncated, so the "+N"
 * stays visible however long the (often all-caps) registered name is.
 */
function PlaintiffLine({
  plaintiff,
  empty = NOT_INFORMED,
}: {
  plaintiff: ReturnType<typeof plaintiffText>;
  empty?: string;
}) {
  if (!plaintiff.name) {
    return <span className="block truncate font-normal text-muted-foreground">{empty}</span>;
  }
  return (
    <span className="flex min-w-0 items-baseline">
      <span className="min-w-0 truncate">{plaintiff.name}</span>
      {plaintiff.more > 0 ? (
        <span className="ml-1 shrink-0 font-normal text-muted-foreground">
          <span className="sr-only"> </span>+{plaintiff.more}
        </span>
      ) : null}
    </span>
  );
}

function plaintiffTitle(p: ProcessListItem, showCompany: boolean): string | undefined {
  const { name, more } = plaintiffText(p);
  const parts: string[] = [];
  if (name) parts.push(more > 0 ? `${name} e mais ${more} ${more === 1 ? "autor" : "autores"}` : name);
  if (p.defendantName) parts.push(`Réu: ${p.defendantName}${p.defendantCount > 1 ? ` e mais ${p.defendantCount - 1}` : ""}`);
  if (showCompany && p.companyName) parts.push(`Empresa: ${p.companyName}`);
  return parts.length > 0 ? parts.join(". ") : undefined;
}

/** "TRT10 · 1º grau"; the vara and the city stay in the tooltip (the source text is never re-cased). */
function courtText(p: ProcessListItem): string | null {
  const court = p.court?.trim() || null;
  const instance = p.instance ? PROCESS_INSTANCE_LABELS[p.instance] : null;
  if (court && instance) return `${court} · ${instance}`;
  return court ?? instance;
}

function courtTitle(p: ProcessListItem): string | undefined {
  const parts: string[] = [];
  if (p.courtDivision?.trim()) parts.push(`Vara: ${p.courtDivision.trim()}`);
  const city = cityWithState(p.city, p.state);
  if (city) parts.push(`Cidade: ${city}`);
  return parts.length > 0 ? parts.join(". ") : undefined;
}

/**
 * Phase, once. Outside the active portfolio the status is what matters
 * ("Encerrado", "Arquivado"), with the phase and closure reason in the tooltip.
 */
function PhaseText({ p }: { p: ProcessListItem }) {
  const phase = PROCESS_PHASE_LABELS[p.phase] ?? null;
  if (p.status === "archived" || p.status === "closed") {
    const title = [
      phase ? `Fase: ${phase}` : null,
      p.closureReason ? `Motivo: ${CLOSURE_REASON_LABELS[p.closureReason]}` : null,
    ]
      .filter(Boolean)
      .join(". ");
    return (
      <span className="text-muted-foreground" title={title || undefined}>
        {PROCESS_STATUS_LABELS[p.status]}
      </span>
    );
  }
  const title = [p.status === "suspended" ? "Suspenso" : null, p.phaseDetail?.trim() || null].filter(Boolean).join(". ");
  return (
    <span className="flex min-w-0 items-center gap-1" title={title || undefined}>
      {p.status === "suspended" ? (
        <>
          <PauseCircle aria-hidden="true" className="size-3.5 shrink-0 text-amber-600" />
          <span className="sr-only">Suspenso, </span>
        </>
      ) : null}
      <span className="truncate">{phase ?? <Muted>{NOT_INFORMED}</Muted>}</span>
    </span>
  );
}

function Money({ cents, empty }: { cents: number | null; empty: string }) {
  return cents === null ? <Muted>{empty}</Muted> : <>{formatMoneyCents(cents)}</>;
}

/** Responsible person, else the external law firm. */
function responsibleText(p: ProcessListItem): { text: string | null; title?: string } {
  if (p.responsibleName) return { text: p.responsibleName, title: p.lawFirmName ? `Escritório: ${p.lawFirmName}` : undefined };
  if (p.lawFirmName) return { text: p.lawFirmName, title: "Escritório externo" };
  return { text: null };
}

/**
 * Small icons after the CNJ: pendente de conferência, fora do padrão CNJ, sigiloso
 * (each with text for screen readers). `single` (table rows) shows only the first
 * icon to keep the CNJ column narrow; its tooltip and the screen-reader text list all.
 */
function Indicators({ p, single = false }: { p: ProcessListItem; single?: boolean }) {
  const items: { key: string; icon: ReactNode; label: string; className: string }[] = [];
  if (p.needsVerification)
    items.push({ key: "verif", icon: <SearchCheck />, label: "Pendente de conferência", className: "text-amber-600" });
  if (!p.isCnjFormat)
    items.push({ key: "cnj", icon: <TriangleAlert />, label: "Fora do padrão CNJ", className: "text-amber-600" });
  if (p.isConfidential) items.push({ key: "conf", icon: <Lock />, label: "Sigiloso", className: "text-primary-700" });
  if (items.length === 0) return null;
  const shown = single ? items.slice(0, 1) : items;
  const allLabels = items.map((i) => i.label).join(", ");
  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      {shown.map((i) => (
        <span
          key={i.key}
          title={single ? allLabels : i.label}
          className={cn("inline-flex [&_svg]:size-3.5", i.className)}
        >
          <span aria-hidden="true" className="inline-flex">
            {i.icon}
          </span>
          <span className="sr-only">{single ? allLabels : i.label}</span>
        </span>
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Sortable headers
// ---------------------------------------------------------------------------

/** First click applies `first`; a second click on an active column applies `second` (or back to the default order). */
const SORTABLE: Record<"number" | "claim" | "liquidated", { first: ProcessSort; second: ProcessSort; firstHint: string; secondHint: string }> = {
  number: { first: "number_asc", second: "updated_desc", firstHint: "Ordenar por número (CNJ)", secondHint: "Voltar à ordem padrão" },
  claim: { first: "claim_desc", second: "claim_asc", firstHint: "Ordenar do maior para o menor", secondHint: "Ordenar do menor para o maior" },
  liquidated: {
    first: "liquidated_desc",
    second: "liquidated_asc",
    firstHint: "Ordenar do maior para o menor",
    secondHint: "Ordenar do menor para o maior",
  },
};

const ASCENDING: readonly ProcessSort[] = ["number_asc", "claim_asc", "liquidated_asc"];

function SortableHead({
  label,
  column,
  sort,
  className,
  align = "left",
}: {
  label: string;
  column: keyof typeof SORTABLE;
  sort?: PortfolioSortControl;
  className?: string;
  align?: "left" | "right";
}) {
  if (!sort) return <TableHead className={className}>{label}</TableHead>;
  const spec = SORTABLE[column];
  const active = sort.current === spec.first || (column !== "number" && sort.current === spec.second);
  const next = sort.current === spec.first ? spec.second : spec.first;
  const hint = sort.current === spec.first ? spec.secondHint : spec.firstHint;
  const ariaSort = active ? (ASCENDING.includes(sort.current) ? "ascending" : "descending") : undefined;
  const Icon = !active ? ArrowUpDown : ariaSort === "ascending" ? ArrowUp : ArrowDown;
  return (
    <TableHead className={className} aria-sort={ariaSort}>
      <Link
        href={sort.href(next)}
        title={hint}
        className={cn(
          "inline-flex items-center gap-1 rounded-sm hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          align === "right" && "flex-row-reverse",
          active && "text-slate-900",
        )}
      >
        {label}
        <Icon aria-hidden="true" className={cn("size-3.5 shrink-0", !active && "text-slate-400")} />
        <span className="sr-only">. {hint}</span>
      </Link>
    </TableHead>
  );
}

// ---------------------------------------------------------------------------
// Table (wide screens) + cards (narrow screens)
// ---------------------------------------------------------------------------

/**
 * Cidade/UF has its own column from 1440 px; below that it is a muted second
 * line under the tribunal, so it is never hidden from 1280 px on. The company
 * (only with more than one active company) is always a muted second line under
 * the autor. The money columns are always visible.
 */
const CITY_COLUMN = "hidden min-[1440px]:table-cell";
const CITY_LINE = "min-[1440px]:hidden";

/** Muted second line of a header or a cell. */
function SecondLine({ className, children }: { className?: string; children: ReactNode }) {
  return <span className={cn("block truncate font-normal text-muted-foreground", className)}>{children}</span>;
}

/**
 * Portfolio list: one row per process on wide screens (no horizontal scroll at
 * 1280 px, the money columns always visible) and one card per process below
 * that. Valor da causa and valor apurado are separate columns and never added
 * together; a null valor apurado reads "Não apurado", never zero.
 */
export function PortfolioTable({ items, emptyDescription, showCompany = false, sort }: PortfolioTableProps) {
  return (
    <>
      <Table aria-label="Carteira de processos" containerClassName="hidden xl:block" className="table-fixed text-xs">
        <TableHeader>
          <TableRow>
            <SortableHead label="Processo (CNJ)" column="number" sort={sort} className="w-[13.5rem] pr-2" />
            <TableHead className="px-2 leading-4">
              Autor
              {showCompany ? <SecondLine>Empresa</SecondLine> : null}
            </TableHead>
            <TableHead className="w-32 px-2 leading-4">
              Tribunal · instância
              <SecondLine className={CITY_LINE}>Cidade/UF</SecondLine>
            </TableHead>
            <TableHead className={cn("w-28 px-2", CITY_COLUMN)}>Cidade/UF</TableHead>
            <TableHead className="w-[6.5rem] px-2">Fase</TableHead>
            <SortableHead label="Valor da causa" column="claim" sort={sort} align="right" className="w-28 px-2 text-right" />
            <SortableHead label="Valor apurado" column="liquidated" sort={sort} align="right" className="w-28 px-2 text-right" />
            <TableHead className="w-[7.5rem] pl-2 min-[1360px]:w-40">Responsável</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.length === 0 ? (
            <TableEmpty colSpan={8} message="Nenhum processo encontrado." description={emptyDescription} />
          ) : (
            items.map((p) => {
              const plaintiff = plaintiffText(p);
              const court = courtText(p);
              const city = cityWithState(p.city, p.state);
              const responsible = responsibleText(p);
              return (
                <TableRow key={p.id} interactive>
                  <TableCell className="py-2 pr-2">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <Link
                        href={`/processos/${p.id}`}
                        className={cn(tableLinkClasses, "truncate font-mono text-xs whitespace-nowrap")}
                        title={`${p.number}. ${p.title}`}
                      >
                        {p.number}
                      </Link>
                      <Indicators p={p} single />
                    </span>
                  </TableCell>
                  <TableCell className="px-2 py-2" title={plaintiffTitle(p, showCompany)}>
                    <PlaintiffLine plaintiff={plaintiff} />
                    {showCompany ? <SecondLine>{p.companyName ?? NOT_INFORMED}</SecondLine> : null}
                  </TableCell>
                  <TableCell className="px-2 py-2" title={courtTitle(p)}>
                    <span className="block truncate">{court ?? <Muted>{NOT_INFORMED}</Muted>}</span>
                    <SecondLine className={CITY_LINE}>{city ?? NOT_INFORMED}</SecondLine>
                  </TableCell>
                  <TableCell className={cn("truncate px-2 py-2 whitespace-nowrap", CITY_COLUMN)} title={city ?? undefined}>
                    {city ?? <Muted>{NOT_INFORMED}</Muted>}
                  </TableCell>
                  <TableCell className="truncate px-2 py-2 whitespace-nowrap">
                    <PhaseText p={p} />
                  </TableCell>
                  <TableCell className="px-2 py-2 text-right whitespace-nowrap tabular-nums">
                    <Money cents={p.claimAmountCents} empty={NOT_INFORMED} />
                  </TableCell>
                  <TableCell className="px-2 py-2 text-right whitespace-nowrap tabular-nums">
                    <Money cents={p.liquidatedAmountCents} empty="Não apurado" />
                  </TableCell>
                  <TableCell className="truncate py-2 pl-2 whitespace-nowrap" title={responsible.title ?? responsible.text ?? undefined}>
                    {responsible.text ?? <Muted>{NOT_INFORMED}</Muted>}
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>

      <PortfolioCards items={items} emptyDescription={emptyDescription} showCompany={showCompany} />
    </>
  );
}

function PortfolioCards({ items, emptyDescription, showCompany }: Required<Omit<PortfolioTableProps, "sort">>) {
  if (items.length === 0) {
    return (
      <div className="px-5 py-10 text-center xl:hidden">
        <p className="font-medium text-slate-700">Nenhum processo encontrado.</p>
        <p className="mt-1 text-sm text-muted-foreground">{emptyDescription}</p>
      </div>
    );
  }
  return (
    <ul aria-label="Carteira de processos" className="divide-y divide-border xl:hidden">
      {items.map((p) => {
        const plaintiff = plaintiffText(p);
        const court = courtText(p);
        const city = cityWithState(p.city, p.state);
        const responsible = responsibleText(p);
        const where = [court, city].filter((v): v is string => Boolean(v));
        return (
          <li key={p.id} className="relative px-4 py-3 hover:bg-slate-50 sm:px-5">
            <div className="flex flex-col gap-2 min-[1200px]:flex-row min-[1200px]:items-center min-[1200px]:gap-6">
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-3">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <Link
                      href={`/processos/${p.id}`}
                      className={cn(
                        tableLinkClasses,
                        "truncate font-mono text-xs after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-ring",
                      )}
                    >
                      {p.number}
                    </Link>
                    <Indicators p={p} />
                  </span>
                  <span className="shrink-0 text-xs">
                    <PhaseText p={p} />
                  </span>
                </div>
                <p className="mt-1 text-sm font-medium text-slate-900" title={plaintiffTitle(p, showCompany)}>
                  <PlaintiffLine plaintiff={plaintiff} empty="Autor não informado" />
                </p>
                <p className="truncate text-xs text-muted-foreground" title={courtTitle(p)}>
                  {where.length > 0 ? where.join(" · ") : "Tribunal não informado"}
                  {showCompany && p.companyName ? ` · ${p.companyName}` : null}
                </p>
              </div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3 min-[1200px]:w-[30rem] min-[1200px]:shrink-0">
                <div className="min-w-0">
                  <dt className="text-xs text-muted-foreground">Valor da causa</dt>
                  <dd className="tabular-nums whitespace-nowrap">
                    <Money cents={p.claimAmountCents} empty={NOT_INFORMED} />
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-xs text-muted-foreground">Valor apurado</dt>
                  <dd className="tabular-nums whitespace-nowrap">
                    <Money cents={p.liquidatedAmountCents} empty="Não apurado" />
                  </dd>
                </div>
                <div className="col-span-2 min-w-0 sm:col-span-1">
                  <dt className="text-xs text-muted-foreground">{p.responsibleName || !p.lawFirmName ? "Responsável" : "Escritório"}</dt>
                  <dd className="truncate" title={responsible.title}>
                    {responsible.text ?? <Muted>{NOT_INFORMED}</Muted>}
                  </dd>
                </div>
              </dl>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
