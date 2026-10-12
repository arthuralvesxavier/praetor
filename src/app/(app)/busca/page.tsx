import { ArrowRight, FileSignature, FileText, Scale, Search, SearchX, ShieldCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { RiskBadge } from "@/components/ui/risk-badge";
import { StatusBadge } from "@/components/ui/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, tableLinkClasses } from "@/components/ui/table";
import {
  CONTRACT_STATUS_LABELS,
  DOCUMENT_CATEGORY_LABELS,
  OCCURRENCE_CATEGORY_LABELS,
  OCCURRENCE_STATUS_LABELS,
  PROCESS_STATUS_LABELS,
} from "@/domain/enums";
import { formatDate, formatNumber } from "@/lib/format";
import { param, type SearchParams } from "@/lib/search-params";
import { CONTRACT_STATUS_TONES, OCCURRENCE_STATUS_TONES, PROCESS_STATUS_TONES } from "@/lib/tones";
import { requirePageContext } from "@/server/auth/session";
import {
  SEARCH_MAX_LENGTH,
  SEARCH_MIN_LENGTH,
  countSearchHits,
  normalizeSearchQuery,
  runGlobalSearch,
  type GlobalSearchResult,
} from "./search";

export const metadata: Metadata = { title: "Busca" };

function listHref(base: string, q: string, extra: Record<string, string> = {}): string {
  return `${base}?${new URLSearchParams({ q, ...extra }).toString()}`;
}

function plural(n: number, one: string, many: string): string {
  return `${formatNumber(n)} ${n === 1 ? one : many}`;
}

/**
 * Global search across the records the user can see: processes (CNJ with or
 * without punctuation, title, court, party), documents, contracts and
 * preventive occurrences. Each section follows its own permission.
 */
export default async function SearchPage(props: { searchParams: Promise<SearchParams> }) {
  const ctx = await requirePageContext("process:read");
  const sp = await props.searchParams;
  const query = normalizeSearchQuery(param(sp, "q"));
  const result = query ? await runGlobalSearch(ctx, query) : null;
  const hits = result && !result.tooShort ? countSearchHits(result) : 0;

  return (
    <>
      <PageHeader
        title="Busca"
        description="Procure na carteira de processos, documentos, contratos e ocorrências que o seu perfil pode acessar."
      />

      <form
        method="get"
        action="/busca"
        role="search"
        aria-label="Busca na plataforma"
        className="mb-6 flex flex-col gap-2 rounded-lg border border-border bg-surface p-3 shadow-xs sm:flex-row sm:items-center"
      >
        <label htmlFor="busca-q" className="sr-only">
          Termo de busca
        </label>
        <div className="relative min-w-0 flex-1">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-500"
          />
          <input
            id="busca-q"
            name="q"
            type="search"
            defaultValue={query}
            required
            minLength={SEARCH_MIN_LENGTH}
            maxLength={SEARCH_MAX_LENGTH}
            autoComplete="off"
            spellCheck={false}
            autoFocus={!query}
            aria-describedby="busca-q-dica"
            placeholder="Ex.: 0001234-73.2024.5.10.0001, nome da parte, vara ou título"
            className="h-10 w-full rounded-md border border-border-strong bg-white pr-3 pl-9 text-sm text-slate-900 shadow-xs placeholder:text-slate-500 focus-visible:border-primary-500 focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring"
          />
        </div>
        <Button type="submit" size="lg">
          <Search aria-hidden="true" />
          Buscar
        </Button>
        <p id="busca-q-dica" className="sr-only">
          Número CNJ com ou sem pontuação, nome de parte, título, tribunal ou vara. Mínimo de {SEARCH_MIN_LENGTH}{" "}
          caracteres.
        </p>
      </form>

      {!result ? (
        <EmptyState
          icon={<Search />}
          title="O que você procura?"
          description={
            <>
              Digite o número CNJ (com ou sem pontuação), o nome de uma parte, o título, o tribunal ou a vara. Atalho:
              tecle <kbd className="rounded border border-border-strong bg-white px-1 text-xs">/</kbd> em qualquer tela.
            </>
          }
        />
      ) : result.tooShort ? (
        <Callout tone="warning" title="Termo muito curto">
          Digite ao menos {SEARCH_MIN_LENGTH} caracteres para buscar.
        </Callout>
      ) : (
        <SearchResults result={result} hits={hits} />
      )}
    </>
  );
}

function SearchResults({ result, hits }: { result: GlobalSearchResult; hits: number }) {
  const q = result.query;
  return (
    <div className="flex flex-col gap-5">
      <p role="status" className="text-sm text-muted-foreground">
        {hits === 0 ? (
          <>Nenhum resultado para “{q}”.</>
        ) : (
          <>
            {plural(hits, "resultado", "resultados")} para <span className="font-semibold text-slate-900">“{q}”</span>
            {result.processes?.limited ? " (processos: primeiros 20)" : ""}.
          </>
        )}
      </p>

      {hits === 0 ? (
        <EmptyState
          icon={<SearchX />}
          title="Nenhum registro encontrado"
          description="Confira a grafia ou busque por outra informação (número CNJ, parte, tribunal, vara). Registros fora do seu perfil de acesso não aparecem."
        />
      ) : null}

      {result.processes && result.processes.items.length > 0 ? (
        <ResultCard
          icon={<Scale />}
          title="Processos"
          count={result.processes.limited ? `${result.processes.items.length}+` : String(result.processes.items.length)}
          description="Carteira ativa e encerrada (todas as instâncias do mesmo CNJ ficam no mesmo processo)."
          moreHref={listHref("/processos", q, { carteira: "todas" })}
          moreLabel="Abrir na carteira de processos"
        >
          <Table aria-label="Processos encontrados">
            <TableHeader>
              <TableRow>
                <TableHead>Número (CNJ)</TableHead>
                <TableHead className="hidden sm:table-cell">Título</TableHead>
                <TableHead className="hidden md:table-cell">Tribunal / órgão</TableHead>
                <TableHead className="hidden sm:table-cell">Situação</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.processes.items.map((p) => (
                <TableRow key={p.id} interactive>
                  <TableCell className="whitespace-nowrap">
                    <Link href={`/processos/${p.id}`} className={`${tableLinkClasses} tabular-nums`}>
                      {p.number}
                    </Link>
                    <span className="mt-1 block max-w-[16rem] text-sm whitespace-normal text-slate-700 sm:hidden">
                      <span className="line-clamp-2">{p.title}</span>
                      <span className="block text-xs text-muted-foreground">{p.court}</span>
                      <span className="mt-1 block">
                        <StatusBadge label={PROCESS_STATUS_LABELS[p.status]} tone={PROCESS_STATUS_TONES[p.status]} />
                      </span>
                    </span>
                  </TableCell>
                  <TableCell className="hidden min-w-48 sm:table-cell">
                    <span className="line-clamp-2">{p.title}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground md:hidden">{p.court}</span>
                  </TableCell>
                  <TableCell className="hidden text-slate-700 md:table-cell">{p.court}</TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <StatusBadge label={PROCESS_STATUS_LABELS[p.status]} tone={PROCESS_STATUS_TONES[p.status]} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ResultCard>
      ) : null}

      {result.documents && result.documents.items.length > 0 ? (
        <ResultCard
          icon={<FileText />}
          title="Documentos"
          count={formatNumber(result.documents.total)}
          description="Título, descrição ou nome do arquivo. O conteúdo dos documentos não é pesquisado aqui."
          moreHref={result.documents.total > result.documents.items.length ? listHref("/documentos", q) : null}
          moreLabel={`Ver todos os ${formatNumber(result.documents.total)} documentos`}
        >
          <Table aria-label="Documentos encontrados">
            <TableHeader>
              <TableRow>
                <TableHead>Documento</TableHead>
                <TableHead className="hidden sm:table-cell">Categoria</TableHead>
                <TableHead className="hidden lg:table-cell">Vinculado a</TableHead>
                <TableHead className="text-right">Atualizado em</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.documents.items.map((d) => (
                <TableRow key={d.id} interactive>
                  <TableCell className="min-w-48">
                    <Link href={`/documentos/${d.id}`} className={tableLinkClasses}>
                      {d.title}
                    </Link>
                    {d.fileName ? (
                      <span className="block truncate text-xs text-muted-foreground">{d.fileName}</span>
                    ) : null}
                  </TableCell>
                  <TableCell className="hidden text-slate-700 sm:table-cell">
                    {DOCUMENT_CATEGORY_LABELS[d.category]}
                  </TableCell>
                  <TableCell className="hidden max-w-xs text-slate-700 lg:table-cell">
                    {d.linkedTo.length > 0 ? <span className="line-clamp-2">{d.linkedTo.join(" · ")}</span> : <span className="text-muted-foreground">Sem vínculo</span>}
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap tabular-nums">{formatDate(d.updatedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ResultCard>
      ) : null}

      {result.contracts && result.contracts.items.length > 0 ? (
        <ResultCard
          icon={<FileSignature />}
          title="Contratos"
          count={formatNumber(result.contracts.total)}
          moreHref={result.contracts.total > result.contracts.items.length ? listHref("/contratos", q) : null}
          moreLabel={`Ver todos os ${formatNumber(result.contracts.total)} contratos`}
        >
          <Table aria-label="Contratos encontrados">
            <TableHeader>
              <TableRow>
                <TableHead>Contrato</TableHead>
                <TableHead className="hidden sm:table-cell">Contraparte</TableHead>
                <TableHead>Situação</TableHead>
                <TableHead className="hidden text-right md:table-cell">Término</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.contracts.items.map((c) => (
                <TableRow key={c.id} interactive>
                  <TableCell className="min-w-48">
                    <Link href={`/contratos/${c.id}`} className={tableLinkClasses}>
                      {c.title}
                    </Link>
                    <span className="block text-xs text-muted-foreground sm:hidden">{c.counterparty}</span>
                  </TableCell>
                  <TableCell className="hidden text-slate-700 sm:table-cell">{c.counterparty}</TableCell>
                  <TableCell>
                    <StatusBadge label={CONTRACT_STATUS_LABELS[c.status]} tone={CONTRACT_STATUS_TONES[c.status]} />
                  </TableCell>
                  <TableCell className="hidden text-right whitespace-nowrap tabular-nums md:table-cell">
                    {c.endDate ? formatDate(c.endDate) : <span className="text-muted-foreground">Prazo indeterminado</span>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ResultCard>
      ) : null}

      {result.occurrences && result.occurrences.items.length > 0 ? (
        <ResultCard
          icon={<ShieldCheck />}
          title="Ocorrências preventivas"
          count={formatNumber(result.occurrences.total)}
          moreHref={result.occurrences.total > result.occurrences.items.length ? listHref("/preventivo", q) : null}
          moreLabel={`Ver todas as ${formatNumber(result.occurrences.total)} ocorrências`}
        >
          <Table aria-label="Ocorrências encontradas">
            <TableHeader>
              <TableRow>
                <TableHead>Ocorrência</TableHead>
                <TableHead className="hidden sm:table-cell">Categoria</TableHead>
                <TableHead>Situação</TableHead>
                <TableHead className="hidden md:table-cell">Risco</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.occurrences.items.map((o) => (
                <TableRow key={o.id} interactive>
                  <TableCell className="min-w-48">
                    <Link href={`/preventivo/${o.id}`} className={tableLinkClasses}>
                      {o.title}
                    </Link>
                  </TableCell>
                  <TableCell className="hidden text-slate-700 sm:table-cell">
                    {OCCURRENCE_CATEGORY_LABELS[o.category]}
                  </TableCell>
                  <TableCell>
                    <StatusBadge label={OCCURRENCE_STATUS_LABELS[o.status]} tone={OCCURRENCE_STATUS_TONES[o.status]} />
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <RiskBadge level={o.riskLevel} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ResultCard>
      ) : null}
    </div>
  );
}

function ResultCard({
  icon,
  title,
  count,
  description,
  moreHref,
  moreLabel,
  children,
}: {
  icon: ReactNode;
  title: string;
  count: string;
  description?: string;
  moreHref: string | null;
  moreLabel: string;
  children: ReactNode;
}) {
  return (
    <Card className="gap-3 py-0 pt-5">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <span aria-hidden="true" className="inline-flex text-primary-600 [&_svg]:size-4">
            {icon}
          </span>
          {title}
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700 tabular-nums">
            {count}
            <span className="sr-only"> resultado(s)</span>
          </span>
        </CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent className="px-0">{children}</CardContent>
      {moreHref ? (
        <div className="border-t border-border px-5 py-3">
          <Link
            href={moreHref}
            className="inline-flex items-center gap-1 rounded-sm text-sm font-medium text-primary-700 underline-offset-4 hover:text-primary-900 hover:underline"
          >
            {moreLabel}
            <ArrowRight aria-hidden="true" className="size-4" />
          </Link>
        </div>
      ) : null}
    </Card>
  );
}
