import { ClipboardCheck, FileSpreadsheet, Landmark, Scale, ShieldCheck, TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { ButtonLink } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FilterBar, FilterSelect } from "@/components/ui/filter-bar";
import { PageHeader } from "@/components/ui/page-header";
import { StatCard } from "@/components/ui/stat-card";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow, tableLinkClasses } from "@/components/ui/table";
import { exposureBasisCounts, type AmountBasisCounts, type MoneyBucket } from "@/domain/contingency";
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
import { formatMoneyCents, formatNumber, pluralize } from "@/lib/format";
import { optionsFromLabels } from "@/lib/options";
import { buildHref, enumParam, hasAnyParam, idParam, param, type SearchParams } from "@/lib/search-params";
import { EstimateBadge } from "@/modules/contingency/components/badges";
import { getContingencyOverview, listCourtOptions } from "@/modules/contingency/service";
import { RegistrationGaps } from "@/modules/dashboard/components/portfolio-panel";
import { coverageStatement, liquidatedCoverage } from "@/modules/dashboard/portfolio";
import type { RegistrationGap } from "@/modules/dashboard/portfolio-service";
import { MISSING_FIELD_PARAMS } from "@/modules/processes/filters";
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
  // RN-03: official amounts carry their coverage and read "Sem valor apurado" (never R$ 0) when nothing is assessed.
  const coverage = liquidatedCoverage(t);
  const noneAssessed = coverage.total > 0 && coverage.assessed === 0;
  const coverageText = capitalize(coverageStatement(coverage));
  const provisionBasis = overview.totalsProvisionBasis;
  // A field left empty is a registration gap, never a table category ("Não informada").
  const blankCourt = (r: { key: string }) => r.key.trim() === "";
  const byCourt = overview.byCourt.filter((r) => !blankCourt(r));
  const byInstance = overview.byInstance.filter((r) => r.key !== "none");
  const byCompany = overview.byCompany.filter((r) => r.key !== "none");
  const countOf = (rows: { bucket: MoneyBucket }[]) => rows.reduce((n, r) => n + r.bucket.count, 0);
  const gap = (field: RegistrationGap["field"], count: number): RegistrationGap[] =>
    count > 0 ? [{ field, count, href: processesHref(sp, { pendencia: MISSING_FIELD_PARAMS[field] }) }] : [];
  const registrationGaps = [
    ...gap("court", countOf(overview.byCourt.filter(blankCourt))),
    ...gap("instance", countOf(overview.byInstance.filter((r) => r.key === "none"))),
    ...gap("company", countOf(overview.byCompany.filter((r) => r.key === "none"))),
  ];

  return (
    <>
      <PageHeader
        title="Contingências"
        description="Valores, garantias, exposição e provisão da carteira ativa (processos ativos e suspensos) visível para você."
        breadcrumbs={[{ label: "Painel executivo", href: "/dashboard" }, { label: "Contingências" }]}
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
            value={t.count > 0 && t.claimUnknown >= t.count ? <Unassessed label="Não informado" /> : formatMoneyCents(t.claimCents)}
            hint={`${formatNumber(t.claimUnknown)} processo(s) sem valor da causa`}
            tone="info"
          />
          <StatCard
            label="Valor liquidado (apurado)"
            value={noneAssessed ? <Unassessed /> : formatMoneyCents(t.liquidatedCents)}
            hint={
              <>
                {coverageText}.
                {t.liquidatedUnknown > 0 ? (
                  <>
                    {" "}
                    <Link href={processesHref(sp, { liquidado: "sem" })} className={tableLinkClasses}>
                      Ver não apurados
                    </Link>
                  </>
                ) : null}
              </>
            }
            tone="primary"
          />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Valor da causa e valor liquidado são grandezas diferentes: exibidos lado a lado e nunca somados. Processos sem
          valor aparecem como “não apurados”, não como zero.
        </p>
      </section>

      <section aria-labelledby="exposicao-titulo" className="mb-6">
        <h2 id="exposicao-titulo" className="mb-2 text-sm font-semibold text-slate-900">
          Exposição e provisão
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label="Garantias vinculadas" value={formatMoneyCents(t.guaranteesCents)} icon={<ShieldCheck />} hint="Abatem a exposição" />
          <StatCard
            label="Exposição líquida apurada"
            value={noneAssessed ? <Unassessed /> : formatMoneyCents(t.exposureCents)}
            hint={`Valor liquidado − garantias vinculadas. ${coverageText}.`}
            tone="alert"
            icon={<Landmark />}
          />
          <StatCard
            label="Exposição estimada"
            value={exposureBasisCounts(t).estimate === 0 ? <Unassessed label="Sem estimativa" /> : formatMoneyCents(t.exposureEstimateCents)}
            hint={`Sem liquidado: causa × risco. ${formatNumber(t.exposureUnknown)} sem base de cálculo`}
            tone="warning"
            icon={<TriangleAlert />}
          />
          <StatCard
            label="Provisão"
            value={
              provisionBasis.official > 0 ? (
                formatMoneyCents(t.provisionCents)
              ) : (
                <Unassessed label={noneAssessed ? "Sem valor apurado" : "Não calculada"} />
              )
            }
            hint={`${
              provisionBasis.estimate > 0
                ? `+ ${formatMoneyCents(t.provisionEstimateCents)} estimada (sobre valor da causa).`
                : "Sem provisão estimada."
            } Apurada: ${coverageStatement(coverage)}.`}
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
            Provisão = base × percentual da classificação em vigor. {formatNumber(overview.unclassifiedCount)} processo(s)
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
              {overview.byClassification.map(({ key, bucket, provisionBasis: basis }) => {
                const unclassified = key === "unclassified";
                return (
                  <TableRow key={key}>
                    <TableCell className="font-medium">
                      {unclassified ? "Não classificado" : LOSS_PROBABILITY_LABELS[key as LossProbability]}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(bucket.count)}</TableCell>
                    {bucket.count === 0 ? (
                      <TableCell colSpan={4} className="text-muted-foreground">
                        Nenhum processo nesta classificação
                      </TableCell>
                    ) : (
                      <>
                        <TableCell className="text-right whitespace-nowrap tabular-nums">
                          <ClaimAmount bucket={bucket} />
                        </TableCell>
                        <TableCell className="text-right whitespace-nowrap tabular-nums">
                          <LiquidatedAmount bucket={bucket} />
                        </TableCell>
                        <TableCell className="text-right whitespace-nowrap tabular-nums">
                          <AmountOf
                            count={basis.official}
                            cents={bucket.provisionCents}
                            empty={unclassified || liquidatedCoverage(bucket).assessed > 0 ? "Não calculada" : "Não apurada"}
                          />
                        </TableCell>
                        <TableCell className="text-right whitespace-nowrap tabular-nums">
                          {basis.estimate > 0 ? (
                            <span className="inline-flex items-center gap-2">
                              {formatMoneyCents(bucket.provisionEstimateCents)}
                              <EstimateBadge />
                            </span>
                          ) : (
                            <Muted>{unclassified ? "Não calculada" : "Sem estimativa"}</Muted>
                          )}
                          <NoBasisNote basis={basis} show={!unclassified} />
                        </TableCell>
                      </>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-6">
        <Breakdown
          title="Por tribunal"
          caption={byCourt.length > TOP ? `Os ${TOP} tribunais com mais processos.` : undefined}
          rows={byCourt.slice(0, TOP).map((r) => ({
            ...r,
            label: r.key,
            href: buildHref("/contingencias", sp, { tribunal: r.key }),
          }))}
        />
        <Breakdown
          title="Por instância"
          rows={byInstance.map((r) => ({
            ...r,
            label: PROCESS_INSTANCE_LABELS[r.key as ProcessInstance] ?? r.key,
            href: buildHref("/contingencias", sp, { instancia: r.key }),
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
          rows={byCompany.map((r) => ({
            ...r,
            label: companyName.get(r.key) ?? "Empresa inativa",
            href: buildHref("/contingencias", sp, { empresa: r.key }),
          }))}
        />
      </div>

      <RegistrationGaps
        gaps={registrationGaps}
        className="mt-6"
        description="Processos da carteira ativa sem um dos campos usados nas tabelas acima. Eles ficam fora da tabela correspondente (os totais do topo os incluem) até o cadastro ser completado."
      />
    </>
  );
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The active portfolio in `/processos` with this page's filters (+ e.g. `pendencia`, `liquidado`). */
function processesHref(sp: SearchParams, extra: Record<string, string> = {}): string {
  const map: Record<string, string> = { empresa: "empresa", tribunal: "tribunal", instancia: "instancia", fase: "phase" };
  const overrides: Record<string, string | undefined> = {};
  for (const [from, to] of Object.entries(map)) overrides[to] = param(sp, from);
  return buildHref("/processos", {}, { ...overrides, ...extra });
}

function Unassessed({ label = "Sem valor apurado" }: { label?: string }) {
  return <span className="text-lg font-medium text-muted-foreground">{label}</span>;
}

/** Muted text in place of an amount: never a dash, never a zero that was not calculated. */
function Muted({ children }: { children: ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>;
}

/** Sum of a group's amounts, or `empty` when no process of the group has this amount (RN-03). */
function AmountOf({ count, cents, empty }: { count: number; cents: number; empty: string }) {
  return count > 0 ? <>{formatMoneyCents(cents)}</> : <Muted>{empty}</Muted>;
}

/** Valor da causa of a group: the informed values, with how many processes have none. */
function ClaimAmount({ bucket }: { bucket: MoneyBucket }) {
  return (
    <>
      <AmountOf count={bucket.count - bucket.claimUnknown} cents={bucket.claimCents} empty="Não informado" />
      {bucket.claimUnknown > 0 && bucket.claimUnknown < bucket.count ? (
        <span className="block text-xs text-muted-foreground">{formatNumber(bucket.claimUnknown)} sem valor</span>
      ) : null}
    </>
  );
}

/** Valor liquidado of a group: "Não apurado" when no process has one, never R$ 0. */
function LiquidatedAmount({ bucket }: { bucket: MoneyBucket }) {
  return (
    <>
      <AmountOf count={liquidatedCoverage(bucket).assessed} cents={bucket.liquidatedCents} empty="Não apurado" />
      {bucket.liquidatedUnknown > 0 && bucket.liquidatedUnknown < bucket.count ? (
        <span className="block text-xs text-muted-foreground">{formatNumber(bucket.liquidatedUnknown)} não apurado(s)</span>
      ) : null}
    </>
  );
}

/**
 * How many processes of the group have no amount: "1 sem base de cálculo" (no valor apurado
 * and no valor da causa) or, for a provision that also needs a classification, "1 não calculada".
 */
function NoBasisNote({ basis, show = true, provision = false }: { basis: AmountBasisCounts; show?: boolean; provision?: boolean }) {
  if (!show || basis.none === 0) return null;
  return (
    <span className="block text-xs text-muted-foreground">
      {provision ? pluralize(basis.none, "não calculada", "não calculadas") : `${formatNumber(basis.none)} sem base de cálculo`}
    </span>
  );
}

/**
 * Apurada amount with the estimated part below it. Each part appears only when some
 * process of the group was calculated on that basis; "Não apurada" otherwise.
 */
function SplitAmount({
  basis,
  officialCents,
  estimateCents,
  provision = false,
}: {
  basis: AmountBasisCounts;
  officialCents: number;
  estimateCents: number;
  provision?: boolean;
}) {
  return (
    <>
      <AmountOf count={basis.official} cents={officialCents} empty="Não apurada" />
      {basis.estimate > 0 ? (
        <span className="block text-xs text-amber-800">
          {basis.official > 0 ? "+ " : ""}
          {formatMoneyCents(estimateCents)} estimada
        </span>
      ) : null}
      <NoBasisNote basis={basis} provision={provision} />
    </>
  );
}

function Breakdown({
  title,
  caption,
  rows,
}: {
  title: string;
  caption?: string;
  rows: { key: string; label: string; href?: string; bucket: MoneyBucket; provisionBasis: AmountBasisCounts }[];
}) {
  return (
    <Card className="min-w-0">
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
                    <ClaimAmount bucket={r.bucket} />
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap tabular-nums">
                    <LiquidatedAmount bucket={r.bucket} />
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap tabular-nums">
                    <SplitAmount
                      basis={exposureBasisCounts(r.bucket)}
                      officialCents={r.bucket.exposureCents}
                      estimateCents={r.bucket.exposureEstimateCents}
                    />
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap tabular-nums">
                    <SplitAmount
                      basis={r.provisionBasis}
                      officialCents={r.bucket.provisionCents}
                      estimateCents={r.bucket.provisionEstimateCents}
                      provision
                    />
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
