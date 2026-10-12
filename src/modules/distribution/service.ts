/**
 * Distribuição de demandas (RF-20) e carga de trabalho (TE-08).
 *
 * - Rules are organization-level records (`distribution_rules`), gated by
 *   `distribution:manage`. Active rules are evaluated by ascending priority;
 *   the first rule whose criteria match the process and that has at least
 *   one active assignee wins (see ./matching.ts).
 * - Methods: `fixed` (first active user of the list), `round_robin` (cursor
 *   advanced inside the assignment transaction, with the rule row locked) and
 *   `least_loaded` (fewest active processes as responsible + open intakes).
 * - No rule applies → least loaded among the active lawyers of the process
 *   unit, else among every active lawyer of the organization.
 * - A process that already has a responsible keeps it (method `kept`) unless
 *   the caller forces a new decision (forcing = redistribution, which needs
 *   `distribution:manage`). The process row is locked while deciding, so two
 *   concurrent assignments never both apply.
 * - Changing the responsible also moves the process's open intakes to the new
 *   responsible (`syncOpenIntakesWithResponsible`) and, when the caller asks
 *   for it (`notify`), sends the simulated "Novo processo atribuído" e-mail.
 * - Workload figures use the row visibility of the caller (`processWhere`) and
 *   the pure contingency rules of `@/domain/contingency` (RN-02/03/04).
 *
 * Conventions (docs/dev/MODULE_CONTRACTS.md): ctx first, assertCan, tenant
 * checks on every foreign id, mutations in a transaction with recordAudit.
 */
import { and, asc, eq, gt, inArray, isNotNull, isNull, notExists, notInArray, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { addToBucket, emptyBucket, type MoneyBucket } from "@/domain/contingency";
import { ASSIGNMENT_METHOD_LABELS, ROLE_LABELS, type AssignmentMethod, type Role } from "@/domain/enums";
import { pluralize } from "@/lib/format";
import { loadOrganization } from "@/modules/analyses/org-settings";
import { markAnalysesStaleForEntity } from "@/modules/analyses/service";
import { recordRiskBp } from "@/modules/contingency/position";
import { intakeAssigneeSql, sendAssignmentEmail, syncOpenIntakesWithResponsible } from "@/modules/intake/assignment";
import { assertLawFirmInOrg } from "@/modules/organization/service";
import { processWhere } from "@/server/auth/access";
import type { AuthContext } from "@/server/auth/context";
import { assertCan, can } from "@/server/auth/permissions";
import { getDb, type DbOrTx } from "@/server/db/client";
import {
  caseBriefs,
  caseIntakes,
  companies,
  deadlines,
  distributionRules,
  lawFirms,
  legalProcesses,
  processGuarantees,
  processValuations,
  units,
  users,
  type DistributionAssignment,
  type DistributionCriteria,
} from "@/server/db/schema";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/lib/errors";
import { diffChanges, recordAudit } from "@/server/services/audit";
import { describeCriteria, evaluateCriteria, normalizeCourt, type NameMaps, type ProcessFacts } from "./matching";
import {
  DISTRIBUTION_METHOD_LABELS,
  isAssignableRole,
  manualAssignmentSchema,
  ruleInputSchema,
  type DistributionMethod,
  type ManualAssignmentInput,
  type RuleInput,
  type RuleValues,
} from "./schemas";

// ---------------------------------------------------------------------------
// Contract types
// ---------------------------------------------------------------------------

export type AssignmentDecision = {
  userId: string | null;
  userName: string | null;
  method: AssignmentMethod;
  ruleId: string | null;
  ruleName: string | null;
  lawFirmId: string | null;
  unitId: string | null;
  /** pt-BR explanation shown in the intake timeline and the e-mail. */
  reason: string;
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const PROCESS_NOT_FOUND = "Processo não encontrado ou sem permissão de acesso.";
const RULE_NOT_FOUND = "Regra de distribuição não encontrada.";
const ACTIVE_STATUSES = ["active", "suspended"] as const;
/** Intake statuses that no longer count as open work. */
const CLOSED_INTAKE_STATUSES = ["approved", "cancelled"] as const;

const isGuid = (v: unknown): v is string => typeof v === "string" && z.guid().safeParse(v).success;

function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(undefined, z.flattenError(result.error).fieldErrors as Record<string, string[]>);
  }
  return result.data;
}

function fieldError(field: string, message: string): ValidationError {
  return new ValidationError(undefined, { [field]: [message] });
}

/** Assignment operations accept either permission (system context always passes). */
function assertCanAssign(ctx: AuthContext): void {
  if (!can(ctx, "distribution:manage") && !can(ctx, "intake:manage")) throw new ForbiddenError();
}

const REDISTRIBUTION_FORBIDDEN =
  "Trocar o responsável já definido de um processo exige a permissão de redistribuir demandas (gestão jurídica).";
const EXTERNAL_COUNSEL_FORBIDDEN =
  "Atribuir um processo a um escritório externo exige a permissão de redistribuir demandas (gestão jurídica).";

const processColumns = {
  id: legalProcesses.id,
  organizationId: legalProcesses.organizationId,
  number: legalProcesses.number,
  title: legalProcesses.title,
  court: legalProcesses.court,
  area: legalProcesses.area,
  companyId: legalProcesses.companyId,
  unitId: legalProcesses.unitId,
  state: legalProcesses.state,
  city: legalProcesses.city,
  instance: legalProcesses.instance,
  processClass: legalProcesses.processClass,
  claimAmountCents: legalProcesses.claimAmountCents,
  responsibleId: legalProcesses.responsibleId,
  lawFirmId: legalProcesses.lawFirmId,
};

type DistributionProcess = {
  id: string;
  organizationId: string;
  number: string;
  title: string;
  court: string;
  area: ProcessFacts["area"];
  companyId: string | null;
  unitId: string | null;
  state: string | null;
  city: string | null;
  instance: ProcessFacts["instance"];
  processClass: string | null;
  claimAmountCents: number | null;
  responsibleId: string | null;
  lawFirmId: string | null;
};

/**
 * `lock`: `FOR UPDATE` on the process row (inside a transaction). Assignments
 * lock it before reading `responsibleId`, so a concurrent assignment waits and
 * then sees the committed responsible.
 */
async function loadProcess(
  ctx: AuthContext,
  processId: string,
  db: DbOrTx = getDb(),
  opts: { lock?: boolean } = {},
): Promise<DistributionProcess> {
  if (!isGuid(processId)) throw new NotFoundError(PROCESS_NOT_FOUND);
  const query = db
    .select(processColumns)
    .from(legalProcesses)
    .where(and(eq(legalProcesses.id, processId), processWhere(ctx)))
    .limit(1);
  const [row] = opts.lock ? await query.for("update", { of: legalProcesses }) : await query;
  if (!row) throw new NotFoundError(PROCESS_NOT_FOUND);
  return row;
}

function toFacts(p: DistributionProcess): ProcessFacts {
  return {
    court: p.court,
    area: p.area,
    companyId: p.companyId,
    unitId: p.unitId,
    state: p.state,
    city: p.city,
    instance: p.instance,
    processClass: p.processClass,
    claimAmountCents: p.claimAmountCents,
  };
}

