/**
 * Demo steps of the v2 seed (scripts/seed-v2.ts) added after P1: fictitious
 * claims (pedidos) with per-claim assessments, so the risk derived from the
 * claims shows up; claim suggestions from the preliminary analyses; scenario
 * proposals; one run of the index series collection (Banco Central); and the
 * demo API key.
 *
 * Every function is IDEMPOTENT and checks its own marker, so the v2 seed can
 * run on a database that already has the earlier v2 demo and only ADD what is
 * missing (never duplicate, never change existing rows). Business records go
 * through the module services with the AuthContext of the person who would do
 * it (claims and assessments: the responsible lawyer; API key: the admin);
 * scenario proposals use the system context (origin "system", for a person to
 * review). Nothing here invents rates, case law or court data: the amounts
 * split the valor da causa of fictitious processes and every text says it is
 * fictitious.
 */
import { and, asc, eq, gt, inArray, isNull, like, or } from "drizzle-orm";
import { LOSS_PROBABILITIES, type LossProbability, type ProcessInstance, type ProcessPhase, type ProcessStatus } from "@/domain/enums";
import { addDaysISO } from "@/lib/format";
import { createApiKey } from "@/modules/api-keys/service";
import { APPLICABLE_STATUSES } from "@/modules/briefs/service";
import { assessClaim, createClaim, suggestClaimsFromBrief } from "@/modules/claims/service";
import { addProcessScenario } from "@/modules/legal-reports/scenarios";
import { systemContext, type AuthContext } from "@/server/auth/context";
import { getDb } from "@/server/db/client";
import {
  apiKeys,
  caseBriefs,
  legalProcesses,
  processClaimAssessments,
  processClaims,
  processScenarios,
  scheduledRoutines,
} from "@/server/db/schema";
import { ensureDefaultRoutines, runRoutine } from "@/server/jobs/routines";
import { AppError } from "@/server/lib/errors";
import {
  CLAIM_FICTITIOUS_SUFFIX,
  CLAIM_OPINIONS,
  CLAIM_TEMPLATES,
  CLAIMS_TARGET_PROCESSES,
  DEMO_API_KEY,
  SCENARIO_COMMENT,
  SCENARIO_PROPOSALS,
  SCENARIO_TARGET_PROCESSES,
  claimDescription,
  type ClaimTemplateItem,
} from "./aurora-v2";

type Warn = (message: string) => void;

/** Process of the demo portfolio that may receive claims (stable attributes only). */
export type ClaimCandidate = {
  id: string;
  number: string;
  status: ProcessStatus;
  phase: ProcessPhase;
  instance: ProcessInstance | null;
  /** Valor da causa in cents (null = não informado). */
  claim: number | null;
  responsibleId: string | null;
};

type ClaimTemplate = (typeof CLAIM_TEMPLATES)[number];

/**
 * A claim written by the seed. `removed` = a person removed it afterwards
 * (soft delete): the seed never deletes, so a removed seed claim is a
 * person's decision, never the trace of an interrupted run.
 */
type SeedClaimRow = { id: string; processId: string; description: string; status: string; assessed: boolean; removed: boolean };

// ---------------------------------------------------------------------------
// Claims: selection (pure)
// ---------------------------------------------------------------------------

/** `n` items spread evenly over the list (deterministic). */
function evenly<T>(list: readonly T[], n: number): T[] {
  if (n <= 0 || list.length === 0) return [];
  if (n >= list.length) return [...list];
  const stride = list.length / n;
  return Array.from({ length: n }, (_, i) => list[Math.floor(i * stride + stride / 2)]);
}

/**
 * Processes that get claims. `seeded` = processes that already got claims
 * from the seed (an earlier or interrupted run), including the ones whose
 * claims a person removed or edited afterwards: they count toward the target,
 * so a person's change never makes the seed pick a new process. `withClaims`
 * = processes with any claim, removed ones included (never picked, they may be
 * a person's work). New picks: active, knowledge phase, with a valor da causa;
 * about 4 in 5 at the 1st grau and the rest at the 2nd/3rd grau.
 */
