/**
 * Demo seed (`npm run db:seed`, also part of `npm run db:setup`).
 *
 * Creates two fictional demo organizations:
 *  - "Grupo Aurora Exemplo S.A. (demonstração)": units, teams, the demo
 *    accounts, processes, occurrences, contracts, documents (uploaded through
 *    the documents service), AI analyses (demo provider), deadlines, tasks,
 *    comments and the alerts produced by the routines.
 *  - "Outra Empresa Ltda. (teste de isolamento)": a tiny organization used to
 *    demonstrate tenant isolation.
 *
 * Business records are created through the module services (same rules as
 * the UI) with the AuthContext of the seeded user who would do it. Direct
 * inserts are used only for what no service covers (organization, units,
 * users, teams, imported data, createdAt backdating).
 *
 * Idempotent: if the demo organization exists, it exits without changes.
 * `--reset` truncates EVERY application table (all organizations) and deletes
 * their stored files before seeding again. All dates are relative to today.
 * The AI runs in demo mode unless SEED_USE_LIVE_AI=true.
 *
 * v2: risk classifications (and therefore the computed provision, RN-05) are
 * registered through the contingency service, and closed processes carry a
 * closure reason (RN-12). The v2 demo (companies, law firm, spreadsheet
 * portfolio, contingencies, hearings, intakes, simulated e-mails) is added on
 * top of this by `npm run db:seed:v2` (scripts/seed-v2.ts).
 */
import "dotenv/config";
import "./seed-data/env-setup";
import { rm } from "node:fs/promises";
import path from "node:path";
import { and, count, eq, inArray, isNull, sql } from "drizzle-orm";
import { DEMO_ACCOUNTS, DEMO_PASSWORD } from "@/domain/demo";
import type { AnalysisType } from "@/domain/enums";
import { ROLE_LABELS } from "@/domain/enums";
import { hashPassword } from "@/server/auth/password";
import { closeDatabase, getDb } from "@/server/db/client";
import {
  aiAnalyses,
  alerts,
  comments,
  contractObligations,
  contracts,
  deadlines,
  documentVersions,
  documents,
  legalProcesses,
  occurrences,
  organizations,
  processEvents,
  processRiskAssessments,
  processValuations,
  scheduledRoutines,
  tasks,
  teamMembers,
  teams,
  units,
  users,
} from "@/server/db/schema";
import { env } from "@/server/env";
import { recordAudit } from "@/server/services/audit";
import { getAiRuntimeInfo } from "@/server/integrations/ai";
import { enqueueJob } from "@/server/jobs/queue";
import { ensureDefaultRoutines } from "@/server/jobs/routines";
import { processPendingJobs } from "@/server/jobs/worker";
import {
  applySuggestedDeadline,
  applySuggestedTask,
  getAnalysis,
  requestAnalysis,
  reviewAnalysis,
} from "@/modules/analyses/service";
import { addComment } from "@/modules/comments/service";
import { addRiskAssessment } from "@/modules/contingency/risk-service";
import { reviewValuation } from "@/modules/contingency/service";
import { addObligation, createContract } from "@/modules/contracts/service";
import { addDocumentVersion, uploadDocument } from "@/modules/documents/service";
import { createOccurrence } from "@/modules/occurrences/service";
import { addParty, addProcessEvent, createProcess } from "@/modules/processes/service";
import {
  createDeadline,
  createTask,
  setDeadlineStatus,
  updateTask,
  validateDeadline,
} from "@/modules/work/service";
import {
  AURORA_COMMENTS,
  AURORA_CONTRACTS,
  AURORA_DEADLINES,
  AURORA_DOCUMENTS,
  AURORA_OCCURRENCES,
  AURORA_ORG,
  AURORA_PROCESSES,
  AURORA_TASKS,
  AURORA_TEAMS,
  AURORA_UNITS,
  AURORA_USERS,
  IMPORT_SOURCE,
  type ContractKey,
  type DocumentKey,
  type LinkSeed,
  type OccurrenceKey,
  type ProcessKey,
  type ProcessSeed,
  type UnitKey,
  type UserKey,
} from "./seed-data/aurora";
import { brDate, brl, documentFile, rel, relTimestamp, today, userContext, type SeededUser } from "./seed-data/helpers";
import {
  OUTRA_ADMIN_EMAIL,
  OUTRA_DOCUMENT,
  OUTRA_OCCURRENCE,
  OUTRA_ORG,
  OUTRA_PROCESSES,
  OUTRA_UNIT,
} from "./seed-data/outra";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TABLE_NAME_RE = /^[a-z_][a-z0-9_]*$/;

function log(message: string) {
  console.log(`[seed] ${message}`);
}

function warn(message: string) {
  console.warn(`[seed] AVISO: ${message}`);
}

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

