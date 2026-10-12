import { TrendingUp } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTime, formatNumber } from "@/lib/format";
import type { Tone } from "@/lib/tones";
import type { AuthContext } from "@/server/auth/context";
import { can } from "@/server/auth/permissions";
import { INDEX_SERIES_CATALOG } from "../catalog";
import { addMonths, formatMonth, formatMonthRanges } from "../math";
import { getIndexSeriesOverview, type IndexSeriesHealth } from "../service";
import { RefreshIndexSeriesButton } from "./refresh-button";

const SELIC_CONFIRMATION_DAY = INDEX_SERIES_CATALOG.find((s) => s.code === "selic")?.confirmationDay ?? 1;

const HEALTH: Record<IndexSeriesHealth, { label: string; tone: Tone }> = {
  ok: { label: "Em dia", tone: "success" },
  awaiting_publication: { label: "Aguardando publicação do último mês", tone: "info" },
  behind: { label: "Atrasada", tone: "warning" },
  gaps: { label: "Meses faltando na série", tone: "warning" },
  failed: { label: "Falha na última coleta", tone: "danger" },
  empty: { label: "Sem dados coletados", tone: "neutral" },
};

/**
 * Card for /admin/integracoes (wired by the integrator): automatic collection
 * of the correction index series from the Banco Central (SGS). Shows, per
 * series, the months stored, the last collection and the last failure.
 * `admin:organization` only; renders nothing otherwise.
 */
export async function IndexSeriesCard({ ctx }: { ctx: AuthContext }) {
  if (!can(ctx, "admin:organization")) return null;
  const overview = await getIndexSeriesOverview(ctx);
  const failures = overview.series.filter((s) => s.health === "failed").length;

  return (
    <Card className="pb-0">
      <CardHeader actions={<RefreshIndexSeriesButton />}>
        <CardTitle className="flex items-center gap-2">
          <TrendingUp aria-hidden="true" className="size-4 text-muted-foreground" />
          Índices de correção: Banco Central (SGS)
        </CardTitle>
        <CardDescription>
          Coleta automática diária das taxas mensais na API pública do Banco Central, usadas para mostrar o valor atualizado
          de cada valor registrado. Nenhuma taxa é digitada à mão e um mês gravado não é reescrito.
          {` O mês corrente nunca é gravado, e a Selic acumulada de um mês só é gravada a partir do dia ${SELIC_CONFIRMATION_DAY} do mês seguinte, quando as taxas diárias do mês inteiro já foram publicadas.`}
          {" Meses que faltarem no meio de uma série são consultados de novo nas próximas execuções."}
          {overview.routine
            ? ` Rotina ${overview.routine.enabled ? "ativa" : "desativada"}; última execução: ${formatDateTime(overview.routine.lastRunAt, "ainda não executada")}.`
            : " Rotina ainda não criada para esta organização (o worker cria as rotinas padrão)."}
          {failures > 0 ? ` ${failures === 1 ? "1 série com falha" : `${failures} séries com falha`} na última coleta.` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        <Table aria-label="Séries de índices de correção">
          <TableHeader>
            <TableRow>
              <TableHead>Índice</TableHead>
              <TableHead>Série no SGS</TableHead>
              <TableHead className="text-right">Meses gravados</TableHead>
              <TableHead>Último mês</TableHead>
              <TableHead>Última coleta</TableHead>
              <TableHead>Situação</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {overview.series.map((s) => (
              <TableRow key={s.code} className="align-top">
                <TableCell className="min-w-40">
                  <span className="block font-medium text-slate-900">{s.label}</span>
                  <span className="block text-xs text-muted-foreground">
                    {s.publisher}, {s.unit.toLowerCase()}
                  </span>
                </TableCell>
                <TableCell className="min-w-48 text-sm">
                  <span className="block tabular-nums">{s.sgsCode}</span>
                  <span className="block text-xs text-muted-foreground">{s.name}</span>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatNumber(s.monthsStored)}
                  {s.firstMonth ? <span className="block text-xs text-muted-foreground">desde {formatMonth(s.firstMonth)}</span> : null}
                </TableCell>
                <TableCell className="whitespace-nowrap tabular-nums">
                  {formatMonth(s.lastMonth, "Nenhum")}
                  <span className="block text-xs text-muted-foreground">{`coletável hoje: ${formatMonth(s.lastStorableMonth)}`}</span>
                </TableCell>
                <TableCell className="min-w-40 text-xs text-slate-600">
                  <span className="block">Sucesso: {formatDateTime(s.lastFetchedAt, "nunca")}</span>
                  <span className="block">Tentativa: {formatDateTime(s.lastAttemptAt, "nunca")}</span>
                </TableCell>
                <TableCell className="min-w-56">
                  <StatusBadge
                    label={
                      s.health === "awaiting_publication" && s.lastMonth
                        ? `Aguardando ${formatMonth(addMonths(s.lastMonth, 1))}`
                        : HEALTH[s.health].label
                    }
                    tone={HEALTH[s.health].tone}
                  />
                  {s.gapMonths.length > 0 ? (
                    <span className="mt-1 block text-xs text-amber-800">
                      {`Sem taxa: ${formatMonthRanges(s.gapMonths)}. Valores que dependem desses meses aparecem como atualização indisponível.`}
                    </span>
                  ) : null}
                  {s.lastError ? (
                    <span className="mt-1 block text-xs text-red-800">
                      {s.lastError}
                      {s.lastErrorAt ? ` (${formatDateTime(s.lastErrorAt)})` : ""}
                    </span>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