export function pickClaimTargets(
  candidates: readonly ClaimCandidate[],
  opts: { seeded: ReadonlySet<string>; withClaims: ReadonlySet<string>; target: number },
): { resume: ClaimCandidate[]; fresh: ClaimCandidate[] } {
  const resume = candidates.filter((c) => opts.seeded.has(c.id));
  const need = Math.max(0, opts.target - opts.seeded.size);
  if (need === 0) return { resume, fresh: [] };
  const eligible = candidates.filter(
    (c) => !opts.withClaims.has(c.id) && c.status === "active" && c.phase === "knowledge" && c.claim !== null && c.claim > 0,
  );
  const first = eligible.filter((c) => (c.instance ?? "first") === "first");
  const appeal = eligible.filter((c) => c.instance === "second" || c.instance === "superior");
  const appealCount = Math.min(appeal.length, Math.round(need / 5));
  const fresh = [...evenly(first, need - appealCount), ...evenly(appeal, appealCount)];
  if (fresh.length < need) {
    const chosen = new Set(fresh.map((c) => c.id));
    for (const c of eligible) {
      if (fresh.length >= need) break;
      if (!chosen.has(c.id)) {
        fresh.push(c);
        chosen.add(c.id);
      }
    }
  }
  return { resume, fresh };
}

/**
 * Template whose claims the process already has (resume of an interrupted run).
 * Claims are created in template order and the FIRST item of each template is
 * unique, so it identifies the template; every claim the process has must also
 * belong to it (otherwise a person changed them: left as they are).
 */
export function templateOf(rows: readonly Pick<SeedClaimRow, "description">[]): ClaimTemplate | null {
  if (rows.length === 0) return null;
  const descriptions = new Set(rows.map((r) => r.description));
  const t = CLAIM_TEMPLATES.find((x) => descriptions.has(claimDescription(x.items[0])));
  if (!t) return null;
  const own = new Set(t.items.map(claimDescription));
  return [...descriptions].every((d) => own.has(d)) ? t : null;
}

/** Claim value: share of the valor da causa in whole reais; null share = not quantified (never zero). */
export function claimAmountCents(claimCents: number | null, share: number | null): number | null {
  if (share === null || claimCents === null) return null;
  return Math.round((claimCents * share) / 100) * 100;
}

/**
 * Effective dates of the assessments of one process: spaced by two days and
 * ending two days ago, never before the first day of the current month (so no
 * classification is backdated into a closed competência) nor after today.
 */
export function assessmentDates(count: number, today: string): string[] {
  const monthStart = `${today.slice(0, 7)}-01`;
  return Array.from({ length: count }, (_, j) => {
    const d = addDaysISO(today, -2 * (count - j));
    return d < monthStart ? monthStart : d;
  });
}

// ---------------------------------------------------------------------------
// Claims: database
// ---------------------------------------------------------------------------

/** Claims written by the seed, the ones a person removed included (`deletedAt` is not filtered on purpose). */
const seedClaimCondition = (organizationId: string) =>
  and(
    eq(processClaims.organizationId, organizationId),
    eq(processClaims.origin, "manual"),
    like(processClaims.description, `%${CLAIM_FICTITIOUS_SUFFIX}`),
  );

/** Every fictitious opinion the seed writes on its claim assessments. */
const SEED_CLAIM_OPINIONS = [...new Set(Object.values(CLAIM_OPINIONS).flat())];

/** Seed claims by process, removed ones included (flagged `removed`). */
async function loadSeedClaims(organizationId: string): Promise<Map<string, SeedClaimRow[]>> {
  const db = getDb();
  const rows = await db
    .select({
      id: processClaims.id,
      processId: processClaims.processId,
      description: processClaims.description,
      status: processClaims.status,
      deletedAt: processClaims.deletedAt,
    })
    .from(processClaims)
    .where(seedClaimCondition(organizationId))
    .orderBy(asc(processClaims.createdAt), asc(processClaims.id));
  const assessed = rows.length
    ? new Set(
        (
          await db
            .selectDistinct({ claimId: processClaimAssessments.claimId })
            .from(processClaimAssessments)
            .where(
              and(
                eq(processClaimAssessments.organizationId, organizationId),
                inArray(
                  processClaimAssessments.claimId,
                  rows.map((r) => r.id),
                ),
              ),
            )
        ).map((r) => r.claimId),
      )
    : new Set<string>();
  const byProcess = new Map<string, SeedClaimRow[]>();
  for (const { deletedAt, ...r } of rows) {
    const list = byProcess.get(r.processId) ?? [];
    list.push({ ...r, assessed: assessed.has(r.id), removed: deletedAt !== null });
    byProcess.set(r.processId, list);
  }
  return byProcess;
}

