import { ArrowRight, ClipboardCheck, Landmark, Lock, ShieldCheck } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { ButtonLink } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { OriginBadge } from "@/components/ui/origin-badge";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatBp } from "@/domain/contingency";
import {
  GUARANTEE_KIND_LABELS,
  PROCESS_INSTANCE_LABELS,
  VALUATION_KIND_LABELS,
  VALUATION_SOURCE_LABELS,
} from "@/domain/enums";
import { formatDate, formatDateTime, formatMoneyCents, todayISO } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { AuthContext } from "@/server/auth/context";
import { can } from "@/server/auth/permissions";
import { NotFoundError } from "@/server/lib/errors";
import { listUserOptions } from "@/modules/admin/service";
import { listGuarantees } from "../guarantee-service";
import { NOT_INFORMED } from "../labels";
import { listRiskAssessments, type RiskAssessmentItem } from "../risk-service";
import { SETTLEMENT_TRANSITIONS, TERMS_EDITABLE_STATUSES } from "../rules";
import {
  getContingencyParams,
  getProcessContingencySummary,
  getValuationTimeline,
  listProcessDocumentOptions,
  listValuations,
  type ProcessContingencySummary,
} from "../service";
import { listProcessSettlements, type SettlementItem } from "../settlement-service";
import { InlineAction } from "./action-dialog";
import {
  ClassificationBadge,
  Delta,
  EstimateBadge,
  GuaranteeStatusBadge,
  InstallmentStatusBadge,
  Money,
  SettlementStatusBadge,
  ValuationStatusBadge,
} from "./badges";
import {
  GuaranteeDeleteDialog,
  GuaranteeDialog,
  GuaranteeStatusDialog,
  RiskDialog,
  RiskProposalReview,
} from "./guarantee-risk-forms";
import {
  InstallmentPayment,
  SettlementCreateDialog,
  SettlementNotesDialog,
  SettlementStatusDialog,
  SettlementTermsDialog,
} from "./settlement-forms";
import { ExtinctionDialog, PositionAtForm, ValuationDialog } from "./valuation-forms";
import { suggestRiskAssessmentAction } from "../actions";

/**
 * Process-detail tab content owned by the contingency module. The process page
 * (owned by the portfolio package) renders these; each component checks its
 * own permission (`contingency:read`) and loads its own data.
 */

function NoAccess() {
  return (
    <Callout tone="info" title="Sem acesso a valores e risco">
      Seu perfil não tem permissão para consultar valores, garantias, risco e acordos deste processo.
    </Callout>
  );
}

async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof NotFoundError) return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Summary tiles (shared by the tab and the overview card)
// ---------------------------------------------------------------------------

