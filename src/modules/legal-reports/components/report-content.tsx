import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow, tableLinkClasses } from "@/components/ui/table";
import { cellDisplayText } from "@/domain/legal-reports";
import { cn } from "@/lib/utils";
import { dateTimeLabel, itemNotes, type ItemView, type ReportView } from "../view";
import { OriginSeal } from "./report-badges";

/** Conteúdo de um relatório (mesma visão do PDF): seções, pendências e fontes. Server component. */

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
        <p className={cn("text-sm text-foreground", item.origin === "gap" && "font-medium text-red-800")}>{item.data ? item.content : item.displayText}</p>
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

export function LegalReportContent({ view }: { view: ReportView }) {
  const confirmed = view.sources.filter((s) => s.confirmed);
  const unconfirmed = view.sources.filter((s) => !s.confirmed);
  return (
    <div className="grid gap-6">
      {view.sections.map((section) => (
        <Card key={section.key}>
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
                {section.items.map((item) => (
                  <ItemRow key={item.id} item={item} />
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      ))}

      <Card>
        <CardHeader>
          <CardTitle as="h2">Pendências do relatório</CardTitle>
          <CardDescription>
            Itens que o relatório NÃO afirma: confiança abaixo do limite, fonte não confirmada ou base pendente. Precisam de conferência humana.
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
        </CardContent>
      </Card>

      <Card className="py-0">
        <CardHeader className="pt-6">
          <CardTitle as="h2">Fontes consultadas</CardTitle>
          <CardDescription>Documentos conferidos automaticamente (página e trecho) e registros do cadastro lidos na geração.</CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <Table aria-label="Fontes consultadas">
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

      <Card className="py-0">
        <CardHeader className="pt-6">
          <CardTitle as="h2">Não confirmado</CardTitle>
          <CardDescription>Fontes que a conferência automática não confirmou. Nunca servem de base para afirmações.</CardDescription>
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
    </div>
  );
}