/**
 * Processes that already got claims from the seed: the ones with seed claims
 * (removed ones included) plus the ones with an assessment carrying one of the
 * seed's fictitious opinions (assessments are append-only, so this survives a
 * person editing every seed claim of the process).
 */
async function seededProcessIds(organizationId: string, seedClaims: ReadonlyMap<string, SeedClaimRow[]>): Promise<Set<string>> {
  const rows = await getDb()
    .selectDistinct({ processId: processClaimAssessments.processId })
    .from(processClaimAssessments)
    .where(and(eq(processClaimAssessments.organizationId, organizationId), inArray(processClaimAssessments.opinion, SEED_CLAIM_OPINIONS)));
  return new Set([...seedClaims.keys(), ...rows.map((r) => r.processId)]);
}

/** Every claim of the organization, removed ones included: id and process. */
async function allClaims(organizationId: string): Promise<{ id: string; processId: string }[]> {
  return getDb()
    .select({ id: processClaims.id, processId: processClaims.processId })
    .from(processClaims)
    .where(eq(processClaims.organizationId, organizationId));
}

type ClaimWork = { process: ClaimCandidate; template: ClaimTemplate; existing: SeedClaimRow[] };

/**
 * Whether a process that already got seed claims is the trace of an
 * interrupted run that the seed may complete: every claim of the process
 * (any origin, removed ones included) is a LIVE seed claim of one template.
 * Anything else (a removed seed claim, an edited description, a claim added
 * by a person or suggested by an analysis) is a person's work: left as it is.
 */
export function resumableTemplate(existing: readonly SeedClaimRow[], claimsOfProcess: number): ClaimTemplate | null {
  if (existing.length === 0 || existing.some((e) => e.removed) || claimsOfProcess !== existing.length) return null;
  return templateOf(existing);
}

/** What the claims step still has to do (empty = done). */
export async function planDemoClaims(
  organizationId: string,
  candidates: readonly ClaimCandidate[],
  target = CLAIMS_TARGET_PROCESSES,
): Promise<ClaimWork[]> {
  const seededClaims = await loadSeedClaims(organizationId);
  const seeded = await seededProcessIds(organizationId, seededClaims);
  const claims = await allClaims(organizationId);
  const withClaims = new Set(claims.map((c) => c.processId));
  const claimsPerProcess = new Map<string, number>();
  for (const c of claims) claimsPerProcess.set(c.processId, (claimsPerProcess.get(c.processId) ?? 0) + 1);
  const { resume, fresh } = pickClaimTargets(candidates, { seeded, withClaims, target });
  const work: ClaimWork[] = [];
  for (const p of resume) {
    const existing = seededClaims.get(p.id) ?? [];
    const template = resumableTemplate(existing, claimsPerProcess.get(p.id) ?? 0);
    if (!template) continue; // changed by a person: left as it is
    const complete =
      template.items.every((i) => existing.some((e) => e.description === claimDescription(i))) &&
      existing.every((e) => e.status !== "confirmed" || e.assessed);
    if (!complete) work.push({ process: p, template, existing });
  }
  let rotation = seeded.size;
  for (const p of fresh) {
    work.push({ process: p, template: CLAIM_TEMPLATES[rotation % CLAIM_TEMPLATES.length], existing: [] });
    rotation += 1;
  }
  return work;
}

export type ClaimsSeedResult = {
  processes: number;
  claimsCreated: number;
  assessments: number;
  /** Process classifications recorded by the derivation (one per change). */
  derivedRecorded: number;
  /** Processes whose derived rate uses the organization percentage (claim without value): flagged for review. */
  flaggedForReview: number;
  failed: number;
};

