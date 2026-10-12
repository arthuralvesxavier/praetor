import Link from "next/link";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow, tableLinkClasses } from "@/components/ui/table";
import { cellDisplayText } from "@/domain/legal-reports";
import { cn } from "@/lib/utils";
import {
  dateTimeLabel,
  gapEntries,
  itemNotes,
  reportLayout,
  reportOutline,
  sectionBlocks,
  standardMethodology,
  type ItemView,
  type ReportView,
  type SectionBlock,
  type SectionView,
} from "../view";
import { OriginSeal } from "./report-badges";

/**
 * Conteúdo de um relatório (mesma visão e mesma ordem do PDF): nota
 * metodológica, seções, pendências e fontes. Server component.
 */

const UNCONFIRMED_RULE_TEXT = "Fontes que a conferência automática não confirmou. Nunca servem de base para afirmações.";

function ItemTable({ item }: { item: ItemView }) {
  const data = item.data;
  if (!data || data.kind !== "table") return null;
  return (
    <div className="mt-2 max-h-96 overflow-auto rounded-md border border-border">
      <Table aria-label={item.content}>
        <TableHeader>
          <TableRow>
            {data.columns.map((c) => (
              <TableHead key={c.header} className={cn(c.align === "right" && "text-right")}>
                {c.header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.rows.map((row, i) => (
            <TableRow key={i}>
              {row.map((cell, j) => (
                <TableCell
                  key={j}
                  className={cn(
                    data.columns[j]?.align === "right" && "text-right tabular-nums",
                    (cell === null || cell === "") && "text-muted-foreground italic",
                  )}
                >
                  {cellDisplayText(cell, data.columns[j] ?? {})}
                </TableCell>
              ))}
            </TableRow>
          ))}
          {data.totals ? (
            <TableRow className="bg-gold-50 font-medium">
              {data.totals.map((cell, j) => (
                <TableCell key={j} className={cn(data.columns[j]?.align === "right" && "text-right tabular-nums")}>
                  {j === 0 ? (cell ?? "Totais") : (cell ?? "")}
                </TableCell>
              ))}
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
      {data.note ? <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">{data.note}</p> : null}
    </div>
  );
}

function ItemRow({ item, pending = false }: { item: ItemView; pending?: boolean }) {
  const notes = itemNotes(item);
  const showExcerpt = item.origin === "documented" && item.excerpt && !item.source?.sensitive;
  return (
    <li className="flex flex-col gap-2 py-3 sm:flex-row sm:gap-4">
      <div className="flex shrink-0 items-center gap-2 sm:w-32 sm:flex-col sm:items-start sm:gap-1">
        <OriginSeal origin={item.origin} />
        <span className="text-xs text-muted-foreground tabular-nums">Item {item.number}</span>
      </div>
      <div className="min-w-0 flex-1">
        {pending && item.pendingReason ? (
          <p className="mb-1 text-xs font-medium text-amber-800">
            Não afirmado. Motivo: {item.pendingReason} Seção de origem: {item.sectionTitle}.
          </p>
        ) : null}
        <p className={cn("text-sm text-foreground", item.origin === "gap" && "font-medium text-red-800")}>
          {item.data?.kind === "table" ? item.content : item.displayText}
        </p>
        {showExcerpt ? (
          <blockquote className="mt-2 border-l-2 border-gold-400 pl-3 font-display text-base leading-snug text-foreground">
            “{item.excerpt}”
          </blockquote>
        ) : null}
        <ItemTable item={item} />
        {notes.length ? (
          <ul className="mt-1.5 space-y-0.5 text-xs text-muted-foreground">
            {notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </li>
  );
}

/** Linhas consecutivas do mesmo grupo (ex.: linha do tempo): uma tabela com o selo de cada linha. */
function RowsTable({ block }: { block: Extract<SectionBlock, { kind: "rows" }> }) {
  return (
    <li className="py-3">
      {block.caption ? <p className="mb-2 text-sm font-medium text-foreground">{block.caption}</p> : null}
      <div className="max-h-[32rem] overflow-auto rounded-md border border-border">
        <Table aria-label={block.caption ?? "Itens do relatório"}>
          <TableHeader>
            <TableRow>
              <TableHead>Origem</TableHead>
              <TableHead>Item</TableHead>
              {block.columns.map((c) => (
                <TableHead key={c.header} className={cn(c.align === "right" && "text-right")}>
                  {c.header}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {block.items.map((item) => {
              const cells = item.data?.kind === "row" ? item.data.cells : [];
              return (
                <TableRow key={item.id}>
                  <TableCell>
                    <OriginSeal origin={item.origin} />
                  </TableCell>
                  <TableCell className="text-xs tabular-nums text-muted-foreground">{item.number}</TableCell>
                  {block.columns.map((c, j) => (
                    <TableCell
                      key={c.header}
                      className={cn(
                        "min-w-28",
                        c.align === "right" && "text-right tabular-nums",
                        (cells[j] === null || cells[j] === "") && "text-muted-foreground italic",
                      )}
                    >
                      {cellDisplayText(cells[j] ?? null, c)}
                    </TableCell>
                  ))}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">
        Cada linha é um item do relatório, com a própria origem. Os documentos citados estão nas fontes, pelo número do item.
      </p>
    </li>
  );
}

function SectionCard({ section }: { section: SectionView }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">
          <span className="mr-2 text-gold-700 tabular-nums">{section.number}</span>
          {section.title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {section.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nenhum item afirmado nesta seção (ver Pendências do relatório).</p>
        ) : (
          <ul className="divide-y divide-border">
            {sectionBlocks(section.items).map((b) =>
              b.kind === "rows" ? <RowsTable key={`${b.group}-${b.items[0].id}`} block={b} /> : <ItemRow key={b.item.id} item={b.item} />,
            )}
          </ul>
        )}
        {section.note ? (
          <Callout tone="info" className="mt-3">
            {section.note}
          </Callout>
        ) : null}
      </CardContent>
    </Card>
  );
}

function MethodologyCard({ view, number }: { view: ReportView; number: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">
          <span className="mr-2 text-gold-700">{number}</span>Nota metodológica
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-2 text-sm text-foreground">
        {[...view.parameters.methodology, ...standardMethodology(view)].map((p) => (
          <p key={p}>{p}</p>
        ))}
      </CardContent>
    </Card>
  );
}

function PendingCard({ view, number, listGaps }: { view: ReportView; number: string | null; listGaps: boolean }) {
  const gaps = listGaps ? gapEntries(view) : [];
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">
          {number ? <span className="mr-2 text-gold-700 tabular-nums">{number}</span> : null}
          Pendências do relatório
        </CardTitle>
        <CardDescription>
          Itens que o relatório NÃO afirma: confiança abaixo do limite, fonte não confirmada ou base pendente. Precisam de conferência humana.
          {listGaps ? " Também lista os dados não localizados na base." : ""}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {view.pendingItems.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nenhuma pendência.</p>
        ) : (
          <ul className="divide-y divide-border">
            {view.pendingItems.map((item) => (
              <ItemRow key={item.id} item={item} pending />
            ))}
          </ul>
        )}
        {gaps.length > 0 ? (
          <div className="mt-4">
            <p className="mb-2 text-sm font-medium text-foreground">Dados não localizados</p>
            <ul className="space-y-1 text-sm">
              {gaps.map((g) => (
                <li key={g.key}>
                  <span className="mr-2 text-xs tabular-nums text-muted-foreground">Item {g.number}</span>
                  <span className="font-medium text-red-800">{g.text}</span>
                  <span className="text-xs text-muted-foreground"> ({g.sectionTitle})</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function SourcesCard({ view, number, title }: { view: ReportView; number: string | null; title: string }) {
  const confirmed = view.sources.filter((s) => s.confirmed);
  return (
    <Card className="py-0">
      <CardHeader className="pt-6">
        <CardTitle as="h2">
          {number ? <span className="mr-2 text-gold-700 tabular-nums">{number}</span> : null}
          {title}
        </CardTitle>
        <CardDescription>Documentos conferidos automaticamente (página e trecho) e registros do cadastro lidos na geração.</CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        <Table aria-label={title}>
          <TableHeader>
            <TableRow>
              <TableHead>Ref.</TableHead>
              <TableHead>Fonte</TableHead>
              <TableHead>Item</TableHead>
              <TableHead>Conferida em</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {confirmed.length === 0 ? (
              <TableEmpty colSpan={4} message="Nenhuma fonte confirmada." />
            ) : (
              confirmed.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-medium tabular-nums">{s.reference}</TableCell>
                  <TableCell className="min-w-64">
                    {s.url ? (
                      <Link href={s.url} className={tableLinkClasses}>
                        {s.source}
                      </Link>
                    ) : (
                      s.source
                    )}
                    {s.sensitive ? <span className="block text-xs text-muted-foreground">Documento sensível: só referenciado.</span> : null}
                  </TableCell>
                  <TableCell className="tabular-nums">{s.itemNumber ?? "Vários"}</TableCell>
                  <TableCell className="whitespace-nowrap">{dateTimeLabel(s.checkedAt)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function UnconfirmedCard({ view, title, description }: { view: ReportView; title: string; description: string }) {
  const unconfirmed = view.sources.filter((s) => !s.confirmed);
  return (
    <Card className="py-0">
      <CardHeader className="pt-6">
        <CardTitle as="h2">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        <Table aria-label="Fontes não confirmadas">
          <TableHeader>
            <TableRow>
              <TableHead>Ref.</TableHead>
              <TableHead>Fonte citada</TableHead>
              <TableHead>Motivo</TableHead>
              <TableHead>Item</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {unconfirmed.length === 0 ? (
              <TableEmpty colSpan={4} message="Todas as fontes documentais citadas foram confirmadas." />
            ) : (
              unconfirmed.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-medium tabular-nums">{s.reference}</TableCell>
                  <TableCell className="min-w-56">{s.source}</TableCell>
                  <TableCell className="min-w-56">{s.notConfirmedReason ?? "Não confirmada."}</TableCell>
                  <TableCell className="tabular-nums">{s.itemNumber ?? "Vários"}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

export function LegalReportContent({ view }: { view: ReportView }) {
  const processReport = reportLayout(view) === "process_report";
  return (
    <div className="grid gap-6">
      {reportOutline(view).map((entry) => {
        switch (entry.kind) {
          case "methodology":
            return <MethodologyCard key="methodology" view={view} number={entry.number} />;
          case "section":
            return <SectionCard key={entry.section.key} section={entry.section} />;
          case "pending":
            return <PendingCard key="pending" view={view} number={processReport ? entry.number : null} listGaps={processReport} />;
          case "sources":
            return processReport ? (
              <div key="sources" className="grid gap-4">
                <SourcesCard view={view} number={entry.number} title="Auditoria de fontes: verificado" />
                <UnconfirmedCard
                  view={view}
                  title="Auditoria de fontes: não confirmado"
                  description={`${UNCONFIRMED_RULE_TEXT} Os itens que dependiam delas estão em Pendências do relatório.`}
                />
              </div>
            ) : (
              <SourcesCard key="sources" view={view} number={null} title="Fontes consultadas" />
            );
          case "unconfirmed":
            return <UnconfirmedCard key="unconfirmed" view={view} title="Não confirmado" description={UNCONFIRMED_RULE_TEXT} />;
        }
      })}
    </div>
  );
}
