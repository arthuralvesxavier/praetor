import Link from "next/link";
import { ButtonLink } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { RiskBadge } from "@/components/ui/risk-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, tableLinkClasses } from "@/components/ui/table";
import { LOSS_PROBABILITY_LABELS, RISK_LEVEL_LABELS, RISK_LEVELS, type LossProbability } from "@/domain/enums";
import { formatMoneyCents, formatNumber } from "@/lib/format";
import type { DashboardData, MoneyBucket } from "../service";

function Figure({ label, value, hint, href }: { label: string; value: string; hint: string; href?: string }) {
  const body = (
    <>
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-lg font-semibold text-slate-900 tabular-nums break-words">{value}</dd>
      <dd className="text-xs text-muted-foreground">{hint}</dd>
    </>
  );
  return (
    <div className="rounded-md border border-border bg-surface-muted/60 px-3 py-2.5">
      {href ? (
        <Link href={href} className="block rounded-sm hover:underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-ring">
          <dl>{body}</dl>
        </Link>
      ) : (
        <dl>{body}</dl>
      )}
    </div>
  );
}

function MoneyCells({ b }: { b: MoneyBucket }) {
  return (
    <>
      <TableCell className="text-right tabular-nums">{formatNumber(b.count)}</TableCell>
      <TableCell className="text-right tabular-nums whitespace-nowrap">{formatMoneyCents(b.claimCents)}</TableCell>
      <TableCell className="text-right tabular-nums whitespace-nowrap">{formatMoneyCents(b.provisionCents)}</TableCell>
    </>
  );
}

const LOSS_ROWS = ["probable", "possible", "remote", "unclassified"] as const satisfies readonly (LossProbability | "unclassified")[];

export function ExposurePanel({ exposure, sections }: { exposure: DashboardData["exposure"]; sections: DashboardData["sections"] }) {
  const a = exposure.activeProcesses;
  return (
    <Card>
      <CardHeader
        actions={
          sections.processes ? (
            <ButtonLink href="/processos?status=active" variant="outline" size="sm">
              Ver processos ativos
            </ButtonLink>
          ) : null
        }
      >
        <CardTitle>Exposição financeira informada nos cadastros</CardTitle>
        <CardDescription>Somatório dos valores digitados ou importados nos registros que você pode acessar.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <Callout tone="info" title="Valores informados nos cadastros — não são estimativas da IA">
          Os números abaixo somam apenas os campos preenchidos por pessoas (valor do pedido, provisão, exposição estimada e
          valor de contrato). Registros sem valor informado não entram na soma. Não representam previsão de resultado.
        </Callout>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {sections.processes ? (
            <>
              <Figure
                label="Valor dos pedidos (processos ativos)"
                value={formatMoneyCents(a.claimCents)}
                hint={`${formatNumber(a.withClaim)} de ${formatNumber(a.count)} processos com valor informado`}
                href="/processos?status=active"
              />
              <Figure
                label="Provisão informada (processos ativos)"
                value={formatMoneyCents(a.provisionCents)}
                hint="Classificação feita pela equipe jurídica"
                href="/processos?status=active"
              />
            </>
          ) : null}
          {sections.occurrences ? (
            <Figure
              label="Exposição estimada (ocorrências em andamento)"
              value={formatMoneyCents(exposure.occurrencesExposureCents)}
              hint={`${formatNumber(exposure.occurrencesWithExposure)} ocorrências com valor informado`}
              href="/preventivo"
            />
          ) : null}
          {sections.contracts ? (
            <Figure
              label="Valor dos contratos vigentes"
              value={formatMoneyCents(exposure.activeContractsValueCents)}
              hint={`${formatNumber(exposure.activeContractsWithValue)} contratos com valor informado`}
              href="/contratos?status=active"
            />
          ) : null}
        </div>

        {sections.processes ? (
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            <div className="space-y-2">
              <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Por nível de risco (ativos)</h3>
              <div className="rounded-md border border-border">
                <Table aria-label="Exposição informada por nível de risco">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Risco</TableHead>
                      <TableHead className="text-right">Processos</TableHead>
                      <TableHead className="text-right">Pedidos</TableHead>
                      <TableHead className="text-right">Provisão</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {[...RISK_LEVELS].reverse().map((r) => (
                      <TableRow key={r}>
                        <TableCell>
                          <Link href={`/processos?status=active&risco=${r}`} className={tableLinkClasses} aria-label={`Ver processos ativos de risco ${RISK_LEVEL_LABELS[r].toLowerCase()}`}>
                            <RiskBadge level={r} />
                          </Link>
                        </TableCell>
                        <MoneyCells b={exposure.byRisk[r]} />
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
            <div className="space-y-2">
              <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                Por probabilidade de perda informada (ativos)
              </h3>
              <div className="rounded-md border border-border">
                <Table aria-label="Exposição informada por probabilidade de perda">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Probabilidade</TableHead>
                      <TableHead className="text-right">Processos</TableHead>
                      <TableHead className="text-right">Pedidos</TableHead>
                      <TableHead className="text-right">Provisão</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {LOSS_ROWS.map((k) => (
                      <TableRow key={k}>
                        <TableCell className="text-slate-700">
                          {k === "unclassified" ? "Não classificada" : LOSS_PROBABILITY_LABELS[k]}
                        </TableCell>
                        <MoneyCells b={exposure.byLossProbability[k]} />
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
