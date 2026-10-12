/**
 * v2 demo seed (`npm run db:seed:v2`, also part of `npm run db:setup`).
 *
 * INCREMENTAL and IDEMPOTENT, STEP BY STEP: adds the v2 demonstration on top
 * of the demo organization "Grupo Aurora Exemplo S.A. (demonstração)" created
 * by `npm run db:seed`. It never truncates, deletes or rewrites anything and
 * never touches other organizations. Each step checks its own marker (listed
 * below) and only ADDS what is missing, so on a database that already has an
 * earlier v2 demo (import, contingencies, hearings, intakes) a run adds only
 * the newer demo data; when every marker is present it exits without changes.
 * A run that stopped halfway continues where it stopped.
 *
 * Steps (business records through the real module services, with the
 * AuthContext of the demo user who would do it; official values and
 * classifications need an identified person):
 *   a. default routines (insert of the missing routine types);
 *   b. company "EMPRESA MODELO TESTE LTDA", the fictitious law firm, the
 *      fictitious regional units and the v2 demo accounts, which join the
 *      "Contencioso Trabalhista" team when they are created (direct inserts
 *      only for the accounts and their team membership);
 *   c. distribution rules.
 *      Steps b and c happen once (scripts/seed-data/v2/structure.ts): done
 *      once the demo import is committed; before it, each record's marker
 *      survives a rename or removal by a person (the row, units by code, or
 *      the seed's create entry in the audit log). Accounts by e-mail;
 *   d. import of the FICTITIOUS spreadsheet by the legal manager (analyze +
 *      commit, base date 2026-07-29) with distribution after the commit.
 *      Marker: the committed batch;
 *   e. contingencies: official risk classifications (manual + approved rule
 *      suggestions), pending rule suggestions, linked guarantees, value
 *      updates, one extinction by payment, settlements with installments and
 *      the monthly closes of the two previous months (closed by accounting
 *      WITH a justification when processes are still unclassified, P1.9) + a
 *      preview of the current one. Markers: risk/guarantee/settlement rows of
 *      the imported processes and the closed competências. Closing is
 *      definitive, so ONLY THE FIRST v2 seed closes months; a later run never
 *      closes the month that just ended (scripts/seed-data/v2/one-time.ts);
 *   f. hearings (next 1 to 20 days) and one past hearing registered as held.
 *      Marker: any hearing of an imported process;
 *   g. three SIMULATED incoming processes (assignment, fictitious documents,
 *      SIMULATED preliminary analysis, SIMULATED e-mail) and the lawyer's
 *      review (edit + approve, edit only, untouched; one deadline pending
 *      validation, one task, one value sent to review). Marker: the simulated
 *      intakes and the records linked to their analyses;
 *   h. one preventive occurrence + action plan from a preventive-intelligence
 *      suggestion. Marker: any occurrence with the preventive reference, in
 *      any status and even removed (a person may resolve or remove it). A run
 *      that stopped between the occurrence and its plan adds the plan later,
 *      while nobody has touched that occurrence (still open, never edited);
 *   k. claims (pedidos) of 20 imported processes, assessed per claim by the
 *      responsible lawyer, so the risk derived from the claims shows up
 *      (P1.6). Marker: the seed's claims (text ends with "(dados fictícios)"),
 *      the ones a person removed included: a removed or edited seed claim is
 *      a person's decision and is never written again;
 *   l. claim suggestions from the latest preliminary analyses (pending
 *      confirmation; idempotent by the claims service);
 *   m. scenario proposals (origin "system") for 4 of those processes.
 *      Marker: the seed's system scenarios (append-only);
 *   n. one run of the index_series_refresh routine (Banco Central SGS, real
 *      public API; a network failure is recorded and the seed continues; the
 *      default correction index of the organization stays "none"). Marker:
 *      the routine already ran;
 *   i. the organization's routines once (alerts, previews, reminder e-mails),
 *      except the DataJud collection (never called by the seed), the
 *      simulated arrival feed (stays disabled) and the index collection (n);
 *   j. one SIMULATED daily digest e-mail for the legal manager. Marker: the
 *      digest e-mail;
 *   o. the demo API key (API de entrada), printed ONCE, right after it is
 *      created (so a later failure never loses it); only its hash is stored.
 *      Marker: an active key with the demo name (revoke it and run the seed
 *      again for a new one: nothing else is closed or duplicated).
 *
 * `--skip=<step>[,<step>]` (claims, suggestions, scenarios, indices, api-key)
 * leaves those steps out, e.g. to reproduce a database seeded by the earlier
 * v2 seed when checking that a later run only adds the missing data.
 *
 * AI analyses run in demo mode (scripts/seed-data/env-setup.ts); the
 * preliminary analysis and the e-mails are simulations in this version.
 */
import "dotenv/config";
import "./seed-data/env-setup";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { and, asc, count, countDistinct, desc, eq, inArray, isNotNull, isNull, like, max, notInArray, sql } from "drizzle-orm";
import { DEMO_ACCOUNTS, DEMO_PASSWORD } from "@/domain/demo";
import {
  ALERT_TYPE_LABELS,
  CASE_BRIEF_STATUS_LABELS,
  CLAIM_STATUS_LABELS,
  CORRECTION_INDEX_LABELS,
  EMAIL_TEMPLATE_LABELS,
  GUARANTEE_KIND_LABELS,
  HEARING_STATUS_LABELS,
  INTAKE_STATUS_LABELS,
  LOSS_PROBABILITY_LABELS,
  PROBABILITY_BAND_LABELS,
  ROLE_LABELS,
  SETTLEMENT_STATUS_LABELS,
  VALUATION_STATUS_LABELS,
  type GuaranteeKind,
  type LossProbability,
  type ProcessInstance,
  type ProcessPhase,
  type ProcessStatus,
  type Role,
  type RoutineType,
  type SettlementStatus,
} from "@/domain/enums";
import type { CaseBriefDetail } from "@/modules/briefs/service";
import { addDaysISO } from "@/lib/format";
import type { AuthContext } from "@/server/auth/context";
import { closeDatabase, getDb } from "@/server/db/client";
import {
  alerts,
  apiKeys,
  caseBriefs,
  caseIntakes,
  companies,
  deadlines,
  distributionRules,
  emailMessages,
  hearings,
  importBatches,
  indexSeriesValues,
  legalProcesses,
  occurrences,
  organizations,
  portfolioSnapshots,
  processClaimAssessments,
  processClaimRiskLinks,
  processClaims,
  processGuarantees,
  processRiskAssessments,
  processScenarios,
  processValuations,
  scheduledRoutines,
  settlements,
  snapshotCloseOverrides,
  tasks,
  units,
  users,
} from "@/server/db/schema";
import { AppError } from "@/server/lib/errors";
import { ensureDefaultRoutines, runRoutine } from "@/server/jobs/routines";
import { processPendingJobs } from "@/server/jobs/worker";
import {
  applyBriefDeadline,
  applyBriefNextStep,
  approveCaseBrief,
  getCaseBrief,
  proposeBriefAmount,
  saveCaseBriefSection,
} from "@/modules/briefs/service";
import { createGuarantee, setGuaranteeStatus } from "@/modules/contingency/guarantee-service";
import { addRiskAssessment, approveRiskProposal, suggestRiskAssessment } from "@/modules/contingency/risk-service";
import { addMonthsISO, formatPeriod, periodOf } from "@/modules/contingency/rules";
import { addValuation, registerExtinction } from "@/modules/contingency/service";
import {
  createSettlement,
  listProcessSettlements,
  setInstallmentPaid,
  setSettlementStatus,
} from "@/modules/contingency/settlement-service";
import type { SettlementCreateInput } from "@/modules/contingency/schemas";
import { closeSnapshot, generateSnapshot, getSnapshotStatus } from "@/modules/contingency/snapshot-service";
import { sendDailyDigest } from "@/modules/emails/service";
import { createHearing, setHearingStatus } from "@/modules/hearings/service";
import { analyzeImport, commitImport } from "@/modules/imports/service";
import { simulateIncomingProcess } from "@/modules/intake/service";
import { PREVENTIVE_MARKER_PREFIX } from "@/modules/occurrences/preventive-origin";
import { AURORA_ORG, AURORA_USERS, type UserKey } from "./seed-data/aurora";
import { rel, today, userContext, type SeededUser } from "./seed-data/helpers";
import {
  demoApiKeyPending,
  ensureDemoApiKey,
  indexSeriesRefreshPending,
  planDemoClaims,
  planDemoScenarios,
  refreshIndexSeriesOnce,
  seedDemoClaims,
  seedDemoScenarios,
  suggestClaimsFromLatestBriefs,
  type ClaimCandidate,
} from "./seed-data/v2/extras";
import {
  committedDemoBatch,
  ensureRules,
  ensureStructure,
  rulesPlan,
  structurePending,
  structurePlan,
  type DemoPeople,
} from "./seed-data/v2/structure";
import {
  closedCompetencias,
  demoClosePlan,
  preventiveOccurrencePending,
  preventiveOccurrenceRecorded,
  seedPreventiveOccurrence,
} from "./seed-data/v2/one-time";
import {
  AURORA_V2_USERS,
  CLAIM_FICTITIOUS_SUFFIX,
  CLOSE_JUSTIFICATION,
  DEMO_API_KEY,
  DEMO_SPREADSHEET,
  EXTINCTION_NOTE,
  GUARANTEE_DESCRIPTIONS,
  RISK_OPINIONS,
  RISK_RECLASSIFICATION_OPINION,
  RULE_APPROVAL_NOTE,
  SIMULATED_INTAKES,
  V2_COMPANY_NAME,
  V2_HEARINGS,
  V2_LAW_FIRM,
  V2_PAST_HEARING,
  V2_SETTLEMENT_NOTES,
  V2_TEAM,
  VALUATION_UPDATE_REASON,
  hearingLocation,
  hearingUrl,
  type DemoUserKey,
} from "./seed-data/v2/aurora-v2";

