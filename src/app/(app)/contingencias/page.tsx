import { ClipboardCheck, FileSpreadsheet, Landmark, Scale, ShieldCheck, TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { ButtonLink } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FilterBar, FilterSelect } from "@/components/ui/filter-bar";
import { PageHeader } from "@/components/ui/page-header";
import { StatCard } from "@/components/ui/stat-card";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow, tableLinkClasses } from "@/components/ui/table";
import type { MoneyBucket } from "@/domain/contingency";
import {
  LOSS_PROBABILITY_LABELS,
  PROCESS_INSTANCE_LABELS,
  PROCESS_INSTANCES,
  PROCESS_PHASE_LABELS,
  PROCESS_PHASES,
  type LossProbability,
  type ProcessInstance,
  type ProcessPhase,
} from "@/domain/enums";
import { formatMoneyCents, formatNumber } from "@/lib/format";
import { optionsFromLabels } from "@/lib/options";
import { buildHref, enumParam, hasAnyParam, idParam, param, type SearchParams } from "@/lib/search-params";
import { EstimateBadge } from "@/modules/contingency/components/badges";
import { getContingencyOverview, listCourtOptions } from "@/modules/contingency/service";
import { listCompanyOptions } from "@/modules/organization/service";
import { requirePageContext } from "@/server/auth/session";

export const metadata: Metadata = { title: "Contingências" };

const FILTER_KEYS = ["empresa", "tribunal", "instancia", "fase"] as const;
const TOP = 15;