function Tile({ label, children, hint, className }: { label: string; children: ReactNode; hint?: ReactNode; className?: string }) {
  return (
    <div className={cn("min-w-0 rounded-lg border border-border bg-surface p-4 shadow-xs", className)}>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-lg font-semibold text-slate-900 tabular-nums">{children}</div>
      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function exposureHint(s: ProcessContingencySummary): string {
  if (s.exposure.basis === "liquidated") return "Valor liquidado − garantias vinculadas.";
  if (s.exposure.basis === "claim_weighted") return "Sem valor liquidado: valor da causa × % de risco − garantias (RN-04).";
  return "Sem valor liquidado e sem classificação de risco: não calculada.";
}

function provisionHint(s: ProcessContingencySummary): string {
  if (s.provision.base === "net_liquidated") return `Base ${formatMoneyCents(s.provision.baseCents)} × ${formatBp(s.percentageBp)}.`;
  if (s.provision.base === "claim") return `Base = valor da causa ${formatMoneyCents(s.provision.baseCents)} × ${formatBp(s.percentageBp)} (estimativa).`;
  return s.percentageBp === null ? "Sem classificação de risco." : "Sem valores para calcular.";
}

function SummaryTiles({ s }: { s: ProcessContingencySummary }) {
  return (
    <section aria-label="Resumo de valores" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      <div className="rounded-lg border border-border bg-surface shadow-xs sm:col-span-2">
        <div className="grid grid-cols-1 divide-y divide-border sm:grid-cols-2 sm:divide-x sm:divide-y-0">
          <div className="p-4">
            <p className="text-xs font-medium text-muted-foreground">Valor da causa (declarado)</p>
            <p className="mt-1 text-lg font-semibold text-slate-900">
              <Money cents={s.claimCents} fallback={NOT_INFORMED} />
            </p>
          </div>
          <div className="p-4">
            <p className="text-xs font-medium text-muted-foreground">Valor liquidado / apurado (oficial)</p>
            <p className="mt-1 text-lg font-semibold text-slate-900">
              <Money cents={s.liquidatedCents} />
            </p>
            {s.liquidatedBaseDate ? (
              <p className="text-xs text-muted-foreground">Data-base {formatDate(s.liquidatedBaseDate)}</p>
            ) : null}
          </div>
        </div>
        <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
          Grandezas diferentes, exibidas lado a lado e nunca somadas (RN-02). “Não apurado” não significa zero (RN-03).
        </p>
      </div>
      <Tile label="Garantias vinculadas" hint="Só garantias vinculadas abatem a exposição (RN-04).">
        <Money cents={s.linkedGuaranteesCents} />
      </Tile>
      <Tile label="Classificação de risco" hint={s.classification ? "Classificação oficial vigente." : "Classifique para calcular a provisão."}>
        <ClassificationBadge classification={s.classification} percentageBp={s.percentageBp} />
      </Tile>
      <Tile label="Exposição líquida" hint={exposureHint(s)}>
        <Money cents={s.exposure.exposureCents} fallback="Sem base" />
        {s.exposure.isEstimate ? <EstimateBadge /> : null}
      </Tile>
      <Tile label="Provisão" hint={provisionHint(s)}>
        <Money cents={s.provision.provisionCents} fallback="Não calculada" />
        {s.provision.isEstimate ? <EstimateBadge /> : null}
      </Tile>
    </section>
  );
}

// ---------------------------------------------------------------------------
// "Valores e risco" tab
// ---------------------------------------------------------------------------

/** "Valores e risco": valuations history, guarantees, risk classification, exposure and provision. */
export async function ProcessContingencyTab({ ctx, processId }: { ctx: AuthContext; processId: string }) {
  if (!can(ctx, "contingency:read")) return <NoAccess />;
  const summary = await safe(() => getProcessContingencySummary(ctx, processId));
  if (!summary) return <NoAccess />;
  const [valuations, timeline, guarantees, risks, documents, params] = await Promise.all([
    listValuations(ctx, processId),
    getValuationTimeline(ctx, processId),
    listGuarantees(ctx, processId),
    listRiskAssessments(ctx, processId),
    listProcessDocumentOptions(ctx, processId),
    getContingencyParams(ctx),
  ]);
  const canWrite = can(ctx, "contingency:write");
  const canApprove = can(ctx, "contingency:approve");
  const docOptions = documents.map((d) => ({ value: d.id, label: d.title }));
  const claimSeries = timeline.find((t) => t.kind === "claim")?.points ?? [];
  const liquidatedSeries = timeline.find((t) => t.kind === "liquidated")?.points ?? [];

  return (
    <div className="space-y-6">
      <SummaryTiles s={summary} />

      {summary.pendingReviewCount > 0 ? (
        <Callout tone="warning" title={`${summary.pendingReviewCount} valor(es) aguardando conferência`}>
          Valores propostos (planilha, documento, extração simulada ou lançamento de advogado) só entram nos totais oficiais
          depois de conferidos por uma pessoa autorizada (RN-11).{" "}
          {canApprove ? <Link href="/contingencias/revisao">Abrir a fila de conferência</Link> : null}
        </Callout>
      ) : null}

      <Card>
        <CardHeader
          actions={
            canWrite ? (
              <>
                <ValuationDialog processId={processId} documents={docOptions} canApprove={canApprove} />
                <ExtinctionDialog processId={processId} documents={docOptions} canApprove={canApprove} />
              </>
            ) : null
          }
        >
          <CardTitle>Histórico de valores (RF-09)</CardTitle>
          <CardDescription>
            Append-only: cada apuração é um novo registro; o valor oficial anterior passa a “substituído”. Propostos e rejeitados
            não entram nos totais.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {claimSeries.length > 0 || liquidatedSeries.length > 0 ? (
            <div className="grid gap-4 md:grid-cols-2">
              <Series title="Evolução do valor da causa" points={claimSeries} />
              <Series title="Evolução do valor liquidado" points={liquidatedSeries} />
            </div>
          ) : null}
          <div>
            <h3 className="mb-2 text-sm font-semibold text-slate-900">Posição em data passada</h3>
            <PositionAtForm processId={processId} />
          </div>
        </CardContent>
        <CardContent className="px-0">
          <Table aria-label="Valores registrados">
            <TableHeader>
              <TableRow>
                <TableHead>Data-base</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead className="text-right">Valor</TableHead>
                <TableHead>Situação</TableHead>
                <TableHead>Origem</TableHead>
                <TableHead>Registro e conferência</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {valuations.length === 0 ? (
                <TableEmpty
                  colSpan={6}
                  message="Nenhum valor registrado."
                  description="Registre o valor da causa, o valor liquidado ou outros valores com a data-base do cálculo."
                />
              ) : (
                valuations.map((v) => (
                  <TableRow key={v.id} className={cn(v.status === "rejected" || v.status === "superseded" ? "text-slate-500" : "")}>
                    <TableCell className="whitespace-nowrap tabular-nums">
                      {formatDate(v.baseDate)}
                      {v.instance ? <span className="block text-xs text-muted-foreground">{PROCESS_INSTANCE_LABELS[v.instance]}</span> : null}
                    </TableCell>
                    <TableCell className="min-w-36">
                      {VALUATION_KIND_LABELS[v.kind]}
                      {v.isEstimate ? <EstimateBadge className="mt-1" /> : null}
                    </TableCell>
                    <TableCell className={cn("text-right whitespace-nowrap tabular-nums", v.status === "rejected" && "line-through")}>
                      {formatMoneyCents(v.amountCents)}
                    </TableCell>
                    <TableCell>
                      <ValuationStatusBadge status={v.status} />
                      {v.confidence !== null ? (
                        <span className="mt-1 block text-xs text-muted-foreground">Confiança {v.confidence}%</span>
                      ) : null}
                    </TableCell>
                    <TableCell className="min-w-56 max-w-md text-sm">
                      <span className="block">{VALUATION_SOURCE_LABELS[v.source]}</span>
                      {v.documentId ? (
                        v.documentVisible ? (
                          <Link href={`/documentos/${v.documentId}`} className="block text-xs font-medium text-primary-600 hover:underline">
                            {v.documentTitle}
                            {v.page ? ` · p. ${v.page}` : ""}
                          </Link>
                        ) : (
                          <span className="flex items-center gap-1 text-xs text-muted-foreground">
                            <Lock aria-hidden="true" className="size-3" />
                            Documento sem acesso para o seu perfil
                          </span>
                        )
                      ) : null}
                      {v.excerpt ? (
                        <q className="mt-1 line-clamp-2 block text-xs text-slate-600 italic" title={v.excerpt}>
                          {v.excerpt}
                        </q>
                      ) : null}
                      {v.reason ? <span className="mt-1 block text-xs text-slate-600">{v.reason}</span> : null}
                    </TableCell>
                    <TableCell className="min-w-48 text-xs text-slate-600">
                      <span className="block">
                        {v.createdByName ? `Registrado por ${v.createdByName}` : "Registrado pelo sistema"} em {formatDateTime(v.createdAt)}
                      </span>
                      {v.reviewedByName && v.reviewedAt ? (
                        <span className="block">
                          Conferido por {v.reviewedByName} em {formatDateTime(v.reviewedAt)}
                        </span>
                      ) : null}
                      {v.reviewNote ? <span className="block italic">“{v.reviewNote}”</span> : null}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader actions={canWrite ? <GuaranteeDialog processId={processId} documents={docOptions} /> : null}>
          <CardTitle>Garantias e deduções (RF-10)</CardTitle>
          <CardDescription>
            Depósitos, penhoras e seguros vinculados abatem a exposição; liberados ao autor ou devolvidos à empresa deixam de abater.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <Table aria-label="Garantias do processo">
            <TableHeader>
              <TableRow>
                <TableHead>Tipo</TableHead>
                <TableHead className="text-right">Valor</TableHead>
                <TableHead>Depósito</TableHead>
                <TableHead>Situação</TableHead>
                <TableHead>Documento / descrição</TableHead>
                {canWrite ? <TableHead className="text-right">Ações</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {guarantees.length === 0 ? (
                <TableEmpty colSpan={canWrite ? 6 : 5} message="Nenhuma garantia vinculada." />
              ) : (
                guarantees.map((g) => (
                  <TableRow key={g.id}>
                    <TableCell className="whitespace-nowrap">{GUARANTEE_KIND_LABELS[g.kind]}</TableCell>
                    <TableCell className="text-right whitespace-nowrap tabular-nums">{formatMoneyCents(g.amountCents)}</TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums">{formatDate(g.depositedAt)}</TableCell>
                    <TableCell>
                      <GuaranteeStatusBadge status={g.status} />
                      {g.statusChangedAt ? (
                        <span className="mt-1 block text-xs text-muted-foreground">desde {formatDate(g.statusChangedAt)}</span>
                      ) : null}
                    </TableCell>
                    <TableCell className="min-w-48 text-sm">
                      {g.documentId ? (
                        g.documentTitle ? (
                          <Link href={`/documentos/${g.documentId}`} className="block text-xs font-medium text-primary-600 hover:underline">
                            {g.documentTitle}
                          </Link>
                        ) : (
                          <span className="block text-xs text-muted-foreground">Documento sem acesso</span>
                        )
                      ) : null}
                      {g.description ? <span className="block text-xs text-slate-600">{g.description}</span> : null}
                      {!g.documentId && !g.description ? <span className="text-muted-foreground">—</span> : null}
                    </TableCell>
                    {canWrite ? (
                      <TableCell className="text-right">
                        <div className="flex flex-wrap justify-end gap-1">
                          <GuaranteeDialog
                            processId={processId}
                            documents={docOptions}
                            guarantee={{
                              id: g.id,
                              kind: g.kind,
                              amountCents: g.amountCents,
                              depositedAt: g.depositedAt,
                              documentId: g.documentId,
                              description: g.description,
                              status: g.status,
                            }}
                          />
                          <GuaranteeStatusDialog guarantee={{ id: g.id, status: g.status, depositedAt: g.depositedAt }} />
                          <GuaranteeDeleteDialog id={g.id} />
                        </div>
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader
          actions={
            canWrite ? (
              <>
                <InlineAction
                  action={suggestRiskAssessmentAction}
                  hiddenFields={{ processId }}
                  label="Sugerir classificação (regra)"
                  pendingLabel="Calculando…"
                />
                <RiskDialog processId={processId} percentages={params.riskPercentages} />
              </>
            ) : null
          }
        >
          <CardTitle>Classificação de risco (RF-11)</CardTitle>
          <CardDescription>
            Percentuais da organização: remota {params.riskPercentages.remote}%, possível {params.riskPercentages.possible}%, provável{" "}
            {params.riskPercentages.probable}% (versão {params.rulesVersion}). A sugestão por regra considera fase, instância,
            encerramento e valor liquidado e nunca vale sem aprovação humana (RF-12).
          </CardDescription>
        </CardHeader>
        <CardContent>
          {risks.length === 0 ? (
            <EmptyState
              icon={<ShieldCheck />}
              title="Processo ainda não classificado"
              description="Sem classificação de risco, a provisão não é calculada."
            />
          ) : (
            <ol className="space-y-3">
              {risks.map((r) => (
                <li
                  key={r.id}
                  className={cn(
                    "rounded-md border p-3",
                    r.status === "proposed" ? "border-amber-200 bg-amber-50/50" : "border-border",
                    r.status === "rejected" && "opacity-75",
                  )}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <ClassificationBadge classification={r.classification} percentageBp={r.percentageBp} />
                    <ValuationStatusBadge status={r.status} />
                    {r.inForce ? <span className="text-xs font-medium text-emerald-800">Em vigor</span> : null}
                    <OriginBadge origin={r.origin} />
                    <span className="text-xs text-muted-foreground">
                      Vigência desde {formatDate(r.effectiveFrom)} · regras v{r.rulesVersion}
                    </span>
                  </div>
                  <p className="mt-2 text-sm whitespace-pre-line text-slate-800">{r.opinion}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{riskAttribution(r)}</p>
                  {r.status === "proposed" && canWrite ? (
                    <div className="mt-2 flex flex-wrap gap-2">
                      <RiskProposalReview id={r.id} decision="approve" />
                      <RiskProposalReview id={r.id} decision="reject" />
                    </div>
                  ) : null}
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function riskAttribution(r: RiskAssessmentItem): string {
  const parts: string[] = [];
  if (r.origin === "system") {
    parts.push(`Sugestão automática por regra${r.assessedByName ? ` solicitada por ${r.assessedByName}` : ""} em ${formatDateTime(r.createdAt)}`);
    if (r.reviewedByName && r.reviewedAt) {
      parts.push(`${r.status === "official" ? "aprovada" : "rejeitada"} por ${r.reviewedByName} em ${formatDateTime(r.reviewedAt)}`);
    }
  } else {
    parts.push(`Registrada${r.assessedByName ? ` por ${r.assessedByName}` : ""} em ${formatDateTime(r.createdAt)}`);
  }
  return parts.join(" · ");
}

function Series({
  title,
  points,
}: {
  title: string;
  points: { id: string; baseDate: string; amountCents: number; status: string }[];
}) {
  return (
    <div className="rounded-md border border-border">
      <p className="border-b border-border bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-700">{title}</p>
      {points.length === 0 ? (
        <p className="px-3 py-3 text-sm text-muted-foreground">Sem valores oficiais.</p>
      ) : (
        <ol className="divide-y divide-border text-sm">
          {points.map((p, i) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <span className="tabular-nums text-slate-600">{formatDate(p.baseDate)}</span>
              <span className="flex items-center gap-3">
                <span className="font-medium tabular-nums text-slate-900">{formatMoneyCents(p.amountCents)}</span>
                {i > 0 ? <Delta cents={p.amountCents - points[i - 1].amountCents} className="text-xs" /> : null}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// "Acordos" tab
// ---------------------------------------------------------------------------

/** "Acordos": settlements and installments of the process. */
export async function ProcessSettlementsTab({ ctx, processId }: { ctx: AuthContext; processId: string }) {
  if (!can(ctx, "contingency:read")) return <NoAccess />;
  const settlements = await safe(() => listProcessSettlements(ctx, processId));
  if (!settlements) return <NoAccess />;
  const canWrite = can(ctx, "contingency:write");
  const canApprove = can(ctx, "contingency:approve");
  const [users, documents] = await Promise.all([
    canWrite ? listUserOptions(ctx) : Promise.resolve([]),
    canWrite ? listProcessDocumentOptions(ctx, processId) : Promise.resolve([]),
  ]);
  const userOptions = users.map((u) => ({ value: u.id, label: u.name }));
  const docOptions = documents.map((d) => ({ value: d.id, label: d.title }));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Valores de acordo são uma grandeza própria: não se somam ao valor da causa nem ao liquidado. Ao cumprir o acordo,
          registre a quitação (RN-06) para zerar o valor liquidado mantendo o histórico.
        </p>
        {canWrite ? <SettlementCreateDialog processId={processId} users={userOptions} /> : null}
      </div>
      {settlements.length === 0 ? (
        <EmptyState icon={<Landmark />} title="Nenhum acordo registrado" description="Registre propostas, negociações e acordos firmados deste processo." />
      ) : (
        settlements.map((s) => (
          <SettlementCard key={s.id} s={s} canWrite={canWrite} canApprove={canApprove} documents={docOptions} />
        ))
      )}
    </div>
  );
}

export function SettlementCard({
  s,
  canWrite,
  canApprove,
  documents,
  showProcess = false,
}: {
  s: SettlementItem;
  canWrite: boolean;
  canApprove: boolean;
  documents: { value: string; label: string }[];
  showProcess?: boolean;
}) {
  const today = todayISO();
  const anyPaid = s.installments.some((i) => i.status === "paid");
  const next = SETTLEMENT_TRANSITIONS[s.status];
  return (
    <Card>
      <CardHeader
        actions={
          canWrite ? (
            <>
              <SettlementStatusDialog id={s.id} next={next} />
              {TERMS_EDITABLE_STATUSES.includes(s.status) && !anyPaid ? (
                <SettlementTermsDialog
                  id={s.id}
                  totalAmountCents={s.totalAmountCents}
                  installmentsCount={s.installmentsCount}
                  firstDueDate={s.installments[0]?.dueDate ?? null}
                />
              ) : null}
              <SettlementNotesDialog id={s.id} notes={s.notes} />
              {s.status === "fulfilled" ? (
                <ExtinctionDialog processId={s.processId} documents={documents} canApprove={canApprove} triggerVariant="primary" />
              ) : null}
            </>
          ) : null
        }
      >
        <CardTitle as="h3" className="flex flex-wrap items-center gap-2">
          <SettlementStatusBadge status={s.status} />
          <span>
            {s.totalAmountCents !== null ? `Acordo de ${formatMoneyCents(s.totalAmountCents)}` : "Acordo sem valor definido"}
            {s.installmentsCount ? ` em ${s.installmentsCount} parcela(s)` : ""}
          </span>
        </CardTitle>
        <CardDescription>
          {showProcess ? (
            <>
              <Link href={`/processos/${s.processId}?aba=acordos`} className="font-medium text-primary-600 hover:underline">
                {s.processNumber}
              </Link>{" "}
              · {s.processTitle} ·{" "}
            </>
          ) : null}
          Proposta {formatDate(s.proposedAt)}
          {s.signedAt ? ` · firmado ${formatDate(s.signedAt)}` : ""}
          {s.homologatedAt ? ` · homologado ${formatDate(s.homologatedAt)}` : ""}
          {s.responsibleName ? ` · responsável ${s.responsibleName}` : ""}
        </CardDescription>
      </CardHeader>
      {s.notes ? (
        <CardContent>
          <p className="rounded-md bg-surface-muted px-3 py-2 text-sm whitespace-pre-line text-slate-700">{s.notes}</p>
        </CardContent>
      ) : null}
      {s.status === "fulfilled" && canWrite ? (
        <CardContent>
          <Callout tone="success" title="Acordo cumprido">
            Registre a quitação (RN-06) para que o valor liquidado oficial passe a R$ 0,00, mantendo o histórico.
          </Callout>
        </CardContent>
      ) : null}
      {s.installments.length > 0 ? (
        <CardContent className="px-0">
          <Table aria-label="Parcelas do acordo">
            <TableHeader>
              <TableRow>
                <TableHead>Parcela</TableHead>
                <TableHead>Vencimento</TableHead>
                <TableHead className="text-right">Valor</TableHead>
                <TableHead>Situação</TableHead>
                <TableHead>Pago em</TableHead>
                {canWrite ? <TableHead className="text-right">Ação</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {s.installments.map((i) => (
                <TableRow key={i.id}>
                  <TableCell className="tabular-nums">
                    {i.number}/{s.installments.length}
                  </TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums">{formatDate(i.dueDate)}</TableCell>
                  <TableCell className="text-right whitespace-nowrap tabular-nums">{formatMoneyCents(i.amountCents)}</TableCell>
                  <TableCell>
                    <InstallmentStatusBadge status={i.status} overdue={i.dueDate < today} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums">{formatDate(i.paidAt)}</TableCell>
                  {canWrite ? (
                    <TableCell className="text-right">
                      {i.status !== "cancelled" && s.status !== "cancelled" && !(s.status === "fulfilled" && i.status === "paid") ? (
                        <InstallmentPayment id={i.id} number={i.number} amountCents={i.amountCents} paid={i.status === "paid"} />
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p className="px-5 pt-3 text-xs text-muted-foreground">
            Pago {formatMoneyCents(s.paidCents)} · a pagar {formatMoneyCents(s.pendingCents)}
            {s.overdueCount > 0 ? ` · ${s.overdueCount} parcela(s) vencida(s)` : ""}
          </p>
        </CardContent>
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Overview card
// ---------------------------------------------------------------------------

/** Compact card for the overview tab: valor da causa and valor liquidado side by side (never summed), exposure, provision. */
export async function ProcessValuesSummary({ ctx, processId }: { ctx: AuthContext; processId: string }) {
  if (!can(ctx, "contingency:read")) return null;
  const s = await safe(() => getProcessContingencySummary(ctx, processId));
  if (!s) return null;
  return (
    <Card>
      <CardHeader
        actions={
          <ButtonLink href={`/processos/${processId}?aba=valores`} variant="ghost" size="sm">
            Valores e risco
            <ArrowRight aria-hidden="true" />
          </ButtonLink>
        }
      >
        <CardTitle>Valores e provisão</CardTitle>
        <CardDescription>Valor da causa e valor liquidado são grandezas diferentes — nunca somadas (RN-02).</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs text-muted-foreground">Valor da causa</dt>
            <dd className="font-semibold text-slate-900">
              <Money cents={s.claimCents} fallback={NOT_INFORMED} />
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Valor liquidado</dt>
            <dd className="font-semibold text-slate-900">
              <Money cents={s.liquidatedCents} />
              {s.liquidatedBaseDate ? (
                <span className="ml-1 text-xs font-normal text-muted-foreground">({formatDate(s.liquidatedBaseDate)})</span>
              ) : null}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Exposição líquida</dt>
            <dd className="flex flex-wrap items-center gap-2 font-semibold text-slate-900">
              <Money cents={s.exposure.exposureCents} fallback="Sem base" />
              {s.exposure.isEstimate ? <EstimateBadge /> : null}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Provisão</dt>
            <dd className="flex flex-wrap items-center gap-2 font-semibold text-slate-900">
              <Money cents={s.provision.provisionCents} fallback="Não calculada" />
              {s.provision.isEstimate ? <EstimateBadge /> : null}
            </dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-xs text-muted-foreground">Classificação de risco</dt>
            <dd className="mt-0.5">
              <ClassificationBadge classification={s.classification} percentageBp={s.percentageBp} />
            </dd>
          </div>
        </dl>
        {s.pendingReviewCount > 0 ? (
          <p className="mt-3 flex items-center gap-1.5 text-xs font-medium text-amber-800">
            <ClipboardCheck aria-hidden="true" className="size-3.5" />
            {s.pendingReviewCount} valor(es) aguardando conferência
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