type UserInfo = {
  id: string;
  name: string;
  role: Role;
  unitId: string | null;
  lawFirmId: string | null;
  isActive: boolean;
};

async function loadUsers(organizationId: string, ids: readonly string[], db: DbOrTx = getDb()): Promise<Map<string, UserInfo>> {
  const unique = [...new Set(ids.filter(isGuid))];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      role: users.role,
      unitId: users.unitId,
      lawFirmId: users.lawFirmId,
      isActive: users.isActive,
    })
    .from(users)
    .where(and(eq(users.organizationId, organizationId), inArray(users.id, unique)));
  return new Map(rows.map((r) => [r.id, r]));
}

function canReceive(u: UserInfo | undefined): u is UserInfo {
  return Boolean(u && u.isActive && isAssignableRole(u.role));
}

type RuleRow = typeof distributionRules.$inferSelect;

async function loadRules(organizationId: string, db: DbOrTx, opts: { lock?: boolean } = {}): Promise<RuleRow[]> {
  const query = db
    .select()
    .from(distributionRules)
    .where(eq(distributionRules.organizationId, organizationId))
    .orderBy(asc(distributionRules.priority), asc(distributionRules.createdAt), asc(distributionRules.id));
  return opts.lock ? query.for("update") : query;
}

async function nameMaps(organizationId: string, db: DbOrTx = getDb()): Promise<Required<NameMaps> & { lawFirms: Record<string, string> }> {
  const [companyRows, unitRows, firmRows] = await Promise.all([
    db.select({ id: companies.id, name: companies.name }).from(companies).where(eq(companies.organizationId, organizationId)),
    db.select({ id: units.id, name: units.name }).from(units).where(eq(units.organizationId, organizationId)),
    db.select({ id: lawFirms.id, name: lawFirms.name }).from(lawFirms).where(eq(lawFirms.organizationId, organizationId)),
  ]);
  return {
    companies: Object.fromEntries(companyRows.map((r) => [r.id, r.name])),
    units: Object.fromEntries(unitRows.map((r) => [r.id, r.name])),
    lawFirms: Object.fromEntries(firmRows.map((r) => [r.id, r.name])),
  };
}

export type UserLoad = { activeProcesses: number; openIntakes: number };

/**
 * Organization-wide load of each user (distribution is an organization-level
 * decision): active processes as responsible + intakes assigned to them that
 * are not finished (brief not yet approved/rejected). The responsible of an
 * open intake is the responsible of its process (`intakeAssigneeSql`), so a
 * redistribution or a process edit moves the intake load too.
 */
async function computeLoads(organizationId: string, userIds: readonly string[], db: DbOrTx = getDb()): Promise<Map<string, UserLoad>> {
  const ids = [...new Set(userIds)];
  const loads = new Map<string, UserLoad>(ids.map((id) => [id, { activeProcesses: 0, openIntakes: 0 }]));
  if (ids.length === 0) return loads;
  const assignee = intakeAssigneeSql();
  const [processRows, intakeRows] = await Promise.all([
    db
      .select({ userId: legalProcesses.responsibleId, n: sql<number>`count(*)::int` })
      .from(legalProcesses)
      .where(
        and(
          eq(legalProcesses.organizationId, organizationId),
          isNull(legalProcesses.deletedAt),
          inArray(legalProcesses.status, [...ACTIVE_STATUSES]),
          inArray(legalProcesses.responsibleId, ids),
        ),
      )
      .groupBy(legalProcesses.responsibleId),
    db
      .select({ userId: assignee, n: sql<number>`count(*)::int` })
      .from(caseIntakes)
      .innerJoin(legalProcesses, and(eq(legalProcesses.id, caseIntakes.processId), isNull(legalProcesses.deletedAt)))
      .leftJoin(caseBriefs, eq(caseBriefs.id, caseIntakes.briefId))
      .where(
        and(
          eq(caseIntakes.organizationId, organizationId),
          inArray(assignee, ids),
          notInArray(caseIntakes.status, [...CLOSED_INTAKE_STATUSES]),
          or(isNull(caseBriefs.status), notInArray(caseBriefs.status, ["approved", "rejected"])),
        ),
      )
      .groupBy(assignee),
  ]);
  for (const r of processRows) if (r.userId) loads.get(r.userId)!.activeProcesses = r.n;
  for (const r of intakeRows) if (r.userId) loads.get(r.userId)!.openIntakes = r.n;
  return loads;
}

function loadText(load: UserLoad | undefined): string {
  const l = load ?? { activeProcesses: 0, openIntakes: 0 };
  return `${pluralize(l.activeProcesses, "processo ativo", "processos ativos", { withCount: true })} e ${pluralize(
    l.openIntakes,
    "entrada em aberto",
    "entradas em aberto",
    { withCount: true },
  )}`;
}

/** Fewest active processes + open intakes; ties keep the candidates' order. */
function pickLeastLoaded(candidates: readonly UserInfo[], loads: Map<string, UserLoad>): UserInfo {
  let best = candidates[0];
  let bestLoad = Number.POSITIVE_INFINITY;
  for (const c of candidates) {
    const l = loads.get(c.id);
    const total = (l?.activeProcesses ?? 0) + (l?.openIntakes ?? 0);
    if (total < bestLoad) {
      best = c;
      bestLoad = total;
    }
  }
  return best;
}

export type RuleEvaluation = {
  ruleId: string;
  ruleName: string;
  priority: number;
  isActive: boolean;
  method: DistributionMethod;
  /** False for inactive rules and rules after the one that was applied. */
  evaluated: boolean;
  matched: boolean;
  matchedOn: string[];
  mismatches: string[];
  /** Why a matching rule was not used, or why it was not evaluated. */
  skippedReason: string | null;
  selected: boolean;
};

type InternalDecision = {
  decision: AssignmentDecision;
  evaluations: RuleEvaluation[];
  /** Round-robin rule used (its cursor must advance when the decision is applied). */
  roundRobinRuleId: string | null;
};

function ruleAssignment(rule: RuleRow): DistributionAssignment {
  const a = (rule.assignment ?? {}) as Partial<DistributionAssignment>;
  return {
    method: a.method ?? "least_loaded",
    userIds: Array.isArray(a.userIds) ? a.userIds : [],
    lawFirmId: a.lawFirmId ?? null,
    unitId: a.unitId ?? null,
  };
}

