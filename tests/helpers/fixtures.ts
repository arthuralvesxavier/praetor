/**
 * Shared fixture for the security and integrated-flow suites.
 *
 * Builds, inside an isolated PGlite database:
 *   - Organization A with units SP and RE and one user of every role
 *     (admin, legal_manager, lawyer SP, analyst SP, executive) plus a lawyer
 *     and an analyst in RE;
 *   - Organization B with one admin (and one unit).
 * Returns their AuthContexts and helpers that create records through the REAL
 * services (never by inserting rows directly), so that tests exercise the same
 * validation, scoping and audit code paths as the application.
 *
 * Environment: AI_PROVIDER=demo and a temporary STORAGE_DIR (removed on teardown).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DocumentCategory, Role } from "@/domain/enums";
import { addDaysISO, todayISO } from "@/lib/format";
import { createContract } from "@/modules/contracts/service";
import { uploadDocument } from "@/modules/documents/service";
import type { CreateOccurrenceInput } from "@/modules/occurrences/schemas";
import { createOccurrence } from "@/modules/occurrences/service";
import type { CreateProcessInput } from "@/modules/processes/schemas";
import { createProcess } from "@/modules/processes/service";
import type { ContractInput } from "@/modules/contracts/schemas";
import { createDeadline, createTask, type DeadlineInput, type TaskInput } from "@/modules/work/service";
import type { AuthContext } from "@/server/auth/context";
import type { Database } from "@/server/db/client";
import { organizations, units, users } from "@/server/db/schema";
import { resetEnvCache } from "@/server/env";
import { setAiProviderForTesting } from "@/server/integrations/ai";
import { LocalStorageProvider, setStorageForTesting } from "@/server/integrations/storage";
import { processPendingJobs } from "@/server/jobs/worker";
import { createTestDatabase } from "./db";

export type FixtureUsers = {
  admin: AuthContext;
  manager: AuthContext;
  /** Lawyer of unit SP. */
  lawyer: AuthContext;
  /** Analyst of unit SP. */
  analyst: AuthContext;
  executive: AuthContext;
  /** Lawyer of unit RE. */
  lawyerRe: AuthContext;
  /** Analyst of unit RE. */
  analystRe: AuthContext;
  /** Admin of organization B. */
  adminB: AuthContext;
};

export type Fixture = {
  db: Database;
  storageDir: string;
  orgA: string;
  orgB: string;
  unitSp: string;
  unitRe: string;
  unitB: string;
  ctx: FixtureUsers;
  teardown: () => Promise<void>;
};

const encoder = new TextEncoder();

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

export function today(): string {
  return todayISO();
}

export function daysFromToday(days: number): string {
  return addDaysISO(todayISO(), days);
}

/** "YYYY-MM-DD" → "DD/MM/YYYY" (how dates appear in Brazilian documents). */
export function brDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function userCtx(
  role: Role,
  userId: string,
  organizationId: string,
  unitId: string | null,
  name: string,
  email: string,
): AuthContext {
  return { kind: "user", userId, organizationId, role, unitId, name, email, isDemoOrganization: false };
}