/**
 * Creates the fictitious claims of up to `CLAIMS_TARGET_PROCESSES` processes and
 * assesses them as the responsible lawyer; each assessment derives the process
 * risk again in the same transaction (claims service). Resumes an interrupted
 * run: missing claims of a started process are created and unassessed ones
 * assessed.
 */
export async function seedDemoClaims(input: {
  organizationId: string;
  candidates: readonly ClaimCandidate[];
  actorFor: (p: ClaimCandidate) => AuthContext;
  /** Data-base of the claim values (the valor da causa's base date). */
  baseDate: string;
  today: string;
  target?: number;
  warn?: Warn;
}): Promise<ClaimsSeedResult> {
  const result: ClaimsSeedResult = { processes: 0, claimsCreated: 0, assessments: 0, derivedRecorded: 0, flaggedForReview: 0, failed: 0 };
  const work = await planDemoClaims(input.organizationId, input.candidates, input.target);
  for (const w of work) {
    try {
      const r = await seedProcessClaims(input.actorFor(w.process), w, input.baseDate, input.today);
      result.processes += 1;
      result.claimsCreated += r.created;
      result.assessments += r.assessed;
      result.derivedRecorded += r.derived;
      if (r.needsReview) result.flaggedForReview += 1;
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      result.failed += 1;
      input.warn?.(`pedidos do processo ${w.process.number}: ${err.message}`);
    }
  }
  return result;
}

async function seedProcessClaims(
  actor: AuthContext,
  w: ClaimWork,
  baseDate: string,
  today: string,
): Promise<{ created: number; assessed: number; derived: number; needsReview: boolean }> {
  const { process: p, template } = w;
  const dates = assessmentDates(template.items.length, today);
  const out = { created: 0, assessed: 0, derived: 0, needsReview: false };
  for (const [j, item] of template.items.entries()) {
    const description = claimDescription(item);
    let row = w.existing.find((e) => e.description === description);
    if (!row) {
      const amount = claimAmountCents(p.claim, item.share);
      const { id } = await createClaim(actor, p.id, {
        description,
        category: item.category,
        claimedAmountCents: amount,
        amountBaseDate: amount === null ? null : baseDate,
        correctionIndex: null,
        instance: p.instance,
      });
      row = { id, processId: p.id, description, status: "confirmed", assessed: false, removed: false };
      out.created += 1;
    }
    if (row.removed || row.status !== "confirmed" || row.assessed) continue;
    const r = await assessClaim(actor, row.id, {
      classification: item.classification,
      percentage: null,
      opinion: opinionFor(item, j),
      effectiveFrom: dates[j],
    });
    out.assessed += 1;
    if (r.derivation.status === "recorded") out.derived += 1;
    // "unchanged" keeps the previous state; every other outcome tells it.
    if ("needsReview" in r.derivation) out.needsReview = r.derivation.needsReview;
  }
  return out;
}

function opinionFor(item: ClaimTemplateItem, index: number): string {
  const list = CLAIM_OPINIONS[item.classification];
  return list[index % list.length];
}

// ---------------------------------------------------------------------------
// Claim suggestions from the preliminary analyses
// ---------------------------------------------------------------------------

/**
 * Brings the claims of the LATEST applicable preliminary analysis of every
 * process as suggestions pending confirmation (claims service, idempotent: a
 * claim already imported is never repeated). The briefs pipeline does the same
 * for briefs generated after P1.6; this covers the ones generated before it.
 */