async function decideInternal(
  ctx: AuthContext,
  process: DistributionProcess,
  opts: { db: DbOrTx; lock: boolean },
): Promise<InternalDecision> {
  const { db } = opts;
  const orgId = ctx.organizationId;
  const [rules, names] = await Promise.all([loadRules(orgId, db, { lock: opts.lock }), nameMaps(orgId, db)]);
  const facts = toFacts(process);
  const evaluations: RuleEvaluation[] = [];
  let chosen: AssignmentDecision | null = null;
  let roundRobinRuleId: string | null = null;

  for (const rule of rules) {
    const assignment = ruleAssignment(rule);
    const base = {
      ruleId: rule.id,
      ruleName: rule.name,
      priority: rule.priority,
      isActive: rule.isActive,
      method: assignment.method,
      matchedOn: [] as string[],
      mismatches: [] as string[],
      selected: false,
    };
    if (!rule.isActive) {
      evaluations.push({ ...base, evaluated: false, matched: false, skippedReason: "Regra inativa, não é avaliada." });
      continue;
    }
    if (chosen) {
      evaluations.push({
        ...base,
        evaluated: false,
        matched: false,
        skippedReason: "Não avaliada: uma regra de prioridade anterior já foi aplicada.",
      });
      continue;
    }
    const ev = evaluateCriteria(rule.criteria ?? {}, facts, names);
    if (!ev.matched) {
      evaluations.push({ ...base, evaluated: true, matched: false, matchedOn: ev.matchedOn, mismatches: ev.mismatches, skippedReason: null });
      continue;
    }
    const people = await loadUsers(orgId, assignment.userIds, db);
    const eligible = assignment.userIds.map((id) => people.get(id)).filter(canReceive);
    if (eligible.length === 0) {
      evaluations.push({
        ...base,
        evaluated: true,
        matched: true,
        matchedOn: ev.matchedOn,
        skippedReason: "Critérios atendidos, mas nenhum advogado ativo da regra pode receber processos.",
      });
      continue;
    }

    let pick: UserInfo;
    let method: AssignmentMethod;
    let how: string;
    switch (assignment.method) {
      case "fixed":
        pick = eligible[0];
        method = "rule";
        how = `responsável fixo da regra: ${pick.name}`;
        break;
      case "round_robin": {
        const index = ((rule.rrCursor % eligible.length) + eligible.length) % eligible.length;
        pick = eligible[index];
        method = "round_robin";
        how = `rodízio entre ${pluralize(eligible.length, "pessoa", "pessoas", { withCount: true })}, vez de ${pick.name} (posição ${index + 1} de ${eligible.length})`;
        roundRobinRuleId = rule.id;
        break;
      }
      default: {
        const loads = await computeLoads(orgId, eligible.map((u) => u.id), db);
        pick = pickLeastLoaded(eligible, loads);
        method = "least_loaded";
        how = `menor carga entre ${pluralize(eligible.length, "pessoa", "pessoas", { withCount: true })} da regra: ${pick.name} (${loadText(loads.get(pick.id))})`;
      }
    }
    const criteriaText =
      ev.matchedOn.length > 0 ? `critérios atendidos: ${ev.matchedOn.join(", ")}` : "regra sem critérios (vale para qualquer processo)";
    chosen = {
      userId: pick.id,
      userName: pick.name,
      method,
      ruleId: rule.id,
      ruleName: rule.name,
      lawFirmId: assignment.lawFirmId ?? (pick.role === "external_counsel" ? pick.lawFirmId : null),
      unitId: assignment.unitId ?? null,
      reason: `Regra “${rule.name}” (prioridade ${rule.priority}): ${criteriaText}; ${how}.`,
    };
    evaluations.push({ ...base, evaluated: true, matched: true, matchedOn: ev.matchedOn, skippedReason: null, selected: true });
  }

  if (!chosen) chosen = await fallbackDecision(orgId, process, names, db);
  return { decision: chosen, evaluations, roundRobinRuleId: chosen.method === "round_robin" ? roundRobinRuleId : null };
}

async function fallbackDecision(
  organizationId: string,
  process: DistributionProcess,
  names: Required<NameMaps>,
  db: DbOrTx,
): Promise<AssignmentDecision> {
  const lawyers = await db
    .select({
      id: users.id,
      name: users.name,
      role: users.role,
      unitId: users.unitId,
      lawFirmId: users.lawFirmId,
      isActive: users.isActive,
    })
    .from(users)
    .where(and(eq(users.organizationId, organizationId), eq(users.isActive, true), eq(users.role, "lawyer")))
    .orderBy(asc(users.name), asc(users.id));

  const unitName = process.unitId ? (names.units[process.unitId] ?? "do processo") : null;
  let pool = process.unitId ? lawyers.filter((u) => u.unitId === process.unitId) : [];
  let scope: string;
  if (pool.length > 0) {
    scope = `advogados da unidade ${unitName}`;
  } else {
    pool = lawyers;
    scope = process.unitId
      ? `todos os advogados (a unidade ${unitName} não tem advogado ativo)`
      : "todos os advogados (processo sem unidade)";
  }
  const empty = { method: "least_loaded" as const, ruleId: null, ruleName: null, lawFirmId: null, unitId: null };
  if (pool.length === 0) {
    return {
      ...empty,
      userId: null,
      userName: null,
      reason: "Nenhuma regra aplicável e nenhum advogado ativo disponível. Atribua o responsável manualmente.",
    };
  }
  const loads = await computeLoads(organizationId, pool.map((u) => u.id), db);
  const pick = pickLeastLoaded(pool, loads);
  return {
    ...empty,
    userId: pick.id,
    userName: pick.name,
    reason: `Nenhuma regra aplicável; menor carga entre ${scope}: ${pick.name} (${loadText(loads.get(pick.id))}).`,
  };
}

async function keptDecision(ctx: AuthContext, process: DistributionProcess, db: DbOrTx = getDb()): Promise<AssignmentDecision> {
  const people = await loadUsers(ctx.organizationId, [process.responsibleId!], db);
  const name = people.get(process.responsibleId!)?.name ?? "usuário cadastrado";
  return {
    userId: process.responsibleId,
    userName: name,
    method: "kept",
    ruleId: null,
    ruleName: null,
    lawFirmId: process.lawFirmId,
    unitId: process.unitId,
    reason: `Responsável já cadastrado no processo: ${name}. Nenhuma regra foi aplicada.`,
  };
}

type ApplyOptions = {
  /** Intake whose own flow records this assignment (the intake module); the other open intakes are synced here. */
  handledIntakeId?: string | null;
};

type ApplyResult = { responsibleChanged: boolean; syncedIntakeIds: string[] };

/**
 * Writes the decision on the process, audited (`legal_process.assign`):
 * - `responsibleId` always; `unitId` only when empty;
 * - `lawFirmId` follows external counsel: a new responsible from a law firm
 *   (or a rule that fixes a firm) brings that firm; when the previous
 *   responsible was the external counsel through whom the process belonged to
 *   their firm, a new responsible outside that firm takes the firm out (the old
 *   firm must stop seeing the process). A firm linked to the process
 *   independently of the responsible (internal responsible) is kept.
 * When the responsible changes, the open intakes of the process follow it
 * (same transaction) and their pipeline is enqueued to notify the new one.
 */