/** Call in `beforeAll`. Pair with `fixture.teardown()` in `afterAll`. */
export async function setupFixture(slugPrefix = "sec"): Promise<Fixture> {
  process.env.AI_PROVIDER = "demo";
  process.env.LOG_LEVEL ??= "warn";
  const storageDir = await mkdtemp(path.join(tmpdir(), `praetor-${slugPrefix}-`));
  process.env.STORAGE_DIR = storageDir;
  resetEnvCache();
  setAiProviderForTesting(null);
  setStorageForTesting(new LocalStorageProvider(storageDir));

  const { db, close } = await createTestDatabase();

  const [a] = await db.insert(organizations).values({ name: "Organização A (fictícia)", slug: `${slugPrefix}-a` }).returning();
  const [b] = await db.insert(organizations).values({ name: "Organização B (fictícia)", slug: `${slugPrefix}-b` }).returning();
  const [sp] = await db.insert(units).values({ organizationId: a.id, name: "São Paulo" }).returning();
  const [re] = await db.insert(units).values({ organizationId: a.id, name: "Recife" }).returning();
  const [ub] = await db.insert(units).values({ organizationId: b.id, name: "Matriz B" }).returning();

  const mk = async (orgId: string, email: string, name: string, role: Role, unitId: string | null) => {
    const [u] = await db
      .insert(users)
      .values({ organizationId: orgId, name, email: `${slugPrefix}.${email}`, passwordHash: "x", role, unitId })
      .returning();
    return userCtx(role, u.id, orgId, unitId, name, u.email);
  };

  const ctx: FixtureUsers = {
    admin: await mk(a.id, "admin@a.test", "Ana Admin", "admin", null),
    manager: await mk(a.id, "gestor@a.test", "Gustavo Gestor", "legal_manager", null),
    lawyer: await mk(a.id, "adv.sp@a.test", "Laura Advogada SP", "lawyer", sp.id),
    analyst: await mk(a.id, "analista.sp@a.test", "André Analista SP", "analyst", sp.id),
    executive: await mk(a.id, "exec@a.test", "Elisa Executiva", "executive", null),
    lawyerRe: await mk(a.id, "adv.re@a.test", "Rafael Advogado RE", "lawyer", re.id),
    analystRe: await mk(a.id, "analista.re@a.test", "Rita Analista RE", "analyst", re.id),
    adminB: await mk(b.id, "admin@b.test", "Bruno Admin B", "admin", null),
  };

  return {
    db,
    storageDir,
    orgA: a.id,
    orgB: b.id,
    unitSp: sp.id,
    unitRe: re.id,
    unitB: ub.id,
    ctx,
    teardown: async () => {
      setStorageForTesting(undefined);
      setAiProviderForTesting(null);
      await close();
      await rm(storageDir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// Record builders (through the real services)
// ---------------------------------------------------------------------------

let seq = 0;
function next(): number {
  seq += 1;
  return seq;
}

export async function makeOccurrence(ctx: AuthContext, overrides: Partial<CreateOccurrenceInput> = {}): Promise<string> {
  const n = next();
  const { id } = await createOccurrence(ctx, {
    title: `Ocorrência de teste ${n}`,
    facts: `Fatos fictícios da ocorrência de teste número ${n}.`,
    category: "contractual",
    ...overrides,
  });
  return id;
}

export async function makeProcess(ctx: AuthContext, overrides: Partial<CreateProcessInput> = {}): Promise<string> {
  const n = next();
  const { id, occurrenceLinkError } = await createProcess(ctx, {
    number: `${String(n).padStart(7, "0")}-11.2026.8.26.0100`,
    title: `Processo de teste ${n}`,
    court: "TJSP",
    area: "civil",
    phase: "knowledge",
    ...overrides,
  });
  if (occurrenceLinkError) throw new Error(`occurrence link failed: ${occurrenceLinkError}`);
  return id;
}

export async function makeContract(ctx: AuthContext, overrides: Partial<ContractInput> = {}): Promise<string> {
  const n = next();
  const { id } = await createContract(ctx, {
    title: `Contrato de teste ${n}`,
    counterparty: `Fornecedor Fictício ${n} Ltda.`,
    type: "services",
    ...overrides,
  });
  return id;
}

export async function makeTextDocument(
  ctx: AuthContext,
  input: {
    text: string;
    title?: string;
    fileName?: string;
    category?: DocumentCategory;
    confidentiality?: "internal" | "confidential" | "restricted";
    processId?: string | null;
    occurrenceId?: string | null;
    contractId?: string | null;
  },
): Promise<{ documentId: string; versionId: string }> {
  const n = next();
  return uploadDocument(ctx, {
    title: input.title ?? `Documento de teste ${n}`,
    category: input.category ?? "other",
    confidentiality: input.confidentiality,
    processId: input.processId ?? null,
    occurrenceId: input.occurrenceId ?? null,
    contractId: input.contractId ?? null,
    file: { name: input.fileName ?? `documento-${n}.txt`, bytes: utf8(input.text) },
  });
}

export async function makeTask(ctx: AuthContext, overrides: Partial<TaskInput> = {}): Promise<string> {
  const n = next();
  const { id } = await createTask(ctx, { title: `Tarefa de teste ${n}`, ...overrides });
  return id;
}

export async function makeDeadline(ctx: AuthContext, overrides: Partial<DeadlineInput> = {}): Promise<string> {
  const n = next();
  const { id } = await createDeadline(ctx, {
    title: `Prazo de teste ${n}`,
    dueDate: daysFromToday(10),
    kind: "internal",
    ...overrides,
  });
  return id;
}

/** Runs the job queue inline until empty (text extraction, analyses, routines). */
export async function runJobs(limit = 200): Promise<number> {
  let total = 0;
  for (let i = 0; i < 10; i++) {
    const { processed } = await processPendingJobs({ limit });
    total += processed;
    if (processed === 0) break;
  }
  return total;
}
