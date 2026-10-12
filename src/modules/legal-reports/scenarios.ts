import { randomUUID } from "node:crypto";
import { and, count, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { bpToPercent, formatBp } from "@/domain/contingency";
import {
  LOSS_PROBABILITY_LABELS,
  PROBABILITY_BAND_LABELS,
  type LossProbability,
  type ProbabilityBand,
  type ScenarioOrigin,
} from "@/domain/enums";
import { bandForPercent, type ProbabilityBands } from "@/domain/legal-reports";
import { formatDate } from "@/lib/format";
import { loadOrganization } from "@/modules/analyses/org-settings";
import { processWhere } from "@/server/auth/access";
import type { AuthContext } from "@/server/auth/context";
import { assertCan } from "@/server/auth/permissions";
import { getDb, type DbOrTx } from "@/server/db/client";
import { legalProcesses, users } from "@/server/db/schema";
import { processScenarios } from "@/server/db/schema/legal-reports";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/lib/errors";
import { recordAudit } from "@/server/services/audit";
import { addScenarioSchema, idSchema, type AddScenarioInput } from "./schemas";

/**
 * Cenários do processo com faixa de probabilidade. APPEND-ONLY e datado (o
 * banco recusa UPDATE e DELETE): mudar de opinião = registrar novo cenário.
 * O percentual precisa caber na faixa configurada (settings.legalReports.bands).
 */

export type ProcessScenarioItem = {
  id: string;
  description: string;
  probabilityBand: ProbabilityBand;
  percentMin: number;
  percentMax: number;
  comment: string | null;
  origin: ScenarioOrigin;
  authorName: string | null;
  createdAt: Date;
};

async function assertVisibleProcess(ctx: AuthContext, processId: string): Promise<string> {
  const parsed = idSchema.safeParse(processId);
  if (!parsed.success) throw new NotFoundError();
  const [p] = await getDb()
    .select({ id: legalProcesses.id })
    .from(legalProcesses)
    .where(and(eq(legalProcesses.id, parsed.data), processWhere(ctx)));
  if (!p) throw new NotFoundError("Processo não encontrado ou sem permissão de acesso.");
  return p.id;
}

export async function listProcessScenarios(ctx: AuthContext, processId: string): Promise<ProcessScenarioItem[]> {
  assertCan(ctx, "contingency:read");
  const id = await assertVisibleProcess(ctx, processId);
  return getDb()
    .select({
      id: processScenarios.id,
      description: processScenarios.description,
      probabilityBand: processScenarios.probabilityBand,
      percentMin: processScenarios.percentMin,
      percentMax: processScenarios.percentMax,
      comment: processScenarios.comment,
      origin: processScenarios.origin,
      authorName: users.name,
      createdAt: processScenarios.createdAt,
    })
    .from(processScenarios)
    .leftJoin(users, eq(users.id, processScenarios.authorId))
    .where(and(eq(processScenarios.processId, id), eq(processScenarios.organizationId, ctx.organizationId)))
    .orderBy(desc(processScenarios.createdAt));
}

/**
 * Registra um cenário. Pessoa identificada = origem "manual"; contexto de
 * sistema = origem "system" (sugestão automática, sempre revisada por humanos).
 */
export async function addProcessScenario(ctx: AuthContext, processId: string, input: AddScenarioInput): Promise<{ id: string }> {
  assertCan(ctx, "contingency:write");
  if (ctx.kind === "user" && !ctx.userId) throw new ForbiddenError("O registro exige uma pessoa identificada.");
  const parsed = addScenarioSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError("Verifique os campos informados.", z.flattenError(parsed.error).fieldErrors as Record<string, string[]>);
  }
  const data = parsed.data;
  const id = await assertVisibleProcess(ctx, processId);
  const { settings } = await loadOrganization(ctx.organizationId);
  const band = settings.legalReports.bands[data.probabilityBand];
  const percentMin = data.percentMin ?? band.min;
  const percentMax = data.percentMax ?? band.max;
  if (percentMin < band.min || percentMax > band.max || percentMin > percentMax) {
    const msg = `Para a faixa "${PROBABILITY_BAND_LABELS[data.probabilityBand]}" use percentuais entre ${band.min}% e ${band.max}%.`;
    throw new ValidationError(msg, { percentMin: [msg] });
  }
  return getDb().transaction(async (tx) => {
    const [row] = await tx
      .insert(processScenarios)
      .values({
        organizationId: ctx.organizationId,
        processId: id,
        description: data.description,
        probabilityBand: data.probabilityBand,
        percentMin,
        percentMax,
        comment: data.comment?.trim() || null,
        origin: ctx.kind === "system" ? "system" : "manual",
        authorId: ctx.kind === "user" ? ctx.userId : null,
      })
      .returning({ id: processScenarios.id });
    await recordAudit(
      ctx,
      {
        action: "process_scenario.create",
        entityType: "legal_process",
        entityId: id,
        summary: `Cenário registrado (faixa ${PROBABILITY_BAND_LABELS[data.probabilityBand]}, ${percentMin}% a ${percentMax}%).`,
        metadata: { scenarioId: row.id, probabilityBand: data.probabilityBand, percentMin, percentMax },
      },
      tx,
    );
    return { id: row.id };
  });
}

