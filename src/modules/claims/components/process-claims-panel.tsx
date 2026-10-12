import { ListChecks, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusBadge } from "@/components/ui/status-badge";
import { formatBp, type ProvisionResult } from "@/domain/contingency";
import {
  CLAIM_CATEGORY_LABELS,
  CLAIM_ORIGIN_LABELS,
  CLAIM_STATUS_LABELS,
  CORRECTION_INDEX_LABELS,
  LOSS_PROBABILITY_LABELS,
  PROCESS_INSTANCE_LABELS,
} from "@/domain/enums";
import { formatDate, formatMoneyCents, pluralize } from "@/lib/format";
import { InlineAction } from "@/modules/contingency/components/action-dialog";
import { ClassificationBadge, Money } from "@/modules/contingency/components/badges";
import type { AuthContext } from "@/server/auth/context";
import { can } from "@/server/auth/permissions";
import { NotFoundError } from "@/server/lib/errors";
import { applyDerivedRiskAction, suggestClaimsFromBriefAction } from "../actions";
import { CLAIM_STATUS_TONES, DERIVED_RATE_BASIS_LABELS, inForceSourceLabel } from "../labels";
import {
  getProcessClaims,
  type ClaimAssessmentItem,
  type ClaimsRiskState,
  type OfficialProvision,
  type ProcessClaimItem,
  type ProcessClaimsOverview,
} from "../service";
import {
  AssessClaimDialog,
  ClaimDialog,
  ConfirmClaimDialog,
  DismissClaimDialog,
  OverrideRiskDialog,
  RemoveClaimDialog,
  type ClaimFormValues,
} from "./claim-forms";

/**
 * "Pedidos" block of the process page (`<ProcessClaimsPanel ctx processId />`),
 * wired by the integrator into the process detail. Checks its own permissions:
 * claims with `process:read`; assessments and derived risk with `contingency:read`.
 */

const NOT_QUANTIFIED = "Não quantificado";

function amountWithBase(cents: number | null, baseDate: string | null, index: keyof typeof CORRECTION_INDEX_LABELS | null) {
  if (cents === null) return <span className="text-muted-foreground italic">{NOT_QUANTIFIED}</span>;
  return (
    <span className="tabular-nums">
      {formatMoneyCents(cents)}
      <span className="text-xs text-muted-foreground">
        {baseDate ? ` em ${formatDate(baseDate)}` : " (sem data-base)"}
        {index ? `, ${CORRECTION_INDEX_LABELS[index]}` : ", sem índice informado"}
      </span>
    </span>
  );
}

function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm text-slate-900">{children}</dd>
    </div>
  );
}

function OriginBadgeForClaim({ claim }: { claim: ProcessClaimItem }) {
  if (claim.origin !== "ai_suggested") return <Badge tone={claim.origin === "imported" ? "info" : "neutral"}>{CLAIM_ORIGIN_LABELS[claim.origin]}</Badge>;
  return (
    <Badge tone="ai" icon={<Sparkles />} title={claim.sourceNote ?? undefined}>
      {CLAIM_ORIGIN_LABELS.ai_suggested}
      {claim.sourceIsDemo ? " (simulação)" : ""}
    </Badge>
  );
}

function AssessmentLine({ a }: { a: ClaimAssessmentItem }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      <ClassificationBadge classification={a.classification} percentageBp={a.percentageBp} />
      <span>
        Base: {amountWithBase(a.baseAmountCents, a.baseDate, a.correctionIndex)}
      </span>
      <span>
        Provisão do pedido: <Money cents={a.provisionCents} fallback={NOT_QUANTIFIED} />
      </span>
      <span className="text-xs text-muted-foreground">
        Vigente desde {formatDate(a.effectiveFrom)}
        {a.assessedByName ? `, por ${a.assessedByName}` : ""}
      </span>
    </div>
  );
}

function toFormValues(c: ProcessClaimItem): ClaimFormValues {
  return {
    id: c.id,
    description: c.description,
    category: c.category,
    claimedAmountCents: c.claimedAmountCents,
    amountBaseDate: c.amountBaseDate,
    correctionIndex: c.correctionIndex,
    instance: c.instance,
  };
}

