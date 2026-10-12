import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DescriptionList } from "@/components/ui/description-list";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDate, formatDateTime, formatNumber } from "@/lib/format";
import type { CourtRecord } from "@/server/integrations/courts/types";
import { grauText } from "../labels";
import { describeComplements } from "../mapping";

const MOVEMENTS_SHOWN = 80;

/**
 * Normalized official data of one number, per grau, exactly as informed by the
 * DataJud (server component, read-only, nothing is saved).
 */
export function CourtRecordView({ records }: { records: CourtRecord[] }) {
  return (
    <div className="flex flex-col gap-6">
      {records.map((r) => {
        const movements = [...r.movements].reverse();
        const shown = movements.slice(0, MOVEMENTS_SHOWN);
        return (
          <Card key={`${r.alias}-${r.grau}`} className="pb-0">
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2">
                {grauText(r.grau)} · {r.tribunal}
                <Badge tone="info">{r.grau}</Badge>
              </CardTitle>
              <CardDescription>
                Atualizado no tribunal em {r.remoteUpdatedAt ? formatDateTime(r.remoteUpdatedAt) : "data não informada"}.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <DescriptionList
                columns={3}
                items={[
                  { label: "Classe", value: r.processClass ? r.processClass.name : "Não informada" },
                  { label: "Órgão julgador", value: r.courtDivision ? r.courtDivision.name : "Não informado" },
                  { label: "Data de ajuizamento", value: r.filedAt ? formatDate(r.filedAt) : "Não informada" },
                  { label: "Sistema e formato", value: [r.system, r.format].filter(Boolean).join(", ") || "Não informados" },
                  { label: "Nível de sigilo", value: r.secrecyLevel === null ? "Não informado" : String(r.secrecyLevel) },
                  { label: "Movimentações", value: formatNumber(r.movements.length) },
                  {
                    label: "Assuntos (tabela do CNJ)",
                    value: r.subjects.length ? r.subjects.map((s) => `${s.name} (${s.code})`).join("; ") : "Não informados",
                    full: true,
                  },
                ]}
              />
            </CardContent>
            <CardContent className="px-0">
              <Table aria-label={`Movimentações do ${grauText(r.grau)} (${r.tribunal})`}>
                <TableHeader>
                  <TableRow>
                    <TableHead>Data</TableHead>
                    <TableHead>Movimentação</TableHead>
                    <TableHead>Complementos</TableHead>
                    <TableHead className="text-right">Código CNJ</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shown.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={4} className="text-sm text-muted-foreground">
                        Nenhuma movimentação informada.
                      </TableCell>
                    </TableRow>
                  ) : (
                    shown.map((m, i) => (
                      <TableRow key={`${m.code}-${m.dateTime}-${i}`} className="align-top">
                        <TableCell className="whitespace-nowrap tabular-nums">{formatDate(m.dateTime.slice(0, 10))}</TableCell>
                        <TableCell className="min-w-48 font-medium text-slate-900">{m.name}</TableCell>
                        <TableCell className="min-w-56 text-sm text-slate-700">{describeComplements(m.complements) ?? "Sem complementos"}</TableCell>
                        <TableCell className="text-right tabular-nums">{m.code ?? "Sem código"}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
              {movements.length > shown.length ? (
                <p className="px-5 py-3 text-xs text-muted-foreground">
                  Mostrando as {formatNumber(shown.length)} mais recentes de {formatNumber(movements.length)} movimentações.
                </p>
              ) : null}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