async function applyToProcess(
  ctx: AuthContext,
  tx: DbOrTx,
  before: DistributionProcess,
  decision: AssignmentDecision,
  opts: ApplyOptions = {},
): Promise<ApplyResult> {
  const patch: { responsibleId: string | null; lawFirmId?: string | null; unitId?: string } = { responsibleId: decision.userId };
  if (decision.lawFirmId && decision.lawFirmId !== before.lawFirmId) {
    patch.lawFirmId = decision.lawFirmId;
  } else if (!decision.lawFirmId && before.lawFirmId && before.responsibleId && before.responsibleId !== decision.userId) {
    const people = await loadUsers(
      ctx.organizationId,
      [before.responsibleId, decision.userId].filter((x): x is string => Boolean(x)),
      tx,
    );
    const previous = people.get(before.responsibleId);
    const next = decision.userId ? people.get(decision.userId) : undefined;
    const firmCameWithPrevious = previous?.role === "external_counsel" && previous.lawFirmId === before.lawFirmId;
    const nextInSameFirm = next?.role === "external_counsel" && next.lawFirmId === before.lawFirmId;
    if (firmCameWithPrevious && !nextInSameFirm) patch.lawFirmId = null;
  }
  if (!before.unitId && decision.unitId) patch.unitId = decision.unitId;
  const changes = diffChanges(before, { ...before, ...patch }, ["responsibleId", "lawFirmId", "unitId"]);
  if (!changes) return { responsibleChanged: false, syncedIntakeIds: [] };
  await tx
    .update(legalProcesses)
    .set(patch)
    .where(and(eq(legalProcesses.id, before.id), eq(legalProcesses.organizationId, ctx.organizationId)));
  const responsibleChanged = before.responsibleId !== decision.userId;
  const syncedIntakeIds =
    responsibleChanged && decision.userId
      ? await syncOpenIntakesWithResponsible(tx, {
          organizationId: ctx.organizationId,
          processId: before.id,
          change: { ...decision, userId: decision.userId },
          actorName: ctx.name,
          skipIntakeId: opts.handledIntakeId ?? null,
        })
      : [];
  const firmNote =
    patch.lawFirmId === null
      ? " Escritório externo do responsável anterior desvinculado do processo."
      : patch.lawFirmId
        ? " Escritório externo vinculado ao processo."
        : "";
  await recordAudit(
    ctx,
    {
      action: "legal_process.assign",
      entityType: "legal_process",
      entityId: before.id,
      summary: `Responsável do processo ${before.number} definido: ${decision.userName ?? "Não informado"} (${ASSIGNMENT_METHOD_LABELS[decision.method]}).${firmNote}`,
      changes,
      metadata: {
        method: decision.method,
        ruleId: decision.ruleId,
        reason: decision.reason,
        ...(syncedIntakeIds.length > 0 ? { intakeIds: syncedIntakeIds } : {}),
      },
    },
    tx,
  );
  await markAnalysesStaleForEntity(
    { organizationId: ctx.organizationId, entityId: before.id, reason: "Responsável do processo alterado" },
    tx,
  );
  return { responsibleChanged, syncedIntakeIds };
}

// ---------------------------------------------------------------------------
// Cross-module contract
// ---------------------------------------------------------------------------

/** Decides who should handle the process (does not persist). */
export async function decideAssignment(ctx: AuthContext, processId: string): Promise<AssignmentDecision> {
  assertCanAssign(ctx);
  const process = await loadProcess(ctx, processId);
  if (process.responsibleId) return keptDecision(ctx, process);
  return (await decideInternal(ctx, process, { db: getDb(), lock: false })).decision;
}

export type AssignOptions = {
  /** Replace an existing responsible (redistribution: requires `distribution:manage`). */
  force?: boolean;
  /**
   * When the responsible changes, send the simulated "Novo processo atribuído"
   * e-mail (only if `settings.email.notifyOnAssignment` is on). The
   * distribution screen passes it; the bulk distribution after an import does not.
   */
  notify?: boolean;
  /** Intake whose own flow records this assignment (intake module only). */
  handledIntakeId?: string | null;
};

/**
 * Decides and applies the assignment (see `applyToProcess`), audited. Keeps an
 * existing responsible unless `force`. Requires `distribution:manage` or
 * `intake:manage` (system context allowed); `force` requires
 * `distribution:manage`. The process row is locked first, so a concurrent call
 * waits and then keeps the responsible the first one applied.
 */
export async function assignResponsible(
  ctx: AuthContext,
  processId: string,
  opts: AssignOptions = {},
): Promise<AssignmentDecision> {
  assertCanAssign(ctx);
  if (opts.force && !can(ctx, "distribution:manage")) throw new ForbiddenError(REDISTRIBUTION_FORBIDDEN);
  const outcome = await getDb().transaction(async (tx) => {
    const before = await loadProcess(ctx, processId, tx, { lock: true });
    if (before.responsibleId && !opts.force) return { decision: await keptDecision(ctx, before, tx), changed: false };
    const { decision, roundRobinRuleId } = await decideInternal(ctx, before, { db: tx, lock: true });
    if (!decision.userId) return { decision, changed: false };
    if (roundRobinRuleId) {
      await tx
        .update(distributionRules)
        .set({ rrCursor: sql`${distributionRules.rrCursor} + 1` })
        .where(and(eq(distributionRules.id, roundRobinRuleId), eq(distributionRules.organizationId, ctx.organizationId)));
    }
    const applied = await applyToProcess(ctx, tx, before, decision, { handledIntakeId: opts.handledIntakeId });
    return { decision, changed: applied.responsibleChanged };
  });
  if (opts.notify && outcome.changed && outcome.decision.userId) {
    await sendAssignmentEmail({
      organizationId: ctx.organizationId,
      processId,
      toUserId: outcome.decision.userId,
      reason: outcome.decision.reason,
      actorUserId: ctx.userId,
    });
  }
  return outcome.decision;
}

// ---------------------------------------------------------------------------
// Manual assignment
// ---------------------------------------------------------------------------

/**
 * Manual assignment (intake page and distribution screen). The reason is
 * mandatory and goes to the audit trail. `intake:manage` only allows the FIRST
 * assignment of a process to an internal lawyer/manager; replacing an existing
 * responsible or choosing an external counsel (which links their law firm)
 * requires `distribution:manage`.
 */
export async function applyManualAssignment(
  ctx: AuthContext,
  processId: string,
  input: ManualAssignmentInput,
  opts: Pick<AssignOptions, "notify" | "handledIntakeId"> = {},
): Promise<AssignmentDecision> {
  assertCanAssign(ctx);
  const v = parse(manualAssignmentSchema, input);
  const person = (await loadUsers(ctx.organizationId, [v.userId])).get(v.userId);
  if (!canReceive(person)) {
    throw fieldError("userId", "Selecione um advogado, gestor jurídico ou escritório externo ativo da organização.");
  }
  const redistributes = can(ctx, "distribution:manage");
  if (person.role === "external_counsel" && !redistributes) throw new ForbiddenError(EXTERNAL_COUNSEL_FORBIDDEN);
  const outcome = await getDb().transaction(async (tx) => {
    const before = await loadProcess(ctx, processId, tx, { lock: true });
    if (before.responsibleId === person.id) {
      throw new ConflictError(`${person.name} já é o responsável por este processo.`);
    }
    if (before.responsibleId && !redistributes) throw new ForbiddenError(REDISTRIBUTION_FORBIDDEN);
    const decision: AssignmentDecision = {
      userId: person.id,
      userName: person.name,
      method: "manual",
      ruleId: null,
      ruleName: null,
      lawFirmId: person.role === "external_counsel" ? person.lawFirmId : null,
      unitId: null,
      reason: `Atribuição manual por ${ctx.name}. Motivo: ${v.reason}`,
    };
    const applied = await applyToProcess(ctx, tx, before, decision, { handledIntakeId: opts.handledIntakeId });
    return { decision, changed: applied.responsibleChanged };
  });
  if (opts.notify && outcome.changed) {
    await sendAssignmentEmail({
      organizationId: ctx.organizationId,
      processId,
      toUserId: person.id,
      reason: outcome.decision.reason,
      actorUserId: ctx.userId,
    });
  }
  return outcome.decision;
}