export async function suggestClaimsFromLatestBriefs(
  organizationId: string,
  ctx: AuthContext,
  warn?: Warn,
): Promise<{ briefs: number; created: number }> {
  const rows = await getDb()
    .select({ id: caseBriefs.id, processId: caseBriefs.processId, version: caseBriefs.version, status: caseBriefs.status })
    .from(caseBriefs)
    .innerJoin(legalProcesses, and(eq(legalProcesses.id, caseBriefs.processId), eq(legalProcesses.organizationId, organizationId)))
    .where(and(eq(caseBriefs.organizationId, organizationId), isNull(legalProcesses.deletedAt)))
    .orderBy(asc(caseBriefs.processId), asc(caseBriefs.version));
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) latest.set(r.processId, r); // ordered by version: the last one wins
  let briefs = 0;
  let created = 0;
  for (const b of latest.values()) {
    if (!APPLICABLE_STATUSES.includes(b.status)) continue;
    try {
      const r = await suggestClaimsFromBrief(ctx, b.id);
      briefs += 1;
      created += r.created;
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      warn?.(`sugestões de pedidos da análise preliminar ${b.id}: ${err.message}`);
    }
  }
  return { briefs, created };
}

// ---------------------------------------------------------------------------
// Scenarios (system proposals)
// ---------------------------------------------------------------------------

type ScenarioPick = { id: string; number: string; classification: LossProbability };

/**
 * Processes that still get scenario proposals (empty = done). The seed's own
 * proposals (origin "system" with the seed's comment; scenarios are
 * append-only) count toward the target wherever they are, so a person
 * removing claims never makes the seed propose scenarios again; new picks are
 * processes that still have live seed claims and no scenario at all.
 */
export async function planDemoScenarios(organizationId: string, target = SCENARIO_TARGET_PROCESSES): Promise<ScenarioPick[]> {
  const db = getDb();
  const withSystem = new Set(
    (
      await db
        .selectDistinct({ processId: processScenarios.processId })
        .from(processScenarios)
        .where(
          and(
            eq(processScenarios.organizationId, organizationId),
            eq(processScenarios.origin, "system"),
            eq(processScenarios.comment, SCENARIO_COMMENT),
          ),
        )
    ).map((r) => r.processId),
  );
  const need = Math.max(0, target - withSystem.size);
  if (need === 0) return [];
  const live = [...(await loadSeedClaims(organizationId)).entries()].filter(([, rows]) => rows.some((r) => !r.removed)).map(([id]) => id);
  if (live.length === 0) return [];
  const procs = await db
    .select({ id: legalProcesses.id, number: legalProcesses.number, classification: legalProcesses.lossProbability })
    .from(legalProcesses)
    .where(
      and(
        eq(legalProcesses.organizationId, organizationId),
        inArray(legalProcesses.id, live),
        isNull(legalProcesses.deletedAt),
        eq(legalProcesses.status, "active"),
      ),
    )
    .orderBy(asc(legalProcesses.number));
  const withScenario = new Set(
    (
      await db
        .selectDistinct({ processId: processScenarios.processId })
        .from(processScenarios)
        .where(and(eq(processScenarios.organizationId, organizationId), inArray(processScenarios.processId, live)))
    ).map((r) => r.processId),
  );
  const candidates = procs.filter((p): p is ScenarioPick => p.classification !== null && !withScenario.has(p.id));
  const picks: ScenarioPick[] = [];
  // One of each derived classification first (worst first), then in number order.
  for (const cls of [...LOSS_PROBABILITIES].reverse()) {
    const c = candidates.find((x) => x.classification === cls);
    if (c && picks.length < need) picks.push(c);
  }
  for (const c of candidates) {
    if (picks.length >= need) break;
    if (!picks.includes(c)) picks.push(c);
  }
  return picks;
}

/**
 * Scenario proposals (origin "system") for a few processes with claims, from
 * the classification derived from them, for the responsible lawyer to review.
 * Scenarios are append-only; a process with any scenario is never touched.
 */
export async function seedDemoScenarios(input: {
  organizationId: string;
  isDemo: boolean;
  target?: number;
  warn?: Warn;
}): Promise<{ processes: number; scenarios: number }> {
  const picks = await planDemoScenarios(input.organizationId, input.target);
  const sys = systemContext(input.organizationId, input.isDemo);
  let processes = 0;
  let scenarios = 0;
  for (const p of picks) {
    try {
      for (const proposal of SCENARIO_PROPOSALS[p.classification]) {
        await addProcessScenario(sys, p.id, { description: proposal.description, probabilityBand: proposal.band, comment: SCENARIO_COMMENT });
        scenarios += 1;
      }
      processes += 1;
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      input.warn?.(`cenários do processo ${p.number}: ${err.message}`);
    }
  }
  return { processes, scenarios };
}