export default async function ContingenciesPage(props: { searchParams: Promise<SearchParams> }) {
  const ctx = await requirePageContext("contingency:read");
  const sp = await props.searchParams;
  const companyId = idParam(sp, "empresa");
  const court = param(sp, "tribunal");
  const instance = enumParam(sp, "instancia", PROCESS_INSTANCES);
  const phase = enumParam(sp, "fase", PROCESS_PHASES);

  const [overview, companies, courts] = await Promise.all([
    getContingencyOverview(ctx, { companyId, court, instance, phase }),
    listCompanyOptions(ctx),
    listCourtOptions(ctx),
  ]);
  const t = overview.totals;
  const filtered = hasAnyParam(sp, FILTER_KEYS);
  const companyName = new Map(companies.map((c) => [c.id, c.name]));

  return (
    <>
      <PageHeader
        title="Contingências"
        description="Valores, garantias, exposição e provisão da carteira ativa (processos ativos e suspensos) visível para você."
        breadcrumbs={[{ label: "Painel", href: "/dashboard" }, { label: "Contingências" }]}
        actions={
          <div className="flex flex-wrap gap-2">
            <ButtonLink href="/contingencias/revisao" variant={overview.pendingReviewCount > 0 ? "primary" : "outline"}>
              <ClipboardCheck aria-hidden="true" />
              Conferência de valores ({formatNumber(overview.pendingReviewCount)})
            </ButtonLink>
            <ButtonLink href="/contingencias/provisao" variant="outline">
              <FileSpreadsheet aria-hidden="true" />
              Provisão e fechamento
            </ButtonLink>
          </div>
        }
      />

      <FilterBar basePath="/contingencias" search={false} showClear={filtered}>
        <FilterSelect
          name="empresa"
          label="Empresa"
          options={companies.map((c) => ({ value: c.id, label: c.name }))}
          defaultValue={companyId}
          placeholder="Todas"
        />
        <FilterSelect
          name="tribunal"
          label="Tribunal"
          options={courts.map((c) => ({ value: c, label: c }))}
          defaultValue={court}
        />
        <FilterSelect
          name="instancia"
          label="Instância"
          options={optionsFromLabels(PROCESS_INSTANCE_LABELS)}
          defaultValue={instance}
          placeholder="Todas"
        />
        <FilterSelect name="fase" label="Fase" options={optionsFromLabels(PROCESS_PHASE_LABELS)} defaultValue={phase} placeholder="Todas" />
      </FilterBar>

      {t.count === 0 ? (
        <Callout tone="info" title={filtered ? "Nenhum processo com esses filtros" : "Nenhum processo ativo visível"} className="mb-6">
          {filtered ? "Ajuste ou limpe os filtros." : "Quando houver processos ativos na sua carteira, os valores aparecerão aqui."}
        </Callout>
      ) : null}

      <section aria-labelledby="valores-titulo" className="mb-6">
        <h2 id="valores-titulo" className="mb-2 text-sm font-semibold text-slate-900">
          Valores declarados × apurados
        </h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <StatCard label="Processos na carteira ativa" value={formatNumber(t.count)} icon={<Scale />} href={processesHref(sp)} />
          <StatCard
            label="Valor da causa (declarado)"
            value={formatMoneyCents(t.claimCents)}
            hint={`${formatNumber(t.claimUnknown)} processo(s) sem valor da causa`}
            tone="info"
          />
          <StatCard
            label="Valor liquidado (apurado, oficial)"
            value={formatMoneyCents(t.liquidatedCents)}
            hint={`${formatNumber(t.liquidatedUnknown)} processo(s) não apurado(s)`}
            tone="primary"
          />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Valor da causa e valor liquidado são grandezas diferentes: exibidos lado a lado e nunca somados (RN-02). Processos sem
          valor aparecem como “não apurados”, não como zero (RN-03).
        </p>
      </section>

      <section aria-labelledby="exposicao-titulo" className="mb-6">
        <h2 id="exposicao-titulo" className="mb-2 text-sm font-semibold text-slate-900">
          Exposição e provisão
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label="Garantias vinculadas" value={formatMoneyCents(t.guaranteesCents)} icon={<ShieldCheck />} hint="Abatem a exposição (RN-04)" />
          <StatCard
            label="Exposição líquida oficial"
            value={formatMoneyCents(t.exposureCents)}
            hint="Valor liquidado − garantias vinculadas"
            tone="alert"
            icon={<Landmark />}
          />
          <StatCard
            label="Exposição estimada (RN-07)"
            value={formatMoneyCents(t.exposureEstimateCents)}
            hint={`Sem liquidado: causa × risco. ${formatNumber(t.exposureUnknown)} sem base de cálculo`}
            tone="warning"
            icon={<TriangleAlert />}
          />
          <StatCard
            label="Provisão"
            value={formatMoneyCents(t.provisionCents)}
            hint={`+ ${formatMoneyCents(t.provisionEstimateCents)} estimada (sobre valor da causa)`}
            tone="danger"
          />
        </div>
      </section>

      <Card className="mb-6">
        <CardHeader
          actions={
            <ButtonLink href="/contingencias/provisao" variant="ghost" size="sm">
              Fechamento mensal
            </ButtonLink>
          }
        >
          <CardTitle>Provisão por classificação de risco</CardTitle>
          <CardDescription>
            Provisão = base × percentual da classificação em vigor (RN-05). {formatNumber(overview.unclassifiedCount)} processo(s)
            sem classificação não têm provisão calculada.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <Table aria-label="Provisão por classificação">
            <TableHeader>
              <TableRow>
                <TableHead>Classificação</TableHead>
                <TableHead className="text-right">Processos</TableHead>
                <TableHead className="text-right">Valor da causa</TableHead>
                <TableHead className="text-right">Valor liquidado</TableHead>
                <TableHead className="text-right">Provisão (apurada)</TableHead>
                <TableHead className="text-right">Provisão estimada</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {overview.byClassification.map(({ key, bucket }) => (
                <TableRow key={key}>
                  <TableCell className="font-medium">
                    {key === "unclassified" ? "Não classificado" : LOSS_PROBABILITY_LABELS[key as LossProbability]}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(bucket.count)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoneyCents(bucket.claimCents)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatMoneyCents(bucket.liquidatedCents)}
                    {bucket.liquidatedUnknown > 0 ? (
                      <span className="block text-xs text-muted-foreground">{formatNumber(bucket.liquidatedUnknown)} não apurado(s)</span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoneyCents(bucket.provisionCents)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {bucket.provisionEstimateCents > 0 ? (
                      <span className="inline-flex items-center gap-2">
                        {formatMoneyCents(bucket.provisionEstimateCents)}
                        <EstimateBadge />
                      </span>
                    ) : (
                      formatMoneyCents(0)
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="grid gap-6 xl:grid-cols-2">
        <Breakdown
          title="Por tribunal"
          caption={overview.byCourt.length > TOP ? `Os ${TOP} tribunais com mais processos.` : undefined}
          rows={overview.byCourt.slice(0, TOP).map((r) => ({
            ...r,
            label: r.key,
            href: buildHref("/contingencias", sp, { tribunal: r.key }),
          }))}
        />
        <Breakdown
          title="Por instância"
          rows={overview.byInstance.map((r) => ({
            ...r,
            label: r.key === "none" ? "Não informada" : PROCESS_INSTANCE_LABELS[r.key as ProcessInstance],
            href: r.key === "none" ? undefined : buildHref("/contingencias", sp, { instancia: r.key }),
          }))}
        />
        <Breakdown
          title="Por fase"
          rows={overview.byPhase.map((r) => ({
            ...r,
            label: PROCESS_PHASE_LABELS[r.key as ProcessPhase] ?? r.key,
            href: buildHref("/contingencias", sp, { fase: r.key }),
          }))}
        />
        <Breakdown
          title="Por empresa"
          rows={overview.byCompany.map((r) => ({
            ...r,
            label: r.key === "none" ? "Sem empresa informada" : (companyName.get(r.key) ?? "Empresa inativa"),
            href: r.key === "none" ? undefined : buildHref("/contingencias", sp, { empresa: r.key }),
          }))}
        />
      </div>
    </>
  );
}

function processesHref(sp: SearchParams): string {
  const map: Record<string, string> = { empresa: "empresa", tribunal: "tribunal", instancia: "instancia", fase: "phase" };
  const overrides: Record<string, string | undefined> = {};
  for (const [from, to] of Object.entries(map)) overrides[to] = param(sp, from);
  return buildHref("/processos", {}, overrides);
}

function Breakdown({
  title,
  caption,
  rows,
}: {
  title: string;
  caption?: string;
  rows: { key: string; label: string; href?: string; bucket: MoneyBucket }[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {caption ? <CardDescription>{caption}</CardDescription> : null}
      </CardHeader>
      <CardContent className="px-0">
        <Table aria-label={`Valores ${title.toLowerCase()}`}>
          <TableHeader>
            <TableRow>
              <TableHead>Grupo</TableHead>
              <TableHead className="text-right">Processos</TableHead>
              <TableHead className="text-right">Valor da causa</TableHead>
              <TableHead className="text-right">Valor liquidado</TableHead>
              <TableHead className="text-right">Exposição</TableHead>
              <TableHead className="text-right">Provisão</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableEmpty colSpan={6} message="Sem processos." />
            ) : (
              rows.map((r) => (
                <TableRow key={r.key} interactive={Boolean(r.href)}>
                  <TableCell className="min-w-36">
                    {r.href ? (
                      <Link href={r.href} className={tableLinkClasses}>
                        {r.label}
                      </Link>
                    ) : (
                      r.label
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(r.bucket.count)}</TableCell>
                  <TableCell className="text-right whitespace-nowrap tabular-nums">
                    {formatMoneyCents(r.bucket.claimCents)}
                    {r.bucket.claimUnknown > 0 ? (
                      <span className="block text-xs text-muted-foreground">{formatNumber(r.bucket.claimUnknown)} sem valor</span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap tabular-nums">
                    {formatMoneyCents(r.bucket.liquidatedCents)}
                    {r.bucket.liquidatedUnknown > 0 ? (
                      <span className="block text-xs text-muted-foreground">{formatNumber(r.bucket.liquidatedUnknown)} não apurado(s)</span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap tabular-nums">
                    {formatMoneyCents(r.bucket.exposureCents)}
                    {r.bucket.exposureEstimateCents > 0 ? (
                      <span className="block text-xs text-amber-800">+ {formatMoneyCents(r.bucket.exposureEstimateCents)} estimada</span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap tabular-nums">
                    {formatMoneyCents(r.bucket.provisionCents)}
                    {r.bucket.provisionEstimateCents > 0 ? (
                      <span className="block text-xs text-amber-800">+ {formatMoneyCents(r.bucket.provisionEstimateCents)} estimada</span>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