/**
 * Manual redistribution from the distribution screen (`distribution:manage`).
 * Open intakes of the process follow the new responsible; the simulated
 * "Novo processo atribuído" e-mail goes out when enabled in the settings.
 */
export async function reassignResponsible(
  ctx: AuthContext,
  processId: string,
  input: ManualAssignmentInput,
): Promise<AssignmentDecision> {
  assertCan(ctx, "distribution:manage");
  return applyManualAssignment(ctx, processId, input, { notify: true });
}

// ---------------------------------------------------------------------------
// Rule preview ("testar regras")
// ---------------------------------------------------------------------------

export type AssignmentPreview = {
  process: {
    id: string;
    number: string;
    title: string;
    court: string;
    city: string | null;
    state: string | null;
    area: ProcessFacts["area"];
    instance: ProcessFacts["instance"];
    processClass: string | null;
    claimAmountCents: number | null;
    companyName: string | null;
    unitName: string | null;
    lawFirmName: string | null;
    responsibleId: string | null;
    responsibleName: string | null;
  };
  /** What the rules decide when the process is (re)distributed — ignores the current responsible. */
  decision: AssignmentDecision;
  evaluations: RuleEvaluation[];
};

/** Shows how the rules would distribute the process, without applying anything. */
export async function previewAssignment(ctx: AuthContext, processId: string): Promise<AssignmentPreview> {
  assertCan(ctx, "distribution:manage");
  const process = await loadProcess(ctx, processId);
  const [{ decision, evaluations }, names, people] = await Promise.all([
    decideInternal(ctx, process, { db: getDb(), lock: false }),
    nameMaps(ctx.organizationId),
    loadUsers(ctx.organizationId, process.responsibleId ? [process.responsibleId] : []),
  ]);
  return {
    process: {
      id: process.id,
      number: process.number,
      title: process.title,
      court: process.court,
      city: process.city,
      state: process.state,
      area: process.area,
      instance: process.instance,
      processClass: process.processClass,
      claimAmountCents: process.claimAmountCents,
      companyName: process.companyId ? (names.companies[process.companyId] ?? null) : null,
      unitName: process.unitId ? (names.units[process.unitId] ?? null) : null,
      lawFirmName: process.lawFirmId ? (names.lawFirms[process.lawFirmId] ?? null) : null,
      responsibleId: process.responsibleId,
      responsibleName: process.responsibleId ? (people.get(process.responsibleId)?.name ?? null) : null,
    },
    decision,
    evaluations,
  };
}

// ---------------------------------------------------------------------------
// Assignable users
// ---------------------------------------------------------------------------

export type AssignableUser = {
  id: string;
  name: string;
  role: Role;
  roleLabel: string;
  unitId: string | null;
  unitName: string | null;
  lawFirmId: string | null;
  lawFirmName: string | null;
};

/** Active users who can receive processes (lawyers, legal managers, external counsel). */
export async function listAssignableUsers(ctx: AuthContext): Promise<AssignableUser[]> {
  assertCanAssign(ctx);
  const rows = await getDb()
    .select({
      id: users.id,
      name: users.name,
      role: users.role,
      unitId: users.unitId,
      unitName: units.name,
      lawFirmId: users.lawFirmId,
      lawFirmName: lawFirms.name,
    })
    .from(users)
    .leftJoin(units, eq(units.id, users.unitId))
    .leftJoin(lawFirms, eq(lawFirms.id, users.lawFirmId))
    .where(
      and(
        eq(users.organizationId, ctx.organizationId),
        eq(users.isActive, true),
        inArray(users.role, ["lawyer", "legal_manager", "external_counsel"]),
      ),
    )
    .orderBy(asc(users.name));
  return rows.map((r) => ({ ...r, roleLabel: ROLE_LABELS[r.role] }));
}

// ---------------------------------------------------------------------------
// Rules CRUD
// ---------------------------------------------------------------------------

export type RuleListItem = {
  id: string;
  name: string;
  description: string | null;
  priority: number;
  isActive: boolean;
  criteriaSummary: string[];
  method: DistributionMethod;
  methodLabel: string;
  assignees: { id: string; name: string; available: boolean }[];
  /** Next person of the round robin (only for `round_robin`). */
  nextInRotation: string | null;
  lawFirmName: string | null;
  assignUnitName: string | null;
  updatedAt: Date;
};

export type RuleDetail = RuleListItem & {
  criteria: DistributionCriteria;
  assignment: DistributionAssignment;
};

function toListItem(
  rule: RuleRow,
  people: Map<string, UserInfo>,
  names: Required<NameMaps> & { lawFirms: Record<string, string> },
): RuleDetail {
  const assignment = ruleAssignment(rule);
  const assignees = assignment.userIds.map((id) => {
    const u = people.get(id);
    return { id, name: u?.name ?? "Usuário removido", available: canReceive(u) };
  });
  const available = assignees.filter((a) => a.available);
  const nextInRotation =
    assignment.method === "round_robin" && available.length > 0
      ? available[((rule.rrCursor % available.length) + available.length) % available.length].name
      : null;
  return {
    id: rule.id,
    name: rule.name,
    description: rule.description,
    priority: rule.priority,
    isActive: rule.isActive,
    criteriaSummary: describeCriteria(rule.criteria ?? {}, names),
    method: assignment.method,
    methodLabel: DISTRIBUTION_METHOD_LABELS[assignment.method],
    assignees,
    nextInRotation,
    lawFirmName: assignment.lawFirmId ? (names.lawFirms[assignment.lawFirmId] ?? "Escritório removido") : null,
    assignUnitName: assignment.unitId ? (names.units[assignment.unitId] ?? "Unidade removida") : null,
    updatedAt: rule.updatedAt,
    criteria: rule.criteria ?? {},
    assignment,
  };
}

export async function listRules(ctx: AuthContext): Promise<RuleListItem[]> {
  assertCan(ctx, "distribution:manage");
  const rules = await loadRules(ctx.organizationId, getDb());
  const [people, names] = await Promise.all([
    loadUsers(ctx.organizationId, rules.flatMap((r) => ruleAssignment(r).userIds)),
    nameMaps(ctx.organizationId),
  ]);
  return rules.map((r) => toListItem(r, people, names));
}

async function loadRule(ctx: AuthContext, id: string, db: DbOrTx = getDb()): Promise<RuleRow> {
  if (!isGuid(id)) throw new NotFoundError(RULE_NOT_FOUND);
  const [row] = await db
    .select()
    .from(distributionRules)
    .where(and(eq(distributionRules.id, id), eq(distributionRules.organizationId, ctx.organizationId)))
    .limit(1);
  if (!row) throw new NotFoundError(RULE_NOT_FOUND);
  return row;
}