/** Truncates every application table (all organizations) and removes their stored files. */
async function resetDatabase() {
  const db = getDb();
  const orgRows = await db.select({ id: organizations.id }).from(organizations);
  const tableRows = await db.execute<{ tablename: string }>(
    sql`select tablename from pg_tables where schemaname = 'public' order by tablename`,
  );
  const tableNames = tableRows.rows.map((r) => r.tablename).filter((t) => TABLE_NAME_RE.test(t));
  if (tableNames.length) {
    await db.execute(sql.raw(`TRUNCATE TABLE ${tableNames.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`));
  }

  // Stored files live under <STORAGE_DIR>/<organizationId>/...; their rows are gone now.
  const root = path.resolve(env().STORAGE_DIR);
  let removed = 0;
  for (const { id } of orgRows) {
    if (!UUID_RE.test(id)) continue;
    const dir = path.resolve(root, id);
    if (path.dirname(dir) !== root) continue; // never leave the storage root
    await rm(dir, { recursive: true, force: true });
    removed++;
  }
  log(`Banco limpo (${tableNames.length} tabelas) e arquivos de ${removed} organização(ões) removidos do armazenamento.`);
}

// ---------------------------------------------------------------------------
// Organization, units, users, teams (direct inserts: no service creates orgs)
// ---------------------------------------------------------------------------

async function createOrganization(name: string, slug: string): Promise<string> {
  const [org] = await getDb().insert(organizations).values({ name, slug, isDemo: true }).returning({ id: organizations.id });
  return org.id;
}