function ClaimRow({ claim, overview }: { claim: ProcessClaimItem; overview: ProcessClaimsOverview }) {
  const { canEditClaims, canAssess } = overview.permissions;
  const readRisk = overview.risk !== null;
  const pending = claim.status === "pending_confirmation";
  const dismissed = claim.status === "dismissed";
  return (
    <article className="flex flex-col gap-3" aria-label={`Pedido: ${claim.description}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className={dismissed ? "text-sm text-muted-foreground line-through" : "text-sm font-medium text-slate-900"}>
          {claim.description}
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusBadge label={CLAIM_STATUS_LABELS[claim.status]} tone={CLAIM_STATUS_TONES[claim.status]} />
          <OriginBadgeForClaim claim={claim} />
        </div>
      </div>
      <dl className="grid gap-3 sm:grid-cols-3">
        <Meta label="Categoria">{claim.category ? CLAIM_CATEGORY_LABELS[claim.category] : "Sem categoria"}</Meta>
        <Meta label="Instância">{claim.instance ? PROCESS_INSTANCE_LABELS[claim.instance] : "Não informada"}</Meta>
        <Meta label="Valor do pedido">{amountWithBase(claim.claimedAmountCents, claim.amountBaseDate, claim.correctionIndex)}</Meta>
      </dl>
      {claim.origin === "ai_suggested" && claim.sourceNote ? (
        <p className="text-xs text-muted-foreground">Origem: {claim.sourceNote}</p>
      ) : null}
      {pending ? (
        <Callout tone="ai">
          Sugestão {claim.sourceIsDemo ? "demonstrativa da simulação" : "da análise preliminar"}: não conta no risco até ser
          confirmada por uma pessoa.
        </Callout>
      ) : null}
      {readRisk && claim.status === "confirmed" ? (
        claim.assessment ? (
          <div className="flex flex-col gap-1">
            <AssessmentLine a={claim.assessment} />
            {claim.baseDiffersFromClaim ? (
              <p className="text-xs text-amber-800">
                A base da avaliação vigente difere do valor atual do pedido. Registre nova avaliação se o valor mudou.
              </p>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Sem avaliação de risco: não entra na classificação do processo.</p>
        )
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {canAssess && claim.status === "confirmed" && overview.riskPercentages ? (
          <AssessClaimDialog
            claim={{
              id: claim.id,
              claimedAmountCents: claim.claimedAmountCents,
              amountBaseDate: claim.amountBaseDate,
              correctionIndex: claim.correctionIndex,
            }}
            percentages={overview.riskPercentages}
          />
        ) : null}
        {canEditClaims && pending ? (
          <>
            <ConfirmClaimDialog claim={toFormValues(claim)} suggestedBaseDate={overview.processFiledAt} />
            <DismissClaimDialog id={claim.id} />
          </>
        ) : null}
        {canEditClaims && !dismissed ? <ClaimDialog processId={overview.processId} claim={toFormValues(claim)} /> : null}
        {canEditClaims && !pending ? <RemoveClaimDialog id={claim.id} /> : null}
      </div>
      {readRisk && claim.history.length > 0 ? (
        <details className="rounded-md border border-border bg-surface-muted px-3 py-2">
          <summary className="cursor-pointer text-xs font-medium text-slate-700">
            Histórico de avaliações ({claim.history.length})
          </summary>
          <ol className="mt-2 flex flex-col gap-3" aria-label="Histórico de avaliações do pedido">
            {claim.history.map((a) => (
              <li key={a.id} className="flex flex-col gap-1 border-t border-border pt-2 first:border-t-0 first:pt-0">
                <div className="flex flex-wrap items-center gap-2">
                  <AssessmentLine a={a} />
                  {a.inForce ? <StatusBadge label="Vigente" tone="success" /> : null}
                </div>
                <p className="text-xs whitespace-pre-line text-slate-700">Parecer: {a.opinion}</p>
                <p className="text-xs text-muted-foreground">
                  Registrada em {formatDate(a.createdAt)} (regras de risco versão {a.rulesVersion}).
                </p>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </article>
  );
}

const OFFICIAL_BASE_LABELS: Record<ProvisionResult["base"], string> = {
  net_liquidated: "sobre o valor apurado vigente, descontadas as garantias vinculadas",
  claim: "sobre o valor da causa (estimativa, sem valor apurado)",
  none: "",
};

function OfficialProvisionValue({ official }: { official: OfficialProvision | null }) {
  const p = official?.provision ?? null;
  if (!official || !p || p.provisionCents === null) {
    return (
      <span className="text-muted-foreground italic">
        Não calculada (sem classificação vigente ou sem valor da causa e valor apurado)
      </span>
    );
  }
  return (
    <span className="flex flex-col">
      <Money cents={p.provisionCents} />
      <span className="text-xs text-muted-foreground">
        {formatBp(official.percentageBp, "sem percentual")} {OFFICIAL_BASE_LABELS[p.base]}
        {p.baseCents !== null ? ` (${formatMoneyCents(p.baseCents)})` : ""}
      </span>
    </span>
  );
}

function RiskStatus({ risk }: { risk: ClaimsRiskState }) {
  const d = risk.derivation;
  if (risk.overrideInForce && risk.overrideNeedsReview) {
    return (
      <Callout tone="warning" title="Classificação manual a rever">
        {risk.overrideKind === "outside_panel"
          ? "A classificação registrada na aba de valores e risco depois da avaliação dos pedidos foi mantida"
          : "A classificação do processo foi definida manualmente e mantida"}
        {d.classification === null
          ? ", mas nenhum pedido confirmado tem mais avaliação vigente. Avalie os pedidos ou registre nova classificação na aba de valores e risco."
          : ", mas a avaliação dos pedidos mudou depois dela. Aplique a classificação derivada ou registre nova justificativa."}
      </Callout>
    );
  }
  if (risk.overrideInForce && risk.overrideKind === "outside_panel") {
    return (
      <Callout tone="info" title="Classificação registrada na aba de valores e risco">
        Registrada depois da avaliação dos pedidos e diferente da derivada, com o parecer como justificativa: é mantida e não é
        substituída pela derivada. Será sinalizada para revisão se a avaliação dos pedidos mudar.
      </Callout>
    );
  }
  if (risk.overrideInForce) {
    return (
      <Callout tone="info" title="Classificação definida manualmente">
        Diferente da derivada dos pedidos, com justificativa registrada
        {risk.overrideDerivedAtTime?.classification
          ? ` (na época, derivada: ${LOSS_PROBABILITY_LABELS[risk.overrideDerivedAtTime.classification]}, ${formatBp(risk.overrideDerivedAtTime.percentageBp, "sem percentual")})`
          : ""}
        . Será sinalizada para revisão se a avaliação dos pedidos mudar.
      </Callout>
    );
  }
  if (risk.derivedWithoutBasis) {
    return (
      <Callout tone="warning" title="Classificação derivada sem pedidos avaliados">
        A classificação vigente foi derivada dos pedidos, mas nenhum pedido confirmado tem mais avaliação vigente. Avalie os
        pedidos ou registre nova classificação na aba de valores e risco.
      </Callout>
    );
  }
  if (d.classification === null) {
    return (
      <Callout tone="info">
        Nenhum pedido confirmado tem avaliação vigente. Avalie os pedidos para derivar a classificação do processo.
      </Callout>
    );
  }
  if (risk.differs) {
    return (
      <Callout tone="warning" title="Classificação vigente diferente da derivada">
        A classificação vigente do processo não corresponde à derivada dos pedidos. Aplique a derivada ou registre uma
        classificação manual com justificativa.
      </Callout>
    );
  }
  return <Callout tone="success">A classificação vigente do processo corresponde à derivada dos pedidos.</Callout>;
}

function RiskCard({ overview }: { overview: ProcessClaimsOverview }) {
  const risk = overview.risk!;
  const d = risk.derivation;
  const rate = risk.derivedRate;
  const canAssess = overview.permissions.canAssess && overview.riskPercentages !== null;
  const derivedLabel =
    d.classification !== null ? `${LOSS_PROBABILITY_LABELS[d.classification]}, ${formatBp(risk.derivedBp, "sem percentual")}` : "sem classificação derivada";

  return (
    <Card aria-labelledby="pedidos-risco">
      <CardHeader>
        <CardTitle id="pedidos-risco">Risco do processo pelos pedidos</CardTitle>
        <CardDescription>
          Classificação = pior classificação entre os pedidos avaliados. Provisão = soma de base × percentual de cada pedido
          quantificado. Valores nas datas-base (atualização monetária não calculada aqui).
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <dl className="grid gap-4 sm:grid-cols-2">
          <Meta label="Derivada dos pedidos">
            {d.classification !== null ? (
              <span className="flex flex-col gap-1">
                <ClassificationBadge classification={d.classification} percentageBp={risk.derivedBp} />
                {rate ? <span className="text-xs text-muted-foreground">{DERIVED_RATE_BASIS_LABELS[rate.basis]}</span> : null}
              </span>
            ) : (
              <span className="text-muted-foreground italic">Sem pedido avaliado</span>
            )}
          </Meta>
          <Meta label="Vigente no processo">
            {risk.inForce ? (
              <span className="flex flex-col gap-1">
                <ClassificationBadge classification={risk.inForce.classification} percentageBp={risk.inForce.percentageBp} />
                <span className="text-xs text-muted-foreground">
                  {inForceSourceLabel(risk.inForce.link, risk.inForce.origin)}, desde {formatDate(risk.inForce.effectiveFrom)}
                  {risk.inForce.assessedByName ? `, por ${risk.inForce.assessedByName}` : ""}
                </span>
              </span>
            ) : (
              <ClassificationBadge classification={null} />
            )}
          </Meta>
          <Meta label="Provisão pelos pedidos">
            {d.provisionCents !== null ? (
              <span className="flex flex-col">
                <Money cents={d.provisionCents} />
                <span className="text-xs text-muted-foreground">
                  {pluralize(d.quantified.length, "pedido quantificado", "pedidos quantificados", { withCount: true })}, base total{" "}
                  {formatMoneyCents(d.quantifiedBaseCents)}
                </span>
              </span>
            ) : (
              <span className="text-muted-foreground italic">Não calculada (nenhum pedido avaliado com valor)</span>
            )}
          </Meta>
          <Meta label="Provisão do processo">
            <OfficialProvisionValue official={risk.official} />
          </Meta>
          <Meta label="Fora da soma">
            <ul className="flex flex-col gap-0.5">
              <li>{pluralize(d.unquantified.length, "pedido não quantificado", "pedidos não quantificados", { withCount: true })} (não valem zero)</li>
              <li>{pluralize(d.unassessed.length, "pedido sem avaliação", "pedidos sem avaliação", { withCount: true })}</li>
              <li>
                {pluralize(d.pendingConfirmation.length, "sugestão aguardando confirmação", "sugestões aguardando confirmação", {
                  withCount: true,
                })}
              </li>
            </ul>
          </Meta>
        </dl>
        <RiskStatus risk={risk} />
        {risk.derivedNeedsReview && rate ? (
          <Callout tone="warning" title="Pedido avaliado sem valor">
            A classificação derivada usa o percentual da organização para a classificação ({formatBp(rate.bp, "sem percentual")}), e
            não o ponderado dos pedidos quantificados ({formatBp(rate.weightedBp, "não calculado")}), porque pedido sem valor não vale
            zero. Quantifique os pedidos ou defina a classificação manualmente com justificativa.
          </Callout>
        ) : null}
        {risk.provisionDiffers ? (
          <Callout tone="info" title="Provisão do processo diferente da provisão pelos pedidos">
            A provisão do processo aplica o percentual vigente sobre o valor apurado vigente (descontadas as garantias
            vinculadas) ou, sem ele, sobre o valor da causa. A provisão pelos pedidos soma base × percentual de cada pedido
            quantificado. A provisão do processo é a que vale para a contingência (fechamentos mensais e relatórios).
          </Callout>
        ) : null}
        {canAssess && d.classification !== null ? (
          <div className="flex flex-wrap items-start gap-2">
            {risk.differs || risk.overrideInForce ? (
              <InlineAction
                action={applyDerivedRiskAction}
                hiddenFields={{ processId: overview.processId }}
                label="Aplicar classificação derivada"
                pendingLabel="Registrando…"
                variant="primary"
              />
            ) : null}
            <OverrideRiskDialog
              processId={overview.processId}
              percentages={overview.riskPercentages!}
              derived={{ label: derivedLabel }}
              current={
                risk.overrideInForce && risk.inForce
                  ? { classification: risk.inForce.classification, percentageBp: risk.inForce.percentageBp }
                  : null
              }
              triggerLabel={
                risk.overrideKind === "panel"
                  ? "Manter manual com nova justificativa"
                  : risk.overrideKind === "outside_panel"
                    ? "Registrar classificação manual com justificativa"
                    : "Definir classificação diferente"
              }
            />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export async function ProcessClaimsPanel({ ctx, processId }: { ctx: AuthContext; processId: string }) {
  if (!can(ctx, "process:read")) {
    return <p className="text-sm text-muted-foreground">Seu perfil não permite consultar os pedidos deste processo.</p>;
  }
  let overview: ProcessClaimsOverview;
  try {
    overview = await getProcessClaims(ctx, processId);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return <p className="text-sm text-muted-foreground">Processo não encontrado ou sem permissão de acesso.</p>;
    }
    throw err;
  }
  const active = overview.claims.filter((c) => c.status !== "dismissed");
  const dismissed = overview.claims.filter((c) => c.status === "dismissed");
  const offer = overview.briefOffer;

  return (
    <div className="flex flex-col gap-4">
      {overview.risk ? <RiskCard overview={overview} /> : null}
      <Card aria-labelledby="pedidos-lista">
        <CardHeader actions={overview.permissions.canEditClaims ? <ClaimDialog processId={overview.processId} /> : null}>
          <CardTitle id="pedidos-lista">Pedidos</CardTitle>
          <CardDescription>
            Verbas pleiteadas no processo. O risco é avaliado por pedido; o valor do pedido e o valor apurado são grandezas
            diferentes e não se somam.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {offer && offer.notImported > 0 ? (
            <Callout tone="ai" title={offer.demo ? "Pedidos da análise preliminar (simulação)" : "Pedidos da análise preliminar"}>
              <div className="flex flex-col gap-2">
                <p>
                  A análise preliminar v{offer.version}
                  {offer.demo ? " (conteúdo demonstrativo, sem inteligência artificial real)" : ""} encontrou{" "}
                  {pluralize(offer.notImported, "pedido que ainda não está", "pedidos que ainda não estão", { withCount: true })} no
                  processo. Eles entram como sugestões e só contam no risco depois de confirmados por uma pessoa.
                </p>
                <InlineAction
                  action={suggestClaimsFromBriefAction}
                  hiddenFields={{ briefId: offer.briefId }}
                  label="Trazer pedidos sugeridos"
                  pendingLabel="Incluindo…"
                />
              </div>
            </Callout>
          ) : null}
          {active.length === 0 ? (
            <EmptyState
              icon={<ListChecks />}
              title="Nenhum pedido cadastrado"
              description={
                overview.permissions.canEditClaims
                  ? "Inclua os pedidos da petição inicial para avaliar o risco de cada um."
                  : "Quando os pedidos forem cadastrados, eles aparecerão aqui."
              }
            />
          ) : (
            <ul className="divide-y divide-border" aria-label="Pedidos do processo">
              {active.map((c) => (
                <li key={c.id} className="py-4 first:pt-0 last:pb-0">
                  <ClaimRow claim={c} overview={overview} />
                </li>
              ))}
            </ul>
          )}
          {dismissed.length > 0 ? (
            <details className="rounded-md border border-border px-3 py-2">
              <summary className="cursor-pointer text-xs font-medium text-slate-700">
                Sugestões descartadas ({dismissed.length})
              </summary>
              <ul className="mt-2 flex flex-col gap-3" aria-label="Sugestões descartadas">
                {dismissed.map((c) => (
                  <li key={c.id}>
                    <ClaimRow claim={c} overview={overview} />
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