export async function getRule(ctx: AuthContext, id: string): Promise<RuleDetail> {
  assertCan(ctx, "distribution:manage");
  const rule = await loadRule(ctx, id);
  const [people, names] = await Promise.all([
    loadUsers(ctx.organizationId, ruleAssignment(rule).userIds),
    nameMaps(ctx.organizationId),
  ]);
  return toListItem(rule, people, names);
}

function dedupe(values: readonly string[] | undefined, key: (v: string) => string = (v) => v): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values ?? []) {
    const k = key(v);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

function toColumns(v: RuleValues): { criteria: DistributionCriteria; assignment: DistributionAssignment } {
  const criteria: DistributionCriteria = {};
  const courts = dedupe(v.courts?.map((c) => c.toUpperCase()), normalizeCourt);
  if (courts.length) criteria.courts = courts;
  const areas = dedupe(v.areas);
  if (areas.length) criteria.areas = areas as DistributionCriteria["areas"];
  const companyIds = dedupe(v.companyIds);
  if (companyIds.length) criteria.companyIds = companyIds;
  const unitIds = dedupe(v.unitIds);
  if (unitIds.length) criteria.unitIds = unitIds;
  const states = dedupe(v.states);
  if (states.length) criteria.states = states;
  const cities = dedupe(v.cities, (c) => c.toLowerCase());
  if (cities.length) criteria.cities = cities;
  const instances = dedupe(v.instances);
  if (instances.length) criteria.instances = instances as DistributionCriteria["instances"];
  const classes = dedupe(v.processClasses, (c) => c.toUpperCase());
  if (classes.length) criteria.processClasses = classes;
  if (v.minClaimCents !== null && v.minClaimCents !== undefined) criteria.minClaimCents = v.minClaimCents;
  if (v.maxClaimCents !== null && v.maxClaimCents !== undefined) criteria.maxClaimCents = v.maxClaimCents;
  return {
    criteria,
    assignment: {
      method: v.method,
      userIds: v.userIds,
      lawFirmId: v.lawFirmId ?? null,
      unitId: v.assignUnitId ?? null,
    },
  };
}

/** Tenant checks for every id of the rule. */
async function validateRuleReferences(ctx: AuthContext, v: RuleValues): Promise<void> {
  const db = getDb();
  const people = await loadUsers(ctx.organizationId, v.userIds, db);
  const invalid = v.userIds.filter((id) => !canReceive(people.get(id)));
  if (invalid.length > 0) {
    throw fieldError(
      "userIds",
      "Selecione apenas advogados, gestores jurídicos ou escritórios externos ativos da organização.",
    );
  }
  if (v.lawFirmId) {
    await assertLawFirmInOrg(ctx, v.lawFirmId, db);
    const other = v.userIds
      .map((id) => people.get(id)!)
      .find((u) => u.role === "external_counsel" && u.lawFirmId !== v.lawFirmId);
    if (other) throw fieldError("userIds", `${other.name} pertence a outro escritório externo.`);
  }
  if (v.assignUnitId) {
    const [unit] = await db
      .select({ id: units.id })
      .from(units)
      .where(and(eq(units.id, v.assignUnitId), eq(units.organizationId, ctx.organizationId), eq(units.isActive, true)))
      .limit(1);
    if (!unit) throw fieldError("assignUnitId", "Selecione uma unidade ativa da organização.");
  }
  const companyIds = dedupe(v.companyIds);
  if (companyIds.length > 0) {
    const rows = await db
      .select({ id: companies.id })
      .from(companies)
      .where(and(eq(companies.organizationId, ctx.organizationId), inArray(companies.id, companyIds)));
    if (rows.length !== companyIds.length) throw fieldError("companyIds", "Selecione empresas da organização.");
  }
  const unitIds = dedupe(v.unitIds);
  if (unitIds.length > 0) {
    const rows = await db
      .select({ id: units.id })
      .from(units)
      .where(and(eq(units.organizationId, ctx.organizationId), inArray(units.id, unitIds)));
    if (rows.length !== unitIds.length) throw fieldError("unitIds", "Selecione unidades da organização.");
  }
}

const RULE_AUDIT_FIELDS = ["name", "description", "priority", "isActive", "criteria", "assignment"] as const;

export async function createRule(ctx: AuthContext, input: RuleInput): Promise<{ id: string }> {
  assertCan(ctx, "distribution:manage");
  const v = parse(ruleInputSchema, input);
  await validateRuleReferences(ctx, v);
  const { criteria, assignment } = toColumns(v);
  return getDb().transaction(async (tx) => {
    const [row] = await tx
      .insert(distributionRules)
      .values({
        organizationId: ctx.organizationId,
        name: v.name,
        description: v.description ?? null,
        priority: v.priority,
        isActive: v.isActive ?? true,
        criteria,
        assignment,
        createdById: ctx.userId,
      })
      .returning();
    await recordAudit(
      ctx,
      {
        action: "distribution_rule.create",
        entityType: "distribution_rule",
        entityId: row.id,
        summary: `Regra de distribuição “${row.name}” criada (prioridade ${row.priority}, ${DISTRIBUTION_METHOD_LABELS[assignment.method].toLowerCase()}).`,
        changes: diffChanges(null, row, RULE_AUDIT_FIELDS),
      },
      tx,
    );
    return { id: row.id };
  });
}

export async function updateRule(ctx: AuthContext, id: string, input: RuleInput): Promise<void> {
  assertCan(ctx, "distribution:manage");
  const v = parse(ruleInputSchema, input);
  const before = await loadRule(ctx, id);
  await validateRuleReferences(ctx, v);
  const { criteria, assignment } = toColumns(v);
  const previous = ruleAssignment(before);
  const rotationChanged =
    previous.method !== assignment.method || JSON.stringify(previous.userIds) !== JSON.stringify(assignment.userIds);
  const patch = {
    name: v.name,
    description: v.description ?? null,
    priority: v.priority,
    isActive: v.isActive ?? true,
    criteria,
    assignment,
    ...(rotationChanged ? { rrCursor: 0 } : {}),
  };
  const changes = diffChanges(before, { ...before, ...patch }, RULE_AUDIT_FIELDS);
  if (!changes) return;
  await getDb().transaction(async (tx) => {
    await tx
      .update(distributionRules)
      .set(patch)
      .where(and(eq(distributionRules.id, before.id), eq(distributionRules.organizationId, ctx.organizationId)));
    await recordAudit(
      ctx,
      {
        action: "distribution_rule.update",
        entityType: "distribution_rule",
        entityId: before.id,
        summary: `Regra de distribuição “${patch.name}” alterada.`,
        changes,
      },
      tx,
    );
  });
}

export async function setRuleActive(ctx: AuthContext, id: string, active: boolean): Promise<void> {
  assertCan(ctx, "distribution:manage");
  const before = await loadRule(ctx, id);
  if (before.isActive === active) return;
  await getDb().transaction(async (tx) => {
    await tx
      .update(distributionRules)
      .set({ isActive: active })
      .where(and(eq(distributionRules.id, before.id), eq(distributionRules.organizationId, ctx.organizationId)));
    await recordAudit(
      ctx,
      {
        action: "distribution_rule.update",
        entityType: "distribution_rule",
        entityId: before.id,
        summary: `Regra de distribuição “${before.name}” ${active ? "ativada" : "desativada"}.`,
        changes: { isActive: { from: before.isActive, to: active } },
      },
      tx,
    );
  });
}

/** Deletes the rule; intakes that used it keep the textual reason (the link is cleared). */
export async function deleteRule(ctx: AuthContext, id: string): Promise<void> {
  assertCan(ctx, "distribution:manage");
  const before = await loadRule(ctx, id);
  await getDb().transaction(async (tx) => {
    await tx
      .update(caseIntakes)
      .set({ distributionRuleId: null })
      .where(and(eq(caseIntakes.organizationId, ctx.organizationId), eq(caseIntakes.distributionRuleId, before.id)));
    await tx
      .delete(distributionRules)
      .where(and(eq(distributionRules.id, before.id), eq(distributionRules.organizationId, ctx.organizationId)));
    await recordAudit(
      ctx,
      {
        action: "distribution_rule.delete",
        entityType: "distribution_rule",
        entityId: before.id,
        summary: `Regra de distribuição “${before.name}” excluída.`,
      },
      tx,
    );
  });
}

/** Sets priorities 10, 20, 30… following `orderedIds` (must list every rule of the organization). */
export async function reorderRules(ctx: AuthContext, orderedIds: string[]): Promise<void> {
  assertCan(ctx, "distribution:manage");
  const ids = z.array(z.guid()).safeParse(orderedIds);
  if (!ids.success) throw new ValidationError("Ordem de regras inválida.");
  await getDb().transaction(async (tx) => {
    const rules = await loadRules(ctx.organizationId, tx, { lock: true });
    const known = new Set(rules.map((r) => r.id));
    if (ids.data.length !== rules.length || new Set(ids.data).size !== ids.data.length || ids.data.some((id) => !known.has(id))) {
      throw new ValidationError("A nova ordem deve conter todas as regras da organização, uma única vez.");
    }
    const byId = new Map(rules.map((r) => [r.id, r]));
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const [index, id] of ids.data.entries()) {
      const priority = (index + 1) * 10;
      const rule = byId.get(id)!;
      if (rule.priority === priority) continue;
      changes[rule.name] = { from: rule.priority, to: priority };
      await tx
        .update(distributionRules)
        .set({ priority })
        .where(and(eq(distributionRules.id, id), eq(distributionRules.organizationId, ctx.organizationId)));
    }
    if (Object.keys(changes).length === 0) return;
    await recordAudit(
      ctx,
      {
        action: "distribution_rule.reorder",
        entityType: "distribution_rule",
        entityId: null,
        summary: "Ordem de avaliação das regras de distribuição alterada.",
        changes,
      },
      tx,
    );
  });
}