async function createUsers(
  organizationId: string,
  accounts: { email: string; name: string; role: SeededUser["role"]; unitId: string | null; jobTitle: string }[],
): Promise<SeededUser[]> {
  const out: SeededUser[] = [];
  for (const a of accounts) {
    const passwordHash = await hashPassword(DEMO_PASSWORD);
    const [row] = await getDb()
      .insert(users)
      .values({
        organizationId,
        name: a.name,
        email: a.email.toLowerCase(),
        passwordHash,
        role: a.role,
        unitId: a.unitId,
        jobTitle: a.jobTitle,
      })
      .returning();
    out.push({ id: row.id, organizationId, name: row.name, email: row.email, role: row.role, unitId: row.unitId });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Grupo Aurora (main demo organization)
// ---------------------------------------------------------------------------

type AuroraIds = {
  organizationId: string;
  units: Record<UnitKey, string>;
  users: Record<UserKey, SeededUser>;
  occurrences: Record<OccurrenceKey, string>;
  processes: Record<ProcessKey, string>;
  contracts: Record<ContractKey, string>;
  documents: Record<DocumentKey, string>;
};

async function seedAurora(): Promise<AuroraIds> {
  const db = getDb();
  const organizationId = await createOrganization(AURORA_ORG.name, AURORA_ORG.slug);
  log(`Organização "${AURORA_ORG.name}" criada.`);

  const unitRows = await db
    .insert(units)
    .values(AURORA_UNITS.map((u) => ({ organizationId, name: u.name, code: u.code })))
    .returning({ id: units.id, name: units.name });
  const unitIds = Object.fromEntries(
    AURORA_UNITS.map((u) => [u.key, unitRows.find((r) => r.name === u.name)!.id]),
  ) as Record<UnitKey, string>;

  const accounts = DEMO_ACCOUNTS.filter((a) => a.email in AURORA_USERS).map((a) => {
    const meta = AURORA_USERS[a.email];
    return { email: a.email, name: a.name, role: a.role, unitId: meta.unit ? unitIds[meta.unit] : null, jobTitle: meta.jobTitle };
  });
  const seededUsers = await createUsers(organizationId, accounts);
  const userMap = Object.fromEntries(
    seededUsers.map((u) => [AURORA_USERS[u.email].key, u]),
  ) as Record<UserKey, SeededUser>;
  log(`${seededUsers.length} usuários e ${AURORA_UNITS.length} unidades criados.`);

  for (const t of AURORA_TEAMS) {
    const [team] = await db
      .insert(teams)
      .values({
        organizationId,
        name: t.name,
        description: t.description,
        unitId: t.unit ? unitIds[t.unit] : null,
        leaderId: userMap[t.leader].id,
      })
      .returning({ id: teams.id });
    await db
      .insert(teamMembers)
      .values(t.members.map((m) => ({ teamId: team.id, userId: userMap[m].id, organizationId })));
  }
  log(`${AURORA_TEAMS.length} equipes criadas.`);

  const ctx = (key: UserKey) => userContext(userMap[key]);
  const uid = (key: UserKey) => userMap[key].id;

  // --- Occurrences --------------------------------------------------------
  const occurrenceIds = {} as Record<OccurrenceKey, string>;
  for (const o of AURORA_OCCURRENCES) {
    const { id } = await createOccurrence(ctx(o.createdBy), {
      title: o.title,
      facts: o.facts,
      category: o.category,
      status: o.status,
      riskLevel: o.riskLevel,
      riskRationale: o.riskRationale,
      areasInvolved: o.areasInvolved,
      involvedParties: o.involvedParties,
      missingInformation: o.missingInformation,
      estimatedExposureCents: brl(o.exposure),
      unitId: unitIds[o.unit],
      responsibleId: uid(o.responsible),
      reportedById: uid(o.reportedBy),
      occurredOn: rel(o.occurredOn),
      reportedOn: rel(o.reportedOn),
      isConfidential: o.isConfidential ?? false,
    });
    occurrenceIds[o.key] = id;
  }
  log(`${AURORA_OCCURRENCES.length} ocorrências criadas.`);

  // --- Processes ------------------------------------------------------------
  const processIds = {} as Record<ProcessKey, string>;
  let approvedClaims = 0;
  for (const p of AURORA_PROCESSES) {
    const actor = ctx(p.createdBy);
    const { id, occurrenceLinkError, claimValuationStatus } = await createProcess(actor, {
      number: p.number,
      title: p.title,
      court: p.court,
      courtDivision: p.courtDivision,
      jurisdiction: p.jurisdiction,
      area: p.area,
      phase: p.phase,
      instance: p.instance ?? null,
      status: p.status,
      filedAt: rel(p.filedAt),
      closedAt: p.closedAt !== undefined ? rel(p.closedAt) : null,
      unitId: unitIds[p.unit],
      responsibleId: uid(p.responsible),
      claimAmountCents: brl(p.claim),
      riskLevel: p.riskLevel,
      riskRationale: p.riskRationale,
      closureReason: p.closureReason ?? null,
      description: p.description,
      isConfidential: p.isConfidential ?? false,
      fromOccurrenceId: p.fromOccurrence ? occurrenceIds[p.fromOccurrence] : null,
    });
    if (occurrenceLinkError) throw new Error(`Falha ao vincular a ocorrência ao processo ${p.number}: ${occurrenceLinkError}`);
    processIds[p.key] = id;
    // P0.6: a lawyer's valor da causa is only a proposal (the record stays without it). The gestor
    // confers it right away, before the risk classification, so the provision is computed from it.
    if (claimValuationStatus === "proposed") {
      await approveCreatedClaim(ctx("gestor"), id, p.number);
      approvedClaims++;
    }
    // Risk classification with the responsible lawyer's opinion; the provision follows (RN-05).
    await seedRiskAssessment(ctx(p.responsible), id, p);

    for (const party of p.parties) {
      await addParty(actor, id, {
        name: party.name,
        role: party.role,
        isClient: party.isClient ?? false,
        counselName: party.counselName ?? null,
      });
    }
    for (const e of p.events) {
      await addProcessEvent(actor, id, {
        occurredAt: rel(e.days),
        type: e.type,
        title: e.title,
        description: e.description ?? null,
      });
    }
    if (p.imported) await markImported(userContext(userMap.admin), id, p);
  }
  log(`${AURORA_PROCESSES.length} processos criados (com partes, movimentações e classificação de risco).`);
  if (approvedClaims > 0) {
    log(
      approvedClaims === 1
        ? "1 valor da causa informado por advogado foi conferido e oficializado pelo gestor jurídico."
        : `${approvedClaims} valores da causa informados por advogados foram conferidos e oficializados pelo gestor jurídico.`,
    );
  }

  // --- Contracts --------------------------------------------------------------
  const contractIds = {} as Record<ContractKey, string>;
  for (const c of AURORA_CONTRACTS) {
    const actor = ctx(c.createdBy);
    const { id } = await createContract(actor, {
      title: c.title,
      counterparty: c.counterparty,
      type: c.type,
      status: c.status,
      startDate: c.startDate !== null ? rel(c.startDate) : null,
      endDate: c.endDate !== null ? rel(c.endDate) : null,
      renewalType: c.renewalType,
      renewalNoticeDays: c.renewalNoticeDays,
      valueCents: brl(c.value),
      riskLevel: c.riskLevel,
      unitId: unitIds[c.unit],
      responsibleId: uid(c.responsible),
      linkedProcessId: c.linkedProcess ? processIds[c.linkedProcess] : null,
      linkedOccurrenceId: c.linkedOccurrence ? occurrenceIds[c.linkedOccurrence] : null,
      description: c.description,
    });
    contractIds[c.key] = id;
    for (const ob of c.obligations) {
      await addObligation(actor, id, {
        description: ob.description,
        responsibleId: uid(ob.responsible),
        dueDate: ob.dueDate !== null ? rel(ob.dueDate) : null,
        recurrence: ob.recurrence ?? null,
        status: ob.status,
      });
    }
  }
  log(`${AURORA_CONTRACTS.length} contratos criados (com obrigações).`);

  const links = (l: LinkSeed) => ({
    processId: l.process ? processIds[l.process] : null,
    occurrenceId: l.occurrence ? occurrenceIds[l.occurrence] : null,
    contractId: l.contract ? contractIds[l.contract] : null,
  });

  // --- Deadlines & tasks (manual) --------------------------------------------
  for (const d of AURORA_DEADLINES) {
    const actor = ctx(d.createdBy);
    const { id } = await createDeadline(actor, {
      title: d.title,
      description: d.description ?? null,
      dueDate: rel(d.due),
      kind: d.kind,
      priority: d.priority,
      responsibleId: uid(d.responsible),
      ...links(d),
    });
    if (d.status && d.status !== "open") await setDeadlineStatus(actor, id, d.status);
  }
  for (const t of AURORA_TASKS) {
    const actor = ctx(t.createdBy);
    const { id } = await createTask(actor, {
      title: t.title,
      description: t.description ?? null,
      kind: t.kind,
      priority: t.priority,
      dueDate: t.due !== null ? rel(t.due) : null,
      assigneeId: uid(t.assignee),
      ...links(t),
    });
    if (t.status !== "todo") await updateTask(actor, id, { status: t.status });
  }
  log(`${AURORA_DEADLINES.length} prazos e ${AURORA_TASKS.length} tarefas criados manualmente.`);

  // --- Documents (through the documents service) ------------------------------
  const documentIds = {} as Record<DocumentKey, string>;
  for (const d of AURORA_DOCUMENTS) {
    const { documentId } = await uploadDocument(ctx(d.uploadedBy), {
      title: d.title,
      category: d.category,
      description: d.description,
      confidentiality: d.confidentiality,
      ...links(d),
      file: documentFile(d.file),
    });
    documentIds[d.key] = documentId;
  }
  log(`${AURORA_DOCUMENTS.length} documentos enviados.`);

  return {
    organizationId,
    units: unitIds,
    users: userMap,
    occurrences: occurrenceIds,
    processes: processIds,
    contracts: contractIds,
    documents: documentIds,
  };
}

/**
 * Marks a process as loaded from the fictional migration spreadsheet and adds
 * its imported movements (no service imports data; the import is recorded in
 * the audit log so the history stays truthful).
 */
async function markImported(actor: ReturnType<typeof userContext>, processId: string, p: ProcessSeed) {
  if (!p.imported) return;
  const imported = p.imported;
  await getDb().transaction(async (tx) => {
    await tx
      .update(legalProcesses)
      .set({
        dataOrigin: "imported",
        externalSource: IMPORT_SOURCE,
        externalId: imported.externalId,
        importedAt: relTimestamp(-imported.importedDaysAgo),
      })
      .where(and(eq(legalProcesses.id, processId), eq(legalProcesses.organizationId, actor.organizationId)));
    if (imported.events.length) {
      await tx.insert(processEvents).values(
        imported.events.map((e) => ({
          organizationId: actor.organizationId,
          processId,
          occurredAt: rel(e.days),
          type: e.type,
          title: e.title,
          description: e.description ?? null,
          origin: "imported" as const,
          externalSource: IMPORT_SOURCE,
        })),
      );
    }
    await recordAudit(
      actor,
      {
        action: "legal_process.update",
        entityType: "legal_process",
        entityId: processId,
        summary: `Processo ${p.number} marcado como importado (${IMPORT_SOURCE}), com ${imported.events.length} movimentação(ões) importada(s).`,
        changes: { dataOrigin: { from: "manual", to: "imported" }, externalSource: { from: null, to: IMPORT_SOURCE } },
        metadata: { seed: true, externalId: imported.externalId },
      },
      tx,
    );
  });
}

/**
 * Approves, as the legal manager, the valor da causa that a lawyer informed when creating a seeded
 * process (P0.6: it is a PROPOSED claim valuation and the record stays without it until a review).
 * The review queue does the same (`reviewValuation`): the proposal becomes official with the gestor
 * as the identified reviewer and `syncProcessMirrors` fills the record.
 *
 * The service dates the proposal "today". The demo dates it from the filing BEFORE the review, so
 * the review's audit entry ("... (data-base <filing>) conferido e oficializado", tab "Histórico")
 * agrees with the value history; `backdateRecords` then dates its creation and review from the
 * filing like any other manual claim valuation.
 */
async function approveCreatedClaim(reviewer: ReturnType<typeof userContext>, processId: string, number: string) {
  const db = getDb();
  const proposals = await db
    .select({ id: processValuations.id, baseDate: processValuations.baseDate, filedAt: legalProcesses.filedAt })
    .from(processValuations)
    .innerJoin(legalProcesses, eq(legalProcesses.id, processValuations.processId))
    .where(
      and(
        eq(processValuations.organizationId, reviewer.organizationId),
        eq(processValuations.processId, processId),
        eq(processValuations.kind, "claim"),
        eq(processValuations.status, "proposed"),
      ),
    );
  if (proposals.length !== 1) {
    throw new Error(`Esperada 1 proposta de valor da causa no processo ${number}, encontrada(s) ${proposals.length}.`);
  }
  const { id, baseDate, filedAt } = proposals[0];
  if (filedAt && filedAt < baseDate) {
    await db
      .update(processValuations)
      .set({ baseDate: filedAt })
      .where(and(eq(processValuations.id, id), eq(processValuations.organizationId, reviewer.organizationId)));
  }
  const result = await reviewValuation(reviewer, id, {
    decision: "approve",
    note: "Conferido na carga de demonstração (dados fictícios).",
  });
  if (result.status !== "official") {
    throw new Error(`O valor da causa do processo ${number} não ficou oficial na conferência (situação "${result.status}").`);
  }
}

/**
 * Official risk classification of a seeded process (contingency service), in
 * force since the filing date, with the seed's risk rationale as the opinion.
 * The service computes the provision mirror from it (RN-05).
 */
async function seedRiskAssessment(
  actor: ReturnType<typeof userContext>,
  processId: string,
  p: Pick<ProcessSeed, "lossProbability" | "riskRationale" | "filedAt">,
) {
  if (!p.lossProbability) return;
  await addRiskAssessment(actor, processId, {
    classification: p.lossProbability,
    opinion: `${p.riskRationale} (parecer fictício de demonstração)`,
    effectiveFrom: rel(Math.min(0, p.filedAt)),
  });
}

// ---------------------------------------------------------------------------
// AI analyses (demo provider unless SEED_USE_LIVE_AI=true)
// ---------------------------------------------------------------------------

async function runQueue(label: string) {
  const { processed } = await processPendingJobs({ limit: 500 });
  log(`Fila processada (${label}): ${processed} tarefa(s) em segundo plano executada(s).`);
}

async function seedAnalyses(ids: AuroraIds) {
  const ctx = (key: UserKey) => userContext(ids.users[key]);

  // Second version of the logistics contract (consolidated with the 1st amendment).
  await addDocumentVersion(ctx("gestor"), ids.documents.contratoLogistica, {
    changeNote: "Versão consolidada com o 1º aditivo: prorrogação de 30 dias e reajuste do valor mensal (texto fictício).",
    file: documentFile("contrato-logistica-v2.txt"),
  });
  log("Segunda versão do contrato de logística enviada.");
  await runQueue("nova versão do contrato");

  const requests: { key: string; by: UserKey; type: AnalysisType; subjectType: "legal_process" | "occurrence" | "contract"; subjectId: string }[] = [
    { key: "fornecedor", by: "gestor", type: "risk_signals", subjectType: "occurrence", subjectId: ids.occurrences.fornecedorCritico },
    { key: "dados", by: "advogada", type: "risk_signals", subjectType: "occurrence", subjectId: ids.occurrences.dadosPessoais },
    { key: "horasExtras", by: "advogada", type: "summary", subjectType: "legal_process", subjectId: ids.processes.horasExtras },
    { key: "acp", by: "gestor", type: "summary", subjectType: "legal_process", subjectId: ids.processes.acpAmbiental },
    { key: "logistica", by: "gestor", type: "inconsistencies", subjectType: "contract", subjectId: ids.contracts.logistica },
  ];
  const analysisIds: Record<string, string> = {};
  for (const r of requests) {
    const { analysisId } = await requestAnalysis(ctx(r.by), {
      type: r.type,
      subjectType: r.subjectType,
      subjectId: r.subjectId,
      trigger: "manual",
    });
    analysisIds[r.key] = analysisId;
  }
  log(`${requests.length} análises solicitadas manualmente.`);
  await runQueue("análises solicitadas");

  for (const r of requests) {
    const a = await getAnalysis(ctx(r.by), analysisIds[r.key]);
    if (a.status !== "succeeded") warn(`a análise "${r.key}" terminou com situação "${a.status}".`);
  }

  // Human review of one analysis.
  await reviewAnalysis(ctx("advogada"), analysisIds.horasExtras, {
    decision: "reviewed",
    note: "Conferido com o resumo interno e com os autos. As datas citadas foram confirmadas pela advogada responsável.",
  });

  // AI-suggested deadline from the contract analysis → stays pending human validation.
  const contractAnalysis = await getAnalysis(ctx("gestor"), analysisIds.logistica);
  const deadlineSuggestions = contractAnalysis.result?.suggestedDeadlines ?? [];
  const insuranceIdx = deadlineSuggestions.findIndex((s) => s.date === rel(20));
  const pendingIdx = insuranceIdx >= 0 ? insuranceIdx : deadlineSuggestions.length ? 0 : -1;
  if (pendingIdx >= 0) {
    await applySuggestedDeadline(ctx("gestor"), analysisIds.logistica, pendingIdx);
    log(`Prazo sugerido pela IA aplicado e aguardando validação (${brDate(deadlineSuggestions[pendingIdx].date)}).`);
  } else {
    warn("a análise do contrato não trouxe prazos sugeridos; a aba Validação ficará vazia.");
  }

  // A second suggestion (environmental report date, from the automatic summary of the meeting minutes) is validated.
  const ataAnalyses = await getDb()
    .select({ id: aiAnalyses.id })
    .from(aiAnalyses)
    .where(
      and(
        eq(aiAnalyses.organizationId, ids.organizationId),
        eq(aiAnalyses.subjectType, "document"),
        eq(aiAnalyses.subjectId, ids.documents.ataAmbiental),
        eq(aiAnalyses.status, "succeeded"),
      ),
    )
    .limit(1);
  if (ataAnalyses[0]) {
    const ata = await getAnalysis(ctx("gestor"), ataAnalyses[0].id);
    const idx = (ata.result?.suggestedDeadlines ?? []).findIndex((s) => s.date === rel(7));
    if (idx >= 0) {
      const { deadlineId } = await applySuggestedDeadline(ctx("gestor"), ata.id, idx);
      await validateDeadline(ctx("gestor"), deadlineId, {
        decision: "validated",
        note: "Data conferida na ata do comitê: entrega do laudo técnico pela consultoria.",
        responsibleId: ids.users.gestor.id,
      });
      log("Prazo sugerido pela IA aplicado e validado por pessoa (laudo ambiental).");
    }
  }

  // AI-suggested task on the critical supplier occurrence (explicit user action).
  const supplier = await getAnalysis(ctx("gestor"), analysisIds.fornecedor);
  if ((supplier.result?.suggestedTasks ?? []).length) {
    await applySuggestedTask(ctx("gestor"), analysisIds.fornecedor, 0);
    log("Tarefa sugerida pela IA aplicada ao plano de ação da ocorrência do fornecedor.");
  } else {
    warn("a análise de sinais de risco do fornecedor não trouxe tarefas sugeridas.");
  }
  if (!supplier.result?.promptInjectionSuspected) {
    warn("a tentativa de instrução no e-mail do fornecedor não foi sinalizada pela análise.");
  }
}

// ---------------------------------------------------------------------------
// Comments, routines, backdating
// ---------------------------------------------------------------------------

async function seedComments(ids: AuroraIds) {
  for (const c of AURORA_COMMENTS) {
    const entity =
      "process" in c
        ? { type: "legal_process" as const, id: ids.processes[c.process] }
        : "occurrence" in c
          ? { type: "occurrence" as const, id: ids.occurrences[c.occurrence] }
          : { type: "contract" as const, id: ids.contracts[c.contract] };
    await addComment(userContext(ids.users[c.author]), entity, c.body);
  }
  log(`${AURORA_COMMENTS.length} comentários adicionados.`);
}

/** Creates the default routines and runs the alert routines once, so alerts exist right away. */
async function seedRoutines(organizationIds: string[]) {
  const db = getDb();
  for (const id of organizationIds) await ensureDefaultRoutines(id);
  const routines = await db
    .select({ id: scheduledRoutines.id, organizationId: scheduledRoutines.organizationId, intervalMinutes: scheduledRoutines.intervalMinutes })
    .from(scheduledRoutines)
    .where(
      and(
        inArray(scheduledRoutines.organizationId, organizationIds),
        inArray(scheduledRoutines.type, ["deadline_alerts", "contract_expiration_alerts"]),
      ),
    );
  for (const r of routines) {
    await enqueueJob({
      type: "routine.run",
      organizationId: r.organizationId,
      payload: { routineId: r.id },
      dedupeKey: `routine:${r.id}`,
      maxAttempts: 3,
    });
    await db
      .update(scheduledRoutines)
      .set({ nextRunAt: new Date(Date.now() + r.intervalMinutes * 60_000) })
      .where(eq(scheduledRoutines.id, r.id));
  }
  await runQueue("rotinas de alertas");
}

/** Spreads createdAt over the past so lists and timelines look like real use. */
async function backdateRecords(organizationId: string) {
  const db = getDb();
  const ts = (column: string) => sql.raw(`(${column}::timestamp + interval '12 hours') at time zone 'America/Sao_Paulo'`);
  await db.execute(sql`
    update ${legalProcesses} set created_at = least(${ts("filed_at")}, now())
    where organization_id = ${organizationId} and filed_at is not null`);
  await db.execute(sql`
    update ${occurrences} set created_at = least(${ts("reported_on")}, now())
    where organization_id = ${organizationId}`);
  await db.execute(sql`
    update ${contracts} set created_at = least(coalesce(${ts("start_date")}, now() - interval '20 days'), now())
    where organization_id = ${organizationId}`);
  // The valor da causa typed in the process form is dated "today" by the service (a lawyer's value is
  // also reviewed "today" by the gestor; approveCreatedClaim already moved its data-base to the
  // filing); date it, its creation and its review from the filing so past positions and monthly
  // closes see it (same backdating as created_at above). A row still waiting for review keeps no
  // review date.
  await db.execute(sql`
    update ${processValuations} v
    set base_date = p.filed_at,
        created_at = p.created_at,
        reviewed_at = case when v.reviewed_at is null then null else p.created_at end
    from ${legalProcesses} p
    where v.process_id = p.id and v.organization_id = ${organizationId} and p.organization_id = ${organizationId}
      and v.kind = 'claim' and v.source = 'manual' and p.filed_at is not null
      and v.base_date >= p.filed_at and v.created_at > p.created_at`);
  await db.execute(sql`
    update ${processRiskAssessments} r
    set created_at = p.created_at, reviewed_at = p.created_at
    from ${legalProcesses} p
    where r.process_id = p.id and r.organization_id = ${organizationId} and p.organization_id = ${organizationId}
      and r.effective_from = p.filed_at`);
}

// ---------------------------------------------------------------------------
// Outra Empresa (isolation demo)
// ---------------------------------------------------------------------------

async function seedOutra(): Promise<string> {
  const db = getDb();
  const organizationId = await createOrganization(OUTRA_ORG.name, OUTRA_ORG.slug);
  const [unit] = await db
    .insert(units)
    .values({ organizationId, name: OUTRA_UNIT.name, code: OUTRA_UNIT.code })
    .returning({ id: units.id });
  const account = DEMO_ACCOUNTS.find((a) => a.email === OUTRA_ADMIN_EMAIL);
  if (!account) throw new Error(`Conta ${OUTRA_ADMIN_EMAIL} ausente de DEMO_ACCOUNTS.`);
  const [admin] = await createUsers(organizationId, [
    { email: account.email, name: account.name, role: account.role, unitId: unit.id, jobTitle: "Administradora do sistema" },
  ]);
  const ctx = userContext(admin);

  const { id: occurrenceId } = await createOccurrence(ctx, {
    title: OUTRA_OCCURRENCE.title,
    facts: OUTRA_OCCURRENCE.facts,
    category: OUTRA_OCCURRENCE.category,
    status: OUTRA_OCCURRENCE.status,
    riskLevel: OUTRA_OCCURRENCE.riskLevel,
    areasInvolved: OUTRA_OCCURRENCE.areasInvolved,
    missingInformation: OUTRA_OCCURRENCE.missingInformation,
    unitId: unit.id,
    responsibleId: admin.id,
    occurredOn: rel(OUTRA_OCCURRENCE.occurredOn),
    reportedOn: rel(OUTRA_OCCURRENCE.reportedOn),
  });

  for (const p of OUTRA_PROCESSES) {
    const { id } = await createProcess(ctx, {
      number: p.number,
      title: p.title,
      court: p.court,
      courtDivision: p.courtDivision,
      jurisdiction: p.jurisdiction,
      area: p.area,
      phase: p.phase,
      instance: p.instance ?? null,
      status: p.status,
      filedAt: rel(p.filedAt),
      unitId: unit.id,
      responsibleId: admin.id,
      claimAmountCents: brl(p.claim),
      riskLevel: p.riskLevel,
      riskRationale: p.riskRationale,
      closureReason: p.closureReason ?? null,
      description: p.description,
    });
    await seedRiskAssessment(ctx, id, p);
    for (const party of p.parties) {
      await addParty(ctx, id, { name: party.name, role: party.role, isClient: party.isClient ?? false });
    }
    for (const e of p.events) {
      await addProcessEvent(ctx, id, { occurredAt: rel(e.days), type: e.type, title: e.title });
    }
  }

  await uploadDocument(ctx, {
    title: OUTRA_DOCUMENT.title,
    category: "internal",
    description: OUTRA_DOCUMENT.description,
    occurrenceId,
    file: documentFile(OUTRA_DOCUMENT.file),
  });
  await backdateRecords(organizationId);
  log(`Organização "${OUTRA_ORG.name}" criada (1 unidade, 1 usuária, ${OUTRA_PROCESSES.length} processos, 1 ocorrência, 1 documento).`);
  return organizationId;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

async function countWhere(table: typeof legalProcesses | typeof occurrences | typeof contracts, organizationId: string) {
  const [r] = await getDb()
    .select({ n: count() })
    .from(table)
    .where(and(eq(table.organizationId, organizationId), isNull(table.deletedAt)));
  return r.n;
}

async function printSummary(auroraId: string, outraId: string) {
  const db = getDb();
  const n = async (q: PromiseLike<{ n: number }[]>) => (await q)[0]?.n ?? 0;
  const org = auroraId;
  const lines: [string, number | string][] = [
    ["Unidades", await n(db.select({ n: count() }).from(units).where(eq(units.organizationId, org)))],
    ["Usuários", await n(db.select({ n: count() }).from(users).where(eq(users.organizationId, org)))],
    ["Equipes", await n(db.select({ n: count() }).from(teams).where(eq(teams.organizationId, org)))],
    ["Processos", await countWhere(legalProcesses, org)],
    ["  com valor da causa", await n(db.select({ n: count() }).from(legalProcesses).where(and(eq(legalProcesses.organizationId, org), isNull(legalProcesses.deletedAt), sql`${legalProcesses.claimAmountCents} is not null`)))],
    ["  importados", await n(db.select({ n: count() }).from(legalProcesses).where(and(eq(legalProcesses.organizationId, org), eq(legalProcesses.dataOrigin, "imported"))))],
    ["  confidenciais", await n(db.select({ n: count() }).from(legalProcesses).where(and(eq(legalProcesses.organizationId, org), eq(legalProcesses.isConfidential, true))))],
    ["  com classificação de risco", await n(db.select({ n: count() }).from(processRiskAssessments).where(and(eq(processRiskAssessments.organizationId, org), eq(processRiskAssessments.status, "official"))))],
    ["  com provisão calculada", await n(db.select({ n: count() }).from(legalProcesses).where(and(eq(legalProcesses.organizationId, org), sql`${legalProcesses.provisionAmountCents} is not null`)))],
    ["Movimentações", await n(db.select({ n: count() }).from(processEvents).where(eq(processEvents.organizationId, org)))],
    ["Ocorrências", await countWhere(occurrences, org)],
    ["Contratos", await countWhere(contracts, org)],
    ["Obrigações contratuais", await n(db.select({ n: count() }).from(contractObligations).where(eq(contractObligations.organizationId, org)))],
    ["Documentos", await n(db.select({ n: count() }).from(documents).where(eq(documents.organizationId, org)))],
    ["Versões de documentos", await n(db.select({ n: count() }).from(documentVersions).where(eq(documentVersions.organizationId, org)))],
    ["  com texto extraído", await n(db.select({ n: count() }).from(documentVersions).where(and(eq(documentVersions.organizationId, org), eq(documentVersions.extractionStatus, "succeeded"))))],
    ["Prazos", await n(db.select({ n: count() }).from(deadlines).where(eq(deadlines.organizationId, org)))],
    ["  vencidos (em aberto)", await n(db.select({ n: count() }).from(deadlines).where(and(eq(deadlines.organizationId, org), eq(deadlines.status, "open"), sql`${deadlines.dueDate} < ${today()}`, inArray(deadlines.validationStatus, ["not_required", "validated"]))))],
    ["  aguardando validação humana", await n(db.select({ n: count() }).from(deadlines).where(and(eq(deadlines.organizationId, org), eq(deadlines.validationStatus, "pending_validation"))))],
    ["Tarefas", await n(db.select({ n: count() }).from(tasks).where(eq(tasks.organizationId, org)))],
    ["Comentários", await n(db.select({ n: count() }).from(comments).where(eq(comments.organizationId, org)))],
    ["Análises de IA", await n(db.select({ n: count() }).from(aiAnalyses).where(eq(aiAnalyses.organizationId, org)))],
    ["  concluídas", await n(db.select({ n: count() }).from(aiAnalyses).where(and(eq(aiAnalyses.organizationId, org), eq(aiAnalyses.status, "succeeded"))))],
    ["  desatualizadas", await n(db.select({ n: count() }).from(aiAnalyses).where(and(eq(aiAnalyses.organizationId, org), eq(aiAnalyses.isStale, true))))],
    ["Alertas abertos", await n(db.select({ n: count() }).from(alerts).where(and(eq(alerts.organizationId, org), isNull(alerts.resolvedAt))))],
  ];
  const outraProcesses = await countWhere(legalProcesses, outraId);

  const ai = getAiRuntimeInfo();
  console.log("");
  console.log(`Resumo: ${AURORA_ORG.name}`);
  for (const [label, value] of lines) console.log(`  ${label.padEnd(32, ".")} ${value}`);
  console.log(`Resumo: ${OUTRA_ORG.name}, ${outraProcesses} processos, 1 ocorrência, 1 documento.`);
  console.log(
    `IA: ${ai.mode === "demo" ? "modo demonstrativo (regras simples, sem IA real; resultados identificados como demonstrativos)" : `${ai.provider} (${ai.model})`}.`,
  );
  console.log("");
  console.log(`Contas de demonstração criadas (senha para todas: ${DEMO_PASSWORD})`);
  for (const a of DEMO_ACCOUNTS) {
    if (!(a.email in AURORA_USERS) && a.email !== OUTRA_ADMIN_EMAIL) continue;
    console.log(`  ${a.email.padEnd(38)} ${ROLE_LABELS[a.role].padEnd(16)} ${a.description}`);
  }
  console.log("");
  console.log("Para a demonstração da v2 (carteira da planilha fictícia, contingências, audiências, entrada de processos");
  console.log("e e-mails simulados, com as contas de contabilidade, auditoria, escritório externo e advogados regionais):");
  console.log("  npm run db:seed:v2   (o npm run db:setup já executa os dois)");
  console.log("");
  console.log("Todos os dados são fictícios. Para recriar do zero: npm run db:seed -- --reset && npm run db:seed:v2");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const reset = process.argv.slice(2).includes("--reset");
  const db = getDb();
  await db.execute(sql`select 1`);

  const [existing] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.slug, AURORA_ORG.slug))
    .limit(1);

  if (existing && !reset) {
    log(`A organização de demonstração "${AURORA_ORG.slug}" já existe. Nada foi alterado.`);
    log("Para apagar TODOS os dados do banco e recriar a demonstração: npm run db:seed -- --reset");
    return;
  }
  if (reset) {
    log("--reset: apagando todos os dados do banco e os arquivos armazenados...");
    await resetDatabase();
  } else {
    const demoEmails = DEMO_ACCOUNTS.map((a) => a.email.toLowerCase());
    const [conflict] = await db
      .select({ n: count() })
      .from(organizations)
      .where(eq(organizations.slug, OUTRA_ORG.slug));
    const [emailConflict] = await db.select({ n: count() }).from(users).where(inArray(users.email, demoEmails));
    if (conflict.n > 0 || emailConflict.n > 0) {
      throw new Error(
        "Há dados de demonstração incompletos de uma execução anterior. Rode `npm run db:seed -- --reset` para recriar do zero.",
      );
    }
  }

  const started = Date.now();
  log(`Data de referência: ${brDate(today())}. IA: ${getAiRuntimeInfo().mode === "demo" ? "modo demonstrativo" : "provedor real"}.`);

  const aurora = await seedAurora();
  await runQueue("extração de texto e análises automáticas");
  await seedAnalyses(aurora);
  await seedComments(aurora);
  await backdateRecords(aurora.organizationId);

  const outraId = await seedOutra();
  await runQueue("documento da outra organização");

  await seedRoutines([aurora.organizationId, outraId]);

  log(`Concluído em ${((Date.now() - started) / 1000).toFixed(1)} s.`);
  await printSummary(aurora.organizationId, outraId);
}

main()
  .catch((err) => {
    console.error("[seed] Falha:", err instanceof Error ? err.stack ?? err.message : err);
    if (err && typeof err === "object" && "fieldErrors" in err) {
      console.error("[seed] Campos inválidos:", JSON.stringify((err as { fieldErrors: unknown }).fieldErrors));
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabase();
  });