function log(message: string) {
  console.log(`[seed-v2] ${message}`);
}

function warn(message: string) {
  console.warn(`[seed-v2] AVISO: ${message}`);
}

/**
 * Server encoding of the database. The embedded development server on Windows
 * creates WIN1252 databases; some v2 texts (e.g. the "→" in the contingency
 * module's settlement status audit) cannot be stored there.
 */
let databaseEncoding = "UTF8";
/** Writes refused by the database encoding (reported in the summary). */
const encodingSkips: string[] = [];

/** 22P05 untranslatable_character / 22021 character_not_in_repertoire (possibly wrapped in `cause`). */
function isEncodingError(err: unknown): boolean {
  let e: unknown = err;
  for (let i = 0; i < 5 && e && typeof e === "object"; i++) {
    const code = (e as { code?: unknown }).code;
    if (code === "22P05" || code === "22021") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/** Runs `fn`; when the database encoding refuses the text it writes, records a warning and continues. */
async function tolerateEncoding<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    if (!isEncodingError(err)) throw err;
    encodingSkips.push(label);
    warn(`${label}: não gravado; o banco usa a codificação ${databaseEncoding} e o texto gravado pelo módulo tem caracteres fora dela.`);
    return null;
  }
}

const ASSIGNABLE: readonly Role[] = ["lawyer", "legal_manager", "external_counsel"];

type People = DemoPeople;

type Env = {
  organizationId: string;
  people: People;
  /** Every user of the organization by id (responsible contexts). */
  byId: Map<string, SeededUser>;
  ctx: (key: DemoUserKey) => AuthContext;
  /** Company of the spreadsheet (null when a person removed it before the import). */
  companyId: string | null;
};

type ImportedProcess = {
  id: string;
  number: string;
  phase: ProcessPhase;
  status: ProcessStatus;
  instance: ProcessInstance | null;
  court: string;
  city: string | null;
  courtDivision: string | null;
  claim: number | null;
  liquidated: number | null;
  responsibleId: string | null;
};

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

function toSeeded(row: typeof users.$inferSelect): SeededUser {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    email: row.email,
    role: row.role,
    unitId: row.unitId,
    lawFirmId: row.lawFirmId,
  };
}

async function loadOrgUsers(organizationId: string): Promise<SeededUser[]> {
  const rows = await getDb().select().from(users).where(eq(users.organizationId, organizationId));
  return rows.map(toSeeded);
}

async function digestSent(organizationId: string, userId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: emailMessages.id })
    .from(emailMessages)
    .where(
      and(
        eq(emailMessages.organizationId, organizationId),
        eq(emailMessages.template, "daily_digest"),
        eq(emailMessages.toUserId, userId),
      ),
    )
    .limit(1);
  return Boolean(row);
}

async function runQueue(organizationId: string, label: string) {
  let total = 0;
  for (let round = 0; round < 10; round++) {
    const { processed } = await processPendingJobs({ limit: 500, organizationId });
    total += processed;
    if (processed === 0) break;
  }
  log(`Fila processada (${label}): ${total} tarefa(s) em segundo plano.`);
}