/** Moves a rule one position up (evaluated earlier) or down. */
export async function moveRule(ctx: AuthContext, id: string, direction: "up" | "down"): Promise<void> {
  assertCan(ctx, "distribution:manage");
  const rule = await loadRule(ctx, id);
  const rules = await loadRules(ctx.organizationId, getDb());
  const order = rules.map((r) => r.id);
  const index = order.indexOf(rule.id);
  const target = direction === "up" ? index - 1 : index + 1;
  if (target < 0 || target >= order.length) return;
  [order[index], order[target]] = [order[target], order[index]];
  await reorderRules(ctx, order);
}

// ---------------------------------------------------------------------------
// Workload (TE-08)
// ---------------------------------------------------------------------------

export type WorkloadPending = {
  /** Open deadlines that count as real (manual or validated). */
  openDeadlines: number;
  /** Preliminary analyses ready for / in review. */
  briefsAwaitingReview: number;
  /** Processes flagged for verification. */
  needsVerification: number;
  /** Valuations proposed and not yet reviewed (RN-11). */
  valuationsPendingReview: number;
  /** Intakes not finished. */
  openIntakes: number;
};

export type WorkloadRow = {
  /** User id, law firm id, or "none". */
  key: string;
  name: string;
  detail: string | null;
  isActive: boolean;
  activeProcesses: number;
  money: MoneyBucket;
  pending: WorkloadPending;
  /** Portfolio filtered by this person / firm. */
  href: string | null;
};

export type Workload = {
  byLawyer: WorkloadRow[];
  byLawFirm: WorkloadRow[];
  totals: { activeProcesses: number; money: MoneyBucket; pending: WorkloadPending };
};

function emptyPending(): WorkloadPending {
  return { openDeadlines: 0, briefsAwaitingReview: 0, needsVerification: 0, valuationsPendingReview: 0, openIntakes: 0 };
}

function sortRows(rows: WorkloadRow[]): WorkloadRow[] {
  return rows.sort((a, b) => {
    if (a.key === "none") return 1;
    if (b.key === "none") return -1;
    return b.activeProcesses - a.activeProcesses || a.name.localeCompare(b.name, "pt-BR");
  });
}

/**
 * Active portfolio (status active/suspended) visible to ctx, grouped by
 * responsible and by external law firm. Money follows RN-02/RN-03 (claim and
 * liquidated are never added; unknown values are counted, not zeroed) and the
 * exposure comes from `@/domain/contingency` over the process mirrors, with
 * the effective risk of each record (`recordRiskBp`: the bp mirror, else the
 * organization percentage of its loss probability).
 *
 * The pending counters are aggregated once per process in SQL (grouped
 * subqueries, LEFT JOINed). Rows are still grouped by responsible / law firm
 * in memory because exposure and provision are per-process domain rules
 * (RN-04) that must not be re-implemented in SQL.
 */
