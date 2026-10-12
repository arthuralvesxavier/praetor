import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { PROBABILITY_BAND_LABELS, type ProbabilityBand, type ScenarioOrigin } from "@/domain/enums";
import { loadOrganization } from "@/modules/analyses/org-settings";
import { processWhere } from "@/server/auth/access";
import type { AuthContext } from "@/server/auth/context";
import { assertCan } from "@/server/auth/permissions";
import { getDb } from "@/server/db/client";
import { legalProcesses, users } from "@/server/db/schema";
import { processScenarios } from "@/server/db/schema/legal-reports";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/lib/errors";
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