/** Avaliação vigente de um pedido confirmado (base da proposta automática de cenário). */
export type ScenarioProposalSource = {
  claimId: string;
  description: string;
  classification: LossProbability;
  percentageBp: number;
  effectiveFrom: string;
  assessedByName: string | null;
};

function clipText(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** Cenário proposto pelo sistema, ainda não gravado (id e data definidos no planejamento). */
export type PlannedScenarioProposal = {
  id: string;
  description: string;
  probabilityBand: ProbabilityBand;
  percentMin: number;
  percentMax: number;
  comment: string;
  createdAt: Date;
};

/**
 * Planeja (sem gravar) os cenários propostos a partir das avaliações de risco
 * dos pedidos, para um processo que ainda NÃO tem cenário (R1). Um cenário por
 * pedido avaliado: "Condenação no pedido X", na faixa configurada que contém o
 * percentual do pedido (intervalo = limites da faixa). Origem `system` (sem
 * autor), sempre sujeita a revisão humana. O R1 monta a matriz com estes
 * cenários e só os grava na emissão (`insertScenarioProposals`, na mesma
 * transação do relatório): se a emissão falhar, nada fica gravado.
 */
export function planScenarioProposals(
  sources: readonly ScenarioProposalSource[],
  bands: ProbabilityBands,
  now: Date = new Date(),
): PlannedScenarioProposal[] {
  return sources
    .map((s): PlannedScenarioProposal | null => {
      const percent = Math.round(bpToPercent(s.percentageBp));
      const band = bandForPercent(bands, percent);
      if (!band) return null;
      return {
        id: randomUUID(),
        description: `Condenação no pedido "${clipText(s.description, 140)}"`,
        probabilityBand: band,
        percentMin: bands[band].min,
        percentMax: bands[band].max,
        comment:
          `Proposta do sistema a partir da avaliação de risco do pedido (${LOSS_PROBABILITY_LABELS[s.classification]}, ${formatBp(s.percentageBp)}, ` +
          `vigente desde ${formatDate(s.effectiveFrom, s.effectiveFrom)}${s.assessedByName ? `, avaliada por ${s.assessedByName}` : ""}). ` +
          "Sujeita a revisão: para confirmar ou corrigir, registre um novo cenário.",
        createdAt: now,
      };
    })
    .filter((r): r is PlannedScenarioProposal => r !== null);
}

/**
 * Grava os cenários planejados (append-only), DENTRO da transação de emissão do
 * relatório que os apresenta. Sob a trava da linha do processo: se outro
 * cenário foi registrado depois do planejamento, a emissão é recusada (a matriz
 * do relatório não refletiria a base). Auditado com quem pediu a geração (a
 * pessoa, ou o sistema na geração automática); os cenários continuam com origem
 * `system` e sem autor, porque o conteúdo é proposta do sistema.
 */
export async function insertScenarioProposals(
  tx: DbOrTx,
  ctx: AuthContext,
  processId: string,
  planned: readonly PlannedScenarioProposal[],
  opts: { reportReference: string },
): Promise<void> {
  if (planned.length === 0) return;
  const [p] = await tx
    .select({ id: legalProcesses.id })
    .from(legalProcesses)
    .where(and(eq(legalProcesses.id, processId), eq(legalProcesses.organizationId, ctx.organizationId)))
    .for("update");
  if (!p) throw new NotFoundError("Processo não encontrado ou sem permissão de acesso.");
  const [existing] = await tx
    .select({ n: count() })
    .from(processScenarios)
    .where(and(eq(processScenarios.processId, processId), eq(processScenarios.organizationId, ctx.organizationId)));
  if (Number(existing?.n ?? 0) > 0) {
    throw new ConflictError("Cenários foram registrados para este processo enquanto o relatório era montado. Gere o relatório de novo.");
  }
  await tx.insert(processScenarios).values(
    planned.map((r) => ({
      id: r.id,
      organizationId: ctx.organizationId,
      processId,
      description: r.description,
      probabilityBand: r.probabilityBand,
      percentMin: r.percentMin,
      percentMax: r.percentMax,
      comment: r.comment,
      origin: "system" as const,
      authorId: null,
      createdAt: r.createdAt,
    })),
  );
  const n = planned.length;
  const who = ctx.kind === "user" ? `na geração do relatório ${opts.reportReference} pedida por ${ctx.name}` : `na geração automática do relatório ${opts.reportReference}`;
  await recordAudit(
    ctx,
    {
      action: "process_scenario.propose",
      entityType: "legal_process",
      entityId: processId,
      summary: `${n === 1 ? "1 cenário proposto" : `${n} cenários propostos`} automaticamente a partir das avaliações dos pedidos (origem: sistema, sujeitos a revisão), ${who}.`,
      metadata: {
        scenarioIds: planned.map((r) => r.id),
        bands: planned.map((r) => r.probabilityBand),
        reportReference: opts.reportReference,
        requestedBy: ctx.kind,
      },
    },
    tx,
  );
}