/** Runs `fn`; on a business error (AppError) logs a warning and returns null instead of stopping the seed. */
async function attempt<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppError) {
      warn(`${label}: ${err.message}`);
      return null;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// b. Company, law firm, units, users; c. Distribution rules
// ---------------------------------------------------------------------------

/** Steps b and c (scripts/seed-data/v2/structure.ts): created once, never brought back after a person's rename or removal. */
async function seedStructureAndRules(organizationId: string, v1: Record<UserKey, SeededUser>): Promise<Env> {
  const { structure, created } = await ensureStructure(organizationId, v1);
  if (created.company) log(`Empresa "${V2_COMPANY_NAME}" cadastrada (dados fictícios, sem CNPJ).`);
  if (created.lawFirm) log(`Escritório externo "${V2_LAW_FIRM.name}" cadastrado.`);
  if (created.units.length) log(`Unidade(s) fictícia(s) cadastrada(s): ${created.units.join(", ")}.`);
  if (created.accounts) log(`${created.accounts} conta(s) de demonstração da v2 criada(s) (senha ${DEMO_PASSWORD}).`);
  if (created.teamMembers) log(`${created.teamMembers} conta(s) nova(s) incluída(s) na equipe "${V2_TEAM.name}".`);
  const people = structure.people;
  const all = await loadOrgUsers(organizationId);
  const env: Env = {
    organizationId,
    people,
    byId: new Map(all.map((u) => [u.id, u])),
    ctx: (key) => userContext(people[key]),
    companyId: structure.companyId,
  };
  const rules = await ensureRules(env.ctx("gestor"), structure);
  if (rules) log(`${rules} regra(s) de distribuição criada(s) (sem regra aplicável: menor carga entre os advogados).`);
  return env;
}

// ---------------------------------------------------------------------------
// d. Spreadsheet import
// ---------------------------------------------------------------------------

async function importSpreadsheet(env: Env): Promise<string> {
  const done = await committedDemoBatch(env.organizationId);
  if (done) {
    await finishImportDistribution(env.organizationId, done);
    return done;
  }
  const db = getDb();
  const gestor = env.ctx("gestor");
  const bytes = new Uint8Array(await readFile(path.resolve(process.cwd(), "scripts", "seed-data", "files", DEMO_SPREADSHEET.fileName)));
  const sha = createHash("sha256").update(bytes).digest("hex");

  // An analysis left by an interrupted run is reused (the commit recomputes the plan anyway).
  const [pending] = await db
    .select({ id: importBatches.id })
    .from(importBatches)
    .where(
      and(
        eq(importBatches.organizationId, env.organizationId),
        eq(importBatches.fileName, DEMO_SPREADSHEET.fileName),
        eq(importBatches.fileSha256, sha),
        eq(importBatches.status, "analyzed"),
      ),
    )
    .orderBy(desc(importBatches.createdAt))
    .limit(1);
  const companyId = env.companyId;
  if (!pending && !companyId) {
    throw new Error(
      `A empresa "${V2_COMPANY_NAME}" criada por uma execução anterior foi excluída, e a planilha fictícia precisa dela para ser importada. ` +
        "O seed não a recria; cadastre a empresa com esse nome ou recrie a demonstração (npm run db:seed -- --reset).",
    );
  }
  const batchId =
    pending?.id ??
    (
      await analyzeImport(gestor, {
        file: { name: DEMO_SPREADSHEET.fileName, bytes },
        companyId: companyId!,
        defaultUnitId: null,
        baseDate: DEMO_SPREADSHEET.baseDate,
        distributeAfterCommit: true,
      })
    ).batchId;
  log(`Planilha fictícia analisada (lote ${batchId}). Confirmando a importação e distribuindo os processos...`);
  const started = Date.now();
  const r = await commitImport(gestor, batchId, { baseDate: DEMO_SPREADSHEET.baseDate, distributeAfterCommit: true });
  log(
    `Importação confirmada em ${((Date.now() - started) / 1000).toFixed(1)} s: ${r.created} processos novos, ${r.updated} atualizados, ` +
      `${r.instancesCreated} vínculos de instância, ${r.valuationsOfficial} valores oficiais e ${r.valuationsProposed} divergências propostas para conferência.`,
  );
  if (r.distribution) {
    log(`Distribuição após a importação: ${r.distribution.assigned} atribuídos, ${r.distribution.failed} sem atribuição.`);
  }
  await finishImportDistribution(env.organizationId, batchId);
  return batchId;
}

/**
 * The post-commit distribution runs in the background (`import.distribute`
 * job). The next steps act as the responsible of each process, so the queue
 * runs here until the distribution is finished (also resumes one left pending
 * by an interrupted run; nothing to do otherwise).
 */
async function finishImportDistribution(organizationId: string, batchId: string) {
  const db = getDb();
  const unassigned = async () =>
    (
      await db
        .select({ n: count() })
        .from(legalProcesses)
        .where(
          and(
            eq(legalProcesses.organizationId, organizationId),
            eq(legalProcesses.importBatchId, batchId),
            isNull(legalProcesses.deletedAt),
            isNull(legalProcesses.responsibleId),
          ),
        )
    )[0]?.n ?? 0;
  const before = await unassigned();
  if (before === 0) return;
  await runQueue(organizationId, "distribuição dos processos importados");
  const after = await unassigned();
  log(`Distribuição após a importação: ${before - after} processo(s) atribuído(s), ${after} sem responsável.`);
}

async function loadImported(organizationId: string, batchId: string): Promise<ImportedProcess[]> {
  return getDb()
    .select({
      id: legalProcesses.id,
      number: legalProcesses.number,
      phase: legalProcesses.phase,
      status: legalProcesses.status,
      instance: legalProcesses.instance,
      court: legalProcesses.court,
      city: legalProcesses.city,
      courtDivision: legalProcesses.courtDivision,
      claim: legalProcesses.claimAmountCents,
      liquidated: legalProcesses.liquidatedAmountCents,
      responsibleId: legalProcesses.responsibleId,
    })
    .from(legalProcesses)
    .where(
      and(
        eq(legalProcesses.organizationId, organizationId),
        eq(legalProcesses.importBatchId, batchId),
        isNull(legalProcesses.deletedAt),
      ),
    )
    .orderBy(asc(legalProcesses.number));
}

/** Context of the person who handles the process (responsible lawyer / firm / manager), or the legal manager. */
function handlerCtx(env: Env, p: { responsibleId: string | null }): AuthContext {
  const u = p.responsibleId ? env.byId.get(p.responsibleId) : undefined;
  return u && ASSIGNABLE.includes(u.role) ? userContext(u) : env.ctx("gestor");
}

/** Every `stride`-th item starting at `offset` (spreads the picks over the portfolio). */
function spread<T>(list: readonly T[], offset: number, stride: number, n: number, skip: (t: T) => boolean): T[] {
  const out: T[] = [];
  for (let i = offset; i < list.length && out.length < n; i += stride) {
    if (!skip(list[i])) out.push(list[i]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// e. Contingencies
// ---------------------------------------------------------------------------

type Periods = { current: string; prev1: string; prev2: string };

function periods(): Periods {
  const current = periodOf(today());
  const first = `${current}-01`;
  return { current, prev1: periodOf(addMonthsISO(first, -1)), prev2: periodOf(addMonthsISO(first, -2)) };
}

/** Liquidated cases used for guarantees (0–11), value updates (12–17) and the extinction (22). */
const MATERIALIZED_WITH_EVENTS = 23;

type ContingencyScope = {
  env: Env;
  per: Periods;
  used: Set<string>;
  accountant: AuthContext;
  /** Active processes in liquidation/enforcement with a liquidated value, largest first. */
  withLiq: ImportedProcess[];
  /** Active processes in liquidation/enforcement without a liquidated value. */
  noLiq: ImportedProcess[];
  /** Active processes in the knowledge phase at the 1st grau (instance not informed counts as 1st). Disjoint from `appeal`. */
  knowledge: ImportedProcess[];
  /** Active processes in the knowledge phase at the 2nd/3rd grau ("em recurso" is the instance, never a phase, P0.5). */
  appeal: ImportedProcess[];
  prev2Date: string;
  prev1Date: (day: number) => string;
};

async function seedContingency(env: Env, procs: ImportedProcess[], used: Set<string>, per: Periods) {
  const db = getDb();
  const org = env.organizationId;
  const ids = procs.map((p) => p.id);
  const any = async (rows: Promise<unknown[]>) => (await rows).length > 0;
  const hasRisk = await any(
    db.select({ id: processRiskAssessments.id }).from(processRiskAssessments).where(and(eq(processRiskAssessments.organizationId, org), inArray(processRiskAssessments.processId, ids))).limit(1),
  );
  const hasGuarantee = await any(
    db.select({ id: processGuarantees.id }).from(processGuarantees).where(and(eq(processGuarantees.organizationId, org), inArray(processGuarantees.processId, ids))).limit(1),
  );
  const hasSettlement = await any(
    db.select({ id: settlements.id }).from(settlements).where(and(eq(settlements.organizationId, org), inArray(settlements.processId, ids))).limit(1),
  );

  const active = procs.filter((p) => p.status === "active");
  const materialized = active.filter((p) => p.phase === "liquidation" || p.phase === "enforcement");
  const scope: ContingencyScope = {
    env,
    per,
    used,
    accountant: env.ctx("contabilidade"),
    withLiq: materialized
      .filter((p) => p.liquidated !== null && p.liquidated > 0)
      .sort((a, b) => b.liquidated! - a.liquidated! || a.number.localeCompare(b.number)),
    noLiq: materialized.filter((p) => p.liquidated === null),
    knowledge: active.filter((p) => p.phase === "knowledge" && (p.instance ?? "first") === "first" && p.claim !== null),
    appeal: active.filter((p) => p.phase === "knowledge" && (p.instance === "second" || p.instance === "superior") && p.claim !== null),
    prev2Date: `${per.prev2}-05`,
    prev1Date: (day) => `${per.prev1}-${String(day).padStart(2, "0")}`,
  };
  for (const p of scope.withLiq.slice(0, MATERIALIZED_WITH_EVENTS + 20)) used.add(p.id);

  // Each sub-step runs once: when a previous (interrupted) run already wrote its records, it is skipped.
  if (!hasRisk) await seedRisk(scope);
  else log("Classificações de risco da carteira importada já registradas; passo ignorado.");
  if (!hasGuarantee) await seedGuaranteesAndValues(scope);
  else log("Garantias e atualizações de valor já registradas; passo ignorado.");
  if (!hasSettlement) await seedSettlements(scope);
  else log("Acordos já registrados; passo ignorado.");

  // Monthly closes of the two previous months (accounting) and a preview of the current one.
  // Close gate (P1.9): most imported processes have no risk classification on the reference date,
  // so accounting closes WITH the demo justification (recorded with the list of those processes).
  // The justification is ignored by the service when nothing is pending.
  // Closing is definitive: only the first v2 seed closes months (demoClosePlan); a later run, e.g. to
  // issue a new demo API key, never closes the month that just ended.
  const closePlan = demoClosePlan({ current: per.current, closed: await closedCompetencias(org), accountantId: env.people.contabilidade.id });
  for (const period of closePlan) {
    await generateSnapshot(scope.accountant, period);
    const closed = await closeSnapshot(scope.accountant, period, { justification: CLOSE_JUSTIFICATION });
    log(
      `Competência ${formatPeriod(period)} calculada e fechada pela contabilidade` +
        (closed.override ? ` com justificativa (${closed.override.unclassifiedCount} processo(s) sem classificação de risco)` : "") +
        ". O fechamento é definitivo; as próximas execuções da carga não fecham outras competências.",
    );
  }
  if (closePlan.length === 0) {
    log("Fechamentos mensais da demonstração já registrados; esta execução não fecha nenhuma competência (fechar cabe à contabilidade).");
    return; // the monthly_snapshot routine (step i) keeps the current month's preview
  }
  // Only when missing: the monthly_snapshot routine (step i) refreshes the current preview.
  if ((await getSnapshotStatus(org, per.current)) === null) {
    const preview = await generateSnapshot(scope.accountant, per.current);
    log(`Prévia da competência ${formatPeriod(per.current)} calculada (${preview.itemCount} processos).`);
  }
}

/**
 * Risk classifications (RF-11/RF-12), always by the person who handles the
 * process: manual classifications with a fictitious opinion in force since the
 * 2nd previous month (including the liquidated cases that get guarantees,
 * value updates and the extinction, so the monthly closes show their effect),
 * reclassifications in the previous month, rule suggestions approved today
 * and rule suggestions left pending.
 */
async function seedRisk(s: ContingencyScope) {
  const { env } = s;
  const counts = { approved: 0, manual: 0, reclassified: 0, pending: 0 };
  // Liquidated cases that get guarantees, value updates and the extinction: classified as probable since
  // the 2nd previous month, so the monthly closes show the effect of those events on the provision.
  for (const [i, p] of s.withLiq.slice(0, MATERIALIZED_WITH_EVENTS).entries()) {
    await addRiskAssessment(handlerCtx(env, p), p.id, {
      classification: "probable",
      opinion: RISK_OPINIONS.probable[i % RISK_OPINIONS.probable.length],
      effectiveFrom: s.prev2Date,
    });
    counts.manual++;
  }
  // Other liquidated cases: rule suggestions approved by whoever handles the process (in force from today).
  for (const p of s.withLiq.slice(MATERIALIZED_WITH_EVENTS, MATERIALIZED_WITH_EVENTS + 20)) {
    const actor = handlerCtx(env, p);
    const suggestion = await suggestRiskAssessment(actor, p.id);
    await approveRiskProposal(actor, suggestion.id, { note: RULE_APPROVAL_NOTE });
    counts.approved++;
  }

  const cycle: LossProbability[] = ["possible", "possible", "remote", "possible", "probable"];
  const manual = spread(s.knowledge, 0, 7, 30, () => false);
  const reclassify: ImportedProcess[] = [];
  for (const [i, p] of manual.entries()) {
    const classification = cycle[i % cycle.length];
    const opinions = RISK_OPINIONS[classification];
    await addRiskAssessment(handlerCtx(env, p), p.id, {
      classification,
      opinion: opinions[i % opinions.length],
      effectiveFrom: s.prev2Date,
    });
    if (classification === "possible" && reclassify.length < 5) reclassify.push(p);
    counts.manual++;
  }
  for (const [i, p] of spread(s.appeal, 0, 3, 10, () => false).entries()) {
    await addRiskAssessment(handlerCtx(env, p), p.id, {
      classification: "possible",
      opinion: RISK_OPINIONS.possible[2 - (i % 2)],
      effectiveFrom: s.prev2Date,
    });
    counts.manual++;
  }

  // Changes in the previous month: reclassifications and enforcement cases without a liquidated value.
  for (const p of reclassify) {
    await addRiskAssessment(handlerCtx(env, p), p.id, {
      classification: "probable",
      opinion: RISK_RECLASSIFICATION_OPINION,
      effectiveFrom: s.prev1Date(10),
    });
    counts.reclassified++;
  }
  for (const [i, p] of s.noLiq.slice(0, 10).entries()) {
    await addRiskAssessment(handlerCtx(env, p), p.id, {
      classification: "probable",
      opinion: RISK_OPINIONS.probable[i % RISK_OPINIONS.probable.length],
      effectiveFrom: s.prev1Date(10),
    });
    counts.manual++;
  }

  // Rule suggestions left pending: they never count until a person approves them.
  const manualIds = new Set(manual.map((p) => p.id));
  for (const p of spread(s.knowledge, 3, 11, 5, (x) => manualIds.has(x.id))) {
    await suggestRiskAssessment(handlerCtx(env, p), p.id);
    counts.pending++;
  }
  log(
    `Risco: ${counts.approved} sugestões por regra aprovadas, ${counts.manual} classificações manuais com parecer fictício, ` +
      `${counts.reclassified} reclassificações em ${formatPeriod(s.per.prev1)} e ${counts.pending} sugestões pendentes de conferência.`,
  );
}

/**
 * Linked guarantees registered by accounting (some idle for more than 180
 * days, one released to the plaintiff), official liquidated value updates in
 * the previous month and one extinction by payment (RN-06).
 */
async function seedGuaranteesAndValues(s: ContingencyScope) {
  const db = getDb();
  const org = s.env.organizationId;
  const offsets = [-420, -300, -250, -200, -190, -150, -120, -90, -75];
  const guaranteeIds: string[] = [];
  for (const [i, p] of s.withLiq.slice(0, 12).entries()) {
    const kind: GuaranteeKind = i < offsets.length && i % 3 !== 0 ? "appeal_deposit" : "judicial_deposit";
    const share = kind === "appeal_deposit" ? 0.3 : 0.5;
    const cap = kind === "appeal_deposit" ? 20_000_00 : 80_000_00;
    const { id } = await createGuarantee(s.accountant, p.id, {
      kind,
      amountCents: Math.max(100_00, Math.min(Math.round(p.liquidated! * share), cap)),
      depositedAt: i < offsets.length ? rel(offsets[i]) : s.prev1Date(12),
      description: GUARANTEE_DESCRIPTIONS[kind as keyof typeof GUARANTEE_DESCRIPTIONS],
    });
    guaranteeIds.push(id);
  }
  if (guaranteeIds[1]) {
    await setGuaranteeStatus(s.accountant, guaranteeIds[1], { status: "released_to_plaintiff", statusChangedAt: s.prev1Date(18) });
  }

  let updates = 0;
  for (const p of s.withLiq.slice(12, 18)) {
    const [current] = await db
      .select({ instance: processValuations.instance })
      .from(processValuations)
      .where(
        and(
          eq(processValuations.organizationId, org),
          eq(processValuations.processId, p.id),
          eq(processValuations.kind, "liquidated"),
          eq(processValuations.status, "official"),
        ),
      )
      .orderBy(desc(processValuations.baseDate))
      .limit(1);
    await addValuation(s.accountant, {
      processId: p.id,
      kind: "liquidated",
      amountCents: Math.round(p.liquidated! * 1.035),
      baseDate: s.prev1Date(20),
      instance: current?.instance ?? null,
      source: "manual",
      reason: VALUATION_UPDATE_REASON,
    });
    updates++;
  }
  const extinct = s.withLiq[MATERIALIZED_WITH_EVENTS - 1];
  if (extinct) await registerExtinction(s.accountant, extinct.id, { baseDate: s.prev1Date(25), note: EXTINCTION_NOTE });
  log(
    `Garantias: ${guaranteeIds.length} vinculadas (1 liberada ao autor); ${updates} atualizações de valor liquidado e ` +
      `${extinct ? 1 : 0} quitação em ${formatPeriod(s.per.prev1)}.`,
  );
}

type SettlementTerms = Omit<SettlementCreateInput, "status">;

/**
 * A signed settlement. On UTF-8 databases it goes "em negociação" → "firmado"
 * on the signing date. On other encodings (the embedded WIN1252 development
 * server) the contingency module's status-change audit text cannot be stored,
 * so the settlement is registered directly as signed (signing date = today).
 */
async function openSignedSettlement(actor: AuthContext, terms: SettlementTerms, signedOn: string): Promise<string> {
  if (databaseEncoding !== "UTF8") return (await createSettlement(actor, { ...terms, status: "signed" })).id;
  const { id } = await createSettlement(actor, { ...terms, status: "negotiating" });
  await setSettlementStatus(actor, id, { status: "signed", date: signedOn });
  return id;
}

function moveSettlement(actor: AuthContext, id: string, status: SettlementStatus, date: string) {
  return tolerateEncoding(`Acordo: mudança para "${SETTLEMENT_STATUS_LABELS[status]}"`, () =>
    setSettlementStatus(actor, id, { status, date }),
  );
}

/** Settlements: homologated with an installment due soon, negotiating, fulfilled and breached. */
async function seedSettlements(s: ContingencyScope) {
  const t = today();
  const total = (p: ImportedProcess) => Math.max(6_000_00, Math.min(60_000_00, Math.round(((p.claim ?? 0) * 0.4) / 100) * 100));
  const terms = (p: ImportedProcess, extra: Partial<SettlementTerms>): SettlementTerms => ({
    processId: p.id,
    totalAmountCents: total(p),
    responsibleId: p.responsibleId,
    ...extra,
  });
  const plans: ((p: ImportedProcess, actor: AuthContext) => Promise<void>)[] = [
    async (p, actor) => {
      const id = await openSignedSettlement(
        actor,
        terms(p, { installmentsCount: 6, firstDueDate: addDaysISO(t, -25), proposedAt: addDaysISO(t, -60), notes: V2_SETTLEMENT_NOTES.homologated }),
        addDaysISO(t, -40),
      );
      await moveSettlement(actor, id, "homologated", addDaysISO(t, -32));
      await payInstallments(actor, p.id, id, 1);
    },
    async (p, actor) => {
      await createSettlement(actor, { ...terms(p, { proposedAt: addDaysISO(t, -12), notes: V2_SETTLEMENT_NOTES.negotiating }), status: "negotiating" });
    },
    async (p, actor) => {
      const id = await openSignedSettlement(
        actor,
        terms(p, { installmentsCount: 2, firstDueDate: addDaysISO(t, -70), proposedAt: addDaysISO(t, -100), notes: V2_SETTLEMENT_NOTES.fulfilled }),
        addDaysISO(t, -80),
      );
      await payInstallments(actor, p.id, id, 2);
      await moveSettlement(actor, id, "fulfilled", addDaysISO(t, -35));
    },
    async (p, actor) => {
      const id = await openSignedSettlement(
        actor,
        terms(p, { installmentsCount: 4, firstDueDate: addDaysISO(t, -50), proposedAt: addDaysISO(t, -90), notes: V2_SETTLEMENT_NOTES.breached }),
        addDaysISO(t, -60),
      );
      const homologated = await moveSettlement(actor, id, "homologated", addDaysISO(t, -55));
      await payInstallments(actor, p.id, id, 1);
      if (homologated) await moveSettlement(actor, id, "breached", addDaysISO(t, -5));
    },
  ];
  const pool = spread(s.knowledge, 5, 13, plans.length, (p) => s.used.has(p.id));
  for (const [i, p] of pool.entries()) {
    await plans[i](p, handlerCtx(s.env, p));
    s.used.add(p.id);
  }
  const final = await getDb()
    .select({ status: settlements.status })
    .from(settlements)
    .where(and(eq(settlements.organizationId, s.env.organizationId), inArray(settlements.processId, pool.map((p) => p.id))));
  log(`Acordos: ${pool.length} registrados (${final.map((r) => SETTLEMENT_STATUS_LABELS[r.status].toLowerCase()).join(", ")}).`);
}

/** Marks the first `n` installments as paid on their due dates. */
async function payInstallments(actor: AuthContext, processId: string, settlementId: string, n: number) {
  const list = await listProcessSettlements(actor, processId);
  const s = list.find((x) => x.id === settlementId);
  for (const inst of (s?.installments ?? []).sort((a, b) => a.number - b.number).slice(0, n)) {
    if (inst.status !== "pending") continue;
    await setInstallmentPaid(actor, inst.id, { paid: true, paidAt: inst.dueDate });
  }
}

// ---------------------------------------------------------------------------
// f. Hearings
// ---------------------------------------------------------------------------

async function seedHearings(env: Env, procs: ImportedProcess[], used: Set<string>) {
  const db = getDb();
  const withHearing = new Set(
    (
      await db
        .selectDistinct({ id: hearings.processId })
        .from(hearings)
        .where(and(eq(hearings.organizationId, env.organizationId), inArray(hearings.processId, procs.map((p) => p.id))))
    ).map((r) => r.id),
  );
  if (withHearing.size > 0) return;
  const pool = spread(
    procs.filter((p) => p.status === "active" && p.phase === "knowledge" && p.instance === "first"),
    2,
    17,
    V2_HEARINGS.length + 1,
    (p) => used.has(p.id) || env.byId.get(p.responsibleId ?? "")?.role !== "lawyer",
  );
  const gestor = env.ctx("gestor");
  const create = async (p: ImportedProcess, h: { days: number; time: string; kind: (typeof V2_HEARINGS)[number]["kind"]; mode: (typeof V2_HEARINGS)[number]["mode"] }, n: number) => {
    const { id } = await createHearing(gestor, {
      processId: p.id,
      kind: h.kind,
      mode: h.mode,
      date: rel(h.days),
      time: h.time,
      location: h.mode === "virtual" ? null : hearingLocation(p.city, p.courtDivision),
      meetingUrl: h.mode === "in_person" ? null : hearingUrl(n),
      responsibleId: p.responsibleId,
      notes: "Pauta cadastrada para a demonstração (dados fictícios).",
    });
    used.add(p.id);
    return id;
  };
  let n = 0;
  for (const [i, h] of V2_HEARINGS.entries()) {
    if (!pool[i]) break;
    await create(pool[i], h, ++n);
  }
  const upcoming = n;
  const past = pool[V2_HEARINGS.length];
  if (past) {
    const id = await create(past, V2_PAST_HEARING, ++n);
    await setHearingStatus(gestor, id, { status: "held", outcome: V2_PAST_HEARING.outcome });
  }
  if (n === 0) {
    warn("nenhum processo de 1º grau na fase de conhecimento com advogado responsável; nenhuma audiência foi cadastrada.");
    return;
  }
  log(`${n} audiência(s) cadastrada(s): ${upcoming} nos próximos 20 dias e ${n - upcoming} realizada(s) (com resultado).`);
}

// ---------------------------------------------------------------------------
// g. Intake demo (SIMULATED documents, preliminary analysis and e-mail)
// ---------------------------------------------------------------------------

async function seedIntakes(env: Env) {
  const db = getDb();
  const org = env.organizationId;
  const [{ n: existing }] = await db
    .select({ n: count() })
    .from(caseIntakes)
    .where(and(eq(caseIntakes.organizationId, org), eq(caseIntakes.source, "simulated_feed")));
  const created: string[] = [];
  for (let i = existing; i < SIMULATED_INTAKES; i++) {
    const r = await simulateIncomingProcess(env.ctx("gestor"));
    created.push(r.intakeId);
    log(`Chegada simulada registrada: processo fictício ${r.number} com ${r.documentIds.length} documento(s) fictício(s).`);
  }
  await runQueue(org, "entrada de processos: distribuição, leitura dos documentos, análise preliminar e e-mail simulados");
  // The lawyer's review below only touches the arrivals created by this run: an arrival simulated
  // earlier (by a person, with "Simular chegada de processo") is left exactly as it is.
  if (created.length === 0) {
    log("Entradas de processo simuladas já registradas; passo ignorado.");
    return;
  }

  const rows = await db
    .select({ intakeId: caseIntakes.id, briefId: caseIntakes.briefId, status: caseIntakes.status, responsibleId: legalProcesses.responsibleId })
    .from(caseIntakes)
    .innerJoin(legalProcesses, eq(legalProcesses.id, caseIntakes.processId))
    .where(and(eq(caseIntakes.organizationId, org), inArray(caseIntakes.id, created)))
    .orderBy(asc(caseIntakes.receivedAt), asc(caseIntakes.id));
  const briefs: { brief: CaseBriefDetail; actor: AuthContext }[] = [];
  for (const r of rows) {
    if (!r.briefId) {
      warn(`a entrada ${r.intakeId} terminou sem análise preliminar (situação "${r.status}").`);
      continue;
    }
    const actor = handlerCtx(env, r);
    briefs.push({ brief: await getCaseBrief(actor, r.briefId), actor });
  }

  // 1st: the responsible lawyer edits one item and approves; 2nd: edited, stays in review; 3rd: untouched.
  const edit = async (b: CaseBriefDetail, actor: AuthContext, note: string) => {
    const items = b.content?.factsSummary ?? [];
    if (!items.length) return false;
    const value = items.map((item, idx) =>
      idx === 0 ? { ...item, text: `${item.text} Conferido pelo advogado responsável com a petição inicial (revisão de demonstração).` } : item,
    );
    await saveCaseBriefSection(actor, b.id, { section: "factsSummary", value, baseRevision: b.currentRevision, changeNote: note });
    return true;
  };
  const [first, second, third] = briefs;
  if (first && first.brief.status === "ready_for_review") {
    await edit(first.brief, first.actor, "Fatos conferidos com a petição inicial (demonstração).");
    await approveCaseBrief(first.actor, first.brief.id, { note: "Análise conferida e aprovada pelo advogado responsável (demonstração)." });
    log(`Análise preliminar ${first.brief.process.number}: editada e aprovada pelo advogado responsável.`);
  }
  if (second && second.brief.status === "ready_for_review") {
    await edit(second.brief, second.actor, "Revisão em andamento (demonstração).");
    log(`Análise preliminar ${second.brief.process.number}: editada, segue em revisão.`);
  }

  // Suggestions turned into records by explicit user action (lawyer): one deadline, one task, one value.
  const ordered = [second, third, first].filter(Boolean) as typeof briefs;
  const hasDeadline = await db
    .select({ id: deadlines.id })
    .from(deadlines)
    .where(and(eq(deadlines.organizationId, org), inArray(deadlines.sourceAnalysisId, briefs.map((b) => b.brief.id))))
    .limit(1);
  if (!hasDeadline.length) {
    const target = ordered
      .map((b) => ({ ...b, index: (b.brief.content?.possibleDeadlines ?? []).findIndex((d) => d.date && d.date >= today()) }))
      .find((b) => b.index >= 0);
    if (target) {
      await attempt("possível prazo da análise", () => applyBriefDeadline(target.actor, target.brief.id, target.index));
      log("Possível prazo da análise preliminar enviado para validação humana (Prazos › Validação).");
    } else warn("nenhuma análise preliminar trouxe possível prazo com data; nenhum prazo foi sugerido.");
  }
  const hasTask = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.organizationId, org), inArray(tasks.sourceAnalysisId, briefs.map((b) => b.brief.id))))
    .limit(1);
  if (!hasTask.length) {
    const target = ordered.find((b) => (b.brief.content?.nextSteps ?? []).length > 0);
    if (target) {
      await attempt("próximo passo da análise", () => applyBriefNextStep(target.actor, target.brief.id, 0));
      log("Próximo passo da análise preliminar transformado em tarefa.");
    }
  }
  const hasValue = await db
    .select({ id: processValuations.id })
    .from(processValuations)
    .where(and(eq(processValuations.organizationId, org), inArray(processValuations.briefId, briefs.map((b) => b.brief.id))))
    .limit(1);
  if (!hasValue.length) {
    const target = ordered
      .map((b) => ({
        ...b,
        index: (b.brief.content?.amounts ?? []).findIndex(
          (a) => a.amountCents !== null && a.citations.some((c) => c.ref !== "REG" && c.page !== null),
        ),
      }))
      .find((b) => b.index >= 0);
    if (target) {
      await attempt("valor da análise", () => proposeBriefAmount(target.actor, target.brief.id, target.index));
      log("Valor lido na análise preliminar enviado para a fila de conferência (proposto, simulação).");
    } else warn("nenhum valor das análises preliminares tem citação de página; nada foi enviado para conferência.");
  }
}

// ---------------------------------------------------------------------------
// h. Preventive intelligence → occurrence + action plan
// ---------------------------------------------------------------------------

async function seedPreventive(env: Env) {
  const r = await seedPreventiveOccurrence(env.ctx("gestor"));
  switch (r.status) {
    case "already_recorded":
      log("Ocorrência da inteligência preventiva já registrada (em qualquer situação, inclusive resolvida ou excluída); passo ignorado.");
      return;
    case "no_suggestion":
      warn("nenhuma sugestão da inteligência preventiva está ativa; nenhuma ocorrência foi criada.");
      return;
    case "created":
      log(`Ocorrência preventiva "${r.title}" criada a partir da inteligência preventiva, com ${r.tasks} tarefa(s) de plano de ação.`);
      return;
    case "plan_resumed":
      log(`Plano de ação da ocorrência preventiva "${r.title}" concluído (${r.tasks} tarefa(s)); a execução anterior parou antes dele.`);
  }
}

// ---------------------------------------------------------------------------
// k. Claims, l. claim suggestions, m. scenarios, n. index series, o. API key
// ---------------------------------------------------------------------------

function claimCandidates(procs: readonly ImportedProcess[]): ClaimCandidate[] {
  return procs.map((p) => ({
    id: p.id,
    number: p.number,
    status: p.status,
    phase: p.phase,
    instance: p.instance,
    claim: p.claim,
    responsibleId: p.responsibleId,
  }));
}

async function seedClaims(env: Env, procs: readonly ImportedProcess[]) {
  const r = await seedDemoClaims({
    organizationId: env.organizationId,
    candidates: claimCandidates(procs),
    actorFor: (p) => handlerCtx(env, p),
    baseDate: DEMO_SPREADSHEET.baseDate,
    today: today(),
    warn,
  });
  if (r.processes === 0 && r.failed === 0) {
    log("Pedidos dos processos da demonstração já registrados; passo ignorado.");
    return;
  }
  log(
    `Pedidos: ${r.claimsCreated} pedido(s) em ${r.processes} processo(s), ${r.assessments} avaliação(ões) por pedido feitas pelo ` +
      `advogado responsável e ${r.derivedRecorded} classificação(ões) do processo derivadas dos pedidos` +
      (r.flaggedForReview ? ` (${r.flaggedForReview} processo(s) com pedido sem valor, marcados para revisão)` : "") +
      (r.failed ? `; ${r.failed} processo(s) com falha (ver avisos)` : "") +
      ".",
  );
}

async function seedClaimSuggestions(env: Env) {
  const r = await suggestClaimsFromLatestBriefs(env.organizationId, env.ctx("gestor"), warn);
  if (r.created > 0) {
    log(`${r.created} pedido(s) sugerido(s) pela análise preliminar (simulação), aguardando confirmação do advogado.`);
  }
}

async function seedScenarios(env: Env, isDemo: boolean) {
  const r = await seedDemoScenarios({ organizationId: env.organizationId, isDemo, warn });
  if (r.scenarios > 0) {
    log(`${r.scenarios} cenário(s) proposto(s) pelo sistema em ${r.processes} processo(s) com pedidos, para revisão do advogado.`);
  }
}

async function seedIndexSeries(organizationId: string): Promise<string | null> {
  const r = await refreshIndexSeriesOnce(organizationId);
  switch (r.status) {
    case "already_ran":
      log("Coleta dos índices do Banco Central já executada nesta organização; passo ignorado.");
      return null;
    case "disabled":
      warn("a rotina de coleta dos índices do Banco Central está desativada; nenhuma série foi consultada.");
      return null;
    case "failed":
      warn(`a coleta dos índices do Banco Central falhou (${r.errorName}); o worker tenta de novo na próxima execução diária.`);
      return null;
    case "ran":
      log(`Coleta dos índices do Banco Central (SGS): ${r.summary ?? "concluída"}`);
      return r.summary;
  }
}

// ---------------------------------------------------------------------------
// i. Routines, j. daily digest
// ---------------------------------------------------------------------------

/**
 * Routines the seed never runs: the DataJud collection (the seed never queries
 * the tribunals), the simulated arrival feed (stays as configured: disabled by
 * default) and the index collection (step n runs it once).
 */
const ROUTINES_NOT_RUN_BY_SEED: readonly RoutineType[] = ["court_sync", "simulated_feed", "index_series_refresh"];

async function runAllRoutines(organizationId: string) {
  const db = getDb();
  const routines = await db
    .select({ id: scheduledRoutines.id, type: scheduledRoutines.type, intervalMinutes: scheduledRoutines.intervalMinutes })
    .from(scheduledRoutines)
    .where(and(eq(scheduledRoutines.organizationId, organizationId), notInArray(scheduledRoutines.type, [...ROUTINES_NOT_RUN_BY_SEED])))
    .orderBy(asc(scheduledRoutines.type));
  for (const r of routines) {
    try {
      const result = await runRoutine(r.id);
      if (result) log(`Rotina ${r.type}: ${result.status}`);
    } catch (err) {
      warn(`a rotina ${r.type} falhou (${err instanceof Error ? err.name : "erro"}); ela será repetida pelo worker.`);
    }
    await db
      .update(scheduledRoutines)
      .set({ nextRunAt: new Date(Date.now() + r.intervalMinutes * 60_000) })
      .where(eq(scheduledRoutines.id, r.id));
  }
  await runQueue(organizationId, "rotinas");
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

type ApiKeyOutcome = Awaited<ReturnType<typeof ensureDemoApiKey>> | null;

async function printSummary(env: Env, batchId: string, apiKey: ApiKeyOutcome) {
  const db = getDb();
  const org = env.organizationId;
  const group = async <K extends string>(rows: Promise<{ k: K | null; n: number }[]>, labels?: Record<string, string>) =>
    (await rows).map((r) => `${labels?.[r.k ?? ""] ?? r.k ?? "Não informado"}: ${r.n}`).join(", ") || "nenhum";
  const n = async (rows: Promise<{ n: number }[]>) => (await rows)[0]?.n ?? 0;
  const seedClaims = and(
    eq(processClaims.organizationId, org),
    isNull(processClaims.deletedAt),
    eq(processClaims.origin, "manual"),
    like(processClaims.description, `%${CLAIM_FICTITIOUS_SUFFIX}`),
  );
  const closes = await db
    .select({ period: portfolioSnapshots.period, status: portfolioSnapshots.status, unclassified: snapshotCloseOverrides.unclassifiedCount })
    .from(portfolioSnapshots)
    .leftJoin(snapshotCloseOverrides, eq(snapshotCloseOverrides.snapshotId, portfolioSnapshots.id))
    .where(eq(portfolioSnapshots.organizationId, org))
    .orderBy(asc(portfolioSnapshots.period));
  const indexRows = await db
    .select({ code: indexSeriesValues.indexCode, months: count(), last: max(indexSeriesValues.month) })
    .from(indexSeriesValues)
    .groupBy(indexSeriesValues.indexCode)
    .orderBy(asc(indexSeriesValues.indexCode));
  const [demoKey] = await db
    .select({ keyPrefix: apiKeys.keyPrefix })
    .from(apiKeys)
    .where(and(eq(apiKeys.organizationId, org), eq(apiKeys.name, DEMO_API_KEY.name), isNull(apiKeys.revokedAt)))
    .limit(1);

  const lines: [string, string | number][] = [
    ["Processos (organização)", await n(db.select({ n: count() }).from(legalProcesses).where(and(eq(legalProcesses.organizationId, org), isNull(legalProcesses.deletedAt))))],
    ["  da planilha fictícia", await n(db.select({ n: count() }).from(legalProcesses).where(and(eq(legalProcesses.organizationId, org), eq(legalProcesses.importBatchId, batchId))))],
    ["  por empresa", await group(
      db
        .select({ k: companies.name, n: sql<number>`count(*)::int` })
        .from(legalProcesses)
        .leftJoin(companies, eq(companies.id, legalProcesses.companyId))
        .where(and(eq(legalProcesses.organizationId, org), isNull(legalProcesses.deletedAt)))
        .groupBy(companies.name),
    )],
    ["  por unidade", await group(
      db
        .select({ k: units.name, n: sql<number>`count(*)::int` })
        .from(legalProcesses)
        .leftJoin(units, eq(units.id, legalProcesses.unitId))
        .where(and(eq(legalProcesses.organizationId, org), isNull(legalProcesses.deletedAt)))
        .groupBy(units.name),
    )],
    ["  com escritório externo", await n(db.select({ n: count() }).from(legalProcesses).where(and(eq(legalProcesses.organizationId, org), isNotNull(legalProcesses.lawFirmId))))],
    ["Regras de distribuição", await n(db.select({ n: count() }).from(distributionRules).where(eq(distributionRules.organizationId, org)))],
    ["Valores por situação", await group(
      db.select({ k: processValuations.status, n: sql<number>`count(*)::int` }).from(processValuations).where(eq(processValuations.organizationId, org)).groupBy(processValuations.status),
      VALUATION_STATUS_LABELS,
    )],
    ["Classificações de risco", await group(
      db.select({ k: processRiskAssessments.status, n: sql<number>`count(*)::int` }).from(processRiskAssessments).where(eq(processRiskAssessments.organizationId, org)).groupBy(processRiskAssessments.status),
      VALUATION_STATUS_LABELS,
    )],
    ["Garantias", await group(
      db.select({ k: processGuarantees.kind, n: sql<number>`count(*)::int` }).from(processGuarantees).where(and(eq(processGuarantees.organizationId, org), isNull(processGuarantees.deletedAt))).groupBy(processGuarantees.kind),
      GUARANTEE_KIND_LABELS,
    )],
    ["Acordos", await group(
      db.select({ k: settlements.status, n: sql<number>`count(*)::int` }).from(settlements).where(and(eq(settlements.organizationId, org), isNull(settlements.deletedAt))).groupBy(settlements.status),
      SETTLEMENT_STATUS_LABELS,
    )],
    ["Competências", closes
      .map((s) =>
        `${formatPeriod(s.period)} ${s.status === "closed" ? "fechada" : "prévia"}` +
        (s.unclassified !== null ? ` (com justificativa: ${s.unclassified} sem classificação)` : ""),
      )
      .join(", ") || "nenhuma"],
    ["Pedidos", await group(
      db.select({ k: processClaims.status, n: sql<number>`count(*)::int` }).from(processClaims).where(and(eq(processClaims.organizationId, org), isNull(processClaims.deletedAt))).groupBy(processClaims.status),
      CLAIM_STATUS_LABELS,
    )],
    ["  da demonstração (processos)", await n(db.select({ n: countDistinct(processClaims.processId) }).from(processClaims).where(seedClaims))],
    ["  sugeridos pela análise preliminar", await n(db.select({ n: count() }).from(processClaims).where(and(eq(processClaims.organizationId, org), isNull(processClaims.deletedAt), eq(processClaims.origin, "ai_suggested"))))],
    ["Avaliações de pedidos", await n(db.select({ n: count() }).from(processClaimAssessments).where(eq(processClaimAssessments.organizationId, org)))],
    ["Classificações derivadas dos pedidos", await n(db.select({ n: count() }).from(processClaimRiskLinks).where(and(eq(processClaimRiskLinks.organizationId, org), eq(processClaimRiskLinks.kind, "derived"))))],
    ["  risco em vigor nos processos com pedidos", await group(
      db
        .select({ k: legalProcesses.lossProbability, n: sql<number>`count(*)::int` })
        .from(legalProcesses)
        .where(
          and(
            eq(legalProcesses.organizationId, org),
            inArray(legalProcesses.id, db.selectDistinct({ id: processClaims.processId }).from(processClaims).where(seedClaims)),
          ),
        )
        .groupBy(legalProcesses.lossProbability),
      LOSS_PROBABILITY_LABELS,
    )],
    ["Cenários", await group(
      db.select({ k: processScenarios.probabilityBand, n: sql<number>`count(*)::int` }).from(processScenarios).where(eq(processScenarios.organizationId, org)).groupBy(processScenarios.probabilityBand),
      PROBABILITY_BAND_LABELS,
    )],
    ["Índices do Banco Central (meses)", indexRows.map((r) => `${CORRECTION_INDEX_LABELS[r.code]}: ${r.months} até ${r.last ? formatPeriod(r.last) : "Não informado"}`).join(", ") || "nenhum mês coletado"],
    ["Chave de API de demonstração", demoKey ? `ativa (prefixo ${demoKey.keyPrefix})` : "não criada"],
    ["Audiências", await group(
      db.select({ k: hearings.status, n: sql<number>`count(*)::int` }).from(hearings).where(eq(hearings.organizationId, org)).groupBy(hearings.status),
      HEARING_STATUS_LABELS,
    )],
    ["Entradas de processo", await group(
      db.select({ k: caseIntakes.status, n: sql<number>`count(*)::int` }).from(caseIntakes).where(eq(caseIntakes.organizationId, org)).groupBy(caseIntakes.status),
      INTAKE_STATUS_LABELS,
    )],
    ["Análises preliminares (simulação)", await group(
      db.select({ k: caseBriefs.status, n: sql<number>`count(*)::int` }).from(caseBriefs).where(eq(caseBriefs.organizationId, org)).groupBy(caseBriefs.status),
      CASE_BRIEF_STATUS_LABELS,
    )],
    ["E-mails simulados", await group(
      db.select({ k: emailMessages.template, n: sql<number>`count(*)::int` }).from(emailMessages).where(eq(emailMessages.organizationId, org)).groupBy(emailMessages.template),
      EMAIL_TEMPLATE_LABELS,
    )],
    ["Prazos aguardando validação", await n(db.select({ n: count() }).from(deadlines).where(and(eq(deadlines.organizationId, org), eq(deadlines.validationStatus, "pending_validation"))))],
    ["Ocorrências da inteligência preventiva", await n(db.select({ n: count() }).from(occurrences).where(and(eq(occurrences.organizationId, org), isNull(occurrences.deletedAt), sql`${occurrences.facts} like ${"%" + PREVENTIVE_MARKER_PREFIX + "%"}`)))],
    ["Alertas abertos", await group(
      db.select({ k: alerts.type, n: sql<number>`count(*)::int` }).from(alerts).where(and(eq(alerts.organizationId, org), isNull(alerts.resolvedAt))).groupBy(alerts.type),
      ALERT_TYPE_LABELS,
    )],
  ];
  console.log("");
  console.log(`Resumo da v2: ${AURORA_ORG.name}`);
  for (const [label, value] of lines) console.log(`  ${label.padEnd(40, ".")} ${value}`);
  console.log("");
  console.log(`Contas da v2 (senha ${DEMO_PASSWORD}):`);
  for (const [email] of Object.entries(AURORA_V2_USERS)) {
    const a = DEMO_ACCOUNTS.find((x) => x.email === email)!;
    console.log(`  ${a.email.padEnd(38)} ${ROLE_LABELS[a.role].padEnd(30)} ${a.description}`);
  }
  if (encodingSkips.length > 0) {
    console.log("");
    console.log(`Não gravado por causa da codificação ${databaseEncoding} do banco (${encodingSkips.length}):`);
    for (const s of encodingSkips) console.log(`  - ${s}`);
  }
  if (apiKey) {
    console.log("");
    console.log(
      apiKey.created
        ? `API de entrada: a chave "${DEMO_API_KEY.name}" (prefixo ${apiKey.keyPrefix}) foi exibida acima, logo depois de criada, e não é exibida de novo.`
        : `API de entrada: ${API_KEY_EXISTS(apiKey.keyPrefix)}`,
    );
  }
  console.log("");
  console.log(
    "Dados fictícios. A análise preliminar e o e-mail são SIMULAÇÕES (nada é enviado, nenhuma IA real); " +
      "o seed não consulta os tribunais (DataJud).",
  );
}

const API_KEY_EXISTS = (prefix: string) =>
  `a chave "${DEMO_API_KEY.name}" já existe (prefixo ${prefix}) e não pode ser exibida de novo. Para uma nova, revogue-a em ` +
  "Administração, Integrações, API de entrada e rode npm run db:seed:v2 de novo (a carga só acrescenta o que falta e não fecha nenhuma competência).";

/** Demo API key created by this run (prefix only), so the failure path can point to where it was printed. */
let printedKeyPrefix: string | null = null;

/**
 * Prints the demo API key ONCE, right after it is created (the database keeps
 * only its hash): a step that fails afterwards never loses it.
 */
function printApiKey(apiKey: Exclude<ApiKeyOutcome, null>) {
  if (!apiKey.created) return; // an existing key cannot be shown again (the summary says how to get a new one)
  console.log("");
  console.log("=".repeat(78));
  console.log(`API de entrada: "${DEMO_API_KEY.name}"`);
  console.log(`  Chave: ${apiKey.key}`);
  console.log("  Exibida só agora: o banco guarda apenas o hash. Não compartilhe nem versione esta chave.");
  console.log("  Teste, com o sistema rodando (npm run dev), trocando <chave> pela chave acima:");
  console.log('    PowerShell: $env:PRAETOR_API_KEY="<chave>"; npx tsx scripts/demo-api-push.ts');
  console.log("    Git Bash:   PRAETOR_API_KEY=<chave> npx tsx scripts/demo-api-push.ts");
  console.log("=".repeat(78));
  console.log("");
  printedKeyPrefix = apiKey.keyPrefix;
}

// ---------------------------------------------------------------------------
// Step markers
// ---------------------------------------------------------------------------

type StepKey =
  | "structure"
  | "rules"
  | "import"
  | "contingency"
  | "hearings"
  | "intakes"
  | "preventive"
  | "claims"
  | "scenarios"
  | "indices"
  | "api-key"
  | "digest";

/** Steps that `--skip` may leave out (the ones added after the first v2 seed). */
const SKIPPABLE = ["claims", "suggestions", "scenarios", "indices", "api-key"] as const;
type SkippableStep = (typeof SKIPPABLE)[number];

const STEP_LABELS: Record<StepKey, string> = {
  structure: "empresa, escritório e contas da v2",
  rules: "regras de distribuição",
  import: "importação da planilha fictícia",
  contingency: "contingências e fechamentos mensais",
  hearings: "audiências",
  intakes: "entrada de processos simulada",
  preventive: "ocorrência da inteligência preventiva",
  claims: "pedidos com avaliação por pedido",
  scenarios: "cenários propostos pelo sistema",
  indices: "coleta dos índices do Banco Central",
  "api-key": "chave de API de demonstração",
  digest: "resumo diário simulado",
};

function parseSkip(argv: readonly string[]): Set<SkippableStep> {
  const values: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--skip=")) values.push(...a.slice("--skip=".length).split(","));
    else if (a === "--skip" && argv[i + 1]) values.push(...argv[++i].split(","));
  }
  const out = new Set<SkippableStep>();
  for (const v of values.map((x) => x.trim()).filter(Boolean)) {
    if (!(SKIPPABLE as readonly string[]).includes(v)) {
      throw new Error(`Passo desconhecido em --skip: "${v}". Use: ${SKIPPABLE.join(", ")}.`);
    }
    out.add(v as SkippableStep);
  }
  return out;
}

/** Steps whose marker is missing (reads only; nothing is written). */
async function pendingSteps(organizationId: string, gestor: SeededUser, skip: ReadonlySet<SkippableStep>): Promise<StepKey[]> {
  const db = getDb();
  const pending: StepKey[] = [];

  // Created once (scripts/seed-data/v2/structure.ts): a person's rename or removal never makes them pending again.
  if (structurePending(await structurePlan(organizationId))) pending.push("structure");
  if ((await rulesPlan(organizationId)).length > 0) pending.push("rules");

  const batchId = await committedDemoBatch(organizationId);
  if (!batchId) {
    pending.push("import", "contingency", "hearings");
    if (!skip.has("claims")) pending.push("claims");
    if (!skip.has("scenarios")) pending.push("scenarios");
  } else {
    const procs = await loadImported(organizationId, batchId);
    const ids = procs.map((p) => p.id);
    const exists = async (rows: Promise<unknown[]>) => (await rows).length > 0;
    const accountantEmail = Object.entries(AURORA_V2_USERS).find(([, m]) => m.key === "contabilidade")?.[0].toLowerCase() ?? "";
    const [accountant] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.organizationId, organizationId), eq(users.email, accountantEmail)));
    const closes = demoClosePlan({ current: periods().current, closed: await closedCompetencias(organizationId), accountantId: accountant?.id ?? null });
    // The current month's preview is not a marker: it is refreshed by the monthly_snapshot routine, and a
    // month that just started must not make the seed run (nor close the month that just ended).
    const contingencyDone =
      ids.length > 0 &&
      (await exists(
        db.select({ id: processRiskAssessments.id }).from(processRiskAssessments).where(and(eq(processRiskAssessments.organizationId, organizationId), inArray(processRiskAssessments.processId, ids))).limit(1),
      )) &&
      (await exists(
        db.select({ id: processGuarantees.id }).from(processGuarantees).where(and(eq(processGuarantees.organizationId, organizationId), inArray(processGuarantees.processId, ids))).limit(1),
      )) &&
      (await exists(
        db.select({ id: settlements.id }).from(settlements).where(and(eq(settlements.organizationId, organizationId), inArray(settlements.processId, ids))).limit(1),
      )) &&
      closes.length === 0;
    if (!contingencyDone) pending.push("contingency");
    const hasHearing = await exists(
      db.select({ id: hearings.id }).from(hearings).where(and(eq(hearings.organizationId, organizationId), inArray(hearings.processId, ids))).limit(1),
    );
    if (!hasHearing) pending.push("hearings");
    const claimsPending = !skip.has("claims") && (await planDemoClaims(organizationId, claimCandidates(procs))).length > 0;
    if (claimsPending) pending.push("claims");
    if (!skip.has("scenarios") && (claimsPending || (await planDemoScenarios(organizationId)).length > 0)) pending.push("scenarios");
  }

  const [{ n: intakes }] = await db
    .select({ n: count() })
    .from(caseIntakes)
    .where(and(eq(caseIntakes.organizationId, organizationId), eq(caseIntakes.source, "simulated_feed")));
  if (intakes < SIMULATED_INTAKES) pending.push("intakes");
  // Before the import there is nothing to suggest from yet: pending while no occurrence from an indicator exists.
  const preventivePending = batchId
    ? await preventiveOccurrencePending(userContext(gestor))
    : !(await preventiveOccurrenceRecorded(organizationId));
  if (preventivePending) pending.push("preventive");
  if (!skip.has("indices") && (await indexSeriesRefreshPending(organizationId))) pending.push("indices");
  if (!skip.has("api-key") && (await demoApiKeyPending(organizationId))) pending.push("api-key");
  if (!(await digestSent(organizationId, gestor.id))) pending.push("digest");
  return pending;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const skip = parseSkip(process.argv.slice(2));
  const db = getDb();
  await db.execute(sql`select 1`);
  const [org] = await db
    .select({ id: organizations.id, isDemo: organizations.isDemo })
    .from(organizations)
    .where(eq(organizations.slug, AURORA_ORG.slug))
    .limit(1);
  if (!org) {
    throw new Error(`A organização de demonstração "${AURORA_ORG.slug}" não existe. Rode antes: npm run db:seed (ou npm run db:setup).`);
  }
  if (!org.isDemo) throw new Error(`A organização "${AURORA_ORG.slug}" não está marcada como demonstração; nada foi alterado.`);

  const orgUsers = await loadOrgUsers(org.id);
  const v1 = {} as Record<UserKey, SeededUser>;
  for (const [email, meta] of Object.entries(AURORA_USERS)) {
    const u = orgUsers.find((x) => x.email === email);
    if (!u) throw new Error(`A conta de demonstração ${email} não existe na organização; rode npm run db:seed -- --reset para recriar a demonstração.`);
    v1[meta.key] = u;
  }

  if (skip.size > 0) log(`Passos deixados de fora (--skip): ${[...skip].join(", ")}.`);
  const pending = await pendingSteps(org.id, v1.gestor, skip);
  if (pending.length === 0) {
    log("A demonstração da v2 já está completa nesta organização (todos os passos registrados). Nada foi alterado.");
    return;
  }
  log(`Passos pendentes: ${pending.map((s) => STEP_LABELS[s]).join(", ")}.`);
  if (!pending.includes("import")) log("A planilha fictícia já foi importada; só os passos pendentes acrescentam dados.");

  const started = Date.now();
  log(`Data de referência: ${today()}.`);
  const encoding = await db.execute<{ enc: string }>(
    sql`select pg_encoding_to_char(encoding) as enc from pg_database where datname = current_database()`,
  );
  databaseEncoding = encoding.rows[0]?.enc ?? "UTF8";
  if (databaseEncoding !== "UTF8") {
    warn(
      `o banco usa a codificação ${databaseEncoding} (não UTF-8). Textos com caracteres fora dela não podem ser gravados; ` +
        "os passos afetados são pulados com aviso e listados no resumo.",
    );
  }

  await ensureDefaultRoutines(org.id); // a
  const env = await seedStructureAndRules(org.id, v1); // b, c
  const batchId = await importSpreadsheet(env); // d
  env.byId = new Map((await loadOrgUsers(org.id)).map((u) => [u.id, u]));
  const procs = await loadImported(org.id, batchId);
  const used = new Set<string>();
  await seedContingency(env, procs, used, periods()); // e
  await seedHearings(env, await loadImported(org.id, batchId), used); // f
  await seedIntakes(env); // g
  await seedPreventive(env); // h
  if (!skip.has("claims")) await seedClaims(env, await loadImported(org.id, batchId)); // k
  if (!skip.has("suggestions")) await seedClaimSuggestions(env); // l
  if (!skip.has("scenarios")) await seedScenarios(env, org.isDemo); // m
  if (!skip.has("indices")) await seedIndexSeries(org.id); // n
  await runAllRoutines(org.id); // i
  if (!(await digestSent(org.id, env.people.gestor.id))) {
    await sendDailyDigest(env.ctx("gestor")); // j
    log("Resumo diário (e-mail simulado) gerado para o gestor jurídico.");
  }
  // o: last writing step, printed right away (never only in the summary below).
  const apiKey = skip.has("api-key") ? null : await ensureDemoApiKey(env.ctx("admin"));
  if (apiKey) printApiKey(apiKey);

  log(`Concluído em ${((Date.now() - started) / 1000).toFixed(1)} s.`);
  await printSummary(env, batchId, apiKey);
}

main()
  .catch((err) => {
    if (err instanceof AppError) {
      console.error(`[seed-v2] Falha: ${err.message}`);
      if ("fieldErrors" in err) console.error("[seed-v2] Campos:", JSON.stringify((err as { fieldErrors: unknown }).fieldErrors));
    } else if (err && typeof err === "object" && ("code" in err || "cause" in err)) {
      // Database errors carry query parameters in their message: print name and code only.
      const e = err as { name?: string; code?: string; cause?: { code?: string; name?: string } };
      console.error(`[seed-v2] Falha no banco de dados: ${e.name ?? "Erro"} (código ${e.code ?? e.cause?.code ?? "?"}).`);
    } else {
      console.error("[seed-v2] Falha:", err instanceof Error ? (err.stack ?? err.message) : err);
    }
    if (printedKeyPrefix) {
      console.error(
        `[seed-v2] A chave de API de demonstração criada nesta execução (prefixo ${printedKeyPrefix}) foi exibida acima; guarde-a, ela não é exibida de novo.`,
      );
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabase();
  });
