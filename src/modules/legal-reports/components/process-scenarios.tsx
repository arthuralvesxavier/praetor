import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PROBABILITY_BAND_LABELS, SCENARIO_ORIGIN_LABELS } from "@/domain/enums";
import { formatDateTime } from "@/lib/format";
import { loadOrganization } from "@/modules/analyses/org-settings";
import type { AuthContext } from "@/server/auth/context";
import { can } from "@/server/auth/permissions";
import { listProcessScenarios } from "../scenarios";
import { ScenarioForm } from "./scenario-form";

/**
 * Cenários do processo (faixas de probabilidade), para a ficha do processo.
 * Server component: confere a própria permissão (contingency:read) e mostra o
 * formulário só com contingency:write. Registros datados, nunca sobrescritos.
 *
 *   <ProcessScenarios ctx={ctx} processId={id} />
 */
export async function ProcessScenarios({ ctx, processId }: { ctx: AuthContext; processId: string }) {
  if (!can(ctx, "contingency:read")) return null;
  const [scenarios, org] = await Promise.all([listProcessScenarios(ctx, processId), loadOrganization(ctx.organizationId)]);
  return (
    <Card className="py-0">
      <CardHeader className="pt-6">
        <CardTitle as="h3">Cenários</CardTitle>
        <CardDescription>
          Cenários com faixa de probabilidade, usados nos relatórios jurídicos. Mudou a avaliação? Registre um novo cenário: os
          anteriores ficam no histórico.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        <Table aria-label="Cenários do processo">
          <TableHeader>
            <TableRow>
              <TableHead>Cenário</TableHead>
              <TableHead>Faixa</TableHead>
              <TableHead className="text-right">Percentual</TableHead>
              <TableHead>Registro</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {scenarios.length === 0 ? (
              <TableEmpty colSpan={4} message="Nenhum cenário registrado." />
            ) : (
              scenarios.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="min-w-64">
                    <span className="block">{s.description}</span>
                    {s.comment ? <span className="block text-xs text-muted-foreground">{s.comment}</span> : null}
                  </TableCell>
                  <TableCell>{PROBABILITY_BAND_LABELS[s.probabilityBand]}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {s.percentMin}% a {s.percentMax}%
                  </TableCell>
                  <TableCell className="min-w-40 text-xs text-muted-foreground">
                    {SCENARIO_ORIGIN_LABELS[s.origin]}
                    {s.authorName ? `, ${s.authorName}` : ""}
                    <span className="block">{formatDateTime(s.createdAt, "")}</span>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </CardContent>
      {can(ctx, "contingency:write") ? (
        <CardContent className="border-t border-border pt-4 pb-6">
          <ScenarioForm processId={processId} bands={org.settings.legalReports.bands} />
        </CardContent>
      ) : null}
    </Card>
  );
}