// ---------------------------------------------------------------------------
// Index series (Banco Central SGS), once
// ---------------------------------------------------------------------------

/** True while the organization's index_series_refresh routine never ran. */
export async function indexSeriesRefreshPending(organizationId: string): Promise<boolean> {
  const [r] = await getDb()
    .select({ lastRunAt: scheduledRoutines.lastRunAt })
    .from(scheduledRoutines)
    .where(and(eq(scheduledRoutines.organizationId, organizationId), eq(scheduledRoutines.type, "index_series_refresh")));
  return !r || r.lastRunAt === null;
}

export type IndexRefreshOnce =
  | { status: "already_ran"; summary: string | null }
  | { status: "ran"; summary: string | null }
  | { status: "failed"; errorName: string }
  | { status: "disabled" };

/**
 * Runs the organization's `index_series_refresh` routine once (the series are
 * public and shared; the routine itself skips months already stored and series
 * consulted recently). A network failure is recorded by the routine on each
 * series (shown in /admin/integracoes) and never stops the seed; no rate is
 * ever estimated. Afterwards the worker keeps it daily.
 */
export async function refreshIndexSeriesOnce(organizationId: string): Promise<IndexRefreshOnce> {
  const db = getDb();
  await ensureDefaultRoutines(organizationId);
  const [r] = await db
    .select({
      id: scheduledRoutines.id,
      enabled: scheduledRoutines.enabled,
      lastRunAt: scheduledRoutines.lastRunAt,
      lastStatus: scheduledRoutines.lastStatus,
      intervalMinutes: scheduledRoutines.intervalMinutes,
    })
    .from(scheduledRoutines)
    .where(and(eq(scheduledRoutines.organizationId, organizationId), eq(scheduledRoutines.type, "index_series_refresh")));
  if (!r || !r.enabled) return { status: "disabled" };
  if (r.lastRunAt) return { status: "already_ran", summary: r.lastStatus };
  try {
    const res = await runRoutine(r.id);
    return { status: "ran", summary: res?.status ?? null };
  } catch (err) {
    // runRoutine already stored "Falhou" with a sanitized message; never print driver messages.
    return { status: "failed", errorName: err instanceof Error ? err.name : "erro" };
  } finally {
    await db
      .update(scheduledRoutines)
      .set({ nextRunAt: new Date(Date.now() + r.intervalMinutes * 60_000) })
      .where(eq(scheduledRoutines.id, r.id));
  }
}

// ---------------------------------------------------------------------------
// Demo API key
// ---------------------------------------------------------------------------

async function activeDemoKey(organizationId: string): Promise<{ keyPrefix: string } | null> {
  const [row] = await getDb()
    .select({ keyPrefix: apiKeys.keyPrefix })
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.organizationId, organizationId),
        eq(apiKeys.name, DEMO_API_KEY.name),
        isNull(apiKeys.revokedAt),
        or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, new Date())),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function demoApiKeyPending(organizationId: string): Promise<boolean> {
  return (await activeDemoKey(organizationId)) === null;
}

/**
 * The demo API key (API de entrada), created by the administrator through the
 * API keys service: the database stores only its SHA-256 and display prefix.
 * The full key is returned ONCE (the seed prints it); when an active demo key
 * already exists nothing is created and the key cannot be shown again (revoke
 * it in Administração, Integrações and run the seed again for a new one).
 */
export async function ensureDemoApiKey(
  adminCtx: AuthContext,
): Promise<{ created: true; key: string; keyPrefix: string } | { created: false; keyPrefix: string }> {
  const existing = await activeDemoKey(adminCtx.organizationId);
  if (existing) return { created: false, keyPrefix: existing.keyPrefix };
  const r = await createApiKey(adminCtx, { name: DEMO_API_KEY.name, scopes: DEMO_API_KEY.scopes, expiresOn: null });
  return { created: true, key: r.key, keyPrefix: r.keyPrefix };
}