export async function getWorkload(ctx: AuthContext): Promise<Workload> {
  assertCan(ctx, "distribution:manage");
  const db = getDb();
  const orgId = ctx.organizationId;
  const p = legalProcesses;
  const g = processGuarantees;
  const d = deadlines;
  const v = processValuations;
  const b = caseBriefs;
  const i = caseIntakes;

  const guaranteeAgg = db
    .select({ processId: g.processId, total: sql<number>`sum(${g.amountCents})`.as("guarantees_total") })
    .from(g)
    .where(and(eq(g.organizationId, orgId), eq(g.status, "linked"), isNull(g.deletedAt)))
    .groupBy(g.processId)
    .as("workload_guarantees");
  // Only deadlines that count as real (manual or validated) — never AI suggestions pending validation.
  const deadlineAgg = db
    .select({ processId: d.processId, n: sql<number>`count(*)`.as("open_deadlines") })
    .from(d)
    .where(
      and(
        eq(d.organizationId, orgId),
        eq(d.status, "open"),
        inArray(d.validationStatus, ["not_required", "validated"]),
        isNull(d.deletedAt),
      ),
    )
    .groupBy(d.processId)
    .as("workload_deadlines");
  const valuationAgg = db
    .select({ processId: v.processId, n: sql<number>`count(*)`.as("pending_valuations") })
    .from(v)
    .where(and(eq(v.organizationId, orgId), eq(v.status, "proposed")))
    .groupBy(v.processId)
    .as("workload_valuations");
  // Same rule as the review queue: a version superseded by a newer generated one (with
  // content) of the same process is no longer reviewed, so it is not pending work.
  const newerBrief = alias(caseBriefs, "workload_newer_brief");
  const briefAgg = db
    .select({ processId: b.processId, n: sql<number>`count(*)`.as("briefs_awaiting") })
    .from(b)
    .where(
      and(
        eq(b.organizationId, orgId),
        inArray(b.status, ["ready_for_review", "in_review"]),
        notExists(
          db
            .select({ one: sql`1` })
            .from(newerBrief)
            .where(
              and(
                eq(newerBrief.organizationId, b.organizationId),
                eq(newerBrief.processId, b.processId),
                gt(newerBrief.version, b.version),
                isNotNull(newerBrief.content),
              ),
            ),
        ),
      ),
    )
    .groupBy(b.processId)
    .as("workload_briefs");
  // Open intakes (same rule as computeLoads); the process join below applies the row visibility.
  const intakeAgg = db
    .select({ processId: i.processId, n: sql<number>`count(*)`.as("open_intakes") })
    .from(i)
    .leftJoin(b, eq(b.id, i.briefId))
    .where(
      and(
        eq(i.organizationId, orgId),
        notInArray(i.status, [...CLOSED_INTAKE_STATUSES]),
        or(isNull(b.status), notInArray(b.status, ["approved", "rejected"])),
      ),
    )
    .groupBy(i.processId)
    .as("workload_intakes");

  const [rows, org] = await Promise.all([
    db
      .select({
        id: p.id,
        responsibleId: p.responsibleId,
        lawFirmId: p.lawFirmId,
        claimCents: p.claimAmountCents,
        liquidatedCents: p.liquidatedAmountCents,
        riskBp: p.riskPercentageBp,
        lossProbability: p.lossProbability,
        needsVerification: p.needsVerification,
        guaranteesCents: sql<number>`coalesce(${guaranteeAgg.total}, 0)`.mapWith(Number),
        openDeadlines: sql<number>`coalesce(${deadlineAgg.n}, 0)`.mapWith(Number),
        pendingValuations: sql<number>`coalesce(${valuationAgg.n}, 0)`.mapWith(Number),
        briefsAwaitingReview: sql<number>`coalesce(${briefAgg.n}, 0)`.mapWith(Number),
        openIntakes: sql<number>`coalesce(${intakeAgg.n}, 0)`.mapWith(Number),
      })
      .from(p)
      .leftJoin(guaranteeAgg, eq(guaranteeAgg.processId, p.id))
      .leftJoin(deadlineAgg, eq(deadlineAgg.processId, p.id))
      .leftJoin(valuationAgg, eq(valuationAgg.processId, p.id))
      .leftJoin(briefAgg, eq(briefAgg.processId, p.id))
      .leftJoin(intakeAgg, eq(intakeAgg.processId, p.id))
      .where(and(processWhere(ctx), inArray(p.status, [...ACTIVE_STATUSES]))),
    loadOrganization(orgId),
  ]);
  const riskParams = org.settings.contingency.riskPercentages;

  const responsibleIds = rows.map((r) => r.responsibleId).filter((x): x is string => Boolean(x));
  const [assignable, others, names] = await Promise.all([
    db
      .select({ id: users.id, name: users.name, role: users.role, unitId: users.unitId, isActive: users.isActive })
      .from(users)
      .where(
        and(
          eq(users.organizationId, ctx.organizationId),
          eq(users.isActive, true),
          inArray(users.role, ["lawyer", "legal_manager", "external_counsel"]),
        ),
      ),
    loadUsers(ctx.organizationId, responsibleIds, db),
    nameMaps(ctx.organizationId, db),
  ]);
  const activeFirms = await db
    .select({ id: lawFirms.id, name: lawFirms.name })
    .from(lawFirms)
    .where(and(eq(lawFirms.organizationId, ctx.organizationId), eq(lawFirms.isActive, true)));

  const lawyerRows = new Map<string, WorkloadRow>();
  const firmRows = new Map<string, WorkloadRow>();
  const blank = (key: string, name: string, detail: string | null, isActive: boolean, href: string | null): WorkloadRow => ({
    key,
    name,
    detail,
    isActive,
    activeProcesses: 0,
    money: emptyBucket(),
    pending: emptyPending(),
    href,
  });
  const userDetail = (role: Role, unitId: string | null) =>
    [ROLE_LABELS[role], unitId ? names.units[unitId] : null].filter(Boolean).join(" · ");

  for (const u of assignable) {
    lawyerRows.set(u.id, blank(u.id, u.name, userDetail(u.role, u.unitId), true, `/processos?responsavel=${u.id}`));
  }
  for (const f of activeFirms) {
    firmRows.set(f.id, blank(f.id, f.name, "Escritório externo", true, `/processos?escritorio=${f.id}`));
  }

  const totals = { activeProcesses: 0, money: emptyBucket(), pending: emptyPending() };
  const add = (row: WorkloadRow | { activeProcesses: number; money: MoneyBucket; pending: WorkloadPending }, r: (typeof rows)[number]) => {
    row.activeProcesses += 1;
    addToBucket(row.money, {
      liquidatedCents: r.liquidatedCents,
      linkedGuaranteesCents: r.guaranteesCents,
      claimCents: r.claimCents,
      riskPercentageBp: recordRiskBp({ riskPercentageBp: r.riskBp, lossProbability: r.lossProbability }, riskParams),
    });
    row.pending.openDeadlines += r.openDeadlines;
    row.pending.briefsAwaitingReview += r.briefsAwaitingReview;
    row.pending.needsVerification += r.needsVerification ? 1 : 0;
    row.pending.valuationsPendingReview += r.pendingValuations;
    row.pending.openIntakes += r.openIntakes;
  };

  for (const r of rows) {
    add(totals, r);
    const userKey = r.responsibleId ?? "none";
    let lawyer = lawyerRows.get(userKey);
    if (!lawyer) {
      const u = r.responsibleId ? others.get(r.responsibleId) : undefined;
      lawyer = u
        ? blank(u.id, u.name, userDetail(u.role, u.unitId), u.isActive, `/processos?responsavel=${u.id}`)
        : blank("none", "Sem responsável definido", "Aguardando distribuição", true, null);
      lawyerRows.set(userKey, lawyer);
    }
    add(lawyer, r);

    const firmKey = r.lawFirmId ?? "none";
    let firm = firmRows.get(firmKey);
    if (!firm) {
      firm = r.lawFirmId
        ? blank(r.lawFirmId, names.lawFirms[r.lawFirmId] ?? "Escritório", "Escritório externo (inativo)", false, `/processos?escritorio=${r.lawFirmId}`)
        : blank("none", "Carteira interna", "Sem escritório externo vinculado", true, null);
      firmRows.set(firmKey, firm);
    }
    add(firm, r);
  }

  return {
    byLawyer: sortRows([...lawyerRows.values()]),
    byLawFirm: sortRows([...firmRows.values()]),
    totals,
  };
}
